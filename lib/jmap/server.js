'use strict';

// The HTTP side of the JMAP service: routes, authentication, request parsing, problem details and
// limits. Methods live in the type modules (types/*.js), the request model in request.js.

const crypto = require('crypto');
const fastify = require('fastify');
const log = require('npmlog');
const { ObjectId } = require('mongodb');
const { JmapAuth, AuthError } = require('./auth');
const { buildSession } = require('./session');
const { processRequest, MethodRegistry } = require('./request');
const { RequestProblem } = require('./errors');
const { parseStrict, JsonError } = require('./json');
const { limitsFrom, URN } = require('./capabilities');
const { formatId } = require('./ids');

const NO_CACHE = 'no-cache, no-store, must-revalidate';
const CHALLENGE = 'Basic realm="JMAP", Bearer realm="JMAP"';
const CONCURRENCY_TTL = 120;
const MAX_PARAM_LENGTH = 4096;

const sendProblem = (reply, problem) =>
    reply.code(problem.status).header('Content-Type', 'application/problem+json').header('Cache-Control', NO_CACHE).send(JSON.stringify(problem.toResponse()));

const authorizationCount = rawHeaders => {
    let count = 0;
    for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i].toLowerCase() === 'authorization') {
            count++;
        }
    }
    return count;
};

// client supplied names (methods) are logged as one token of printable ASCII
const logSafe = value =>
    String(value)
        .replace(/[^\x21-\x7e]/g, '_')
        .slice(0, 64);

function defaultBaseUrl(options) {
    const host = !options.host || ['0.0.0.0', '::'].includes(options.host) ? 'localhost' : options.host;
    return `${options.secure ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${options.port}`;
}

function errorHandler(err, request, reply) {
    if (err instanceof AuthError) {
        if (err.status === 401) {
            reply.header('WWW-Authenticate', CHALLENGE);
        }
        if (err.retryAfter) {
            reply.header('Retry-After', String(Math.ceil(err.retryAfter)));
        }
        return sendProblem(reply, new RequestProblem(err.status === 429 ? 'limit' : 'about:blank', err.status, err.message));
    }
    if (err instanceof RequestProblem) {
        return sendProblem(reply, err);
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        const limit = request.routeOptions.config.sizeLimit || 'maxSizeRequest';
        return sendProblem(reply, new RequestProblem('limit', 413, `The body is larger than ${limit}`, { limit }));
    }
    if (err.statusCode && err.statusCode < 500) {
        return sendProblem(reply, new RequestProblem('about:blank', err.statusCode, err.message));
    }
    log.error('JMAP', 'request=%s error=%s', request.id, err.stack || err.message);
    return sendProblem(reply, new RequestProblem('serverFail', 500, 'Internal server error'));
}

/**
 * Creates the JMAP Fastify application.
 *
 * @param {Object} deps {database, users, redis, userHandler, ...handlers, modules: type modules}
 * @param {Object} options The [jmap] configuration plus accessSecret, roles, tokenLifetime
 */
function createApp(deps, options) {
    const limits = limitsFrom(options);
    const registry = new MethodRegistry(deps.modules);
    const auth = new JmapAuth({
        redis: deps.redis,
        users: deps.users,
        userHandler: deps.userHandler,
        accessSecret: options.accessSecret,
        roles: options.roles,
        tokenLifetime: options.tokenLifetime,
        cacheSecret: options.accessSecret,
        cacheTtl: (options.auth && options.auth.cacheTtl) || 300
    });
    const corsOrigins = new Set((options.cors && options.cors.origins) || []);

    const app = fastify({
        logger: false,
        bodyLimit: limits.maxSizeRequest,
        trustProxy: !!options.trustProxy,
        serverFactory: options.serverFactory,
        // path parameters carry ids and download file names (percent encoded UTF-8): a long one is not
        // found, never 414
        maxParamLength: MAX_PARAM_LENGTH
    });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => done(null, body));
    app.setErrorHandler(errorHandler);
    app.setNotFoundHandler((request, reply) => sendProblem(reply, new RequestProblem('about:blank', 404, 'Not found')));

    app.addHook('onRequest', async (request, reply) => {
        // identifies the request in the access log and in the authentication log
        request.jmapSession = crypto.randomBytes(8).toString('hex');
        const origin = request.headers.origin;
        if (origin && corsOrigins.has(origin)) {
            reply.header('Access-Control-Allow-Origin', origin);
            reply.header('Vary', 'Origin');
        }
    });

    // every response gets one access log line: user, methods, errors, timing (no credentials, no content)
    app.addHook('onResponse', async (request, reply) => {
        const user = request.jmapUser ? request.jmapUser._id.toString() : '-';
        log.info(
            'JMAP',
            '%s %s %s user=%s sess=%s methods=%s errors=%s %sms',
            request.method,
            request.url.split('?')[0],
            reply.statusCode,
            user,
            request.jmapSession,
            request.jmapMethods || '-',
            request.jmapErrors || '-',
            Math.round(reply.elapsedTime)
        );
    });

    // runs before the body is read, so an unauthenticated client can not make the server buffer one
    const authenticate = async request => {
        const header = request.headers.authorization;
        // Node keeps only the first of repeated Authorization headers; a second credential is an error, not ignored
        if (authorizationCount(request.raw.rawHeaders) > 1 || /^\s*\S+\s+[^\s,]+\s*,/.test(header || '')) {
            throw new RequestProblem('about:blank', 400, 'Only one credential is allowed in a request');
        }
        request.jmapUser = await auth.authenticate(header, { ip: request.ip, sess: request.jmapSession });
    };

    const context = (request, session) => ({
        account: { id: formatId('account', request.jmapUser._id), user: new ObjectId(request.jmapUser._id), userData: request.jmapUser },
        limits,
        advertised: new Set(Object.keys(session.capabilities)),
        sessionState: session.state,
        deps,
        options,
        cache: {}
    });

    // the session URLs never follow client supplied headers (Host, X-Forwarded-Host)
    const baseUrl = options.baseUrl || defaultBaseUrl(options);
    const sessionFor = request => buildSession(request.jmapUser, { baseUrl, limits, registry });

    // a path answers only its own HTTP methods, others get 405 with Allow
    const route = (path, methods, handler, routeOptions = {}) => {
        app.route({ method: methods, url: path, onRequest: authenticate, handler, ...routeOptions });
        app.route({
            method: ['DELETE', 'PATCH', 'PUT', 'POST', 'GET', 'HEAD'].filter(
                method => !methods.includes(method) && !(method === 'HEAD' && methods.includes('GET'))
            ),
            url: path,
            handler: (request, reply) => {
                reply.header('Allow', methods.join(', '));
                return sendProblem(reply, new RequestProblem('about:blank', 405, 'Method not allowed'));
            }
        });
        app.route({
            method: 'OPTIONS',
            url: path,
            handler: (request, reply) => {
                if (request.headers.origin && corsOrigins.has(request.headers.origin)) {
                    reply.header('Access-Control-Allow-Methods', methods.join(', '));
                    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Last-Event-ID');
                    reply.header('Access-Control-Max-Age', '3600');
                }
                reply.header('Allow', methods.concat('OPTIONS').join(', '));
                return reply.code(204).send();
            }
        });
    };

    const sendSession = (request, reply) =>
        reply
            .header('Cache-Control', NO_CACHE)
            .header('Content-Type', 'application/json')
            .send(JSON.stringify(sessionFor(request)));
    for (const path of ['/.well-known/jmap', '/.well-known/jmap/', '/jmap/session', '/jmap/session/']) {
        route(path, ['GET'], sendSession);
    }

    const api = async (request, reply) => {
        const type = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') {
            throw new RequestProblem('notJSON', 400, 'The request content type must be application/json');
        }
        let body;
        try {
            body = parseStrict(request.body || Buffer.alloc(0));
        } catch (err) {
            throw err instanceof JsonError ? new RequestProblem('notJSON', 400, `The request body is not valid I-JSON: ${err.message}`) : err;
        }

        const session = sessionFor(request);
        const response = await processRequest(body, registry, context(request, session));
        request.jmapMethods = body.methodCalls.map(call => logSafe(call[0])).join(',');
        const errors = response.methodResponses.filter(entry => entry[0] === 'error').map(entry => logSafe(entry[1].type));
        request.jmapErrors = errors.length ? errors.join(',') : null;
        return reply.header('Content-Type', 'application/json').header('Cache-Control', NO_CACHE).send(JSON.stringify(response));
    };

    // the concurrency slot is taken before the body is read and given back on every exit path
    const concurrency = {
        preParsing: async (request, reply, payload) => {
            request.jmapRelease = await acquireSlot(deps.redis, request.jmapUser._id, limits.maxConcurrentRequests);
            return payload;
        },
        onResponse: async request => request.jmapRelease && request.jmapRelease(),
        onRequestAbort: async request => request.jmapRelease && request.jmapRelease()
    };
    for (const path of ['/jmap/api', '/jmap/api/']) {
        route(path, ['POST'], api, concurrency);
    }

    for (const extra of deps.routes || []) {
        extra({ app, route, sessionFor, context, limits, registry, sendProblem, deps, options });
    }

    return app;
}

// Counts the API requests a user has in flight across all workers (RFC 8620 maxConcurrentRequests).
// The answered release function decrements the counter once, however often it is called.
async function acquireSlot(redis, user, limit) {
    const key = `jmap:conc:${user}`;
    const [[, count]] = await redis.multi().incr(key).expire(key, CONCURRENCY_TTL).exec();
    let released = false;
    const release = async () => {
        if (!released) {
            released = true;
            await redis.decr(key).catch(() => false);
        }
    };
    if (count > limit) {
        await release();
        throw new RequestProblem('limit', 429, `More than ${limit} concurrent requests`, { limit: 'maxConcurrentRequests' });
    }
    return release;
}

module.exports = { createApp, URN };
