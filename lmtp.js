'use strict';

// Simple LMTP server that accepts all messages for valid recipients

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const ObjectId = require('mongodb').ObjectId;
const SMTPServer = require('smtp-server').SMTPServer;
const tools = require('./lib/tools');
const MessageHandler = require('./lib/message-handler');
const UserHandler = require('./lib/user-handler');
const FilterHandler = require('./lib/filter-handler');
const db = require('./lib/db');
const certs = require('./lib/certs');
const Gelf = require('gelf');
const os = require('os');

let messageHandler;
let userHandler;
let filterHandler;
let loggelf;

config.on('reload', () => {
    log.info('LMTP', 'Configuration reloaded');
});

const serverOptions = {
    lmtp: true,

    secure: config.lmtp.secure,
    secured: config.lmtp.secured,

    // log to console
    logger: {
        info(...args) {
            args.shift();
            log.info('LMTP', ...args);
        },
        debug(...args) {
            args.shift();
            log.silly('LMTP', ...args);
        },
        error(...args) {
            args.shift();
            log.error('LMTP', ...args);
        }
    },

    name: config.lmtp.name || false,

    // not required but nice-to-have
    banner: config.lmtp.banner || 'Welcome to WildDuck Mail Server',

    disabledCommands: ['AUTH'].concat(config.lmtp.disableSTARTTLS ? 'STARTTLS' : []),

    onMailFrom(address, session, callback) {
        // reset session entries
        session.users = [];

        // accept all sender addresses
        return callback();
    },

    // Validate RCPT TO envelope address. Example allows all addresses that do not start with 'deny'
    // If this method is not set, all addresses are allowed
    onRcptTo(rcpt, session, callback) {
        let originalRecipient = tools.normalizeAddress(rcpt.address);
        userHandler.get(
            originalRecipient,
            {
                name: true,
                forwards: true,
                targets: true,
                autoreply: true,
                encryptMessages: true,
                encryptForwarded: true,
                pubKey: true,
                spamLevel: true
            },
            (err, userData) => {
                if (err) {
                    log.error('LMTP', err);
                    return callback(new Error('Database error'));
                }
                if (!userData) {
                    return callback(new Error('Unknown recipient'));
                }

                if (!session.users) {
                    session.users = [];
                }

                session.users.push({
                    recipient: originalRecipient,
                    user: userData
                });

                callback();
            }
        );
    },

    // Handle message stream
    onData(stream, session, callback) {
        let chunks = [];
        let chunklen = 0;

        stream.on('readable', () => {
            let chunk;
            while ((chunk = stream.read()) !== null) {
                chunks.push(chunk);
                chunklen += chunk.length;
            }
        });

        stream.once('error', err => {
            log.error('LMTP', err);
            callback(new Error('Error reading from stream'));
        });

        stream.once('end', () => {
            let sender = tools.normalizeAddress((session.envelope.mailFrom && session.envelope.mailFrom.address) || '');
            let responses = [];
            let users = session.users;
            let stored = 0;

            let transactionId = new ObjectId();
            let prepared = false;

            let storeNext = () => {
                if (stored >= users.length) {
                    return callback(
                        null,
                        responses.map(r => r.response)
                    );
                }

                let rcptData = users[stored++];
                let recipient = rcptData.recipient;
                let userData = rcptData.user;

                let response = responses.filter(r => r.userData === userData);
                if (response.length) {
                    responses.push(response[0]);
                    return storeNext();
                }

                filterHandler.process(
                    {
                        mimeTree: prepared && prepared.mimeTree,
                        maildata: prepared && prepared.maildata,
                        user: userData,
                        sender,
                        recipient,
                        chunks,
                        chunklen,
                        meta: {
                            transactionId,
                            source: 'MX',
                            from: sender,
                            to: [recipient],
                            origin: session.remoteAddress,
                            originhost: session.clientHostname,
                            transhost: session.hostNameAppearsAs,
                            transtype: session.transmissionType,
                            time: new Date()
                        }
                    },
                    (err, response, preparedResponse) => {
                        if (err) {
                            // ???
                        }

                        if (response) {
                            responses.push(response);
                        }

                        if (!prepared && preparedResponse) {
                            prepared = preparedResponse;
                        }

                        setImmediate(storeNext);
                    }
                );
            };

            storeNext();
        });
    }
};

certs.loadTLSOptions(serverOptions, 'lmtp');

const server = new SMTPServer(serverOptions);

certs.registerReload(server, 'lmtp');

module.exports = done => {
    if (!config.lmtp.enabled) {
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
        gelf.emit('gelf.log', message);
    };

    messageHandler = new MessageHandler({
        database: db.database,
        users: db.users,
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

    filterHandler = new FilterHandler({
        db,
        sender: config.sender,
        messageHandler,
        loggelf: message => loggelf(message)
    });

    let started = false;

    server.on('error', err => {
        if (!started) {
            started = true;
            return done(err);
        }
        log.error('LMTP', err);
    });

    server.listen(config.lmtp.port, config.lmtp.host, () => {
        if (started) {
            return server.close();
        }
        started = true;
        done(null, server);
    });
};
