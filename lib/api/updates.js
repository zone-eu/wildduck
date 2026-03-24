'use strict';

const config = require('@zone-eu/wild-config');
const crypto = require('crypto');
const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const log = require('npmlog');
const tools = require('../tools');
const roles = require('../roles');
const base32 = require('base32.js');
const { sessSchema, sessIPSchema } = require('../schemas');
const { userId } = require('../schemas/request/general-schemas');

const getMailboxCounterCb = (db, mailbox, type, callback) => {
    tools
        .getMailboxCounter(db, mailbox, type)
        .then(sum => callback(null, sum))
        .catch(err => callback(err));
};

const hasUpdatesStreamLogging = !!(config.log && config.log.updateStream);

const formatLogValue = value => String(value);

const getJournalPayload = entry => {
    const data = {};
    Object.keys(entry).forEach(key => {
        if (!['_id', 'ignore', 'user', 'modseq', 'unseenChange', 'created'].includes(key)) {
            if (entry.command !== 'COUNTERS' && key === 'unseen') {
                return;
            }
            data[key] = entry[key];
        }
    });

    return data;
};

const stringifyJournalPayload = (entry, space) => JSON.stringify(getJournalPayload(entry), null, space);

const logUpdatesStream = (level, session, message, ...args) => {
    if (!hasUpdatesStreamLogging) {
        return;
    }

    log[level]('API', '[%s] ' + message, session.id, ...args);
};

const logUpdatesEvent = (session, source, entry) => {
    if (!hasUpdatesStreamLogging || !entry) {
        return;
    }

    const payload = stringifyJournalPayload(entry);

    if (entry.command === 'COUNTERS') {
        return log.verbose(
            'API',
            '[%s] action=updates-event source=%s user=%s event=%s eventId=%s mailbox=%s total=%s unseen=%s payload=%s',
            session.id,
            source,
            formatLogValue(session.user.id),
            entry.command,
            formatLogValue(entry._id),
            formatLogValue(entry.mailbox),
            formatLogValue(entry.total),
            formatLogValue(entry.unseen),
            payload
        );
    }

    log.verbose(
        'API',
        '[%s] action=updates-event source=%s user=%s event=%s eventId=%s mailbox=%s message=%s modseq=%s payload=%s',
        session.id,
        source,
        formatLogValue(session.user.id),
        formatLogValue(entry.command),
        formatLogValue(entry._id),
        formatLogValue(entry.mailbox),
        formatLogValue(entry.message),
        formatLogValue(entry.modseq),
        payload
    );
};

module.exports = (db, server, notifier) => {
    server.get(
        {
            path: '/users/:user/updates',
            tags: ['Users'],
            summary: 'Open change stream',
            name: 'getUpdates',
            description:
                'This api call returns an EventSource response. Listen on this stream to get notifications about changes in messages and mailboxes. Returned events are JSON encoded strings',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    'Last-Event-ID': Joi.string().hex().lowercase().length(24).description('Last event ID header as query param'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: { 200: { description: 'Success', model: Joi.string() } }
            },
            responseType: 'text/event-stream'
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            if (req.header('Last-Event-ID')) {
                req.params['Last-Event-ID'] = req.header('Last-Event-ID');
            }

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            // should the resource be something else than 'users'?
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let user = new ObjectId(result.value.user);
            let lastEventId = result.value['Last-Event-ID'] ? new ObjectId(result.value['Last-Event-ID']) : false;

            let userData;

            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            username: true,
                            address: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let session = {
                id: 'api.' + base32.encode(crypto.randomBytes(10)).toLowerCase(),
                user: {
                    id: userData._id,
                    username: userData.username
                }
            };

            let remoteAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
            let opened = Date.now();
            let closed = false;
            let idleTimer = false;
            let idleCounter = 0;

            let sendIdleComment = () => {
                clearTimeout(idleTimer);
                if (closed) {
                    return;
                }
                res.write(': idling ' + ++idleCounter + '\n\n');
                idleTimer = setTimeout(sendIdleComment, 15 * 1000);
            };

            let resetIdleComment = () => {
                clearTimeout(idleTimer);
                if (closed) {
                    return;
                }
                idleTimer = setTimeout(sendIdleComment, 15 * 1000);
            };

            let journalReading = false;
            let journalReader = message => {
                if (journalReading || closed) {
                    return;
                }

                if (message) {
                    try {
                        res.write(formatJournalData(message));
                        logUpdatesEvent(session, 'live', message);
                        resetIdleComment();
                    } catch (err) {
                        log.error(
                            'API',
                            '[%s] action=updates-event-write-fail source=live user=%s event=%s payload=%s error=%s',
                            session.id,
                            session.user.id.toString(),
                            formatLogValue(message.command),
                            stringifyJournalPayload(message),
                            err.stack || err
                        );
                    }
                    return;
                }

                journalReading = true;
                logUpdatesStream(
                    'verbose',
                    session,
                    'action=updates-replay-start user=%s lastEventId=%s',
                    session.user.id.toString(),
                    formatLogValue(lastEventId)
                );

                loadJournalStream(
                    db,
                    res,
                    user,
                    lastEventId,
                    (err, info) => {
                        if (err) {
                            logUpdatesStream(
                                'error',
                                session,
                                'action=updates-replay-error user=%s lastEventId=%s error=%s',
                                session.user.id.toString(),
                                formatLogValue(lastEventId),
                                err.message
                            );
                        }

                        lastEventId = info && info.lastEventId;
                        journalReading = false;

                        logUpdatesStream(
                            'verbose',
                            session,
                            'action=updates-replay-complete user=%s processed=%s lastEventId=%s',
                            session.user.id.toString(),
                            formatLogValue(info && info.processed),
                            formatLogValue(lastEventId)
                        );

                        if (info && info.processed) {
                            resetIdleComment();
                        }
                    },
                    (source, entry) => logUpdatesEvent(session, source, entry)
                );
            };

            let close = reason => {
                if (closed) {
                    return;
                }

                closed = true;
                clearTimeout(idleTimer);
                notifier.removeListener(session, journalReader);

                logUpdatesStream(
                    'info',
                    session,
                    'action=updates-close user=%s reason=%s duration=%s idle=%s lastEventId=%s',
                    session.user.id.toString(),
                    reason,
                    Date.now() - opened,
                    idleCounter,
                    formatLogValue(lastEventId)
                );
            };

            let setup = () => {
                notifier.addListener(session, journalReader);

                let finished = false;
                let done = reason => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    return close(reason);
                };

                // force close after 30 min, otherwise we might end with connections that never close
                req.connection.setTimeout(30 * 60 * 1000, () => done('timeout'));
                req.connection.on('end', () => done('end'));
                req.connection.on('close', () => done('close'));
                req.connection.on('error', err => {
                    logUpdatesStream('error', session, 'action=updates-connection-error user=%s error=%s', session.user.id.toString(), err.message);
                    done('error');
                });
            };

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no'
            });

            if (lastEventId) {
                logUpdatesStream(
                    'info',
                    session,
                    'action=updates-open user=%s remote=%s sess=%s ip=%s lastEventId=%s replay=yes',
                    session.user.id.toString(),
                    remoteAddress,
                    formatLogValue(req.params.sess),
                    formatLogValue(req.params.ip),
                    lastEventId.toString()
                );

                logUpdatesStream('verbose', session, 'action=updates-replay-start user=%s lastEventId=%s', session.user.id.toString(), lastEventId.toString());

                loadJournalStream(
                    db,
                    res,
                    user,
                    lastEventId,
                    (err, info) => {
                        if (err) {
                            logUpdatesStream(
                                'error',
                                session,
                                'action=updates-replay-error user=%s lastEventId=%s error=%s',
                                session.user.id.toString(),
                                formatLogValue(lastEventId),
                                err.message
                            );
                            res.write('event: error\ndata: ' + err.message.split('\n').join('\ndata: ') + '\n\n');
                        }

                        lastEventId = info && info.lastEventId;

                        logUpdatesStream(
                            'verbose',
                            session,
                            'action=updates-replay-complete user=%s processed=%s lastEventId=%s',
                            session.user.id.toString(),
                            formatLogValue(info && info.processed),
                            formatLogValue(lastEventId)
                        );

                        setup();
                        if (info && info.processed) {
                            resetIdleComment();
                        } else {
                            sendIdleComment();
                        }
                    },
                    (source, entry) => logUpdatesEvent(session, source, entry)
                );
            } else {
                let latest;
                try {
                    latest = await db.database.collection('journal').findOne({ user }, { sort: { _id: -1 } });
                } catch (err) {
                    // ignore
                }
                if (latest) {
                    lastEventId = latest._id;
                }

                logUpdatesStream(
                    'info',
                    session,
                    'action=updates-open user=%s remote=%s sess=%s ip=%s lastEventId=%s replay=no',
                    session.user.id.toString(),
                    remoteAddress,
                    formatLogValue(req.params.sess),
                    formatLogValue(req.params.ip),
                    formatLogValue(lastEventId)
                );

                setup();
                sendIdleComment();
            }
        })
    );
};

function formatJournalData(e) {
    let response = [];
    response.push('data: ' + stringifyJournalPayload(e, 2).split('\n').join('\ndata: '));
    if (e._id) {
        response.push('id: ' + e._id.toString());
    }

    return response.join('\n') + '\n\n';
}

function loadJournalStream(db, res, user, lastEventId, done, onEntry) {
    onEntry = typeof onEntry === 'function' ? onEntry : () => false;

    let query = { user };
    if (lastEventId) {
        query._id = { $gt: lastEventId };
    }

    let mailboxes = new Set();

    let cursor = db.database.collection('journal').find(query).sort({ _id: 1 });
    let processed = 0;
    let processNext = () => {
        cursor.next((err, e) => {
            if (err) {
                return done(err);
            }
            if (!e) {
                return cursor.close(() => {
                    if (!mailboxes.size) {
                        return done(null, {
                            lastEventId,
                            processed
                        });
                    }

                    mailboxes = Array.from(mailboxes);
                    let mailboxPos = 0;
                    let emitCounters = () => {
                        if (mailboxPos >= mailboxes.length) {
                            return done(null, {
                                lastEventId,
                                processed
                            });
                        }
                        let mailbox = new ObjectId(mailboxes[mailboxPos++]);
                        getMailboxCounterCb(db, mailbox, false, (err, total) => {
                            if (err) {
                                // ignore
                            }
                            getMailboxCounterCb(db, mailbox, 'unseen', (err, unseen) => {
                                if (err) {
                                    // ignore
                                }

                                let countersEntry = {
                                    command: 'COUNTERS',
                                    _id: lastEventId,
                                    mailbox,
                                    total,
                                    unseen
                                };

                                res.write(formatJournalData(countersEntry));
                                onEntry('counters', countersEntry);

                                setImmediate(emitCounters);
                            });
                        });
                    };
                    emitCounters();
                });
            }

            lastEventId = e._id;

            if (!e || !e.command) {
                // skip
                return setImmediate(processNext);
            }

            switch (e.command) {
                case 'EXISTS':
                case 'EXPUNGE':
                    if (e.mailbox) {
                        mailboxes.add(e.mailbox.toString());
                    }
                    break;
                case 'FETCH':
                    if (e.mailbox && (e.unseen || e.unseenChange)) {
                        mailboxes.add(e.mailbox.toString());
                    }
                    break;
            }

            try {
                let data = formatJournalData(e);
                res.write(data);
                onEntry('replay', e);
            } catch (err) {
                log.error(
                    'API',
                    'action=updates-event-write-fail user=%s event=%s payload=%s error=%s',
                    user.toString(),
                    formatLogValue(e.command),
                    stringifyJournalPayload(e),
                    err.stack || err
                );
            }

            processed++;
            return setImmediate(processNext);
        });
    };

    processNext();
}
