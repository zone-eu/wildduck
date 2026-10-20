'use strict';

const config = require('@zone-eu/wild-config');
const fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyMultipart = require('@fastify/multipart');
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
const ApnClient = require('./lib/apn-client');
const metrics = require('./lib/metrics');
const { attachNativeRoutes } = require('./lib/fastify/routes');
const { attachResponseContractCheck, createViolationLog } = require('./lib/fastify/response-contract');
const { sharedSchemas, stripInternalKeywords } = require('./lib/fastify/validation');
const {
    baseServerOptions,
    maskUrl,
    requestParams,
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
const pushsubscriptionsRoutes = require('./lib/api/pushsubscriptions');
const mcpTokensRoutes = require('./lib/api/mcp-tokens');
const { SettingsHandler } = require('./lib/settings-handler');
const McpTokenHandler = require('./lib/mcp-token-handler');
const roles = require('./lib/roles');

// The only routes an MCP credential may reach, by route name and method. Read routes map to
// the resource whose field allowlist shapes the response. The sole non-read route revokes the
// credential that authenticated that same request.
const MCP_ROUTES = new Map([
    ['getuser', { method: 'GET', resource: 'users' }],
    ['getuseraddresses', { method: 'GET', resource: 'addresses' }],
    ['getmailboxes', { method: 'GET', resource: 'mailboxes' }],
    ['getmailbox', { method: 'GET', resource: 'mailboxes' }],
    ['getmessages', { method: 'GET', resource: 'messages' }],
    ['getmessage', { method: 'GET', resource: 'messages' }],
    ['searchmessages', { method: 'GET', resource: 'messages' }],
    ['invalidateaccesstoken', { method: 'DELETE' }]
]);

// logged param values are truncated to 128 chars, so there is no point in
// rendering more than that per nested value
const INSPECT_OPTIONS = { depth: 3, maxStringLength: 160, maxArrayLength: 20, breakLength: Infinity };

// assigned by createApp(); module level because the TLS SNI callback built in
// buildServer() logs through it
let loggelf;

function buildServer() {
    const serverOptions = {
        ...baseServerOptions(),
        // restify read bodies without a size limit (maxBodySize: 0)
        bodyLimit: 1024 * 1024 * 1024
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
        transformObject({ openapiObject }) {
            return stripInternalKeywords(openapiObject);
        }
    });

    // ---- body parsing (restify bodyParser equivalents) ----

    app.removeAllContentTypeParsers();

    const jsonParser = async (request, payload) => {
        let data = payload;
        if (Buffer.isBuffer(data)) {
            data = data.toString('utf8');
        }
        if (!data || !data.trim()) {
            // restify skipped parsing empty bodies
            return undefined;
        }
        try {
            return JSON.parse(data);
        } catch (err) {
            const parseError = new Error('Invalid JSON: ' + err.message);
            parseError.responseCode = 400;
            parseError.code = 'InvalidContent';
            throw parseError;
        }
    };

    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonParser);
    // fastify matches the regex against the full header value including
    // parameters, so 'application/report+json; charset=utf-8' must match too;
    // the ^ anchor also keeps fastify from printing the FSTSEC001 warning
    app.addContentTypeParser(/^application\/[a-z0-9._-]+\+json\b/i, { parseAs: 'buffer' }, jsonParser);

    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, async (request, payload) => {
        try {
            return qs.parse(payload.toString('utf8'));
        } catch (err) {
            err.responseCode = 400;
            throw err;
        }
    });

    // restify's bodyReader explicitly skipped application/octet-stream: the
    // request stream stays unconsumed so handlers can pipe it themselves
    // (POST /data/import does)
    app.addContentTypeParser('application/octet-stream', async () => undefined);

    // restify's bodyParser handed multipart/form-data to formidable and mapped
    // form fields and uploaded file contents into req.params (mapParams +
    // mapFiles); keyValues mode replicates that: fields arrive as strings and
    // files as Buffers under their field names (POST /users/:user/storage).
    // Parts buffer in memory, so cap them at the largest payload any consumer
    // accepts (storage uploads, wdMaxBytes MAX_ALLOWED_MESSAGE_SIZE)
    app.register(fastifyMultipart, {
        attachFieldsToBody: 'keyValues',
        limits: {
            fieldSize: consts.MAX_ALLOWED_MESSAGE_SIZE,
            // one byte of headroom over the wdMaxBytes ceiling the routes
            // declare: an oversized upload then fails request validation with
            // the documented 400 InputValidationError instead of being cut off
            // by the parser with a bare 413 FST_REQ_FILE_TOO_LARGE
            fileSize: consts.MAX_ALLOWED_MESSAGE_SIZE + 1
        }
    });

    // everything else: Buffer for binary types, utf8 string for text/*
    // (message/rfc822 uploads and similar raw payloads)
    app.addContentTypeParser('*', { parseAs: 'buffer' }, async (request, payload) => {
        const contentType = (request.headers['content-type'] || '').toLowerCase();
        if (/^text\//.test(contentType)) {
            return payload.toString('utf8');
        }
        return payload;
    });

    return app;
}

/**
 * Builds the API application with every hook and route registered, without
 * listening. Expects the database connections in lib/db to be open.
 *
 * Tests build one in-process and drive it with app.inject().
 *
 * @param {Object} [options]
 * @param {Object} [options.contractViolations] Violation log (createViolationLog()); when set, every reply of a documented
 *     route is checked against its response model and each difference is recorded (see lib/fastify/response-contract.js)
 * @returns {Object} Fastify instance
 */
function createApp(options = {}) {
    let userHandler;
    let mailboxHandler;
    let messageHandler;
    let storageHandler;
    let auditHandler;
    let settingsHandler;
    let mcpTokenHandler;
    let notifier;
    let apnClient;

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

    // named route registry, served by the test-only /api-methods route and
    // used by the test overview generator
    const routeRegistry = {};

    const corsOrigins = [].concat(config.api.cors.origins || ['*']);
    app.register(fastifyCors, {
        // `true` reflects the request Origin (and sets Vary: Origin) instead of
        // sending a literal "*", which browsers reject outright when combined
        // with credentials. restify-cors-middleware2 echoed the origin too
        origin: corsOrigins.includes('*') ? true : corsOrigins,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        // restify-cors-middleware2 always merged its own defaults into the
        // configured lists (src/constants.js), so the full set has to be
        // spelled out here; without content-type every cross-origin JSON
        // request fails preflight
        allowedHeaders: [
            'X-Access-Token',
            'Authorization',
            'Accept',
            'Accept-Version',
            'Content-Type',
            'Request-Id',
            'Origin',
            'X-Api-Version',
            'X-Request-Id',
            'X-Requested-With'
        ],
        exposedHeaders: ['Api-Version', 'Content-Length', 'Content-Md5', 'Content-Type', 'Date', 'Request-Id', 'Response-Time'],
        credentials: true
    });

    attachRequestDecorations(app);
    attachReplyDecorations(app);

    // Applies an MCP access level's field allowlist (set by the token check below) to whatever a
    // route is about to answer. Most routes filter their own output already, but the message and
    // mailbox routes do not, and adding a filter call to each of them would leave the next one to
    // remember. preSerialization sees every object payload, from a handler, a hook or the error
    // handler, and nothing else: a stream or a buffer is not a resource. Which bodies carry
    // resource fields (an error body does not) is decided by roles.filterResponseBody. Registered
    // ahead of the payload stash so the Gelf line logs what was actually sent.
    app.decorateRequest('wdResponseFieldFilter', null);
    app.addHook('preSerialization', async (request, reply, payload) =>
        request.wdResponseFieldFilter ? roles.filterResponseBody(request.wdResponseFieldFilter, payload) : payload
    );

    attachPayloadStash(app);
    attachResponseHeaders(app, 'WildDuck API');
    attachNativeRoutes(app, routeRegistry);

    if (options.contractViolations) {
        attachResponseContractCheck(app, finding => options.contractViolations.record(finding));
    }

    // public files (restify serveStatic joined the route path to the root
    // directory, so the files live under public/public)
    app.register(fastifyStatic, {
        root: Path.join(__dirname, 'public', 'public'),
        prefix: '/public/',
        index: 'index.html'
    });

    // ---- access token check (previously a restify server.use middleware) ----

    app.addHook('onRequest', async request => {
        if (request.is404) {
            return;
        }

        const routeConfig = (request.routeOptions && request.routeOptions.config) || {};

        // routes opt out of the token check with config.public; the static
        // files under /public/ are matched by URL prefix instead
        if (routeConfig.public || request.url.startsWith('/public/')) {
            request.wdIsPublic = true;
            return;
        }

        // Where a credential arrived, resolved before the carriers are cleared below. The merge
        // itself is unchanged, and deliberately loose, because that is what every other credential
        // kind has always been read with.
        let bearerToken = McpTokenHandler.getBearerToken(request.headers.authorization);
        let misplacedMcpToken =
            McpTokenHandler.isToken(request.query && request.query.accessToken) || McpTokenHandler.isToken(request.headers['x-access-token']);

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
            throw error;
        };

        // An MCP token is a bearer credential and nothing else. A wdmcp_ value in a query string or
        // an X-Access-Token header has already been written somewhere a credential does not belong,
        // since a URL reaches proxy logs, browser history and referrer headers, so the request is
        // refused even when the same token is also presented correctly. Serving it would teach a
        // client that the unsafe carrier works. Refused ahead of every other credential, including
        // the master token, so no combination of carriers can serve a request that also carried a
        // wdmcp_ value where one does not belong.
        if (misplacedMcpToken) {
            return fail();
        }

        // hard coded master token
        if (config.api.accessToken) {
            tokenRequired = true;
            if (config.api.accessToken === accessToken) {
                request.role = 'root';
                request.user = 'root';
                return;
            }
        }

        // Dedicated MCP tokens resolve to the access level stored on the token record, so what an
        // agent may do is decided by config/roles.json like every other role. These are only ever
        // presented by the MCP service over the private network; they are not API access tokens
        // and carry none of their privileges.
        //
        // The bearer value has to be the one the merge selected as well, so that a token presented
        // alongside an ordinary access token cannot shadow it: precedence between carriers is the
        // same for every credential kind, and this branch does not get its own.
        if (accessToken === bearerToken && McpTokenHandler.isToken(bearerToken)) {
            tokenRequired = true;

            // A role alone is too coarse to describe what an agent may reach. `read:own` on
            // messages and users also covers the raw RFC822 source, the archive, the address
            // register, the journal stream and PUT /users/:user/logout, which is a state change
            // guarded by readOwn('users'). So the credential is additionally pinned to the exact
            // routes the MCP tools dispatch to, plus self-revocation: adding a route under an
            // existing grant cannot widen what an agent token reaches, and the read-only promise
            // belongs to the credential rather than to the client that happens to be using it.
            let mcpRoute = MCP_ROUTES.get(String(routeConfig.name || '').toLowerCase());
            if (!mcpRoute || request.method !== mcpRoute.method) {
                return fail();
            }

            let authenticated;
            try {
                // No address is passed, so no failure is counted here. The failure budget belongs
                // to the MCP listener, which is the surface a guess can actually be aimed at; this
                // caller has already authenticated there, and the `ip` param is supplied by the
                // caller, so keying a limiter on it would let one dodge or poison another's budget.
                // Every MCP token holder reaches this listener from the same socket, so a budget
                // here would also let one of them spend everyone else's.
                authenticated = await mcpTokenHandler.authenticate(bearerToken);
            } catch {
                return fail();
            }

            request.role = authenticated.role;
            request.user = authenticated.user._id.toString();

            if (mcpRoute.resource) {
                // config/roles.json is meant to be the single declaration of what an agent may
                // see, so the allowlist is enforced at the exit of the API (the preSerialization
                // hook below) rather than in the MCP service that usually calls it. A level with
                // no read grant for the resource has no allowlist to apply: refused rather than
                // answered unfiltered, so the next entry added to MCP_ROUTES cannot leak.
                let permission = roles.can(request.role).readOwn(mcpRoute.resource);
                if (!permission.granted) {
                    return fail();
                }
                request.wdResponseFieldFilter = permission;
            } else {
                request.accessToken = {
                    revoke: () => mcpTokenHandler.revokeCurrent(bearerToken)
                };
            }

            return;
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
                        if ('mfaRequired' in tokenData || 'mfaVerified' in tokenData || 'passwordChangeRequired' in tokenData) {
                            signData.mfaRequired = tokenData.mfaRequired;
                            signData.mfaVerified = tokenData.mfaVerified;
                            signData.passwordChangeRequired = tokenData.passwordChangeRequired;
                        }
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
                                await db.redis.del('tn:token:' + tokenHash);
                            } catch (err) {
                                // ignore
                            }
                            */
                    } else if (tokenData.ttl && !isNaN(tokenData.ttl) && Number(tokenData.ttl) > 0) {
                        let tokenTTL = Number(tokenData.ttl);
                        let tokenLifetime = config.api.accessControl.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME;

                        // check if token is not too old
                        if ((Date.now() - Number(tokenData.created)) / 1000 < tokenLifetime) {
                            let assuranceRecorded = 'mfaRequired' in tokenData && 'mfaVerified' in tokenData && 'passwordChangeRequired' in tokenData;
                            let mfaRequired = assuranceRecorded && tokenData.mfaRequired === 'true';
                            let mfaVerified = assuranceRecorded && tokenData.mfaVerified === 'true';
                            // set when a later 2FA completion verified this token through the side key
                            let mfaProofVerified = false;
                            if (mfaRequired && !mfaVerified) {
                                try {
                                    let proof = await db.redis.get('tn:token:mfa:' + tokenHash);
                                    mfaProofVerified = proof === userHandler.getAuthTokenMfaProof(tokenHash, tokenData.user, tokenData.authVersion);
                                } catch {
                                    // treat as unverified
                                }
                                mfaVerified = mfaProofVerified;
                            }

                            // token is still usable, increase session length
                            try {
                                let refresh = db.redis.multi().expire('tn:token:' + tokenHash, tokenTTL);
                                if (mfaProofVerified) {
                                    refresh.expire('tn:token:mfa:' + tokenHash, tokenTTL);
                                }
                                await refresh.exec();
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
                                authVersion: tokenData.authVersion,
                                assuranceRecorded,
                                mfaRequired,
                                mfaVerified,
                                passwordChangeRequired: assuranceRecorded && tokenData.passwordChangeRequired === 'true',
                                // keeps the session valid after its own account changed the password or 2FA
                                // setup (which bumps authVersion); a change of another account leaves it alone
                                update: async changedUser =>
                                    String(changedUser) === tokenData.user &&
                                    setAuthToken(tokenData.user, accessToken, {
                                        role: tokenData.role,
                                        mfaRequired,
                                        mfaVerified,
                                        passwordChangeRequired: false
                                    })
                            };
                        } else {
                            // expired token, clear it
                            try {
                                await db.redis.del('tn:token:' + tokenHash);
                            } catch (err) {
                                // ignore
                            }
                        }
                    } else {
                        request.role = tokenData.role;
                        request.user = tokenData.user;
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

    // a token redundantly included in the request body must never reach
    // validation (it is not a declared field) nor the logs. The body is not
    // parsed yet in onRequest, so this runs as an instance level preValidation
    // hook, which fastify runs before the route's own params merge
    app.addHook('preValidation', async request => {
        if (request.is404 || request.wdIsPublic) {
            return;
        }
        if (request.body && typeof request.body === 'object' && !Array.isArray(request.body) && !Buffer.isBuffer(request.body) && request.body.accessToken) {
            delete request.body.accessToken;
        }
    });

    // ---- metrics timing (previously a restify server.use middleware) ----

    // ---- Gelf HTTP logging (previously done inside the restify JSON formatter) ----

    app.addHook('onResponse', async (request, reply) => {
        const body = reply.wdResponseBody;
        if (!body || typeof body !== 'object') {
            return;
        }

        // only documented API routes produce a gelf line; infra routes
        // (metrics, the OpenAPI document, /api-methods) declare no
        // validationObjs and are not API responses
        const routeConfig = (request.routeOptions && request.routeOptions.config) || {};
        if (!routeConfig.validationObjs) {
            return;
        }

        // fastify has already computed the body size for content-length
        const size = Number(reply.getHeader('content-length')) || 0;
        const params = requestParams(request);

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
            value = typeof value === 'string' ? value : util.inspect(value, INSPECT_OPTIONS).trim();

            if (['password', 'existingPassword', 'accessToken'].includes(key)) {
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

        if (typeof body.id !== 'undefined') {
            let value = typeof body.id === 'string' ? body.id : util.inspect(body.id, INSPECT_OPTIONS).trim();
            message._res_id = value.length > 128 ? value.substr(0, 128) + '…' : value;
        }

        loggelf(message);
    });

    attachAccessLog(app, 'API', { includeUser: true, serverName: 'WildDuck API' });
    attachErrorHandler(app, 'API');

    app.setNotFoundHandler((request, reply) => {
        const body = {
            code: 'ResourceNotFound',
            message: `${maskUrl(request.url)} does not exist`
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

    apnClient = ApnClient.get({ config: config.imap && config.imap.aps, database: db.database, loggelf: message => loggelf(message) });

    messageHandler = new MessageHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        gridfs: db.gridfs,
        attachments: config.attachments,
        settingsHandler,
        apn: apnClient,
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

    // Built after userHandler so a failed MCP authentication here reaches the same authlog it
    // would through the MCP listener. Without the binding this path failed silently, and the
    // user saw a different history depending on which listener the token hit.
    //
    // Successes are left to the MCP listener, which is the hop that sees the client. This one
    // re-checks the same credential on each request that listener makes on a caller's behalf,
    // so recording them here would name the internal address and add two awaited round trips
    // to every one of those requests.
    mcpTokenHandler = new McpTokenHandler({
        users: db.users,
        redis: db.redis,
        counters: userHandler.counters,
        logAuthEvent: userHandler.logAuthEvent.bind(userHandler),
        logSuccessfulAuth: false
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

    // route modules read these off the fastify instance
    app.decorate('loggelf', (message, requiredKeys = []) => loggelf(message, requiredKeys));
    app.decorate(
        'lock',
        new Lock({
            redis: db.redis,
            namespace: 'mail'
        })
    );

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
        totpRoutes(db, app, userHandler, mcpTokenHandler);
        custom2faRoutes(db, app, userHandler);
        webauthnRoutes(db, app, userHandler, mcpTokenHandler);
        updatesRoutes(db, app, notifier);
        authRoutes(db, app, userHandler, mcpTokenHandler);
        autoreplyRoutes(db, app);
        submitRoutes(db, app, messageHandler, userHandler, settingsHandler);
        auditRoutes(db, app, auditHandler);
        domainaliasRoutes(db, app);
        dkimRoutes(db, app);
        certsRoutes(db, app);
        webhooksRoutes(db, app);
        pushsubscriptionsRoutes(db, app, apnClient);
        settingsRoutes(db, app, settingsHandler);
        healthRoutes(db, app, loggelf);
        mcpTokensRoutes(app, mcpTokenHandler);
    });

    if (process.env.NODE_ENV === 'test') {
        app.get('/api-methods', { config: { name: 'api-methods' } }, async () => routeRegistry);
        if (options.contractViolations) {
            // what the response contract check found so far (paths and kinds, no values)
            app.get('/api-contract-violations', { config: { name: 'api-contract-violations' } }, async () => options.contractViolations.list());
        }
    }

    // the specification is static once the routes are registered, build once
    let openApiDocsCache = null;
    app.get(apiDocsConfig.docsPath || '/docs/api/openapidocs.json', { config: { name: 'openapidocs' }, schema: { hide: true } }, async () => {
        if (!openApiDocsCache) {
            openApiDocsCache = app.swagger();
        }
        return openApiDocsCache;
    });

    return app;
}

/**
 * Starts the API server
 *
 * @returns {Promise<Object|false>} The fastify instance, or false if the API is disabled
 */
module.exports = async () => {
    if (!config.api.enabled) {
        metrics.setServiceUp('api', false);
        return false;
    }

    // the test server checks every reply against its response model, the API
    // test suite reads the findings from /api-contract-violations at the end
    const app = createApp(process.env.NODE_ENV === 'test' ? { contractViolations: createViolationLog() } : {});

    if (process.env.GENERATE_API_DOCS === 'true') {
        await app.ready();
        try {
            fs.writeFileSync(Path.join(__dirname, 'docs', 'api', 'openapidocs.json'), JSON.stringify(app.swagger(), null, 4));
            log.info('API', 'Generated OpenAPI docs to docs/api/openapidocs.json');
        } catch (err) {
            log.error('API', 'Failed to generate OpenAPI docs: %s', err.message);
        }
    }

    if (process.env.REGENERATE_API_DOCS === 'true') {
        // allow 2.5 seconds for services to start and the api doc to be generated, after that exit process
        setTimeout(() => process.exit(0), 2500);
    }

    await app.listen({ port: config.api.port, host: config.api.host || '0.0.0.0' });

    metrics.setServiceUp('api', true);
    log.info('API', 'Server listening on %s:%s', config.api.host || '0.0.0.0', config.api.port);

    return app;
};

module.exports.createApp = createApp;
