'use strict';

const log = require('npmlog');
const config = require('@zone-eu/wild-config');
const Gelf = require('gelf');
const os = require('os');
const { Queue, Worker } = require('bullmq');
const db = require('./lib/db');
const errors = require('./lib/errors');
const crypto = require('crypto');
const counters = require('./lib/counters');
const { ObjectId } = require('mongodb');
const libmime = require('libmime');
const punycode = require('punycode.js');
const { getClient } = require('./lib/elasticsearch');

let loggelf;
let processlock;
let queueWorkers = {};

const LOCK_EXPIRE_TTL = 5;
const LOCK_RENEW_TTL = 2;

let FORCE_DISABLE = false;
const processId = crypto.randomBytes(8).toString('hex');
let isCurrentWorker = false;
let liveIndexingQueue;

const FORCE_DISABLED_MESSAGE = 'Can not set up change streams. Not a replica set. Changes are not indexed to ElasticSearch.';

class Indexer {
    constructor() {
        this.running = false;
    }

    async start() {
        if (this.running) {
            return;
        }
        this.running = true;
        log.info('Indexer', 'Starting indexer');

        this.monitorChanges()
            .then()
            .catch(err => {
                log.error('Indexer', 'Indexing failed error=%s', err.message);
            })
            .finally(() => {
                this.running = false;
            });
    }
    async stop() {
        if (!this.running) {
            return;
        }
        this.running = false;
        log.info('Indexer', 'Stopping indexer');
        try {
            if (this.changeStream && !this.changeStream.closed) {
                await this.changeStream.close();
            }
        } catch (err) {
            // ignore
        }
    }

    async processJobEntry(entry) {
        let payload;

        if (!entry.user) {
            // nothing to do here
            return;
        }

        switch (entry.command) {
            case 'EXISTS':
                payload = {
                    action: 'new',
                    message: entry.message.toString(),
                    mailbox: entry.mailbox.toString(),
                    uid: entry.uid,
                    modseq: entry.modseq,
                    user: entry.user.toString()
                };
                break;
            case 'EXPUNGE':
                payload = {
                    action: 'delete',
                    message: entry.message.toString(),
                    mailbox: entry.mailbox.toString(),
                    uid: entry.uid,
                    modseq: entry.modseq,
                    user: entry.user.toString()
                };
                break;
            case 'FETCH':
                payload = {
                    action: 'update',
                    message: entry.message.toString(),
                    mailbox: entry.mailbox.toString(),
                    uid: entry.uid,
                    flags: entry.flags,
                    modseq: entry.modseq,
                    user: entry.user.toString()
                };
                break;
        }

        if (payload) {
            let hasFeatureFlag =
                (config.enabledFeatureFlags && config.enabledFeatureFlags.indexer) || (await db.redis.sismember(`feature:indexing`, entry.user.toString()));

            if (!hasFeatureFlag) {
                log.silly('Indexer', `Feature flag not set, skipping user=%s command=%s message=%s`, entry.user, entry.command, entry.message);
                return;
            } else {
                log.verbose('Indexer', `Feature flag set, processing user=%s command=%s message=%s`, entry.user, entry.command, entry.message);
            }

            await liveIndexingQueue.add('journal', payload, {
                removeOnComplete: 100,
                removeOnFail: 100,
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 2000
                }
            });
        }
    }

    async monitorChanges() {
        if (FORCE_DISABLE) {
            log.error('Indexer', FORCE_DISABLED_MESSAGE);
            return;
        }

        const pipeline = [
            {
                $match: {
                    operationType: 'insert'
                }
            }
        ];

        const collection = db.database.collection('journal');
        let opts = {
            allowDiskUse: true
        };

        let lastId = await db.redis.get('indexer:last');
        if (lastId) {
            opts.resumeAfter = {
                _data: lastId
            };
        }

        this.changeStream = collection.watch(pipeline, opts);

        try {
            while (await this.changeStream.hasNext()) {
                if (!this.running) {
                    return;
                }

                let job = await this.changeStream.next();

                try {
                    if (job.fullDocument && job.fullDocument.command) {
                        await this.processJobEntry(job.fullDocument);
                    }

                    await db.redis.set('indexer:last', job._id._data);
                } catch (error) {
                    try {
                        await this.stop();
                    } catch (err) {
                        // ignore
                    }
                    throw error;
                }
            }
        } catch (error) {
            if (error.code === 40573) {
                // not a replica set!
                FORCE_DISABLE = true;
                log.error('Indexer', FORCE_DISABLED_MESSAGE);
                return;
            }

            if (error.errorLabels && error.errorLabels.includes('NonResumableChangeStreamError')) {
                // can't resume previous cursor
                await db.redis.del('indexer:last');
                log.info('Indexer', 'Can not resume existing cursor');
                return;
            }

            if (this.changeStream && this.changeStream.closed) {
                log.info('Indexer', 'The change stream is closed. Will not wait on any more changes.');
                return;
            } else {
                try {
                    await this.stop();
                } catch (err) {
                    // ignore
                }
                throw error;
            }
        }
    }
}

let indexer = new Indexer();

async function renewLock() {
    try {
        let lockSuccess = await processlock('indexer:lock', processId, LOCK_EXPIRE_TTL);
        isCurrentWorker = !!lockSuccess;
    } catch (err) {
        log.error('Indexer', 'Failed to get lock process=%s err=%s', processId, err.message);
        isCurrentWorker = false;
    }

    if (!isCurrentWorker) {
        await indexer.stop();
    } else {
        await indexer.start();
    }
}

async function getLock() {
    let renewTimer;
    let keepLock = () => {
        clearTimeout(renewTimer);
        renewTimer = setTimeout(() => {
            renewLock().finally(keepLock);
        }, LOCK_RENEW_TTL * 1000);
    };

    renewLock().finally(keepLock);
}

function removeEmptyKeys(obj) {
    for (let key of Object.keys(obj)) {
        if (obj[key] === null) {
            delete obj[key];
        }
    }
    return obj;
}

function formatAddresses(addresses) {
    let result = [];
    for (let address of [].concat(addresses || [])) {
        if (address.group) {
            result = result.concat(formatAddresses(address.group));
        } else {
            let name = address.name || '';
            let addr = address.address || '';
            try {
                name = libmime.decodeWords(name);
            } catch (err) {
                // ignore?
            }

            if (/@xn--/.test(addr)) {
                addr = addr.substr(0, addr.lastIndexOf('@') + 1) + punycode.toUnicode(addr.substr(addr.lastIndexOf('@') + 1));
            }

            result.push({ name, address: addr });
        }
    }
    return result;
}

function indexingJob(esclient) {
    return async job => {
        try {
            if (!job || !job.data) {
                return false;
            }
            const data = job.data;

            const dateKeyTdy = new Date().toISOString().substring(0, 10).replace(/-/g, '');
            const dateKeyYdy = new Date(Date.now() - 24 * 3600 * 1000).toISOString().substring(0, 10).replace(/-/g, '');
            const tombstoneTdy = `indexer:tomb:${dateKeyTdy}`;
            const tombstoneYdy = `indexer:tomb:${dateKeyYdy}`;

            switch (data.action) {
                case 'new': {
                    // check tombstone for race conditions (might be already deleted)

                    let [[err1, isDeleted1], [err2, isDeleted2]] = await db.redis
                        .multi()
                        .sismember(tombstoneTdy, data.message)
                        .sismember(tombstoneYdy, data.message)
                        .exec();

                    if (err1) {
                        log.verbose('Indexing', 'Failed checking tombstone key=%s error=%s', tombstoneTdy, err1.message);
                    }

                    if (err2) {
                        log.verbose('Indexing', 'Failed checking tombstone key=%s error=%s', tombstoneYdy, err2.message);
                    }

                    if (isDeleted1 || isDeleted2) {
                        log.info('Indexing', 'Document tombstone found, skip index message=%s', data.message);
                        break;
                    }

                    // fetch message from DB
                    let messageData = await db.database.collection('messages').findOne(
                        {
                            _id: new ObjectId(data.message),
                            // shard key
                            mailbox: new ObjectId(data.mailbox),
                            uid: data.uid
                        },
                        {
                            projection: {
                                bodystructure: false,
                                envelope: false,
                                'mimeTree.childNodes': false,
                                'mimeTree.header': false
                            }
                        }
                    );

                    if (!messageData) {
                        log.info('Indexing', 'Message not found from DB, skip index message=%s', data.message);
                        break;
                    }

                    const now = messageData._id.getTimestamp();

                    const messageObj = removeEmptyKeys({
                        user: messageData.user.toString(),
                        mailbox: messageData.mailbox.toString(),

                        thread: messageData.thread ? messageData.thread.toString() : null,
                        uid: messageData.uid,
                        answered: messageData.flags ? messageData.flags.includes('\\Answered') : null,

                        ha: (messageData.attachments && messageData.attachments.length > 0) || false,

                        attachments:
                            (messageData.attachments &&
                                messageData.attachments.map(attachment =>
                                    removeEmptyKeys({
                                        cid: attachment.cid || null,
                                        contentType: attachment.contentType || null,
                                        size: attachment.size,
                                        filename: attachment.filename,
                                        id: attachment.id,
                                        disposition: attachment.disposition
                                    })
                                )) ||
                            null,

                        bcc: formatAddresses(messageData.mimeTree && messageData.mimeTree.parsedHeader && messageData.mimeTree.parsedHeader.bcc),
                        cc: formatAddresses(messageData.mimeTree && messageData.mimeTree.parsedHeader && messageData.mimeTree.parsedHeader.cc),

                        // Time when stored
                        created: now.toISOString(),

                        // Internal Date
                        idate: (messageData.idate && messageData.idate.toISOString()) || now.toISOString(),

                        // Header Date
                        hdate: (messageData.hdate && messageData.hdate.toISOString()) || now.toISOString(),

                        draft: messageData.flags ? messageData.flags.includes('\\Draft') : null,

                        flagged: messageData.flags ? messageData.flags.includes('\\Flagged') : null,

                        flags: messageData.flags || [],

                        from: formatAddresses(messageData.mimeTree && messageData.mimeTree.parsedHeader && messageData.mimeTree.parsedHeader.from),

                        // do not index authentication and transport headers
                        headers: messageData.headers
                            ? messageData.headers.filter(header => !/^x|^received|^arc|^dkim|^authentication/gi.test(header.key))
                            : null,

                        inReplyTo: messageData.inReplyTo || null,

                        msgid: messageData.msgid || null,

                        replyTo: formatAddresses(messageData.mimeTree && messageData.mimeTree.parsedHeader && messageData.mimeTree.parsedHeader['reply-to']),

                        size: messageData.size || null,

                        subject: messageData.subject || '',

                        to: formatAddresses(messageData.mimeTree && messageData.mimeTree.parsedHeader && messageData.mimeTree.parsedHeader.to),

                        unseen: messageData.flags ? !messageData.flags.includes('\\Seen') : null,

                        html: (messageData.html && messageData.html.join('\n')) || null,

                        text: messageData.text || null,

                        modseq: data.modseq
                    });

                    let indexResponse = await esclient.index({
                        id: messageData._id.toString(),
                        index: config.elasticsearch.index,
                        body: messageObj,
                        refresh: false
                    });

                    log.verbose(
                        'Indexing',
                        'Document index result=%s message=%s',
                        indexResponse.body && indexResponse.body.result,
                        indexResponse.body && indexResponse.body._id
                    );

                    loggelf({
                        short_message: '[INDEXER]',
                        _mail_action: `indexer_${data.action}`,
                        _user: data.user,
                        _mailbox: data.mailbox,
                        _uid: data.uid,
                        _modseq: data.modseq,
                        _indexer_result: indexResponse.body && indexResponse.body.result,
                        _indexer_message: indexResponse.body && indexResponse.body._id
                    });

                    break;
                }

                case 'delete': {
                    let deleteResponse;
                    try {
                        deleteResponse = await esclient.delete({
                            id: data.message,
                            index: config.elasticsearch.index,
                            refresh: false
                        });
                    } catch (err) {
                        if (err.meta && err.meta.body && err.meta.body.result === 'not_found') {
                            // set tombstone to prevent indexing this message in case of race conditions
                            await db.redis
                                .multi()
                                .sadd(tombstoneTdy, data.message)
                                .expire(tombstoneTdy, 24 * 3600)
                                .exec();
                        }
                        throw err;
                    }

                    log.verbose(
                        'Indexing',
                        'Document delete result=%s message=%s',
                        deleteResponse.body && deleteResponse.body.result,
                        deleteResponse.body && deleteResponse.body._id
                    );

                    loggelf({
                        short_message: '[INDEXER]',
                        _mail_action: `indexer_${data.action}`,
                        _user: data.user,
                        _mailbox: data.mailbox,
                        _uid: data.uid,
                        _modseq: data.modseq,
                        _indexer_result: deleteResponse.body && deleteResponse.body.result,
                        _indexer_message: deleteResponse.body && deleteResponse.body._id
                    });
                    break;
                }

                case 'update': {
                    let updateRequest = {
                        id: data.message,
                        index: config.elasticsearch.index,
                        refresh: false
                    };

                    if (data.modseq && typeof data.modseq === 'number') {
                        updateRequest.body = {
                            script: {
                                lang: 'painless',
                                source: `
                                    if( ctx._source.modseq >= params.modseq) {
                                        ctx.op = 'none';
                                    } else {
                                        ctx._source.draft = params.draft;
                                        ctx._source.flagged = params.flagged;
                                        ctx._source.flags = params.flags;
                                        ctx._source.unseen = params.unseen;
                                        ctx._source.modseq = params.modseq;
                                    }
                                `,
                                params: {
                                    modseq: data.modseq,
                                    draft: data.flags.includes('\\Draft'),
                                    flagged: data.flags.includes('\\Flagged'),
                                    flags: data.flags || [],
                                    unseen: !data.flags.includes('\\Seen')
                                }
                            }
                        };
                    } else {
                        updateRequest.body = {
                            doc: removeEmptyKeys({
                                draft: data.flags ? data.flags.includes('\\Draft') : null,
                                flagged: data.flags ? data.flags.includes('\\Flagged') : null,
                                flags: data.flags || [],
                                unseen: data.flags ? !data.flags.includes('\\Seen') : null
                            })
                        };
                    }

                    let updateResponse = await esclient.update(updateRequest);

                    log.verbose(
                        'Indexing',
                        'Document update result=%s message=%s',
                        updateResponse.body && updateResponse.body.result,
                        updateResponse.body && updateResponse.body._id
                    );

                    loggelf({
                        short_message: '[INDEXER]',
                        _mail_action: `indexer_${data.action}`,
                        _user: data.user,
                        _mailbox: data.mailbox,
                        _uid: data.uid,

                        _modseq: data.modseq,
                        _flags: data.flags && data.flags.join(', '),
                        _indexer_result: updateResponse.body && updateResponse.body.result,
                        _indexer_message: updateResponse.body && updateResponse.body._id
                    });
                }
            }

            // loggelf({ _msg: 'hello world' });
        } catch (err) {
            if (err.meta && err.meta.body && err.meta.body.result === 'not_found') {
                // missing document, ignore
                log.error('Indexing', 'Failed to process indexing request, document not found message=%s', err.meta.body._id);
                return;
            }

            log.error('Indexing', err);

            const data = job.data;
            loggelf({
                short_message: '[INDEXER]',
                _mail_action: `indexer_${data.action}`,
                _user: data.user,
                _mailbox: data.mailbox,
                _uid: data.uid,
                _modseq: data.modseq,
                _indexer_message: err.meta && err.meta.body && err.meta.body._id,
                _error: err.message,
                _err_code: err.meta && err.meta.body && err.meta.body.result
            });

            throw err;
        }
    };
}

module.exports.start = callback => {
    if (!config.elasticsearch || !config.elasticsearch.indexer || !config.elasticsearch.indexer.enabled) {
        return setImmediate(() => callback(null, false));
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

    db.connect(err => {
        if (err) {
            log.error('Db', 'Failed to setup database connection');
            errors.notify(err);
            return setTimeout(() => process.exit(1), 3000);
        }

        liveIndexingQueue = new Queue('live_indexing', db.queueConf);

        processlock = counters(db.redis).processlock;

        getLock().catch(err => {
            errors.notify(err);
            return setTimeout(() => process.exit(1), 3000);
        });

        const esclient = getClient();

        queueWorkers.liveIndexing = new Worker(
            'live_indexing',
            indexingJob(esclient),
            Object.assign(
                {
                    concurrency: 1
                },
                db.queueConf
            )
        );

        queueWorkers.backlogIndexing = new Worker(
            'backlog_indexing',
            indexingJob(esclient),
            Object.assign(
                {
                    concurrency: 1
                },
                db.queueConf
            )
        );

        callback();
    });
};
