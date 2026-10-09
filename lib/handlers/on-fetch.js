'use strict';

const { setTimeout: sleep } = require('timers/promises');
const IMAPServerModule = require('../../imap-core');
const imapHandler = IMAPServerModule.imapHandler;
const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');
const LimitedFetch = require('../limited-fetch');
const { getLabelMaps, getMessageImapFlags, labelNamesForMessage } = require('../label-handler');
const metrics = require('../metrics');

module.exports = (server, messageHandler, userCache) => (mailbox, options, session, callback) => {
    server.logger.debug(
        {
            tnx: 'fetch',
            cid: session.id
        },
        '[%s] Requested FETCH for "%s"',
        session.id,
        mailbox
    );
    const socket = (session.socket && session.socket._parent) || session.socket;

    try {
        tools.checkSocket(socket);
    } catch (err) {
        return callback(err);
    }

    const info = {
        rowCount: 0,
        totalBytes: 0
    };

    fetch(server, messageHandler, userCache, mailbox, options, session, socket, info).then(
        result => callback(null, result, result === true ? info : undefined),
        err => callback(err, false, info)
    );
};

// Resolves with true once every requested message is written, or with a response code
async function fetch(server, messageHandler, userCache, mailbox, options, session, socket, info) {
    let mailboxData = await db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (!mailboxData) {
        return 'NONEXISTENT';
    }

    let limit = await userCache.getAsync(session.user.id, 'imapMaxDownload', { setting: 'const:max:imap:download' });

    let res = await messageHandler.counters.asyncTTLCounter('idw:' + session.user.id, 0, limit, false);
    if (!res.success) {
        let err = new Error('Download was rate limited');
        err.response = 'NO';
        err.code = 'DownloadRateLimited';
        err.ttl = res.ttl;
        err.responseMessage = `Download was rate limited. Try again in ${tools.roundTime(res.ttl)}.`;
        throw err;
    }

    let projection = {
        _id: true,
        uid: true,
        thread: true,
        modseq: true
    };

    if (options.flagsExist || options.markAsSeen) {
        projection.flags = true;
        projection.labels = true;
    }

    if (options.idateExist) {
        projection.idate = true;
    }

    if (options.bodystructureExist) {
        projection.bodystructure = true;
    }

    if (options.rfc822sizeExist) {
        projection.size = true;
    }

    if (options.envelopeExist) {
        projection.envelope = true;
    }

    if (!options.metadataOnly) {
        projection.mimeTree = true;
    }

    let query = {
        mailbox: mailboxData._id
    };

    if (options.changedSince) {
        query = {
            mailbox: mailboxData._id,
            modseq: {
                $gt: options.changedSince
            }
        };
    }

    let labelMaps = { byId: new Map() };
    if (options.flagsExist || options.markAsSeen) {
        const labelQuery = { ...query };
        if (options.messages.length !== session.selected.uidList.length) {
            labelQuery.uid = tools.checkRangeQuery(options.messages, false);
        }
        const labelIds = await db.database.collection('messages').distinct('labels', labelQuery, { maxTimeMS: consts.DB_MAX_TIME_MESSAGES });
        if (labelIds.length) {
            labelMaps = await getLabelMaps(db.database, mailboxData.user, { ids: labelIds });
        }
    }

    let isUpdated = false;
    let updateEntries = [];
    let notifyEntries = [];

    // writes the collected \Seen updates, journals them and notifies the user
    const flushUpdates = async ({ ignoreErrors = false } = {}) => {
        if (!updateEntries.length) {
            return false;
        }

        let entries = updateEntries;
        updateEntries = [];

        try {
            await db.database.collection('messages').bulkWrite(entries, {
                ordered: false,
                writeConcern: 1
            });
        } catch (err) {
            if (!ignoreErrors) {
                throw err;
            }
        }

        try {
            await server.notifier.addEntriesAsync(mailboxData, notifyEntries);
        } catch {
            // the flags are updated, only the journal entries are missing
        }
        notifyEntries = [];
        server.notifier.fire(session.user.id);
        return true;
    };

    const logFetchError = (err, pageQuery) => {
        server.logger.error(
            {
                tnx: 'fetch',
                cid: session.id,
                err
            },
            '[%s] FETCHERR error=%s query=%s',
            session.id,
            err.message,
            JSON.stringify(pageQuery)
        );
        if (typeof server.loggelf === 'function') {
            server.loggelf({
                short_message: '[FETCHERR] ' + (err && err.message ? err.message : 'Fetch error'),
                full_message: err && err.stack,
                _error: err && err.message,
                _code: err && err.code,
                _tnx: 'fetch',
                _sess: session.id,
                _user: session.user && session.user.id,
                _mailbox: mailboxData && mailboxData._id,
                _mailbox_path: mailboxData && mailboxData.path,
                _query: JSON.stringify(pageQuery)
            });
        }
    };

    const fetchOptions = () => ({
        logger: server.logger,
        fetchOptions: {},
        database: db.database,
        attachmentStorage: messageHandler.attachmentStorage,
        acceptUTF8Enabled: session.isUTF8Enabled()
    });

    let lastUid = false;
    let startTime = Date.now();
    let pageQuery;

    try {
        // instead of fetching all messages at once from a large mailbox
        // we page it into smaller queries
        for (;;) {
            let queryAll = false;

            pageQuery = Object.assign({}, query);

            if (options.messages.length !== session.selected.uidList.length) {
                // do not use uid selector for 1:*
                pageQuery.uid = tools.checkRangeQuery(options.messages, false);
            } else {
                // 1:*
                queryAll = true;
            }

            if (lastUid) {
                if (!pageQuery.uid) {
                    pageQuery.uid = { $gt: lastUid };
                } else {
                    pageQuery.$and = [
                        {
                            uid: pageQuery.uid
                        },
                        { uid: { $gt: lastUid } }
                    ];
                }
            }

            let sort = { uid: 1 };
            let cursor = db.database
                .collection('messages')
                .find(pageQuery)
                .project(projection)
                .sort(sort)
                .limit(consts.CURSOR_MAX_PAGE_SIZE)
                .withReadPreference('secondaryPreferred')
                .maxTimeMS(consts.DB_MAX_TIME_MESSAGES);

            let limitedKeys = ['_id', 'flags', 'modseq', 'uid'];
            if (!Object.keys(projection).some(key => !limitedKeys.includes(key))) {
                // limited query, use extra large batch size
                cursor = cursor.batchSize(1000);
            }

            let processedCount = 0;
            try {
                for await (let messageData of cursor) {
                    // stop processing if IMAP socket is not open anymore
                    tools.checkSocket(socket);

                    processedCount++;
                    lastUid = messageData.uid;

                    if (queryAll && !session.selected.uidList.includes(messageData.uid)) {
                        // skip processing messages that we do not know about yet
                        continue;
                    }

                    if (options.flagsExist || options.markAsSeen) {
                        messageData.flags = getMessageImapFlags(messageData, labelMaps.byId);
                    }

                    let markAsSeen = options.markAsSeen && !messageData.flags.includes('\\Seen');
                    if (markAsSeen) {
                        messageData.flags.unshift('\\Seen');
                    }

                    if (options.metadataOnly && !markAsSeen) {
                        // quick response
                        const data = session.formatResponse('FETCH', messageData.uid, {
                            query: options.query,
                            values: session.getQueryResponse(options.query, messageData, fetchOptions())
                        });

                        const compiled = imapHandler.compiler(data);

                        // `compiled` is a 'binary' string
                        info.totalBytes += compiled.length;
                        session.writeStream.write({ compiled });

                        info.rowCount++;
                        continue;
                    }

                    let stream = imapHandler.compileStream(
                        session.formatResponse('FETCH', messageData.uid, {
                            query: options.query,
                            values: session.getQueryResponse(options.query, messageData, fetchOptions())
                        })
                    );

                    info.rowCount++;

                    stream.on('literalMismatch', mismatch => {
                        // the literal was padded or cut to its announced length, so the client
                        // did not get the stored message. Always a bug in the rebuild, never expected
                        let fetchItems = imapHandler.compiler({ attributes: options.query.map(item => item.original) }, false, true).trim();
                        server.logger.error(
                            {
                                tnx: 'fetch',
                                cid: session.id,
                                mid: messageData._id
                            },
                            '[%s] LITERALMISMATCH message=%s uid=%s kind=%s expected=%s received=%s query=%s',
                            session.id,
                            messageData._id,
                            messageData.uid,
                            mismatch.kind,
                            mismatch.expected,
                            mismatch.received,
                            fetchItems
                        );
                        if (typeof server.loggelf === 'function') {
                            server.loggelf({
                                short_message: '[LITERALMISMATCH] FETCH literal ' + mismatch.kind,
                                _mail_action: 'literal_length_mismatch',
                                _tnx: 'fetch',
                                _sess: session.id,
                                _user: session.user && session.user.id,
                                _mailbox: mailboxData && mailboxData._id,
                                _mailbox_path: mailboxData && mailboxData.path,
                                _message: messageData._id,
                                _uid: messageData.uid,
                                _kind: mismatch.kind,
                                _expected: mismatch.expected,
                                _received: mismatch.received,
                                _query: fetchItems
                            });
                        }
                        metrics.recordImapLiteralMismatch(mismatch.kind);
                    });

                    // a failed message source ends the FETCH, the connection is dropped
                    let failed = new Promise((resolve, reject) =>
                        stream.once('error', err => {
                            err.processed = true;
                            server.logger.error(
                                {
                                    err,
                                    tnx: 'fetch',
                                    cid: session.id,
                                    mid: messageData._id
                                },
                                '[%s] FETCHFAIL message=%s rows=%s user=%s mailbox=%s time=%s error=%s',
                                session.id,
                                messageData._id,
                                info.rowCount,
                                mailboxData.user,
                                mailboxData._id,
                                (Date.now() - startTime) / 1000,
                                err.message
                            );
                            if (typeof server.loggelf === 'function') {
                                server.loggelf({
                                    short_message: '[FETCHFAIL] ' + (err && err.message ? err.message : 'Fetch failed'),
                                    full_message: err && err.stack,
                                    _error: err && err.message,
                                    _code: err && err.code,
                                    _tnx: 'fetch',
                                    _sess: session.id,
                                    _user: session.user && session.user.id,
                                    _mailbox: mailboxData && mailboxData._id,
                                    _mailbox_path: mailboxData && mailboxData.path,
                                    _message: messageData && messageData._id,
                                    _uid: messageData && messageData.uid,
                                    _rows: info.rowCount
                                });
                            }

                            session.socket.end('\n* BYE Internal Server Error\n');
                            reject(err);
                        })
                    );

                    let limiter = new LimitedFetch({
                        key: 'idw:' + session.user.id,
                        ttlcounter: messageHandler.counters.ttlcounter,
                        maxBytes: limit
                    });
                    stream.pipe(limiter);
                    // a destroyed limiter (the client went away) must release the message stream too
                    limiter.once('close', () => stream.destroy());

                    limiter._uid = messageData.uid;
                    limiter._message = messageData._id;
                    limiter._mailbox = mailbox;

                    // send formatted response to socket
                    let written = new Promise(resolve => session.writeStream.write(limiter, resolve));
                    await Promise.race([written, failed]);

                    info.totalBytes += limiter.bytes;

                    if (!markAsSeen || (limiter.destroyed && !limiter.writableFinished)) {
                        // a message the client did not receive in full is not marked as seen
                        continue;
                    }

                    server.logger.debug(
                        {
                            tnx: 'flags',
                            cid: session.id
                        },
                        '[%s] UPDATE FLAGS message=%s',
                        session.id,
                        messageData.uid
                    );

                    isUpdated = true;

                    updateEntries.push({
                        updateOne: {
                            filter: {
                                _id: messageData._id,
                                // include sharding key in query
                                mailbox: mailboxData._id,
                                uid: messageData.uid
                            },
                            update: {
                                $addToSet: {
                                    flags: '\\Seen'
                                },
                                $set: {
                                    unseen: false
                                }
                            }
                        }
                    });

                    const notifyEntry = {
                        command: 'FETCH',
                        ignore: session.id,
                        uid: messageData.uid,
                        flags: messageData.flags,
                        thread: messageData.thread,
                        message: messageData._id,
                        unseenChange: true
                    };
                    const labels = labelNamesForMessage(messageData, labelMaps.byId);
                    if (labels.length) {
                        notifyEntry.labels = labels;
                    }
                    notifyEntries.push(notifyEntry);

                    if (updateEntries.length >= consts.BULK_BATCH_SIZE) {
                        await flushUpdates();
                    }
                }
            } finally {
                await cursor.close().catch(() => false);
            }

            if (processedCount === consts.CURSOR_MAX_PAGE_SIZE) {
                //  might have more entries, check next page
                await sleep(10);
                continue;
            }

            break;
        }

        server.logger.debug(
            {
                tnx: 'fetch',
                cid: session.id
            },
            '[%s] FETCHOK rows=%s user=%s mailbox=%s time=%s',
            session.id,
            info.rowCount,
            mailboxData.user,
            mailboxData._id,
            (Date.now() - startTime) / 1000
        );
    } catch (err) {
        if (!err.processed) {
            logFetchError(err, pageQuery);
        }
        throw err;
    } finally {
        // the \Seen flags collected so far are written even if the FETCH failed
        let flushed = await flushUpdates({ ignoreErrors: true });
        if (!flushed && isUpdated) {
            server.notifier.fire(session.user.id);
        }
    }

    return true;
}
