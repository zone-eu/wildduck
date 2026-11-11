'use strict';

// The JMAP service (docs/jmap/implementation-plan.md). Started by worker.js in every worker process
// when [jmap] enabled is true; it shares the handlers, MongoDB and Redis with the other services.

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const https = require('https');
const tls = require('tls');
const db = require('./lib/db');
const certs = require('./lib/certs');
const metrics = require('./lib/metrics');
const UserHandler = require('./lib/user-handler');
const MessageHandler = require('./lib/message-handler');
const MailboxHandler = require('./lib/mailbox-handler');
const { SettingsHandler } = require('./lib/settings-handler');
const StorageHandler = require('./lib/storage-handler');
const ImapNotifier = require('./lib/imap-notifier');
const Lock = require('ioredfour');
const { createApp } = require('./lib/jmap/server');
const types = require('./lib/jmap/types');

function createDeps() {
    const settingsHandler = new SettingsHandler({ db: db.database });
    const messageHandler = new MessageHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        gridfs: db.gridfs,
        attachments: config.attachments,
        settingsHandler
    });
    const userHandler = new UserHandler({ database: db.database, users: db.users, redis: db.redis, messageHandler });
    // listens to change notifications for the event source, fanned out across workers through Redis
    const notifier = new ImapNotifier({ database: db.database, redis: db.redis, settingsHandler });
    const storageHandler = new StorageHandler({ database: db.database, users: db.users, gridfs: db.gridfs });
    const mailboxHandler = new MailboxHandler({ database: db.database, users: db.users, redis: db.redis, notifier, settingsHandler });
    return {
        settingsHandler,
        messageHandler,
        mailboxHandler,
        notifier,
        storageHandler,
        database: db.database,
        users: db.users,
        gridfs: db.gridfs,
        redis: db.redis,
        userHandler,
        // the mailbox write lock IMAP and the REST API take around moves
        lock: new Lock({ redis: db.redis, namespace: 'mail' }),
        modules: types.modules,
        routes: types.routes
    };
}

function serverFactory(options) {
    if (!options.secure) {
        return undefined;
    }
    // HTTPS with the [jmap] TLS settings, and certificates from CertHandler by server name (SNI)
    return handler => {
        const serverOptions = {};
        certs.loadTLSOptions(serverOptions, 'jmap');
        const defaultSecureContext = tls.createSecureContext(serverOptions);
        serverOptions.SNICallback = (servername, callback) => {
            certs
                .getContextForServername(servername, serverOptions, { source: 'JMAP' })
                .then(context => callback(null, context || defaultSecureContext))
                .catch(err => callback(err));
        };
        const server = https.createServer(serverOptions, handler);
        certs.registerReload(server, 'jmap', serverOptions);
        return server;
    };
}

/**
 * Starts the service.
 *
 * @param {Object} options The [jmap] configuration
 * @param {Function} done Called with (err, app or false when disabled)
 */
function start(options, done) {
    options = options || {};
    if (options.enabled !== true) {
        metrics.setServiceUp('jmap', false);
        return setImmediate(() => done(null, false));
    }

    let app;
    try {
        const factory = serverFactory(options);
        app = createApp(createDeps(), {
            ...options,
            accessSecret: config.api.accessControl.secret,
            roles: config.api.roles,
            tokenLifetime: config.api.accessControl.tokenLifetime,
            serverFactory: factory
        });
    } catch (err) {
        return setImmediate(() => done(err));
    }

    app.listen({ port: options.port, host: options.host || '127.0.0.1' })
        .then(() => {
            metrics.setServiceUp('jmap', true);
            log.info('JMAP', '%s server listening on %s:%s', options.secure ? 'HTTPS' : 'HTTP', options.host || '127.0.0.1', options.port);
            done(null, app);
        })
        .catch(err => {
            metrics.setServiceUp('jmap', false);
            done(err);
        });
}

module.exports = done => start(config.jmap || {}, done);
module.exports.start = start;
module.exports.createDeps = createDeps;
