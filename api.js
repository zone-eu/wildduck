'use strict';

const config = require('@zone-eu/wild-config');
const fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyStatic = require('@fastify/static');
const fastifySwagger = require('@fastify/swagger');
const fs = require('fs');
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
const { attachNativeRoutes } = require('./lib/fastify/routes');
const { sharedSchemas, stripInternalKeywords } = require('./lib/fastify/validation');
const {
    maskUrl,
    attachRequestDecorations,
    attachReplyDecorations,
    attachPayloadStash,
    attachResponseHeaders,
    attachAccessLog,
    attachErrorHandler
} = require('./lib/fastify/bootstrap');
require('./lib/schemas/json-schemas'); // populates sharedSchemas
const apiDocsConfig = require('./config/apigeneration.json');

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

// named routes that skip the access token check (static /public files are
// matched by URL prefix instead, restify used routes named public_get/public_post)
const PUBLIC_ROUTE_NAMES = new Set(['acmeToken', 'metrics']);

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

    // OpenAPI generation from the route schemas
    app.register(fastifySwagger, {
        openapi: {
            openapi: apiDocsConfig.openapiVersion || '3.0.0',
            info: apiDocsConfig.info,
            servers: apiDocsConfig.servers,
            tags: apiDocsConfig.tags,
            components: apiDocsConfig.components,
            security: apiDocsConfig.security
        },
        refResolver: {
            buildLocalReference(json, baseUri, fragment, i) {
                return String(json.$id || `def-${i}`).replace(/^wd:/, '');
            }
        },
        transformSpecification(swaggerObject) {
            return stripInternalKeywords(swaggerObject);
        }
    });

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

    attachRequestDecorations(app);
    attachReplyDecorations(app);
    attachPayloadStash(app);
    attachResponseHeaders(app, 'WildDuck API');
    attachNativeRoutes(app, server.routes);

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

    app.addHook('onRequest', async request => {
        if (request.is404) {
            return;
        }

        const routeName = request.routeOptions && request.routeOptions.config && request.routeOptions.config.name;

        if (PUBLIC_ROUTE_NAMES.has(routeName) || request.url.startsWith('/public/')) {
            // skip token check for public pages
            request.wdIsPublic = true;
            return;
        }

        let accessToken =
            (request.query && request.query.accessToken) ||
            request.headers['x-access-token'] ||
            (request.headers.authorization ? request.headers.authorization.replace(/^Bearer\s+/i, '').trim() : false) ||
            false;

        if (request.query && request.query.accessToken) {
            // delete or the strict routes would reject it as an unknown key
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
                request.role = 'root';
                request.user = 'root';
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
                            request.role = tokenData.role;
                            request.user = tokenData.user;

                            // make a reference to original method, otherwise might be overridden
                            let setAuthToken = userHandler.setAuthToken.bind(userHandler);

                            request.accessToken = {
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
                        request.role = tokenData.role;
                        request.user = tokenData.user;
                    }

                    if (request.params && request.params.user === 'me' && /^[0-9a-f]{24}$/i.test(request.user)) {
                        request.params.user = request.user;
                    }

                    if (!request.role) {
                        return fail();
                    }

                    if (/^[0-9a-f]{24}$/i.test(request.user)) {
                        let tokenAuthVersion = Number(tokenData.authVersion) || 0;
                        let userData = await db.users.collection('users').findOne(
                            {
                                _id: new ObjectId(request.user)
                            },
                            { projection: { authVersion: true, disabled: true, suspended: true } }
                        );
                        let userAuthVersion = Number(userData && userData.authVersion) || 0;
                        if (!userData || tokenAuthVersion < userAuthVersion) {
                            // unknown user or expired session
                            return fail();
                        }
                        if (userData.disabled || userData.suspended) {
                            // locked out account, existing tokens must not keep working
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
        request.role = 'root';
        request.user = 'root';
    });

    // restify's bodyParser mapped JSON body keys into req.params and the token
    // middleware then deleted req.params.accessToken, so a token redundantly
    // included in the request body never reached validation; the body is not
    // parsed yet in onRequest, so this runs as a separate preHandler hook
    app.addHook('preHandler', async request => {
        if (request.is404 || request.wdIsPublic) {
            return;
        }
        if (request.body && typeof request.body === 'object' && !Array.isArray(request.body) && !Buffer.isBuffer(request.body) && request.body.accessToken) {
            delete request.body.accessToken;
        }
    });

    // ---- metrics timing (previously a restify server.use middleware) ----

    if (metricsEnabled) {
        app.addHook('onResponse', async (request, reply) => {
            const route = (request.routeOptions && request.routeOptions.url) || 'unknown';
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

        const routeConfig = (request.routeOptions && request.routeOptions.config) || {};
        if (routeConfig.logGelf === false) {
            return payload;
        }

        const size = typeof payload === 'string' || Buffer.isBuffer(payload) ? Buffer.byteLength(payload) : 0;
        const params = request.wdMergedParams || request.query || {};

        let path = (request.routeOptions && request.routeOptions.url) || maskUrl(request.url);

        let message = {
            short_message: 'HTTP [' + request.method + ' ' + path + '] ' + (body.success ? 'OK' : 'FAILED'),

            _req_remoteAddress: request.headers['x-forwarded-for'] || request.raw.socket.remoteAddress,

            _ip: ((params && params.ip) || '').toString().substr(0, 40) || '',
            _sess: ((params && params.sess) || '').toString().substr(0, 40) || '',

            _http_route: path,
            _http_method: request.method,
            _user: request.user,
            _role: request.role,

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

    attachAccessLog(app, 'API', { includeUser: true });
    attachErrorHandler(app, 'API');

    app.setNotFoundHandler((request, reply) => {
        const body = {
            code: 'ResourceNotFound',
            message: `${request.url} does not exist`
        };
        reply.status(404);
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

    // native route modules receive the fastify instance itself
    app.decorate('loggelf', server.loggelf);
    app.decorate('lock', server.lock);

    // route modules load in a sibling plugin context so they boot after the
    // swagger plugin (its onRoute hook only sees routes registered later)
    app.register(async () => {
        acmeRoutes(db, app);
        usersRoutes(db, app, userHandler, settingsHandler);
        addressesRoutes(db, app, userHandler, settingsHandler);
        mailboxesRoutes(db, app, mailboxHandler);
        messagesRoutes(db, app, messageHandler, userHandler, storageHandler, settingsHandler);
        storageRoutes(db, app, storageHandler);
        filtersRoutes(db, app, userHandler, settingsHandler);
        domainaccessRoutes(db, app);
        aspsRoutes(db, app, userHandler);
        totpRoutes(db, app, userHandler);
        custom2faRoutes(db, app, userHandler);
        webauthnRoutes(db, app, userHandler);
        updatesRoutes(db, app, notifier);
        authRoutes(db, app, userHandler);
        autoreplyRoutes(db, app);
        submitRoutes(db, app, messageHandler, userHandler, settingsHandler);
        auditRoutes(db, app, auditHandler);
        domainaliasRoutes(db, app);
        dkimRoutes(db, app);
        certsRoutes(db, app);
        webhooksRoutes(db, app);
        settingsRoutes(db, app, settingsHandler);
        healthRoutes(db, app, loggelf);
    });

    if (process.env.NODE_ENV === 'test') {
        app.get('/api-methods', { config: { name: 'api-methods' } }, async () => server.routes);
    }

    // the specification is static once the routes are registered, build once
    let openApiDocsCache = null;
    app.get(apiDocsConfig.docsPath || '/docs/api/openapidocs.json', { config: { name: 'openapidocs', logGelf: false }, schema: { hide: true } }, async () => {
        if (!openApiDocsCache) {
            openApiDocsCache = app.swagger();
        }
        return openApiDocsCache;
    });

    if (process.env.GENERATE_API_DOCS === 'true') {
        app.ready(() => {
            try {
                fs.writeFileSync(Path.join(__dirname, 'docs', 'api', 'openapidocs.json'), JSON.stringify(app.swagger(), null, 4));
                log.info('API', 'Generated OpenAPI docs to docs/api/openapidocs.json');
            } catch (err) {
                log.error('API', 'Failed to generate OpenAPI docs: %s', err.message);
            }
        });
    }

    if (process.env.REGENERATE_API_DOCS === 'true') {
        // allow 2.5 seconds for services to start and the api doc to be generated, after that exit process
        (async function () {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            await sleep(2500);
            process.exit(0);
        })();
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
