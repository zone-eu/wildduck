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
const { normalizeLoggelfMessage } = require('./lib/loggelf-message');
const {
    MESSAGE_INDEXING_QUEUE,
    LIVE_INDEXING_PRIORITY,
    createSyncToken,
    createSyncJobData,
    enqueueMessageSync,
    getSyncStateKey
} = require('./lib/indexing-queue');

let loggelf;
let processlock;
let queueWorkers = {};

const LOCK_EXPIRE_TTL = 5;
const LOCK_RENEW_TTL = 2;

let FORCE_DISABLE = false;
const processId = crypto.randomBytes(8).toString('hex');
let isCurrentWorker = false;
let messageIndexingQueue;

const FORCE_DISABLED_MESSAGE = 'Can not set up change streams. Not a replica set. Changes are not indexed to ElasticSearch.';
const MAX_SYNC_PASSES = 5;
const CLEAR_SYNC_STATE_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
    end
    return 0
`;

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
        if (!entry.user) {
            // nothing to do here
            return;
        }

        if (!['EXISTS', 'EXPUNGE', 'FETCH'].includes(entry.command) || !entry.message) {
            return;
        }

        let hasFeatureFlag =
            (config.enabledFeatureFlags && config.enabledFeatureFlags.indexer) || (await db.redis.sismember(`feature:indexing`, entry.user.toString()));

        if (!hasFeatureFlag) {
            log.silly('Indexer', `Feature flag not set, skipping user=%s command=%s message=%s`, entry.user, entry.command, entry.message);
            return;
        } else {
            log.verbose('Indexer', `Feature flag set, processing user=%s command=%s message=%s`, entry.user, entry.command, entry.message);
        }

        await enqueueMessageSync(
            messageIndexingQueue,
            db.redis,
            {
                message: entry.message,
                mailbox: entry.mailbox,
                uid: entry.uid,
                modseq: entry.modseq,
                user: entry.user
            },
            LIVE_INDEXING_PRIORITY
        );
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

function normalizeJobData(data) {
    if (!data || !data.message) {
        return false;
    }

    if (!data.action || data.action === 'sync') {
        return createSyncJobData(data);
    }

    if (['new', 'update', 'delete'].includes(data.action)) {
        return createSyncJobData(data);
    }

    return false;
}

function buildMessageObject(messageData) {
    const now = messageData._id.getTimestamp();

    return removeEmptyKeys({
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
        headers: messageData.headers ? messageData.headers.filter(header => !/^x|^received|^arc|^dkim|^authentication/gi.test(header.key)) : null,

        inReplyTo: messageData.inReplyTo || null,

        msgid: messageData.msgid || null,

        replyTo: formatAddresses(messageData.mimeTree && messageData.mimeTree.parsedHeader && messageData.mimeTree.parsedHeader['reply-to']),

        size: messageData.size || null,

        subject: messageData.subject || '',

        to: formatAddresses(messageData.mimeTree && messageData.mimeTree.parsedHeader && messageData.mimeTree.parsedHeader.to),

        unseen: messageData.flags ? !messageData.flags.includes('\\Seen') : null,

        html: (messageData.html && messageData.html.join('\n')) || null,

        text: messageData.text || null,

        modseq: Number.isFinite(messageData.modseq) ? messageData.modseq : null
    });
}

async function loadMessageForSync(data) {
    const messageId = new ObjectId(data.message);
    const query = {
        _id: messageId
    };

    if (data.mailbox && ObjectId.isValid(data.mailbox)) {
        query.mailbox = new ObjectId(data.mailbox);
    }

    if (Number.isFinite(data.uid)) {
        query.uid = data.uid;
    }

    let messageData = await db.database.collection('messages').findOne(query, {
        projection: {
            bodystructure: false,
            envelope: false,
            'mimeTree.childNodes': false,
            'mimeTree.header': false
        }
    });

    if (!messageData && (query.mailbox || Number.isFinite(query.uid))) {
        messageData = await db.database.collection('messages').findOne(
            {
                _id: messageId
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
    }

    return messageData;
}

async function indexMessage(esclient, messageData) {
    const messageObj = buildMessageObject(messageData);
    const indexRequest = {
        id: messageData._id.toString(),
        index: config.elasticsearch.index,
        body: messageObj,
        refresh: false
    };

    if (Number.isFinite(messageObj.modseq) && messageObj.modseq > 0) {
        indexRequest.version = messageObj.modseq;
        indexRequest.version_type = 'external_gte';
    }

    let indexResponse = await esclient.index(indexRequest);

    log.verbose('Indexing', 'Document sync result=%s message=%s', indexResponse.body && indexResponse.body.result, indexResponse.body && indexResponse.body._id);

    loggelf({
        short_message: '[INDEXER]',
        _mail_action: 'indexer_sync',
        _user: messageObj.user,
        _mailbox: messageObj.mailbox,
        _uid: messageObj.uid,
        _modseq: messageObj.modseq,
        _indexer_result: indexResponse.body && indexResponse.body.result,
        _indexer_message: indexResponse.body && indexResponse.body._id
    });
}

async function deleteMessage(esclient, data) {
    let deleteResponse;
    try {
        deleteResponse = await esclient.delete({
            id: data.message,
            index: config.elasticsearch.index,
            refresh: false
        });
    } catch (err) {
        if (err.meta && err.meta.body && err.meta.body.result === 'not_found') {
            log.verbose('Indexing', 'Document already deleted message=%s', data.message);
            return;
        }

        throw err;
    }

    log.verbose('Indexing', 'Document delete result=%s message=%s', deleteResponse.body && deleteResponse.body.result, deleteResponse.body && deleteResponse.body._id);

    loggelf({
        short_message: '[INDEXER]',
        _mail_action: 'indexer_sync_delete',
        _user: data.user,
        _mailbox: data.mailbox,
        _uid: data.uid,
        _modseq: data.modseq,
        _indexer_result: deleteResponse.body && deleteResponse.body.result,
        _indexer_message: deleteResponse.body && deleteResponse.body._id
    });
}

async function clearSyncState(stateKey, version) {
    return db.redis.eval(CLEAR_SYNC_STATE_SCRIPT, 1, stateKey, version);
}

function indexingJob(esclient) {
    return async job => {
        try {
            if (!job || !job.data) {
                return false;
            }
            const data = normalizeJobData(job.data);
            if (!data) {
                return false;
            }

            const stateKey = getSyncStateKey(data.message);
            let pass = 0;

            while (pass < MAX_SYNC_PASSES) {
                pass++;

                const startVersion = (await db.redis.get(stateKey)) || createSyncToken();
                const messageData = await loadMessageForSync(data);

                if (messageData) {
                    await indexMessage(esclient, messageData);
                } else {
                    await deleteMessage(esclient, data);
                }

                const latestVersion = await db.redis.get(stateKey);
                if (!latestVersion) {
                    return true;
                }

                if (latestVersion !== startVersion) {
                    log.verbose('Indexing', 'Document changed during sync, retrying message=%s from=%s to=%s', data.message, startVersion, latestVersion);
                    continue;
                }

                const cleared = await clearSyncState(stateKey, startVersion);
                if (cleared) {
                    return true;
                }
            }

            let err = new Error(`Failed to settle indexing sync for message ${data.message}`);
            err.code = 'IndexingSyncUnsettled';
            throw err;
        } catch (err) {
            log.error('Indexing', err);

            const data = normalizeJobData(job.data) || job.data;
            loggelf({
                short_message: '[INDEXER]',
                _mail_action: 'indexer_sync',
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

        messageIndexingQueue = new Queue(MESSAGE_INDEXING_QUEUE, db.queueConf);

        processlock = counters(db.redis).processlock;

        getLock().catch(err => {
            errors.notify(err);
            return setTimeout(() => process.exit(1), 3000);
        });

        const esclient = getClient();

        queueWorkers.messageIndexing = new Worker(
            MESSAGE_INDEXING_QUEUE,
            indexingJob(esclient),
            {
                concurrency: Math.max(1, Number(config.elasticsearch.indexer.concurrency) || 10),
                ...db.queueConf
            }
        );

        // Drain legacy queue names during rollout. New jobs are enqueued into MESSAGE_INDEXING_QUEUE.
        queueWorkers.liveIndexingLegacy = new Worker(
            'live_indexing',
            indexingJob(esclient),
            {
                concurrency: 1,
                ...db.queueConf
            }
        );

        queueWorkers.backlogIndexing = new Worker(
            'backlog_indexing',
            indexingJob(esclient),
            {
                concurrency: 1,
                ...db.queueConf
            }
        );

        callback();
    });
};
