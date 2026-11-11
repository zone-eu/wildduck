'use strict';

// The outbound queue side of EmailSubmission (RFC 8621 7). A submission is a record in
// jmapsubmissions that names the queue id of its message (lib/maildropper.js). ZoneMTA never writes
// the record, so its undoStatus follows the queue:
//
//   pending   every queue entry of the message is still there and none is locked by the MTA
//   final     an entry is locked (delivery is running) or gone (delivered, bounced or expired); it can
//             no longer be recalled
//   canceled  the entries were removed before the MTA touched any of them (JMAP undo, or the REST
//             API deleting the queue entry)
//
// The transition to final is observed lazily when a user's submissions are read, and by a poller
// that checks due pending submissions round robin and notifies the user, so an open event stream
// learns about it. The REST outbound routes report their queue changes through syncQueueChange().

const log = require('npmlog');
const { ObjectId } = require('mongodb');
const consts = require('../consts');
const { ChangeLog } = require('./changelog');
const { syncOwned } = require('./owned-sync');

const TYPE = 'EmailSubmission';
const COLLECTION = 'jmapsubmissions';
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
// most pending submissions of one user checked in one read, and most records removed by one cleanup
const MAX_PENDING = 1000;
const CLEANUP_BATCH = 500;
const POLL_BATCH = 500;
const POLL_LOCK = 'jmap:submissions:poll';

/** The queue collection and the Maildropper that owns it */
const queueOf = maildropper => maildropper.db.senderDb.collection(maildropper.collection);

/** Release time as stored and shown: whole seconds */
const toSecond = date => new Date(Math.floor(date.getTime() / 1000) * 1000);

/**
 * The queue entries of messages, counted per queue id.
 *
 * @param {Maildropper} maildropper
 * @param {String[]} queueIds
 * @returns {Promise<Map<String, {count: Number, locked: Boolean}>>}
 */
async function queueEntries(maildropper, queueIds) {
    const result = new Map();
    if (!queueIds.length) {
        return result;
    }
    // the id field is what the REST API looks queue entries up by; the MTA keeps it indexed
    const entries = await queueOf(maildropper)
        .find({ id: { $in: queueIds } }, { projection: { _id: false, id: true, locked: true }, maxTimeMS: MAX_TIME_MS })
        .toArray();
    for (const entry of entries) {
        const state = result.get(entry.id) || { count: 0, locked: false };
        state.count++;
        state.locked = state.locked || !!entry.locked;
        result.set(entry.id, state);
    }
    return result;
}

/** True when the MTA started on the message of a pending submission */
function started(doc, entries) {
    const state = entries.get(doc.queueId);
    return !state || state.locked || state.count < doc.deliveries;
}

/**
 * Moves pending submissions to final, each with its own change sequence number.
 *
 * @param {Db} database
 * @param {ChangeLog} changeLog
 * @param {Object[]} docs {_id, user}
 * @returns {Promise<Set<String>>} users whose submissions changed
 */
async function finalize(database, changeLog, docs) {
    const byUser = new Map();
    for (const doc of docs) {
        const key = doc.user.toString();
        byUser.set(key, (byUser.get(key) || []).concat(doc));
    }
    const changed = new Set();
    for (const userDocs of byUser.values()) {
        const user = userDocs[0].user;
        let seq = await changeLog.next(user, TYPE, userDocs.length);
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
 * Brings the undoStatus of a user's pending submissions up to date with the queue.
 *
 * @param {Object} deps {database, maildropper}
 * @returns {Promise<Boolean>} true when a submission changed
 */
async function refreshUser(deps, changeLog, user) {
    const pending = await deps.database
        .collection(COLLECTION)
        .find({ user, undoStatus: 'pending' }, { projection: { _id: true, user: true, queueId: true, deliveries: true }, maxTimeMS: MAX_TIME_MS })
        .limit(MAX_PENDING)
        .toArray();
    if (!pending.length) {
        return false;
    }
    const entries = await queueEntries(
        deps.maildropper,
        pending.map(doc => doc.queueId)
    );
    const finals = pending.filter(doc => started(doc, entries));
    return finals.length ? (await finalize(deps.database, changeLog, finals)).size > 0 : false;
}

/**
 * Removes the final and canceled submissions of a user that were released longer than the retention
 * ago, leaving tombstones so /changes reports them destroyed (RFC 8621 7: the server may remove
 * submissions any time after sending).
 *
 * @param {Number} retention seconds
 */
async function cleanupUser(deps, changeLog, user, retention) {
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
    const seq = await changeLog.next(user, TYPE, old.length);
    await submissions.deleteMany({ _id: { $in: old.map(doc => doc._id) }, user });
    await changeLog.destroyed(
        user,
        TYPE,
        old.map(doc => ({ id: doc._id, createdSeq: doc.createdSeq })),
        seq
    );
    return true;
}

/**
 * Cancels the delivery of a pending submission: every queue entry is claimed first, so the MTA can not
 * pick one up in between, and removed only when all of them were claimed. A message the MTA started on
 * is left alone completely, no recipient loses it (RFC 8621 7: canceled means no recipient got it).
 *
 * @returns {Promise<Boolean>} false when delivery had started (cannotUnsend)
 */
async function cancelDelivery(maildropper, doc) {
    const queue = queueOf(maildropper);
    const token = new ObjectId();
    const claimed = await queue.updateMany({ id: doc.queueId, locked: false }, { $set: { locked: true, lockTime: Date.now(), jmapCancel: token } });
    const total = await queue.countDocuments({ id: doc.queueId }, { maxTimeMS: MAX_TIME_MS });
    if (claimed.modifiedCount !== doc.deliveries || total !== doc.deliveries) {
        await queue.updateMany({ id: doc.queueId, jmapCancel: token }, { $set: { locked: false, lockTime: 0 }, $unset: { jmapCancel: '' } });
        return false;
    }
    await queue.deleteMany({ id: doc.queueId, jmapCancel: token });
    await maildropper.removeMessageAsync(doc.queueId);
    return true;
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
            const update =
                'sendTime' in change
                    ? { sendAt: toSecond(change.sendTime), checked: change.sendTime }
                    : { undoStatus: change.deleted === doc.deliveries ? 'canceled' : 'final' };
            // the update writes no state strings, so the change log needs no checksum key
            update.modSeq = await new ChangeLog({ database: deps.database, secret: '' }).next(user, TYPE);
            return (await submissions.updateOne({ _id: doc._id, user, undoStatus: 'pending' }, { $set: update })).modifiedCount > 0;
        },
        { name: 'submission' }
    );
}

/**
 * Checks due pending submissions of all users against the queue, oldest check first, and moves the ones
 * the MTA started on to final. One worker runs it per interval (a Redis lock), every other skips.
 *
 * @param {Object} deps {database, redis, maildropper, notifier}
 * @param {Number} interval seconds between two checks of the same submission
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
        .find(
            { undoStatus: 'pending', checked: { $lte: new Date(now.getTime() - interval * 1000) } },
            { projection: { _id: true, user: true, queueId: true, deliveries: true }, maxTimeMS: MAX_TIME_MS }
        )
        .sort({ checked: 1 })
        .limit(POLL_BATCH)
        .toArray();
    if (!due.length) {
        return 0;
    }
    const entries = await queueEntries(
        deps.maildropper,
        due.map(doc => doc.queueId)
    );
    const finals = due.filter(doc => started(doc, entries));
    const waiting = due.filter(doc => !started(doc, entries));
    if (waiting.length) {
        await submissions.updateMany({ _id: { $in: waiting.map(doc => doc._id) }, undoStatus: 'pending' }, { $set: { checked: now } });
    }
    if (!finals.length) {
        return 0;
    }
    const users = await finalize(deps.database, new ChangeLog({ database: deps.database, secret: '' }), finals);
    for (const user of users) {
        deps.notifier.fire(new ObjectId(user));
    }
    return finals.length;
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

module.exports = { TYPE, COLLECTION, queueEntries, refreshUser, cleanupUser, cancelDelivery, syncQueueChange, pollOnce, startPoller, toSecond };
