'use strict';

const config = require('@zone-eu/wild-config');
const fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyStatic = require('@fastify/static');
const qs = require('qs');
const log = require('npmlog');
const UserHandler = require('./lib/user-handler');
const MailboxHandler = require('./lib/mailbox-handler');
const MessageHandler = require('./lib/message-handler');
const StorageHandler = require('./lib/storage-handler');
const AuditHandler = require('./lib/audit-handler');
const ImapNotifier = require('./lib/imap-notifier');
const db = require('./lib/db');
const certs = require('./lib/certs');
const tools = require('./lib/tools');
const consts = require('./lib/consts');
const crypto = require('crypto');
const Gelf = require('gelf');
const os = require('os');
const util = require('util');
const ObjectId = require('mongodb').ObjectId;
const tls = require('tls');
const Lock = require('ioredfour');
const Path = require('path');
const { normalizeLoggelfMessage } = require('./lib/loggelf-message');
const metrics = require('./lib/metrics');
const { RestifyCompatAdapter } = require('./lib/fastify/adapter');
const { sharedSchemas } = require('./lib/fastify/validation');
require('./lib/schemas/json-schemas'); // populates sharedSchemas

const acmeRoutes = require('./lib/api/acme');
const usersRoutes = require('./lib/api/users');
const addressesRoutes = require('./lib/api/addresses');
const mailboxesRoutes = require('./lib/api/mailboxes');
const messagesRoutes = require('./lib/api/messages');
const storageRoutes = require('./lib/api/storage');
const filtersRoutes = require('./lib/api/filters');
const domainaccessRoutes = require('./lib/api/domainaccess');
const aspsRoutes = require('./lib/api/asps');
const totpRoutes = require('./lib/api/2fa/totp');
const custom2faRoutes = require('./lib/api/2fa/custom');
const webauthnRoutes = require('./lib/api/2fa/webauthn');
const updatesRoutes = require('./lib/api/updates');
const authRoutes = require('./lib/api/auth');
const autoreplyRoutes = require('./lib/api/autoreply');
const submitRoutes = require('./lib/api/submit');
const auditRoutes = require('./lib/api/audit');
const domainaliasRoutes = require('./lib/api/domainaliases');
const dkimRoutes = require('./lib/api/dkim');
const certsRoutes = require('./lib/api/certs');
const webhooksRoutes = require('./lib/api/webhooks');
const settingsRoutes = require('./lib/api/settings');
const healthRoutes = require('./lib/api/health');
const { SettingsHandler } = require('./lib/settings-handler');

let userHandler;
let mailboxHandler;
let messageHandler;
let storageHandler;
let auditHandler;
let settingsHandler;
let notifier;
let loggelf;

// routes that skip the access token check (same list as the restify setup)
const PUBLIC_ROUTE_NAMES = new Set(['public_get', 'public_post', 'acmeToken', 'metrics']);

function maskUrl(url) {
    return (url || '').replace(/(accessToken=)[^&]+/, '$1xxxxxx');
}

function buildServer() {
    const serverOptions = {
        maxParamLength: 196,
        exposeHeadRoutes: false,
        // restify read bodies without a size limit (maxBodySize: 0)
        bodyLimit: 1024 * 1024 * 1024,
        // restify parsed query strings with qs and allowDots
        querystringParser: str => qs.parse(str, { allowDots: true }),
        // new code logs through Fastify's built-in pino JSON logger; the
        // request/response logging is done by our own hooks below
        logger: { level: 'warn' },
        disableRequestLogging: true
    };

    let certOptions = {};
    certs.loadTLSOptions(certOptions, 'api');

    if (config.api.secure && certOptions.key) {
        let httpsServerOptions = {};

        httpsServerOptions.key = certOptions.key;
        httpsServerOptions.cert = tools.buildCertChain(certOptions.cert, certOptions.ca);

        let defaultSecureContext = tls.createSecureContext(httpsServerOptions);

        httpsServerOptions.SNICallback = (servername, cb) => {
            const opts = {
                servername,
                meta: {}
            };

            certs
                .getContextForServername(
                    opts.servername,
                    httpsServerOptions,
                    {
                        source: 'API',
                        ...opts.meta
                    },
                    {
                        loggelf: message => loggelf(message)
                    }
                )
                .then(context => {
                    cb(null, context || defaultSecureContext);
                })
                .catch(err => cb(err));
        };

        serverOptions.https = httpsServerOptions;
    }

    const app = fastify(serverOptions);

    // shared schema definitions, referenced from route response schemas via
    // $ref and published to OpenAPI docs
    for (const schema of sharedSchemas.values()) {
        app.addSchema(schema);
    }

    // request validation happens in the compat adapter on the MERGED params
    // object (see migration/SEMANTICS.md section 2); Fastify's own per-part
    // request validation must not run
    app.setValidatorCompiler(() => () => true);

    // ---- body parsing (restify bodyParser equivalents) ----

    app.removeAllContentTypeParsers();

    const jsonParser = (request, payload, done) => {
        let data = payload;
        if (Buffer.isBuffer(data)) {
            data = data.toString('utf8');
        }
        if (!data || !data.trim()) {
            // restify skipped parsing empty bodies
            return done(null, undefined);
        }
        try {
            return done(null, JSON.parse(data));
        } catch (err) {
            const parseError = new Error('Invalid JSON: ' + err.message);
            parseError.responseCode = 400;
            parseError.code = 'InvalidContent';
            parseError.restifyStyle = true;
            return done(parseError);
        }
    };

    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonParser);
    app.addContentTypeParser(/\+json$/, { parseAs: 'buffer' }, jsonParser);

    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (request, payload, done) => {
        try {
            return done(null, qs.parse(payload.toString('utf8')));
        } catch (err) {
            err.responseCode = 400;
            return done(err);
        }
    });

    // restify's bodyReader explicitly skipped application/octet-stream and
    // multipart/form-data: the request stream stays unconsumed so handlers
    // can pipe it themselves (POST /data/import does)
    const passthroughParser = (request, payload, done) => done(null, undefined);
    app.addContentTypeParser('application/octet-stream', passthroughParser);
    app.addContentTypeParser('multipart/form-data', passthroughParser);

    // everything else: Buffer for binary types, utf8 string for text/*
    // (message/rfc822 uploads and similar raw payloads)
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, payload, done) => {
        const contentType = (request.headers['content-type'] || '').toLowerCase();
        if (/^text\//.test(contentType)) {
            return done(null, payload.toString('utf8'));
        }
        done(null, payload);
    });

    return app;
}

module.exports = done => {
    if (!config.api.enabled) {
        metrics.setServiceUp('api', false);
        return setImmediate(() => done(null, false));
    }

    let started = false;

    const component = config.log.gelf.component || 'wildduck';
    const hostname = config.log.gelf.hostname || os.hostname();
    const gelf =
        config.log.gelf && config.log.gelf.enabled
            ? new Gelf(config.log.gelf.options)
            : {
                  // placeholder
                  emit: (key, message) => log.info('Gelf', JSON.stringify(message))
              };

    loggelf = (message, requiredKeys = []) => {
        if (typeof message === 'string') {
            message = {
                short_message: message
            };
        }
        message = message || {};
        normalizeLoggelfMessage(message);

        if (!message.short_message || message.short_message.indexOf(component.toUpperCase()) !== 0) {
            message.short_message = component.toUpperCase() + ' ' + (message.short_message || '');
        }

        message.facility = component; // facility is deprecated but set by the driver if not provided
        message.host = hostname;
        message.timestamp = Date.now() / 1000;
        message._component = component;
        Object.keys(message).forEach(key => {
            if (!message[key] && !requiredKeys.includes(key)) {
                // remove the key if it empty/falsy/undefined/null and it is not required to stay
                delete message[key];
            }
        });
        gelf.emit('gelf.log', message);
    };

    const app = buildServer();
    const server = new RestifyCompatAdapter(app);

    const corsOrigins = [].concat(config.api.cors.origins || ['*']);
    app.register(fastifyCors, {
        origin: corsOrigins.includes('*') ? '*' : corsOrigins,
        allowedHeaders: ['X-Access-Token', 'Authorization'],
        credentials: true
    });

    app.decorateReply('wdResponseBody', null);
    app.decorateReply('wdContentType', null);

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('server', 'WildDuck API');
        if (reply.wdContentType) {
            // exact content type parity with restify (it only appended a
            // charset parameter when the handler called res.charSet())
            reply.header('content-type', reply.wdContentType);
        }
        return payload;
    });

    // public files (restify serveStatic joined the route path to the root
    // directory, so the files live under public/public)
    app.register(fastifyStatic, {
        root: Path.join(__dirname, 'public', 'public'),
        prefix: '/public/',
        index: 'index.html'
    });

    const metricsEnabled = metrics.enabled;

    if (metricsEnabled) {
        app.get('/metrics', { config: { name: 'metrics' } }, async (request, reply) => {
            try {
                // restify's text formatter replaced prom-client's content type
                // (version param included) with plain text/plain
                reply.header('Content-Type', 'text/plain; charset=utf-8');
                return await metrics.getMetrics();
            } catch (err) {
                log.error('API', 'Failed to collect metrics: %s', err.message);
                reply.status(500);
                return 'error: metrics collection failed';
            }
        });
    }

    // ---- access token check (previously a restify server.use middleware) ----

    app.decorateRequest('wdCtx', null);
    app.decorateRequest('wdMergedParams', null);

    app.addHook('onRequest', async request => {
        if (request.is404) {
            return;
        }

        const routeName = request.routeOptions && request.routeOptions.config && request.routeOptions.config.name;
        const ctx = {
            user: null,
            role: null,
            accessToken: null,
            validate: permission => {
                if (!permission.granted) {
                    let err = new Error('Not enough privileges');
                    err.responseCode = 403;
                    err.code = 'MissingPrivileges';
                    throw err;
                }
            }
        };
        request.wdCtx = ctx;

        if (PUBLIC_ROUTE_NAMES.has(routeName) || request.url.startsWith('/public/')) {
            // skip token check for public pages
            return;
        }

        let accessToken =
            (request.query && request.query.accessToken) ||
            request.headers['x-access-token'] ||
            (request.headers.authorization ? request.headers.authorization.replace(/^Bearer\s+/i, '').trim() : false) ||
            false;

        if (request.query && request.query.accessToken) {
            // delete or it will conflict with Joi schemes
            delete request.query.accessToken;
        }

        if (request.headers['x-access-token']) {
            request.headers['x-access-token'] = '';
        }

        if (request.headers.authorization) {
            request.headers.authorization = '';
        }

        let tokenRequired = false;

        let fail = () => {
            let error = new Error('Invalid accessToken value');
            error.responseCode = 403;
            error.code = 'InvalidToken';
            error.restifyStyle = true;
            throw error;
        };

        // hard coded master token
        if (config.api.accessToken) {
            tokenRequired = true;
            if (config.api.accessToken === accessToken) {
                ctx.role = 'root';
                ctx.user = 'root';
                return;
            }
        }

        if (config.api.accessControl.enabled || accessToken) {
            tokenRequired = true;
            if (accessToken && accessToken.length === 40 && /^[a-fA-F0-9]{40}$/.test(accessToken)) {
                let tokenData;
                let tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');

                try {
                    let key = 'tn:token:' + tokenHash;
                    tokenData = await db.redis.hgetall(key);
                } catch (err) {
                    err.responseCode = 500;
                    err.code = 'InternalDatabaseError';
                    throw err;
                }

                if (tokenData && tokenData.user && tokenData.role && config.api.roles[tokenData.role]) {
                    let signData;
                    if ('authVersion' in tokenData) {
                        // cast value to number
                        tokenData.authVersion = Number(tokenData.authVersion) || 0;
                        signData = {
                            token: accessToken,
                            user: tokenData.user,
                            authVersion: tokenData.authVersion,
                            role: tokenData.role
                        };
                    } else {
                        signData = {
                            token: accessToken,
                            user: tokenData.user,
                            role: tokenData.role
                        };
                    }

                    let signature = crypto.createHmac('sha256', config.api.accessControl.secret).update(JSON.stringify(signData)).digest('hex');

                    if (signature !== tokenData.s) {
                        // rogue token or invalidated secret
                        /*
                            // do not delete just in case there is something wrong with the check
                            try {
                                await db.redis
                                    .multi()
                                    .del('tn:token:' + tokenHash)
                                    .exec();
                            } catch (err) {
                                // ignore
                            }
                            */
                    } else if (tokenData.ttl && !isNaN(tokenData.ttl) && Number(tokenData.ttl) > 0) {
                        let tokenTTL = Number(tokenData.ttl);
                        let tokenLifetime = config.api.accessControl.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME;

                        // check if token is not too old
                        if ((Date.now() - Number(tokenData.created)) / 1000 < tokenLifetime) {
                            // token is still usable, increase session length
                            try {
                                await db.redis
                                    .multi()
                                    .expire('tn:token:' + tokenHash, tokenTTL)
                                    .exec();
                            } catch (err) {
                                // ignore
                            }
                            ctx.role = tokenData.role;
                            ctx.user = tokenData.user;

                            // make a reference to original method, otherwise might be overridden
                            let setAuthToken = userHandler.setAuthToken.bind(userHandler);

                            ctx.accessToken = {
                                hash: tokenHash,
                                user: tokenData.user,
                                // if called then refreshes token data for current hash
                                update: async () => setAuthToken(tokenData.user, accessToken)
                            };
                        } else {
                            // expired token, clear it
                            try {
                                await db.redis
                                    .multi()
                                    .del('tn:token:' + tokenHash)
                                    .exec();
                            } catch (err) {
                                // ignore
                            }
                        }
                    } else {
                        ctx.role = tokenData.role;
                        ctx.user = tokenData.user;
                    }

                    if (request.params && request.params.user === 'me' && /^[0-9a-f]{24}$/i.test(ctx.user)) {
                        request.params.user = ctx.user;
                    }

                    if (!ctx.role) {
                        return fail();
                    }

                    if (/^[0-9a-f]{24}$/i.test(ctx.user)) {
                        let tokenAuthVersion = Number(tokenData.authVersion) || 0;
                        let userData = await db.users.collection('users').findOne(
                            {
                                _id: new ObjectId(ctx.user)
                            },
                            { projection: { authVersion: true } }
                        );
                        let userAuthVersion = Number(userData && userData.authVersion) || 0;
                        if (!userData || tokenAuthVersion < userAuthVersion) {
                            // unknown user or expired session
                            return fail();
                        }
                    }

                    // pass
                    return;
                }
            }
        }

        if (tokenRequired) {
            // no valid token found
            return fail();
        }

        // allow all
        ctx.role = 'root';
        ctx.user = 'root';
    });

    // ---- metrics timing (previously a restify server.use middleware) ----

    if (metricsEnabled) {
        app.addHook('onResponse', async (request, reply) => {
            const spec = request.routeOptions && request.routeOptions.config && request.routeOptions.config.spec;
            const route = (spec && spec.path) || (request.routeOptions && request.routeOptions.url) || 'unknown';
            if (route === '/metrics') {
                return;
            }
            metrics.recordApiRequest(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
        });
    }

    // ---- Gelf HTTP logging (previously done inside the restify JSON formatter) ----

    app.addHook('onSend', async (request, reply, payload) => {
        const body = reply.wdResponseBody;
        if (!body || typeof body !== 'object') {
            return payload;
        }

        const size = typeof payload === 'string' || Buffer.isBuffer(payload) ? Buffer.byteLength(payload) : 0;
        const spec = request.routeOptions && request.routeOptions.config && request.routeOptions.config.spec;
        const params = request.wdMergedParams || request.query || {};
        const ctx = request.wdCtx || {};

        let path = (spec && spec.path) || maskUrl(request.url);

        let message = {
            short_message: 'HTTP [' + request.method + ' ' + path + '] ' + (body.success ? 'OK' : 'FAILED'),

            _req_remoteAddress: request.headers['x-forwarded-for'] || request.raw.socket.remoteAddress,

            _ip: ((params && params.ip) || '').toString().substr(0, 40) || '',
            _sess: ((params && params.sess) || '').toString().substr(0, 40) || '',

            _http_route: path,
            _http_method: request.method,
            _user: ctx.user,
            _role: ctx.role,

            _api_response: body.success ? 'success' : 'fail',

            _error: body.error,
            _code: body.code,

            _size: size
        };

        Object.keys(params || {}).forEach(key => {
            let value = params[key];

            if (!value && value !== 0) {
                // if falsy don't continue, allow 0 integer as value
                return;
            }

            // cast value to string if not string
            value = typeof params[key] === 'string' ? params[key] : util.inspect(params[key], false, 3).toString().trim();

            if (['password', 'existingPassword'].includes(key)) {
                value = '***';
            } else if (value.length > 128) {
                value = value.substr(0, 128) + '…';
            }

            if (key.length > 30) {
                key = key.substr(0, 30) + '…';
            }

            if (key === 'sendTime') {
                try {
                    value = new Date(value).toISOString();
                } catch {
                    // ignore
                }
            }

            message['_req_' + key] = value;
        });

        Object.keys(body).forEach(key => {
            let value = body[key];
            if (!body || !['id'].includes(key)) {
                return;
            }
            value = typeof value === 'string' ? value : util.inspect(value, false, 3).toString().trim();

            if (value.length > 128) {
                value = value.substr(0, 128) + '…';
            }

            if (key.length > 30) {
                key = key.substr(0, 30) + '…';
            }

            message['_res_' + key] = value;
        });

        loggelf(message);

        return payload;
    });

    // ---- HTTP access log (previously restify-logger) ----

    app.addHook('onResponse', async (request, reply) => {
        const ctx = request.wdCtx || {};
        const params = request.wdMergedParams || request.query || {};
        const userIp = ((params && params.ip) || '').toString().substr(0, 40) || '-';
        const userSess = (params && params.sess) || '-';
        const line = `${request.raw.socket.remoteAddress} ${(ctx.user && ctx.user.toString()) || '-'} [${userIp}/${userSess}] ${request.method} ${maskUrl(
            request.url
        )} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`;
        log.http('API', line);
    });

    // ---- error handling ----

    app.setErrorHandler((err, request, reply) => {
        if (err.restifyStyle || (err.responseCode && !reply.sent)) {
            // restify-errors style output ({code, message}) used by the access
            // token middleware and body parser failures
            const body = {
                code: err.code || 'InternalError',
                message: err.message
            };
            reply.status(err.responseCode || 500);
            reply.wdResponseBody = body;
            // restify-errors responses carried no charset parameter
            reply.wdContentType = 'application/json';
            return reply.send(body);
        }

        log.error('API', 'Unhandled error: %s', err.stack || err.message);
        const body = {
            code: 'InternalError',
            message: err.message
        };
        reply.status(500);
        reply.wdResponseBody = body;
        return reply.send(body);
    });

    app.setNotFoundHandler((request, reply) => {
        const body = {
            code: 'ResourceNotFound',
            message: `${request.url} does not exist`
        };
        reply.status(404);
        reply.wdResponseBody = body;
        reply.wdContentType = 'application/json';
        return reply.send(body);
    });

    // ---- handlers and routes ----

    settingsHandler = new SettingsHandler({ db: db.database });

    notifier = new ImapNotifier({
        database: db.database,
        redis: db.redis,
        settingsHandler
    });

    messageHandler = new MessageHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        gridfs: db.gridfs,
        attachments: config.attachments,
        settingsHandler,
        loggelf: message => loggelf(message)
    });

    storageHandler = new StorageHandler({
        database: db.database,
        users: db.users,
        gridfs: db.gridfs,
        loggelf: message => loggelf(message)
    });

    userHandler = new UserHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        messageHandler,
        loggelf: message => loggelf(message)
    });

    mailboxHandler = new MailboxHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        notifier,
        settingsHandler,
        loggelf: message => loggelf(message)
    });

    auditHandler = new AuditHandler({
        database: db.database,
        users: db.users,
        gridfs: db.gridfs,
        bucket: 'audit',
        loggelf: message => loggelf(message)
    });

    server.loggelf = (message, requiredKeys = []) => loggelf(message, requiredKeys);

    server.lock = new Lock({
        redis: db.redis,
        namespace: 'mail'
    });

    acmeRoutes(db, server, { disableRedirect: true });
    usersRoutes(db, server, userHandler, settingsHandler);
    addressesRoutes(db, server, userHandler, settingsHandler);
    mailboxesRoutes(db, server, mailboxHandler);
    messagesRoutes(db, server, messageHandler, userHandler, storageHandler, settingsHandler);
    storageRoutes(db, server, storageHandler);
    filtersRoutes(db, server, userHandler, settingsHandler);
    domainaccessRoutes(db, server);
    aspsRoutes(db, server, userHandler);
    totpRoutes(db, server, userHandler);
    custom2faRoutes(db, server, userHandler);
    webauthnRoutes(db, server, userHandler);
    updatesRoutes(db, server, notifier);
    authRoutes(db, server, userHandler);
    autoreplyRoutes(db, server);
    submitRoutes(db, server, messageHandler, userHandler, settingsHandler);
    auditRoutes(db, server, auditHandler);
    domainaliasRoutes(db, server);
    dkimRoutes(db, server);
    certsRoutes(db, server);
    webhooksRoutes(db, server);
    settingsRoutes(db, server, settingsHandler);
    healthRoutes(db, server, loggelf);

    if (process.env.NODE_ENV === 'test') {
        app.get('/api-methods', { config: { name: 'api-methods' } }, async (request, reply) => {
            reply.wdContentType = 'application/json; charset=utf-8';
            reply.wdResponseBody = server.routes;
            return server.routes;
        });
    }

    app.listen({ port: config.api.port, host: config.api.host || '0.0.0.0' }, err => {
        if (err) {
            if (!started) {
                started = true;
                return done(err);
            }
            return log.error('API', err);
        }
        if (started) {
            return app.close();
        }
        started = true;
        metrics.setServiceUp('api', true);
        log.info('API', 'Server listening on %s:%s', config.api.host || '0.0.0.0', config.api.port);
        done(null, server);
    });
};
