'use strict';

const IMAPServerModule = require('../../imap-core');
const imapHandler = IMAPServerModule.imapHandler;
const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');
const LimitedFetch = require('../limited-fetch');

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

    db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        },
        (err, mailboxData) => {
            if (err) {
                return callback(err);
            }
            if (!mailboxData) {
                return callback(null, 'NONEXISTENT');
            }

            userCache.get(session.user.id, 'imapMaxDownload', { setting: 'const:max:imap:download' }, (err, limit) => {
                if (err) {
                    return callback(err);
                }

                messageHandler.counters.ttlcounter('idw:' + session.user.id, 0, limit, false, (err, res) => {
                    if (err) {
                        return callback(err);
                    }
                    if (!res.success) {
                        let err = new Error('Download was rate limited');
                        err.response = 'NO';
                        err.code = 'DownloadRateLimited';
                        err.ttl = res.ttl;
                        err.responseMessage = `Download was rate limited. Try again in ${tools.roundTime(res.ttl)}.`;
                        return callback(err);
                    }

                    let projection = {
                        _id: true,
                        uid: true,
                        thread: true,
                        modseq: true
                    };

                    if (options.flagsExist) {
                        projection.flags = true;
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

                    let isUpdated = false;
                    let updateEntries = [];
                    let notifyEntries = [];

                    let done = (...args) => {
                        if (updateEntries.length) {
                            return db.database.collection('messages').bulkWrite(
                                updateEntries,
                                {
                                    ordered: false,
                                    writeConcern: 1
                                },
                                () => {
                                    updateEntries = [];
                                    server.notifier.addEntries(mailboxData, notifyEntries, () => {
                                        notifyEntries = [];
                                        server.notifier.fire(session.user.id);
                                        return callback(...args);
                                    });
                                }
                            );
                        }
                        if (isUpdated) {
                            server.notifier.fire(session.user.id);
                        }
                        return callback(...args);
                    };

                    let lastUid = false;

                    let startTime = Date.now();
                    let rowCount = 0;
                    let totalBytes = 0;

                    // instead of fetching all messages at once from a large mailbox
                    // we page it into smaller queries
                    let processPage = () => {
                        let queryAll = false;

                        let pageQuery = Object.assign({}, query);

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
                        let processNext = () => {
                            cursor.next((err, messageData) => {
                                if (err) {
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
                                    return done(err);
                                }

                                try {
                                    // stop processing if IMAP socket is not open anymore
                                    tools.checkSocket(socket);
                                } catch (err) {
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
                                    return done(err);
                                }

                                if (!messageData) {
                                    return cursor.close(() => {
                                        if (processedCount === consts.CURSOR_MAX_PAGE_SIZE) {
                                            //  might have more entries, check next page
                                            return setTimeout(processPage, 10);
                                        }

                                        server.logger.debug(
                                            {
                                                tnx: 'fetch',
                                                cid: session.id
                                            },
                                            '[%s] FETCHOK rows=%s user=%s mailbox=%s time=%s',
                                            session.id,
                                            rowCount,
                                            mailboxData.user,
                                            mailboxData._id,
                                            (Date.now() - startTime) / 1000
                                        );

                                        done(null, true, {
                                            rowCount,
                                            totalBytes
                                        });
                                    });
                                }

                                processedCount++;
                                lastUid = messageData.uid;

                                if (queryAll && !session.selected.uidList.includes(messageData.uid)) {
                                    // skip processing messages that we do not know about yet
                                    return processNext();
                                }

                                let markAsSeen = options.markAsSeen && !messageData.flags.includes('\\Seen');
                                if (markAsSeen) {
                                    messageData.flags.unshift('\\Seen');
                                }

                                if (options.metadataOnly && !markAsSeen) {
                                    // quick response
                                    const data = session.formatResponse('FETCH', messageData.uid, {
                                        query: options.query,
                                        values: session.getQueryResponse(options.query, messageData, {
                                            logger: server.logger,
                                            fetchOptions: {},
                                            database: db.database,
                                            attachmentStorage: messageHandler.attachmentStorage,
                                            acceptUTF8Enabled: session.isUTF8Enabled()
                                        })
                                    });

                                    const compiled = imapHandler.compiler(data);

                                    // `compiled` is a 'binary' string
                                    totalBytes += compiled.length;
                                    session.writeStream.write({ compiled });

                                    rowCount++;
                                    return setImmediate(processNext);
                                }

                                let stream = imapHandler.compileStream(
                                    session.formatResponse('FETCH', messageData.uid, {
                                        query: options.query,
                                        values: session.getQueryResponse(options.query, messageData, {
                                            logger: server.logger,
                                            fetchOptions: {},
                                            database: db.database,
                                            attachmentStorage: messageHandler.attachmentStorage,
                                            acceptUTF8Enabled: session.isUTF8Enabled()
                                        })
                                    })
                                );

                                rowCount++;

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
                                        rowCount,
                                        mailboxData.user,
                                        mailboxData._id,
                                        (Date.now() - startTime) / 1000,
                                        err.message
                                    );

                                    session.socket.end('\n* BYE Internal Server Error\n');
                                    return cursor.close(() =>
                                        done(err, false, {
                                            rowCount,
                                            totalBytes
                                        })
                                    );
                                });

                                let limiter = new LimitedFetch({
                                    key: 'idw:' + session.user.id,
                                    ttlcounter: messageHandler.counters.ttlcounter,
                                    maxBytes: limit
                                });
                                stream.pipe(limiter);

                                limiter._uid = messageData.uid;
                                limiter._message = messageData._id;
                                limiter._mailbox = mailbox;

                                // send formatted response to socket
                                session.writeStream.write(limiter, () => {
                                    totalBytes += limiter.bytes;

                                    if (!markAsSeen) {
                                        return processNext();
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

                                    notifyEntries.push({
                                        command: 'FETCH',
                                        ignore: session.id,
                                        uid: messageData.uid,
                                        flags: messageData.flags,
                                        thread: messageData.thread,
                                        message: messageData._id,
                                        unseenChange: true
                                    });

                                    if (updateEntries.length >= consts.BULK_BATCH_SIZE) {
                                        return db.database.collection('messages').bulkWrite(
                                            updateEntries,
                                            {
                                                ordered: false,
                                                writeConcern: 1
                                            },
                                            err => {
                                                updateEntries = [];
                                                if (err) {
                                                    return cursor.close(() =>
                                                        done(err, false, {
                                                            rowCount,
                                                            totalBytes
                                                        })
                                                    );
                                                }

                                                server.notifier.addEntries(mailboxData, notifyEntries, () => {
                                                    notifyEntries = [];
                                                    server.notifier.fire(session.user.id);
                                                    processNext();
                                                });
                                            }
                                        );
                                    } else {
                                        processNext();
                                    }
                                });
                            });
                        };

                        processNext();
                    };

                    processPage();
                });
            });
        }
    );
};
