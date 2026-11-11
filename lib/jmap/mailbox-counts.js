'use strict';

// Mailbox counts for JMAP (RFC 8621 2): totalEmails and unreadEmails leave out \Deleted messages and
// unread leaves out drafts; totalThreads and unreadThreads count threads with a message in the mailbox.
//
// Every count reads as little as possible: message counts are index counts, minus the usually few
// drafts and \Deleted messages; the thread count is an index only scan of by_idate_reverse_thread
// (mailbox, ..., thread) corrected for \Deleted messages, cached until a message is added, removed,
// deleted or undeleted, because other flag changes do not change it; unreadThreads groups only the
// unseen messages and is cached until the mailbox changes.

const consts = require('../consts');

const CACHE_TTL = 24 * 3600;
const MAX_TIME_MS = consts.DB_MAX_TIME_MESSAGES_SEARCH * 3;

async function emailCounts(messages, mailbox) {
    const count = filter => messages.countDocuments(Object.assign({ mailbox }, filter), { maxTimeMS: MAX_TIME_MS });
    const [all, deleted, unseen, unseenDrafts, unseenDeleted] = await Promise.all([
        count({}),
        count({ undeleted: false }),
        count({ unseen: true }),
        count({ draft: true, unseen: true, undeleted: true }),
        count({ undeleted: false, unseen: true })
    ]);
    return { totalEmails: all - deleted, unreadEmails: Math.max(0, unseen - unseenDrafts - unseenDeleted) };
}

async function countGroups(messages, pipeline, hint) {
    const [result] = await messages
        .aggregate(pipeline.concat([{ $group: { _id: '$thread' } }, { $count: 'n' }]), Object.assign({ maxTimeMS: MAX_TIME_MS }, hint ? { hint } : {}))
        .toArray();
    return result ? result.n : 0;
}

// Threads in the mailbox: an index only count of every thread, minus the threads that are there only
// through \Deleted messages. Those are found from the deleted messages (usually few) and a lookup of
// the remaining messages of just those threads on the {user, thread} index.
async function totalThreads(messages, mailboxData) {
    const mailbox = mailboxData._id;
    const [all, deleted] = await Promise.all([
        countGroups(messages, [{ $match: { mailbox } }, { $project: { _id: 0, thread: 1 } }], 'by_idate_reverse_thread'),
        messages
            .aggregate([{ $match: { mailbox, undeleted: false } }, { $group: { _id: '$thread' } }], { maxTimeMS: MAX_TIME_MS, hint: 'mailbox_undeleted_flag' })
            .toArray()
    ]);
    if (!deleted.length) {
        return all;
    }
    const kept = await countGroups(
        messages,
        [{ $match: { user: mailboxData.user, thread: { $in: deleted.map(item => item._id) }, mailbox, undeleted: true } }],
        'user_messages_by_thread'
    );
    return all - (deleted.length - kept);
}
const unreadThreads = (messages, mailbox) => countGroups(messages, [{ $match: { mailbox, unseen: true, undeleted: true, draft: { $ne: true } } }]);

/**
 * The four counts of a mailbox.
 *
 * @param {Object} deps {database, redis}
 * @param {Object} mailboxData The mailbox document (needs _id, user, modifyIndex, uidNext)
 * @returns {Promise<{totalEmails, unreadEmails, totalThreads, unreadThreads}>}
 */
async function mailboxCounts(deps, mailboxData) {
    const key = `jmap:mbc:${mailboxData._id}`;
    const version = String(mailboxData.modifyIndex || 0);
    const cached = await deps.redis.hgetall(key).catch(() => ({}));
    if (cached && cached.version === version) {
        return {
            totalEmails: Number(cached.totalEmails),
            unreadEmails: Number(cached.unreadEmails),
            totalThreads: Number(cached.totalThreads),
            unreadThreads: Number(cached.unreadThreads)
        };
    }

    const messages = deps.database.collection('messages');
    const emails = await emailCounts(messages, mailboxData._id);
    // the thread count only changes when messages are added or removed
    const threadsVersion = `${mailboxData.uidNext || 0}:${emails.totalEmails}`;
    const [total, unread] = await Promise.all([
        cached && cached.threadsVersion === threadsVersion ? Number(cached.totalThreads) : totalThreads(messages, mailboxData),
        emails.unreadEmails ? unreadThreads(messages, mailboxData._id) : 0
    ]);
    const counts = Object.assign(emails, { totalThreads: total, unreadThreads: unread });

    await deps.redis
        .multi()
        .hset(key, Object.assign({ version, threadsVersion }, counts))
        .expire(key, CACHE_TTL)
        .exec()
        .catch(() => false);
    return counts;
}

module.exports = { mailboxCounts };
