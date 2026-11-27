'use strict';

// Takes a deleted user's mail out of the outbound queue, so nothing is sent from a deleted account
// (security audit NV-06). Mail can wait in the queue for up to 30 days when it was submitted with a
// send time (REST sendTime, JMAP FUTURERELEASE). Called by UserHandler#delete when it has a maildropper.

const log = require('npmlog');
const consts = require('./consts');
const { syncQueueChange } = require('./jmap/submission-queue');

// most queue ids taken from each source; a user with more scheduled mail keeps the rest queued
const MAX_QUEUE_IDS = 1000;
// stored copies dated this far back are looked at: a scheduled message is dated with its send time, an
// immediate one that is still retried was sent recently
const LOOKBACK = 24 * 3600 * 1000;
const PARALLEL = 10;

/** Queue ids of the user's JMAP submissions that still wait in the queue */
async function pendingSubmissions(database, user) {
    const docs = await database
        .collection('jmap.submissions')
        .find({ user, undoStatus: 'pending' }, { projection: { _id: false, queueId: true }, maxTimeMS: consts.DB_MAX_TIME_USERS })
        .limit(MAX_QUEUE_IDS)
        .toArray();
    return docs.map(doc => doc.queueId);
}

/**
 * Queue ids recorded on the user's stored messages (REST submit and draft submit, JMAP) dated from
 * LOOKBACK ago on. Matched per mailbox on the {mailbox, hdate} index, so only recent and future dated
 * messages are read.
 */
async function recordedOnMessages(database, user) {
    const mailboxes = await database
        .collection('mailboxes')
        .find({ user }, { projection: { _id: true }, maxTimeMS: consts.DB_MAX_TIME_USERS })
        .toArray();
    if (!mailboxes.length) {
        return [];
    }
    const docs = await database
        .collection('messages')
        .find(
            { mailbox: { $in: mailboxes.map(mailbox => mailbox._id) }, hdate: { $gte: new Date(Date.now() - LOOKBACK) }, outbound: { $exists: true } },
            { projection: { _id: false, outbound: true }, maxTimeMS: consts.DB_MAX_TIME_USERS }
        )
        .limit(MAX_QUEUE_IDS)
        .toArray();
    return docs.flatMap(doc => [].concat(doc.outbound || []));
}

/** Removes what is left in the queue of one message; a JMAP submission of it follows as for the REST API */
async function removeQueued(deps, user, queueId) {
    try {
        const result = await deps.maildropper.removeFromQueue(queueId, user);
        if (!result || !result.success) {
            // gone already (delivered), or not the user's (the queue entry names another sender)
            return 0;
        }
        await syncQueueChange(deps, user, queueId, { deleted: result.deleted });
        return result.deleted;
    } catch (err) {
        log.error('USERDEL', 'Failed to remove queued message user=%s queue=%s error=%s', user, queueId, err.message);
        return 0;
    }
}

/**
 * Removes the queue entries of a user's queued messages that are not being delivered right now.
 *
 * @param {Object} deps {database, maildropper, notifier}
 * @param {ObjectId} user
 * @returns {Promise<{messages: Number, entries: Number}>} queue ids looked at and queue entries removed
 */
async function removeUserOutbound(deps, user) {
    const [submitted, recorded] = await Promise.all([pendingSubmissions(deps.database, user), recordedOnMessages(deps.database, user)]);
    const queueIds = [...new Set(submitted.concat(recorded).filter(id => typeof id === 'string' && id))];
    let entries = 0;
    for (let i = 0; i < queueIds.length; i += PARALLEL) {
        const removed = await Promise.all(queueIds.slice(i, i + PARALLEL).map(queueId => removeQueued(deps, user, queueId)));
        entries += removed.reduce((sum, count) => sum + count, 0);
    }
    return { messages: queueIds.length, entries };
}

module.exports = { removeUserOutbound };
