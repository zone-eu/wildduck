'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const POP3Server = require('./lib/pop3/server');
const UserHandler = require('./lib/user-handler');
const MessageHandler = require('./lib/message-handler');
const packageData = require('./package.json');
const ObjectId = require('mongodb').ObjectId;
const db = require('./lib/db');
const certs = require('./lib/certs');
const LimitedFetch = require('./lib/limited-fetch');
const tools = require('./lib/tools');
const Gelf = require('gelf');
const os = require('os');
const { normalizeLoggelfMessage } = require('./lib/loggelf-message');
const metrics = require('./lib/metrics');

const MAX_MESSAGES = 250;

let messageHandler;
let userHandler;
let loggelf;

const serverOptions = {
    port: config.pop3.port,
    host: config.pop3.host,

    secure: config.pop3.secure,
    secured: config.pop3.secured,

    disableSTARTTLS: config.pop3.disableSTARTTLS,
    ignoreSTARTTLS: config.pop3.ignoreSTARTTLS,

    disableVersionString: !!config.pop3.disableVersionString,

    useProxy: !!config.imap.useProxy,
    ignoredHosts: config.pop3.ignoredHosts,

    id: {
        name: config.pop3.name || 'WildDuck POP3 Server',
        version: config.pop3.version || packageData.version
    },

    SNICallback(opts, cb) {
        if (typeof opts === 'string') {
            opts = {
                servername: opts,
                meta: {}
            };
        }

        certs
            .getContextForServername(
                opts.servername,
                serverOptions,
                {
                    source: 'pop3',
                    ...opts.meta
                },
                {
                    loggelf: message => loggelf(message)
                }
            )
            .then(context => cb(null, context))
            .catch(err => cb(err));
    },

    // log to console
    logger: {
        info(...args) {
            args.shift();
            log.info('POP3', ...args);
        },
        debug(...args) {
            args.shift();
            log.silly('POP3', ...args);
        },
        error(...args) {
            args.shift();
            log.error('POP3', ...args);
        }
    },

    onAuth(auth, session, callback) {
        userHandler
            .asyncAuthenticate(auth.username, auth.password, 'pop3', {
                protocol: 'POP3',
                sess: session.id,
                ip: session.remoteAddress
            })
            .then(([result]) => {
                if (!result) {
                    return callback();
                }

                if (result.scope === 'master' && result.require2fa) {
                    // master password not allowed if 2fa is enabled!
                    return callback();
                }

                callback(null, {
                    user: {
                        id: result.user,
                        username: result.username
                    }
                });
            }, callback);
    },

    onListMessages(session, callback) {
        listMessages(session).then(result => callback(null, result), callback);
    },

    onFetchMessage(message, session, callback) {
        fetchMessage(message, session).then(limiter => callback(null, limiter), callback);
    },

    onUpdate(update, session, callback) {
        applyUpdate(session, update).catch(err => log.error('POP3', err));

        // return callback without waiting for the update result
        setImmediate(callback);
    }
};

certs.loadTLSOptions(serverOptions, 'pop3');

const server = new POP3Server(serverOptions);

certs.registerReload(server, 'pop3');

// only list messages in INBOX
async function listMessages(session) {
    let mailbox = await db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path: 'INBOX'
    });

    if (!mailbox) {
        throw new Error('Mailbox not found for user');
    }

    session.user.mailbox = mailbox._id;

    // the UID the previous listing started from, so older messages are not listed again
    let lastIndex;
    try {
        let res = await db.redis
            .multi()
            // "new" limit store
            .hget(`pxm:${session.user.id}`, mailbox._id.toString())
            // fallback store
            .hget(`pop3uid`, mailbox._id.toString())
            .exec();
        lastIndex = res && ((res[0] && res[0][1]) || (res[1] && res[1][1]));
    } catch {
        // the index is only an optimisation
    }

    let query = {
        mailbox: mailbox._id
    };
    if (lastIndex && !isNaN(lastIndex)) {
        query.uid = { $gte: Number(lastIndex) };
    }

    let maxMessages = await userHandler.userCache.getAsync(session.user.id, 'pop3MaxMessages', config.pop3.maxMessages);

    let messages = await db.database
        .collection('messages')
        .find(query)
        .project({
            uid: true,
            size: true,
            mailbox: true,
            // required to decide if we need to update flags after RETR
            flags: true,
            unseen: true
        })
        .sort({ uid: -1 })
        .limit(maxMessages || MAX_MESSAGES)
        .toArray();

    // first is the newest, last the oldest
    let oldestMessageData = messages && messages.length && messages[messages.length - 1];
    if (oldestMessageData && oldestMessageData.uid) {
        // try to update index, ignore result
        try {
            await db.redis
                .multi()
                // update limit store
                .hset(`pxm:${session.user.id}`, mailbox._id.toString(), oldestMessageData.uid)
                // delete fallback store as it is no longer needed
                .hdel(`pop3uid`, mailbox._id.toString())
                .exec();
        } catch {
            // ignore
        }
    }

    return {
        messages: messages
            // show older first
            .reverse()
            // compose message objects
            .map(message => ({
                id: message._id.toString(),
                uid: message.uid,
                mailbox: message.mailbox,
                size: message.size,
                flags: message.flags,
                seen: !message.unseen
            })),
        count: messages.length,
        size: messages.reduce((acc, message) => acc + message.size, 0)
    };
}

// resolves with a rate limited stream of the message source
async function fetchMessage(message, session) {
    let limit = await userHandler.userCache.getAsync(session.user.id, 'pop3MaxDownload', { setting: 'const:max:pop3:download' });

    let res = await messageHandler.counters.asyncTTLCounter('pdw:' + session.user.id, 0, limit, false);
    if (!res.success) {
        let err = new Error('Download was rate limited');
        err.response = 'NO';
        err.code = 'DownloadRateLimited';
        err.ttl = res.ttl;
        err.responseMessage = `Download was rate limited. Try again in ${tools.roundTime(res.ttl)}.`;
        throw err;
    }

    let messageData = await db.database.collection('messages').findOne(
        {
            _id: new ObjectId(message.id),
            // shard key
            mailbox: message.mailbox,
            uid: message.uid
        },
        {
            projection: {
                mimeTree: true,
                size: true
            }
        }
    );

    if (!messageData) {
        throw new Error('Message does not exist or is already deleted');
    }

    let response = messageHandler.indexer.rebuild(messageData.mimeTree);
    if (!response || response.type !== 'stream' || !response.value) {
        throw new Error('Can not fetch message');
    }

    let limiter = new LimitedFetch({
        key: 'pdw:' + session.user.id,
        ttlcounter: messageHandler.counters.ttlcounter,
        maxBytes: limit,
        skipCounter: true
    });

    response.value.pipe(limiter);
    response.value.once('error', err => limiter.emit('error', err));

    // ends all streams and cleans up
    limiter.abort = () => {
        response.value.abort(); // abort rebuilder
        response.value.unpipe(limiter);
        limiter.end();
    };

    return limiter;
}

// applies the flag updates a session collected (RETR marks seen, DELE deletes)
async function applyUpdate(session, update) {
    let seenCount = 0;
    let deleteCount = 0;

    if (update.seen && update.seen.length) {
        seenCount = await markAsSeen(session, update.seen);
    }

    if (update.deleted && update.deleted.length) {
        deleteCount = await trashMessages(session, update.deleted);
    }

    log.info('POP3', '[%s] Deleted %s messages, marked %s messages as seen', session.user.username, deleteCount, seenCount);
}

// move messages to trash
async function trashMessages(session, messages) {
    // find Trash folder
    let trashMailbox = await db.database.collection('mailboxes').findOne({
        user: session.user.id,
        specialUse: '\\Trash'
    });

    if (!trashMailbox) {
        throw new Error('Trash mailbox not found for user');
    }

    let moved = await messageHandler.moveAsync({
        user: session.user.id,
        // folder to move messages from
        source: {
            mailbox: session.user.mailbox
        },
        // folder to move messages to
        destination: trashMailbox,
        // list of UIDs to move
        messages: messages.map(message => message.uid),

        // add \Seen flags to deleted messages
        markAsSeen: true
    });

    return (moved.result && moved.info && moved.info.destinationUid && moved.info.destinationUid.length) || 0;
}

async function markAsSeen(session, messages) {
    let ids = messages.map(message => new ObjectId(message.id));

    let item = await db.database.collection('mailboxes').findOneAndUpdate(
        {
            _id: session.user.mailbox
        },
        {
            $inc: {
                modifyIndex: 1
            }
        },
        {
            returnDocument: 'after'
        }
    );

    let mailboxData = item && item.value;
    if (!mailboxData) {
        let err = new Error('Selected mailbox does not exist');
        err.responseCode = 404;
        err.code = 'NoSuchMailbox';
        throw err;
    }

    await db.database.collection('messages').updateMany(
        {
            _id: {
                $in: ids
            },
            user: session.user.id,
            mailbox: mailboxData._id,
            modseq: {
                $lt: mailboxData.modifyIndex
            }
        },
        {
            $set: {
                modseq: mailboxData.modifyIndex,
                unseen: false
            },
            $addToSet: {
                flags: '\\Seen'
            }
        },
        {
            writeConcern: 1
        }
    );

    try {
        await messageHandler.notifier.addEntriesAsync(
            mailboxData,
            messages.map(message => ({
                command: 'FETCH',
                uid: message.uid,
                flags: message.flags.concat('\\Seen'),
                thread: message.thread,
                message: new ObjectId(message.id),
                modseq: mailboxData.modifyIndex,
                // Indicate that unseen values are changed. Not sure how much though
                unseenChange: true
            }))
        );
    } catch {
        // the flags are set, only the journal entries are missing
    }
    messageHandler.notifier.fire(mailboxData.user);

    return messages.length;
}

module.exports = done => {
    if (!config.pop3.enabled) {
        metrics.setServiceUp('pop3', false);
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

    loggelf = message => {
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
            if (!message[key]) {
                delete message[key];
            }
        });
        gelf.emit('gelf.log', message);
    };

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

    server.loggelf = loggelf;

    server.on('error', err => {
        if (!started) {
            started = true;
            return done(err);
        }
        log.error('POP3', err.message);
    });

    server.listen(config.pop3.port, config.pop3.host, () => {
        if (started) {
            return server.close();
        }
        started = true;
        metrics.setServiceUp('pop3', true);
        done(null, server);
    });
};
