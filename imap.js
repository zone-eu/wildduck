'use strict';

const log = require('npmlog');
const config = require('@zone-eu/wild-config');
const IMAPServerModule = require('./imap-core');
const IMAPServer = IMAPServerModule.IMAPServer;
const ImapNotifier = require('./lib/imap-notifier');
const Indexer = require('./imap-core/lib/indexer/indexer');
const MessageHandler = require('./lib/message-handler');
const UserHandler = require('./lib/user-handler');
const MailboxHandler = require('./lib/mailbox-handler');
const { SettingsHandler } = require('./lib/settings-handler');
const db = require('./lib/db');
const packageData = require('./package.json');
const certs = require('./lib/certs');
const Gelf = require('gelf');
const os = require('os');
const Lock = require('ioredfour');

const onFetch = require('./lib/handlers/on-fetch');
const onAuth = require('./lib/handlers/on-auth');
const onList = require('./lib/handlers/on-list');
const onLsub = require('./lib/handlers/on-lsub');
const onSubscribe = require('./lib/handlers/on-subscribe');
const onUnsubscribe = require('./lib/handlers/on-unsubscribe');
const onCreate = require('./lib/handlers/on-create');
const onRename = require('./lib/handlers/on-rename');
const onDelete = require('./lib/handlers/on-delete');
const onOpen = require('./lib/handlers/on-open');
const onStatus = require('./lib/handlers/on-status');
const onAppend = require('./lib/handlers/on-append');
const onStore = require('./lib/handlers/on-store');
const onExpunge = require('./lib/handlers/on-expunge');
const onCopy = require('./lib/handlers/on-copy');
const onMove = require('./lib/handlers/on-move');
const onSearch = require('./lib/handlers/on-search');
const onGetQuotaRoot = require('./lib/handlers/on-get-quota-root');
const onGetQuota = require('./lib/handlers/on-get-quota');
const onXAPPLEPUSHSERVICE = require('./lib/handlers/on-xapplepushservice');

let logger = {
    info(...args) {
        args.shift();
        log.info('IMAP', ...args);
    },
    debug(...args) {
        args.shift();
        log.silly('IMAP', ...args);
    },
    error(...args) {
        args.shift();
        log.error('IMAP', ...args);
    }
};

let indexer;
let notifier;
let messageHandler;
let userHandler;
let mailboxHandler;
let loggelf;

let createInterface = (ifaceOptions, callback) => {
    // Setup server
    const serverOptions = {
        secure: ifaceOptions.secure,
        secured: ifaceOptions.secured,

        disableSTARTTLS: ifaceOptions.disableSTARTTLS,
        ignoreSTARTTLS: ifaceOptions.ignoreSTARTTLS,

        useProxy: !!config.imap.useProxy,
        ignoredHosts: config.imap.ignoredHosts,

        id: {
            name: config.imap.name || 'WildDuck IMAP Server',
            version: config.imap.version || packageData.version,
            vendor: config.imap.vendor || 'Kreata'
        },

        aps: config.imap.aps,

        logger,

        maxMessage: config.imap.maxMB * 1024 * 1024,
        settingsHandler: ifaceOptions.settingsHandler,

        enableCompression: !!config.imap.enableCompression,

        skipFetchLog: config.log.skipFetchLog,

        SNICallback(servername, cb) {
            certs
                .getContextForServername(
                    servername,
                    serverOptions,
                    {
                        source: 'imap'
                    },
                    {
                        loggelf: message => loggelf(message)
                    }
                )
                .then(context => cb(null, context))
                .catch(err => cb(err));
        }
    };

    certs.loadTLSOptions(serverOptions, 'imap');

    serverOptions.logoutMessages = config.imap.quotes;

    const server = new IMAPServer(serverOptions);

    certs.registerReload(server, 'imap');

    let started = false;
    server.on('error', err => {
        if (!started) {
            started = true;
            return callback(err);
        }

        logger.error(
            {
                err
            },
            '%s',
            err.message
        );
    });

    // TODO: is this even used anywhere?
    server.indexer = indexer;
    server.notifier = notifier;

    server.lock = new Lock({
        redis: db.redis,
        namespace: 'mail'
    });

    // setup command handlers for the server instance
    server.onFetch = onFetch(server, messageHandler, userHandler.userCache);
    server.onAuth = onAuth(server, userHandler, userHandler.userCache);
    server.onList = onList(server);
    server.onLsub = onLsub(server);
    server.onSubscribe = onSubscribe(server);
    server.onUnsubscribe = onUnsubscribe(server);
    server.onCreate = onCreate(server, mailboxHandler);
    server.onRename = onRename(server, mailboxHandler);
    server.onDelete = onDelete(server, mailboxHandler);
    server.onOpen = onOpen(server);
    server.onStatus = onStatus(server);
    server.onAppend = onAppend(server, messageHandler, userHandler.userCache);
    server.onStore = onStore(server);
    server.onExpunge = onExpunge(server, messageHandler);
    server.onCopy = onCopy(server, messageHandler);
    server.onMove = onMove(server, messageHandler);
    server.onSearch = onSearch(server);
    server.onGetQuotaRoot = onGetQuotaRoot(server);
    server.onGetQuota = onGetQuota(server);
    server.onXAPPLEPUSHSERVICE = onXAPPLEPUSHSERVICE(server);

    if (loggelf) {
        server.loggelf = loggelf;
    }

    // start listening
    server.listen(ifaceOptions.port, ifaceOptions.host, () => {
        if (started) {
            return server.close();
        }
        started = true;
        callback(null, server);
    });
};

module.exports = done => {
    if (!config.imap.enabled) {
        return setImmediate(() => done(null, false));
    }

    const component = config.log.gelf.component || 'wildduck';
    const hostname = config.log.gelf.hostname || os.hostname();
    const gelf =
        config.log.gelf && config.log.gelf.enabled
            ? new Gelf(config.log.gelf.options)
            : {
                  // placeholder
                  emit: (key, message) => log.info('Gelf', JSON.stringify(message))
              };

    loggelf = message => {
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
            if (!message[key]) {
                delete message[key];
            }
        });
        try {
            gelf.emit('gelf.log', message);
        } catch (err) {
            log.error('Gelf', err);
        }
    };

    indexer = new Indexer({
        database: db.database
    });

    // setup notification system for updates
    notifier = new ImapNotifier({
        database: db.database,
        redis: db.redis
    });

    messageHandler = new MessageHandler({
        users: db.users,
        database: db.database,
        redis: db.redis,
        gridfs: db.gridfs,
        attachments: config.attachments,
        loggelf: message => loggelf(message)
    });

    userHandler = new UserHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        loggelf: message => loggelf(message)
    });

    mailboxHandler = new MailboxHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        notifier,
        loggelf: message => loggelf(message)
    });

    let settingsHandler = new SettingsHandler({ db: db.database });

    let ifaceOptions = [
        {
            enabled: true,
            secure: config.imap.secure,
            disableSTARTTLS: config.imap.disableSTARTTLS || false,
            ignoreSTARTTLS: config.imap.ignoreSTARTTLS || false,
            host: config.imap.host,
            port: config.imap.port,
            settingsHandler
        }
    ]
        .concat(config.imap.interface || [])
        .filter(iface => iface.enabled);

    let iPos = 0;
    let startInterfaces = () => {
        if (iPos >= ifaceOptions.length) {
            return db.redis.del('lim:imap', () => done());
        }
        let opts = ifaceOptions[iPos++];

        createInterface(opts, err => {
            if (err) {
                logger.error(
                    {
                        err,
                        tnx: 'bind'
                    },
                    'Failed starting %sIMAP interface %s:%s. %s',
                    opts.secure ? 'secure ' : '',
                    opts.host,
                    opts.port,
                    err.message
                );
                return done(err);
            }
            setImmediate(startInterfaces);
        });
    };
    setImmediate(startInterfaces);
};
