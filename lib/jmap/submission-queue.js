'use strict';

// The outbound queue side of EmailSubmission (RFC 8621 7). A submission is a record in
// jmap.submissions that names the queue id of its message (lib/maildropper.js). ZoneMTA never writes
// the record, so its undoStatus follows the queue:
//
//   pending   every queue entry of the message is still there and none is locked by the MTA
//   final     an entry is locked (delivery is running) or gone (delivered, bounced or expired); it can
//             no longer be recalled
//   canceled  the entries were removed before the MTA touched any of them (JMAP undo, or the REST
//             API deleting the queue entry)
//
// The transition to final is observed lazily when a user's submissions are read, and by a poller
// that checks due pending submissions, with a growing delay while a message waits, and notifies the
// user, so an open event stream learns about it. The REST outbound routes report their queue changes
// through syncQueueChange().

const log = require('npmlog');
const { ObjectId } = require('mongodb');
const consts = require('../consts');
const { changeWriter } = require('./changelog');
const { syncOwned } = require('./owned-sync');

const TYPE = 'EmailSubmission';
const COLLECTION = 'jmap.submissions';
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
// most pending submissions of one user checked in one read, and most records removed by one cleanup
const MAX_PENDING = 1000;
const CLEANUP_BATCH = 500;
const POLL_BATCH = 500;
const POLL_LOCK = 'jmap:submissions:poll';
// seconds: a pending submission whose message still waits is checked again later each time, at most this far apart
const MAX_CHECK_DELAY = 3600;
const PENDING_PROJECTION = { _id: true, user: true, queueId: true, deliveries: true, queuingUntil: true };
// ms: a submission record is stored before its message is queued; this long, missing queue entries mean
// that the push is still running, not that the message was delivered
const QUEUING_TIME = 10 * 60 * 1000;

/** Release time as stored and shown: whole seconds */
const toSecond = date => new Date(Math.floor(date.getTime() / 1000) * 1000);

/** The queuingUntil of a submission record stored now, before its message is queued */
const queuingUntil = () => new Date(Date.now() + QUEUING_TIME);

/** True while the message of a submission may still be on its way into the queue */
const queuing = doc => doc.queuingUntil instanceof Date && doc.queuingUntil > new Date();

/** True when the MTA started on the message of a pending submission */
function started(doc, entries) {
    const state = entries.get(doc.queueId);
    if (!state) {
        return !queuing(doc);
    }
    return state.locked || state.count < doc.deliveries;
}

/**
 * Moves pending submissions to final, each with its own change sequence number.
 *
 * @param {Db} database
 * @param {Object[]} docs {_id, user}
 * @returns {Promise<Set<String>>} users whose submissions changed
 */
async function finalize(database, docs) {
    const byUser = new Map();
    for (const doc of docs) {
        const key = doc.user.toString();
        byUser.set(key, (byUser.get(key) || []).concat(doc));
    }
    const writer = changeWriter(database);
    const changed = new Set();
    for (const userDocs of byUser.values()) {
        const user = userDocs[0].user;
        let seq = await writer.next(user, TYPE, userDocs.length);
        for (const doc of userDocs) {
            // a concurrent cancel may have won; then this sequence number stays unused
            const res = await database
                .collection(COLLECTION)
                .updateOne({ _id: doc._id, user, undoStatus: 'pending' }, { $set: { undoStatus: 'final', modSeq: seq++ } });
            if (res.modifiedCount) {
                changed.add(user.toString());
            }
        }
    }
    return changed;
}

/**
 * Checks pending submissions against the queue and moves the ones the MTA started on to final.
 *
 * @param {Object} deps {database, maildropper}
 * @param {Object[]} docs pending submissions with the PENDING_PROJECTION fields
 * @returns {Promise<{users: Set<String>, waiting: Object[]}>} the users whose submissions changed, and the
 *   submissions whose message still waits in the queue
 */
async function finalizeStarted(deps, docs) {
    if (!docs.length) {
        return { users: new Set(), waiting: [] };
    }
    const entries = await deps.maildropper.queueState(docs.map(doc => doc.queueId));
    const finals = docs.filter(doc => started(doc, entries));
    const waiting = docs.filter(doc => !started(doc, entries));
    return { users: finals.length ? await finalize(deps.database, finals) : new Set(), waiting };
}

/**
 * Brings the undoStatus of a user's due pending submissions up to date with the queue. A submission held
 * for later can not have started: the MTA takes due queue entries only.
 *
 * @param {Object} deps {database, maildropper}
 * @returns {Promise<Boolean>} true when a submission changed
 */
async function refreshUser(deps, user) {
    const pending = await deps.database
        .collection(COLLECTION)
        .find({ user, undoStatus: 'pending', sendAt: { $lte: new Date() } }, { projection: PENDING_PROJECTION, maxTimeMS: MAX_TIME_MS })
        .limit(MAX_PENDING)
        .toArray();
    return (await finalizeStarted(deps, pending)).users.size > 0;
}

/**
 * Removes the final and canceled submissions of a user that were released longer than the retention
 * ago, leaving tombstones so /changes reports them destroyed (RFC 8621 7: the server may remove
 * submissions any time after sending).
 *
 * @param {Number} retention seconds
 */
async function cleanupUser(deps, user, retention) {
    const submissions = deps.database.collection(COLLECTION);
    const old = await submissions
        .find(
            { user, undoStatus: { $in: ['final', 'canceled'] }, sendAt: { $lt: new Date(Date.now() - retention * 1000) } },
            { projection: { _id: true, createdSeq: true }, maxTimeMS: MAX_TIME_MS }
        )
        .limit(CLEANUP_BATCH)
        .toArray();
    if (!old.length) {
        return false;
    }
    const writer = changeWriter(deps.database);
    const seq = await writer.next(user, TYPE, old.length);
    await submissions.deleteMany({ _id: { $in: old.map(doc => doc._id) }, user });
    await writer.destroyed(
        user,
        TYPE,
        old.map(doc => ({ id: doc._id, createdSeq: doc.createdSeq })),
        seq
    );
    return true;
}

/**
 * Cancels the delivery of a pending submission: every queue entry of its message is removed, or none, so
 * a message the MTA started on keeps all its recipients (RFC 8621 7: canceled means no recipient got it).
 *
 * @returns {Promise<Boolean>} false when delivery had started (cannotUnsend)
 */
async function cancelDelivery(maildropper, doc) {
    const result = await maildropper.cancelQueued(doc.queueId, { user: doc.user, expected: doc.deliveries });
    return result.success === true;
}

/**
 * Called by the REST outbound routes after a queued message was deleted or rescheduled, so the JMAP
 * submission of that message follows: a deletion of every entry cancels it, a partial one makes it
 * final, a new delivery time becomes its sendAt. Does nothing for messages not sent over JMAP.
 *
 * @param {Object} deps {database, notifier}
 * @param {ObjectId} user
 * @param {String} queueId
 * @param {Object} change {deleted: count of removed entries} or {sendTime: Date}
 */
async function syncQueueChange(deps, user, queueId, change) {
    await syncOwned(
        deps,
        user,
        async () => {
            const submissions = deps.database.collection(COLLECTION);
            const doc = await submissions.findOne(
                { user, queueId, undoStatus: 'pending' },
                { projection: { _id: true, deliveries: true }, maxTimeMS: MAX_TIME_MS }
            );
            if (!doc) {
                return false;
            }
            // a new delivery time starts the checks of the poller over
            const update =
                'sendTime' in change
                    ? { $set: { sendAt: toSecond(change.sendTime), checkAt: change.sendTime }, $unset: { checkDelay: '' } }
                    : { $set: { undoStatus: change.deleted === doc.deliveries ? 'canceled' : 'final' } };
            update.$set.modSeq = await changeWriter(deps.database).next(user, TYPE);
            return (await submissions.updateOne({ _id: doc._id, user, undoStatus: 'pending' }, update)).modifiedCount > 0;
        },
        { name: 'submission' }
    );
}

/**
 * Checks due pending submissions of all users against the queue, earliest check time first, and moves
 * the ones the MTA started on to final. A submission whose message still waits (deferred by the MTA,
 * for example) is checked again after a delay that doubles every time, up to MAX_CHECK_DELAY. One worker
 * runs it per interval (a Redis lock), every other skips.
 *
 * @param {Object} deps {database, redis, maildropper, notifier}
 * @param {Number} interval seconds between two polls, and the first delay before a waiting submission is checked again
 * @returns {Promise<Number>} submissions moved to final
 */
async function pollOnce(deps, interval) {
    const locked = await deps.redis.set(POLL_LOCK, process.pid.toString(), 'PX', Math.max(interval * 1000 - 100, 100), 'NX');
    if (!locked) {
        return 0;
    }
    const now = new Date();
    const submissions = deps.database.collection(COLLECTION);
    const due = await submissions
        .find({ undoStatus: 'pending', checkAt: { $lte: now } }, { projection: PENDING_PROJECTION, maxTimeMS: MAX_TIME_MS })
        .sort({ checkAt: 1 })
        .limit(POLL_BATCH)
        .toArray();
    const { users, waiting } = await finalizeStarted(deps, due);
    if (waiting.length) {
        const delay = { $ifNull: ['$checkDelay', interval] };
        await submissions.updateMany({ _id: { $in: waiting.map(doc => doc._id) }, undoStatus: 'pending' }, [
            { $set: { checkAt: { $add: [now, { $multiply: [delay, 1000] }] }, checkDelay: { $min: [{ $multiply: [delay, 2] }, MAX_CHECK_DELAY] } } }
        ]);
    }
    for (const user of users) {
        deps.notifier.fire(new ObjectId(user));
    }
    return due.length - waiting.length;
}

/**
 * Starts the poller of a JMAP service instance.
 *
 * @returns {Function} stops it
 */
function startPoller(deps, interval) {
    if (!(interval > 0)) {
        return () => false;
    }
    let timer = null;
    let stopped = false;
    const tick = async () => {
        try {
            await pollOnce(deps, interval);
        } catch (err) {
            log.error('JMAP', 'submission poll failed: %s', err.message);
        }
        if (!stopped) {
            timer = setTimeout(tick, interval * 1000);
            timer.unref();
        }
    };
    timer = setTimeout(tick, interval * 1000);
    timer.unref();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}

module.exports = {
    TYPE,
    COLLECTION,
    queuingUntil,
    finalizeStarted,
    refreshUser,
    cleanupUser,
    cancelDelivery,
    syncQueueChange,
    pollOnce,
    startPoller,
    toSecond
};
