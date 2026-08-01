'use strict';

const log = require('npmlog');
const metrics = require('../metrics');

// shared plumbing for the two Fastify entry points (api.js and the
// standalone ACME agent in acme.js): both must present the exact same
// surface, so the pieces live here instead of being copied between the files

const maskUrl = url => (url || '').replace(/(accessToken=)[^&]+/g, '$1xxxxxx');

// params for the logging hooks: the merged (and once validated, the validated)
// object for API routes, the bare query string for infra routes that never run
// validation
const requestParams = request => (request.rawParams ? request.params : request.query) || {};

// throws when a permission check fails; exposed to handlers as req.validate
function validatePermission(permission) {
    if (!permission.granted) {
        const err = new Error('Not enough privileges');
        err.responseCode = 403;
        err.code = 'MissingPrivileges';
        throw err;
    }
}

// request state shared by the auth hook, validation, handlers and the
// logging hooks. All request-scoped values default to null/false and are
// assigned per request.
const attachRequestDecorations = app => {
    app.decorateRequest('user', null);
    app.decorateRequest('role', null);
    app.decorateRequest('accessToken', null);
    app.decorateRequest('validate', validatePermission);
    // pre-validation view of the merged params (key-presence checks)
    app.decorateRequest('rawParams', null);
    // route skips the access token check
    app.decorateRequest('wdIsPublic', false);
    // validation passed, the request reached handler code: thrown errors get
    // the handler error contract instead of the infra {code, message} shape
    app.decorateRequest('wdValidated', false);
};

// wdResponseBody carries the reply body object to the Gelf logging hook,
// wdContentType pins an exact content type applied in the onSend hook
// (fastify force-appends a charset to bare application/json)
const attachReplyDecorations = app => {
    app.decorateReply('wdResponseBody', null);
    app.decorateReply('wdContentType', null);
};

// preSerialization: runs for every object payload right before it is
// serialized, whether sent from a handler, a hook or the error handler
const attachPayloadStash = app => {
    app.addHook('preSerialization', async (request, reply, payload) => {
        if (payload && typeof payload === 'object') {
            // the Gelf logging hook reads the body object (the restify
            // implementation logged from within its JSON formatter)
            reply.wdResponseBody = payload;
            if (payload.error !== undefined && payload.success === undefined) {
                // legacy inline error bodies ({error, code}, sometimes with a
                // 200 status) predate the response schemas; serialize them
                // verbatim instead of letting fast-json-stringify reject them
                // over missing required keys
                reply.serializer(body => JSON.stringify(body));
            }
        }
        return payload;
    });
};

// server header on every response plus the JSON content-type policy:
// an explicitly pinned wdContentType always wins; otherwise JSON replies
// carry charset=utf-8 unless the route opts out with config.charset = false
// (routes that never called res.charSet in the restify era)
const attachResponseHeaders = (app, serverName) => {
    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('server', serverName);
        if (reply.wdContentType) {
            reply.header('content-type', reply.wdContentType);
            return payload;
        }
        const contentType = reply.getHeader('content-type');
        if (typeof contentType === 'string' && contentType.startsWith('application/json')) {
            const config = request.routeOptions && request.routeOptions.config;
            reply.header('content-type', config && config.charset === false ? 'application/json' : 'application/json; charset=utf-8');
        }
        return payload;
    });
};

// HTTP access log line (previously restify-logger)
const accessLogLine = (request, reply, includeUser, statusCode) => {
    const params = requestParams(request);
    const userIp = ((params && params.ip) || '').toString().substr(0, 40) || '-';
    const userSess = (params && params.sess) || '-';
    const user = (includeUser && request.user && request.user.toString()) || '-';
    return `${request.raw.socket.remoteAddress} ${user} [${userIp}/${userSess}] ${request.method} ${maskUrl(request.url)} ${statusCode} ${Math.round(
        reply.elapsedTime
    )}ms`;
};

/**
 * Access log line and request metric, emitted once per reply.
 *
 * Normally that happens in onResponse. Handlers that hijack the response get
 * `server.beginRawResponse(req, reply, status, headers)`: hijacking skips the
 * reply hooks entirely for a client that disconnects mid-stream, while a
 * hijacked response that ends normally still reaches onResponse, so both
 * paths funnel through the same emit-once guard.
 */
const attachAccessLog = (app, logTag, { includeUser = false, serverName } = {}) => {
    const emit = (request, reply, statusCode) => {
        if (reply.wdLogged) {
            return;
        }
        reply.wdLogged = true;

        log.http(logTag, accessLogLine(request, reply, includeUser, statusCode));

        const route = (request.routeOptions && request.routeOptions.url) || 'unknown';
        // the scrape endpoint does not measure itself
        if (metrics.enabled && route !== '/metrics') {
            metrics.recordApiRequest(request.method, route, statusCode, reply.elapsedTime / 1000);
        }
    };

    app.decorateReply('wdLogged', false);

    app.addHook('onResponse', async (request, reply) => emit(request, reply, reply.statusCode));

    app.decorate('beginRawResponse', (request, reply, statusCode, headers) => {
        reply.hijack();

        // headers accumulated on the reply (CORS, handler set) must survive
        reply.raw.writeHead(statusCode, Object.assign(serverName ? { server: serverName } : {}, reply.getHeaders(), headers || {}));
        reply.raw.once('close', () => emit(request, reply, statusCode));

        return reply.raw;
    });
};

/**
 * Global error handler.
 *
 * Two response shapes:
 *  - errors thrown by a route handler, meaning the request passed validation:
 *    {error, code?, ...details} with the IMAP error code mapping. The status
 *    stays untouched unless the error carries a responseCode, because some
 *    legacy paths answer 200 with an {error} body.
 *  - everything thrown before a handler runs (access token check, body
 *    parsing, param merging) plus anything unhandled: {code, message}. Errors
 *    that carry a responseCode are expected and answered without a charset
 *    parameter, the rest are logged as unhandled and answered 500.
 */
const attachErrorHandler = (app, logTag) => {
    app.setErrorHandler((err, request, reply) => {
        if (reply.sent || reply.raw.headersSent) {
            // response already on the wire (streaming), nothing to send
            log.error(logTag, 'Error after response started: %s', err.stack || err.message);
            return;
        }

        if (request.wdValidated) {
            const data = {
                error: err.formattedMessage || err.message
            };

            switch (err.code) {
                case 'ALREADYEXISTS':
                    err.responseCode = err.responseCode || 400;
                    err.code = 'MailboxExistsError';
                    break;
                case 'NONEXISTENT':
                    err.responseCode = err.responseCode || 404;
                    err.code = 'NoSuchMailbox';
                    break;
                case 'CANNOT':
                    err.responseCode = err.responseCode || 400;
                    err.code = 'DisallowedMailboxMethod';
                    break;
            }

            if (err.responseCode) {
                reply.status(err.responseCode);
            }

            if (err.code) {
                data.code = err.code;
            }

            metrics.recordApiError(request.method, (request.routeOptions && request.routeOptions.url) || 'unknown', err.code || err.responseCode || 'error');

            if (err.details && typeof err.details === 'object') {
                for (const key of Object.keys(err.details)) {
                    if (!data[key]) {
                        data[key] = err.details[key];
                    }
                }
            }

            const params = requestParams(request);
            log.http(
                'Error',
                `${request.method} ${request.url} sess=${(params && params.sess) || '-'} user=${request.user ? request.user : '-'} error=${JSON.stringify(
                    err.stack
                )}`
            );

            reply.wdContentType = 'application/json; charset=utf-8';
            return reply.send(data);
        }

        if (err.responseCode) {
            // expected pre-handler rejection; these responses carry no charset
            reply.wdContentType = 'application/json';
        } else {
            log.error(logTag, 'Unhandled error: %s', err.stack || err.message);
        }

        reply.status(err.responseCode || 500);
        return reply.send({
            code: (err.responseCode && err.code) || 'InternalError',
            message: err.message
        });
    });
};

module.exports = {
    maskUrl,
    requestParams,
    attachRequestDecorations,
    attachReplyDecorations,
    attachPayloadStash,
    attachResponseHeaders,
    attachAccessLog,
    attachErrorHandler
};
