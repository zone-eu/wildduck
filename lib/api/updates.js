'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const base32 = require('base32.js');
const { sessSchema, sessIPSchema } = require('../schemas');
const { userId } = require('../schemas/request/general-schemas');

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
                    return res.write(formatJournalData(message));
                }

                journalReading = true;
                loadJournalStream(db, req, res, user, lastEventId, (err, info) => {
                    if (err) {
                        // ignore?
                    }
                    lastEventId = info && info.lastEventId;
                    journalReading = false;
                    if (info && info.processed) {
                        resetIdleComment();
                    }
                });
            };

            let close = () => {
                closed = true;
                clearTimeout(idleTimer);
                notifier.removeListener(session, journalReader);
            };

            let setup = () => {
                notifier.addListener(session, journalReader);

                let finished = false;
                let done = () => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    return close();
                };

                // force close after 30 min, otherwise we might end with connections that never close
                req.connection.setTimeout(30 * 60 * 1000, done);
                req.connection.on('end', done);
                req.connection.on('close', done);
                req.connection.on('error', done);
            };

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no'
            });

            if (lastEventId) {
                loadJournalStream(db, req, res, user, lastEventId, (err, info) => {
                    if (err) {
                        res.write('event: error\ndata: ' + err.message.split('\n').join('\ndata: ') + '\n\n');
                        // ignore
                    }
                    setup();
                    if (info && info.processed) {
                        resetIdleComment();
                    } else {
                        sendIdleComment();
                    }
                });
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

                setup();
                sendIdleComment();
            }
        })
    );
};

function formatJournalData(e) {
    let data = {};
    Object.keys(e).forEach(key => {
        if (!['_id', 'ignore', 'user', 'modseq', 'unseenChange', 'created'].includes(key)) {
            if (e.command !== 'COUNTERS' && key === 'unseen') {
                return;
            }
            data[key] = e[key];
        }
    });

    let response = [];
    response.push('data: ' + JSON.stringify(data, false, 2).split('\n').join('\ndata: '));
    if (e._id) {
        response.push('id: ' + e._id.toString());
    }

    return response.join('\n') + '\n\n';
}

function loadJournalStream(db, req, res, user, lastEventId, done) {
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
                        tools.getMailboxCounter(db, mailbox, false, (err, total) => {
                            if (err) {
                                // ignore
                            }
                            tools.getMailboxCounter(db, mailbox, 'unseen', (err, unseen) => {
                                if (err) {
                                    // ignore
                                }

                                res.write(
                                    formatJournalData({
                                        command: 'COUNTERS',
                                        _id: lastEventId,
                                        mailbox,
                                        total,
                                        unseen
                                    })
                                );

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
            } catch (err) {
                console.error(err);
                console.error(e);
            }

            processed++;
            return setImmediate(processNext);
        });
    };

    processNext();
}
