'use strict';

const config = require('@zone-eu/wild-config');
const { objectIdSchema } = require('../schemas/json-schemas');
const crypto = require('crypto');
const ObjectId = require('mongodb').ObjectId;
const log = require('npmlog');
const tools = require('../tools');
const roles = require('../roles');
const base32 = require('base32.js');

const hasUpdatesStreamLogging = !!(config.log && config.log.updateStream);

const formatLogValue = value => String(value);

const COUNTER_COMMANDS = new Set(['COUNTERS', 'LABEL_COUNTERS', 'FLAGGED_COUNTER']);

const getJournalPayload = entry => {
    const data = {};
    Object.keys(entry).forEach(key => {
        if (!['_id', 'ignore', 'user', 'modseq', 'unseenChange', 'created', 'counterLabels', 'flaggedCounterInvalidated'].includes(key)) {
            if (!COUNTER_COMMANDS.has(entry.command) && key === 'unseen') {
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

    if (entry.command === 'LABEL_COUNTERS') {
        return log.verbose(
            'API',
            '[%s] action=updates-event source=%s user=%s event=%s eventId=%s label=%s total=%s unseen=%s payload=%s',
            session.id,
            source,
            formatLogValue(session.user.id),
            entry.command,
            formatLogValue(entry._id),
            formatLogValue(entry.label),
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
    server.route({
        method: 'GET',
        url: '/users/:user/updates',
        schema: {
            summary: 'Open change stream',
            description:
                'This api call returns an EventSource response. Listen on this stream to get notifications about changes in messages and mailboxes. Returned events are JSON encoded strings',
            tags: ['Users']
        },
        config: {
            name: 'getUpdates',
            // the restify-era handler copied the Last-Event-ID header into
            // params before validating
            preValidate: (params, req) => {
                if (req.headers['last-event-id']) {
                    params['Last-Event-ID'] = req.headers['last-event-id'];
                }
            },
            validationObjs: {
                requestBody: {},
                queryParams: {
                    'Last-Event-ID': objectIdSchema('Last event ID header as query param'),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                response: { 200: { description: 'Success' } }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            // should the resource be something else than 'users'?
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let user = new ObjectId(values.user);
            let lastEventId = values['Last-Event-ID'] ? new ObjectId(values['Last-Event-ID']) : false;

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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!userData) {
                return reply.code(404).send({
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

            let remoteAddress = req.headers['x-forwarded-for'] || req.raw.socket.remoteAddress || '';
            let opened = Date.now();
            let closed = false;
            let idleTimer = false;
            let idleCounter = 0;

            let sendIdleComment = () => {
                clearTimeout(idleTimer);
                if (closed) {
                    return;
                }
                reply.raw.write(': idling ' + ++idleCounter + '\n\n');
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
            let close;

            // Replays the journal entries after lastEventId to the client. Resolves with the
            // replay info, or undefined if the replay failed
            let replayJournal = async ({ reportError = false } = {}) => {
                journalReading = true;
                logUpdatesStream(
                    'verbose',
                    session,
                    'action=updates-replay-start user=%s lastEventId=%s',
                    session.user.id.toString(),
                    formatLogValue(lastEventId)
                );

                let info;
                try {
                    info = await loadJournalStream(db, reply.raw, user, lastEventId, (source, entry) => logUpdatesEvent(session, source, entry));
                } catch (err) {
                    logUpdatesStream(
                        'error',
                        session,
                        'action=updates-replay-error user=%s lastEventId=%s error=%s',
                        session.user.id.toString(),
                        formatLogValue(lastEventId),
                        err.message
                    );
                    if (reportError) {
                        reply.raw.write('event: error\ndata: ' + err.message.split('\n').join('\ndata: ') + '\n\n');
                    }
                } finally {
                    journalReading = false;
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

                return info;
            };

            let journalReader = message => {
                if (journalReading || closed) {
                    return;
                }

                if (message) {
                    try {
                        reply.raw.write(formatJournalData(message));
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
                        close('write-fail');
                    }
                    return;
                }

                replayJournal()
                    .then(info => {
                        if (info && info.processed) {
                            resetIdleComment();
                        }
                    })
                    .catch(err =>
                        log.error('API', '[%s] action=updates-replay-crash user=%s error=%s', session.id, session.user.id.toString(), err.stack || err)
                    );
            };

            close = reason => {
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
                req.raw.socket.setTimeout(30 * 60 * 1000, () => done('timeout'));
                req.raw.socket.on('end', () => done('end'));
                req.raw.socket.on('close', () => done('close'));
                req.raw.socket.on('error', err => {
                    logUpdatesStream('error', session, 'action=updates-connection-error user=%s error=%s', session.user.id.toString(), err.message);
                    done('error');
                });
            };

            // SSE writes events incrementally, so the raw response is taken
            // over; the helper keeps the access log and metrics working
            server.beginRawResponse(req, reply, 200, {
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

                let info = await replayJournal({ reportError: true });

                setup();
                if (info && info.processed) {
                    resetIdleComment();
                } else {
                    sendIdleComment();
                }
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
        }
    });
};

function formatJournalData(e) {
    let response = [];
    response.push('data: ' + stringifyJournalPayload(e, 2).split('\n').join('\ndata: '));
    if (e._id) {
        response.push('id: ' + e._id.toString());
    }

    return response.join('\n') + '\n\n';
}

// Replays journal entries newer than lastEventId to the SSE response, followed by the
// counters of every mailbox and label the replayed entries touched. Resolves with the
// id of the last replayed entry and the number of entries written
async function loadJournalStream(db, res, user, lastEventId, onEntry) {
    onEntry = typeof onEntry === 'function' ? onEntry : () => false;

    let query = { user };
    if (lastEventId) {
        query._id = { $gt: lastEventId };
    }

    let mailboxes = new Set();
    let changedLabels = new Set();
    let invalidatedLabels = new Set();
    let flaggedChanged = false;
    let processed = 0;

    let cursor = db.database.collection('journal').find(query).sort({ _id: 1 });
    for await (let e of cursor) {
        lastEventId = e._id;

        if (!e.command) {
            // skip
            continue;
        }

        switch (e.command) {
            case 'EXISTS':
            case 'EXPUNGE':
                if (e.mailbox) {
                    mailboxes.add(e.mailbox.toString());
                }
                if (e.flagged) {
                    flaggedChanged = true;
                }
                break;
            case 'FETCH':
                if (e.mailbox && (e.unseen || e.unseenChange)) {
                    mailboxes.add(e.mailbox.toString());
                }

                if (e.flaggedChangedTo === true || e.flaggedChangedTo === false) {
                    flaggedChanged = true;
                }

                if (e.unseenChange && (e.flags ?? []).includes('\\Flagged')) {
                    flaggedChanged = true;
                }
                break;
            case 'DELETE':
                for (const label of e.counterLabels ?? []) {
                    changedLabels.add(label);
                    invalidatedLabels.add(label);
                }
                if (e.flaggedCounterInvalidated) {
                    flaggedChanged = true;
                }
                break;
        }

        for (const label of [...(e.labels ?? []), ...(e.addedLabels ?? []), ...(e.removedLabels ?? [])]) {
            changedLabels.add(label);
        }

        try {
            res.write(formatJournalData(e));
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
    }

    // a failed counter lookup leaves the value out of the entry
    const mailboxCounters = await Promise.all(
        [...mailboxes].map(async mailboxId => {
            let mailbox = new ObjectId(mailboxId);
            let [total, unseen] = await Promise.all([
                tools.getMailboxCounter(db, mailbox, false).catch(() => undefined),
                tools.getMailboxCounter(db, mailbox, 'unseen').catch(() => undefined)
            ]);
            return { mailbox, total, unseen };
        })
    );

    for (let { mailbox, total, unseen } of mailboxCounters) {
        let countersEntry = {
            command: 'COUNTERS',
            _id: lastEventId,
            mailbox,
            total,
            unseen
        };

        res.write(formatJournalData(countersEntry));
        onEntry('counters', countersEntry);
    }

    if (flaggedChanged) {
        try {
            const [total, unseen] = await Promise.all([tools.getFlaggedCounter(db, user), tools.getFlaggedCounter(db, user, 'unseen')]);
            res.write(
                formatJournalData({
                    command: 'FLAGGED_COUNTER',
                    _id: lastEventId,
                    total,
                    unseen
                })
            );
        } catch {
            // ignore
        }
    }

    if (changedLabels.size) {
        try {
            const trackedLabels = new Set(await tools.getTrackedLabels(db.redis, user));
            const toEmit = [...changedLabels].filter(label => invalidatedLabels.has(label) || trackedLabels.has(label));

            const labelResults = await Promise.all(
                toEmit.map(async label => {
                    let total, unseen;
                    try {
                        total = await tools.getLabelCounter(db, user, label);
                    } catch {
                        total = 0;
                    }
                    try {
                        unseen = await tools.getLabelCounter(db, user, label, 'unseen');
                    } catch {
                        unseen = 0;
                    }
                    return { label, total, unseen };
                })
            );

            for (const { label, total, unseen } of labelResults) {
                let labelEntry = {
                    command: 'LABEL_COUNTERS',
                    _id: lastEventId,
                    label,
                    total,
                    unseen
                };
                res.write(formatJournalData(labelEntry));
                onEntry('label-counters', labelEntry);
            }
        } catch {
            // ignore
        }
    }

    return {
        lastEventId,
        processed
    };
}
