'use strict';

// The JMAP service (docs/jmap/implementation-plan.md). Started by worker.js in every worker process
// when [jmap] enabled is true; it shares the handlers, MongoDB and Redis with the other services.

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const os = require('os');
const Gelf = require('gelf');
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
const AutoreplyHandler = require('./lib/autoreply-handler');
const Maildropper = require('./lib/maildropper');
const { normalizeLoggelfMessage } = require('./lib/loggelf-message');
const ImapNotifier = require('./lib/imap-notifier');
const Lock = require('ioredfour');
const { createApp } = require('./lib/jmap/server');
const types = require('./lib/jmap/types');
const { startPoller } = require('./lib/jmap/submission-queue');
const { settingsOf } = require('./lib/jmap/types/submission');
const { PushService } = require('./lib/jmap/push/delivery');
const { VapidKeys } = require('./lib/jmap/push/vapid');
const { pushSettings } = require('./lib/jmap/push/settings');

// audit and mail action log lines of the handlers, as the other services write them
function createLoggelf() {
    const component = config.log.gelf.component || 'wildduck';
    const hostname = config.log.gelf.hostname || os.hostname();
    const gelf =
        config.log.gelf && config.log.gelf.enabled ? new Gelf(config.log.gelf.options) : { emit: (key, message) => log.info('Gelf', JSON.stringify(message)) };
    return message => {
        message = typeof message === 'string' ? { short_message: message } : message || {};
        normalizeLoggelfMessage(message);
        if (!message.short_message || message.short_message.indexOf(component.toUpperCase()) !== 0) {
            message.short_message = component.toUpperCase() + ' ' + (message.short_message || '');
        }
        Object.assign(message, { facility: component, host: hostname, timestamp: Date.now() / 1000, _component: component });
        for (const key of Object.keys(message)) {
            if (!message[key]) {
                delete message[key];
            }
        }
        gelf.emit('gelf.log', message);
    };
}

function createDeps() {
    const loggelf = createLoggelf();
    const settingsHandler = new SettingsHandler({ db: db.database });
    const messageHandler = new MessageHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        gridfs: db.gridfs,
        attachments: config.attachments,
        settingsHandler,
        loggelf
    });
    const userHandler = new UserHandler({ database: db.database, users: db.users, redis: db.redis, messageHandler, loggelf });
    // listens to change notifications for the event source, fanned out across workers through Redis
    const notifier = new ImapNotifier({ database: db.database, redis: db.redis, settingsHandler });
    const storageHandler = new StorageHandler({ database: db.database, users: db.users, gridfs: db.gridfs, loggelf });
    const mailboxHandler = new MailboxHandler({ database: db.database, users: db.users, redis: db.redis, notifier, settingsHandler, loggelf });
    const autoreplyHandler = new AutoreplyHandler({ database: db.database, users: db.users, redis: db.redis, notifier, loggelf });
    return {
        settingsHandler,
        messageHandler,
        mailboxHandler,
        autoreplyHandler,
        notifier,
        storageHandler,
        // the outbound queue EmailSubmission hands messages to, as the REST submit endpoint does
        maildropper: new Maildropper({
            db: { database: db.database, senderDb: db.senderDb },
            zone: config.sender.zone,
            collection: config.sender.collection,
            gfs: config.sender.gfs,
            maxQueueTime: config.sender.maxQueueTime,
            loopSecret: config.sender.loopSecret
        }),
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
    let push = null;
    try {
        const factory = serverFactory(options);
        const appOptions = {
            ...options,
            accessSecret: config.api.accessControl.secret,
            roles: config.api.roles,
            tokenLifetime: config.api.accessControl.tokenLifetime,
            serverFactory: factory
        };
        // Web Push (PushSubscription), see lib/jmap/push/delivery.js; invalid settings stop the start here
        const settings = pushSettings(appOptions);
        const deps = createDeps();
        if (settings.enabled) {
            push = new PushService(
                Object.assign(deps, { queueConf: db.queueConf }),
                appOptions,
                new VapidKeys(db.database, { refresh: settings.vapidRefresh })
            );
            deps.push = push;
        }
        app = createApp(deps, appOptions);
        // pending EmailSubmissions follow the outbound queue, see lib/jmap/submission-queue.js
        const stopPoller = startPoller(deps, settingsOf(options).pollInterval);
        app.addHook('onClose', async () => {
            stopPoller();
            if (push) {
                push.vapid.stop();
                await push.stop();
            }
        });
    } catch (err) {
        return setImmediate(() => done(err));
    }

    const ready = push ? push.vapid.start().then(() => push.start()) : Promise.resolve();
    ready
        .then(() => app.listen({ port: options.port, host: options.host || '127.0.0.1' }))
        .then(() => {
            metrics.setServiceUp('jmap', true);
            log.info('JMAP', '%s server listening on %s:%s', options.secure ? 'HTTPS' : 'HTTP', options.host || '127.0.0.1', options.port);
            done(null, app);
        })
        .catch(err => {
            metrics.setServiceUp('jmap', false);
            // stops what was started (push worker, poller)
            app.close().catch(() => false);
            done(err);
        });
}

module.exports = done => start(config.jmap || {}, done);
module.exports.start = start;
module.exports.createDeps = createDeps;
