'use strict';

const config = require('@zone-eu/wild-config');
const restify = require('restify');
const log = require('npmlog');
const logger = require('restify-logger');
const corsMiddleware = require('restify-cors-middleware2');
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
const errors = require('restify-errors');

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

const { RestifyApiGenerate } = require('restifyapigenerate');
const Joi = require('joi');
const restifyApiGenerateConfig = require('./config/apigeneration.json');
const restifyApiGenerate = new RestifyApiGenerate(Joi, __dirname);

let userHandler;
let mailboxHandler;
let messageHandler;
let storageHandler;
let auditHandler;
let settingsHandler;
let notifier;
let loggelf;

const serverOptions = {
    name: 'WildDuck API',
    strictRouting: true,
    maxParamLength: 196,
    formatters: {
        'application/json; q=0.4': (req, res, body) => {
            let data = body ? JSON.stringify(body, false, 2) + '\n' : 'null';
            let size = Buffer.byteLength(data);
            res.setHeader('Content-Length', size);
            if (!body) {
                return data;
            }

            let path = (req.route && req.route.path) || (req.url || '').replace(/(accessToken=)[^&]+/, '$1xxxxxx');

            let message = {
                short_message: 'HTTP [' + req.method + ' ' + path + '] ' + (body.success ? 'OK' : 'FAILED'),

                _req_remoteAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress,

                _ip: ((req.params && req.params.ip) || '').toString().substr(0, 40) || '',
                _sess: ((req.params && req.params.sess) || '').toString().substr(0, 40) || '',

                _http_route: path,
                _http_method: req.method,
                _user: req.user,
                _role: req.role,

                _api_response: body.success ? 'success' : 'fail',

                _error: body.error,
                _code: body.code,

                _size: size
            };

            Object.keys(req.params || {}).forEach(key => {
                let value = req.params[key];

                if (!value && value !== 0) {
                    // if falsy don't continue, allow 0 integer as value
                    return;
                }

                // cast value to string if not string
                value = typeof req.params[key] === 'string' ? req.params[key] : util.inspect(req.params[key], false, 3).toString().trim();

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

            return data;
        }
    }
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

    serverOptions.httpsServerOptions = httpsServerOptions;
}

const server = restify.createServer(serverOptions);

const cors = corsMiddleware({
    origins: [].concat(config.api.cors.origins || ['*']),
    allowHeaders: ['X-Access-Token', 'Authorization'],
    allowCredentialsAllOrigins: true
});

server.pre(cors.preflight);
server.use(cors.actual);

// disable compression for EventSource response
// this needs to be called before gzipResponse
server.use(async (req, res) => {
    if (res && req.route.path === '/users/:user/updates') {
        req.headers['accept-encoding'] = '';
    }
});

server.use(
    restify.plugins.queryParser({
        allowDots: true,
        mapParams: true
    })
);
server.use(
    restify.plugins.bodyParser({
        maxBodySize: 0,
        mapParams: true,
        mapFiles: true,
        overrideParams: false
    })
);

// public files
server.get(
    { name: 'public_get', path: '/public/*', excludeRoute: true },
    restify.plugins.serveStatic({
        directory: Path.join(__dirname, 'public'),
        default: 'index.html'
    })
);

// Disable GZIP as it does not work with stream.pipe(res)
//server.use(restify.plugins.gzipResponse());

server.use(async (req, res) => {
    if (['public_get', 'public_post', 'acmeToken'].includes(req.route.name)) {
        // skip token check for public pages
        return;
    }

    let accessToken =
        req.query.accessToken ||
        req.headers['x-access-token'] ||
        (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim() : false) ||
        false;

    if (req.query.accessToken) {
        // delete or it will conflict with Joi schemes
        delete req.query.accessToken;
    }

    if (req.params.accessToken) {
        // delete or it will conflict with Joi schemes
        delete req.params.accessToken;
    }

    if (req.headers['x-access-token']) {
        req.headers['x-access-token'] = '';
    }

    if (req.headers.authorization) {
        req.headers.authorization = '';
    }

    let tokenRequired = false;

    let fail = () => {
        let error = new errors.ForbiddenError(
            {
                code: 'InvalidToken'
            },
            'Invalid accessToken value'
        );
        throw error;
    };

    req.validate = permission => {
        if (!permission.granted) {
            let err = new Error('Not enough privileges');
            err.responseCode = 403;
            err.code = 'MissingPrivileges';
            throw err;
        }
    };

    // hard coded master token
    if (config.api.accessToken) {
        tokenRequired = true;
        if (config.api.accessToken === accessToken) {
            req.role = 'root';
            req.user = 'root';
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
                        req.role = tokenData.role;
                        req.user = tokenData.user;

                        // make a reference to original method, otherwise might be overridden
                        let setAuthToken = userHandler.setAuthToken.bind(userHandler);

                        req.accessToken = {
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
                    req.role = tokenData.role;
                    req.user = tokenData.user;
                }

                if (req.params && req.params.user === 'me' && /^[0-9a-f]{24}$/i.test(req.user)) {
                    req.params.user = req.user;
                }

                if (!req.role) {
                    return fail();
                }

                if (/^[0-9a-f]{24}$/i.test(req.user)) {
                    let tokenAuthVersion = Number(tokenData.authVersion) || 0;
                    let userData = await db.users.collection('users').findOne(
                        {
                            _id: new ObjectId(req.user)
                        },
                        { projection: { authVersion: true } }
                    );
                    let userAuthVersion = Number(userData && userData.authVersion) || 0;
                    if (!userData || tokenAuthVersion < userAuthVersion) {
                        // unknown user or expired session
                        try {
                            /*
                                // do not delete just in case there is something wrong with the check
                                await db.redis
                                    .multi()
                                    .del('tn:token:' + tokenHash)
                                    .exec();
                                */
                        } catch (err) {
                            // ignore
                        }
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
    req.role = 'root';
    req.user = 'root';
});

logger.token('user-ip', req => ((req.params && req.params.ip) || '').toString().substr(0, 40) || '-');
logger.token('user-sess', req => (req.params && req.params.sess) || '-');

logger.token('user', req => (req.user && req.user.toString()) || '-');
logger.token('url', req => {
    if (/\baccessToken=/.test(req.url)) {
        return req.url.replace(/\baccessToken=[^&]+/g, 'accessToken=' + 'x'.repeat(6));
    }
    return req.url;
});

server.use(
    logger(':remote-addr :user [:user-ip/:user-sess] :method :url :status :time-spent :append', {
        stream: {
            write: message => {
                message = (message || '').toString();
                if (message) {
                    log.http('API', message.replace('\n', '').trim());
                }
            }
        }
    })
);

module.exports = done => {
    if (!config.api.enabled) {
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

    notifier = new ImapNotifier({
        database: db.database,
        redis: db.redis
    });

    messageHandler = new MessageHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        gridfs: db.gridfs,
        attachments: config.attachments,
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
        loggelf: message => loggelf(message)
    });

    auditHandler = new AuditHandler({
        database: db.database,
        users: db.users,
        gridfs: db.gridfs,
        bucket: 'audit',
        loggelf: message => loggelf(message)
    });

    settingsHandler = new SettingsHandler({ db: db.database });

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
        server.get(
            { name: 'api-methods', path: '/api-methods' },
            tools.responseWrapper(async (req, res) => {
                res.charSet('utf-8');

                return res.json(server.router.getRoutes());
            })
        );
    }

    if (process.env.GENERATE_API_DOCS === 'true') {
        server.pre(restifyApiGenerate.restifyApiGenerate(server, restifyApiGenerateConfig));
    }

    if (process.env.REGENERATE_API_DOCS === 'true') {
        // allow 2.5 seconds for services to start and the api doc to be generated, after that exit process
        (async function () {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            await sleep(2500);
            process.exit(0);
        })();
    }

    server.on('error', err => {
        if (!started) {
            started = true;
            return done(err);
        }
        log.error('API', err);
    });

    server.on('restifyError', (req, res, err, callback) => {
        if (!started) {
            started = true;
            return done(err);
        }
        return callback();
    });

    server.listen(config.api.port, config.api.host, () => {
        if (started) {
            return server.close();
        }
        started = true;
        log.info('API', 'Server listening on %s:%s', config.api.host || '0.0.0.0', config.api.port);
        done(null, server);
    });
};
