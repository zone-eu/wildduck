'use strict';

// Lookup of messages by `root`, the id that stays the same while a message moves between mailboxes.
// A MOVE stores a new document with a new _id (the messages collection is sharded by mailbox and
// uid, so a document can not change its mailbox in place), and only `root` follows the message.
// JMAP Email ids are built from it. An IMAP COPY gives the copy a root of its own.

const { setTimeout: sleep } = require('timers/promises');
const consts = require('./consts');

/** The root of a message document; one stored before every message got a root is identified by its _id. */
const rootOf = doc => doc.root || doc._id;

/**
 * Finds the current document for each root.
 *
 * Uniqueness of root is kept by the write paths, not by an index (a unique index on a sharded
 * collection must start with the shard key). A move inserts the new document before it deletes the
 * old one, so for a moment two documents share a root; the newer _id is the current one.
 *
 * @param {Collection} collection The messages or archived collection
 * @param {ObjectId} user Owner, every match must belong to this user
 * @param {ObjectId[]} roots Roots to resolve
 * @param {Object} [options]
 * @param {Object} [options.projection] Fields to return; _id and root are always included
 * @param {Boolean} [options.legacy=true] Also match documents stored before roots were set on every
 *   message, by _id. Pass false once the roots of the user are checked (rootsChecked), which saves an index probe
 * @param {Number} [options.maxTimeMS]
 * @returns {Promise<Map<String, Object>>} root as hex string to document; unknown roots are absent
 */
async function resolveRoots(collection, user, roots, options = {}) {
    const found = new Map();
    if (!roots.length) {
        return found;
    }

    // `$exists` lets the planner use the partial by_root index
    const byRoot = { root: { $in: roots, $exists: true } };
    const filter = options.legacy === false ? Object.assign({ user }, byRoot) : { user, $or: [byRoot, { _id: { $in: roots }, root: { $exists: false } }] };
    const projection = options.projection ? Object.assign({}, options.projection, { _id: true, root: true }) : undefined;

    const cursor = collection.find(filter, { projection, maxTimeMS: options.maxTimeMS || consts.DB_MAX_TIME_MESSAGES });
    for await (const doc of cursor) {
        const key = rootOf(doc).toString();
        const current = found.get(key);
        // ObjectId hex strings sort by creation time
        if (!current || current._id.toString() < doc._id.toString()) {
            found.set(key, doc);
        }
    }
    return found;
}

/**
 * Groups of documents of a user that share a root, each group sorted by _id (oldest first).
 *
 * The aggregation only counts per root; the documents of the few shared roots are then read through
 * the by_root index, so a user with many messages does not push them all through the pipeline.
 *
 * @param {Collection} collection
 * @param {ObjectId} user
 * @param {ObjectId[]} [roots] Limit the check to these roots
 * @returns {Promise<Array<{root: ObjectId, docs: Object[]}>>}
 */
async function findDuplicateRoots(collection, user, roots) {
    const match = { user, root: roots ? { $in: roots, $exists: true } : { $exists: true } };
    const shared = await collection
        .aggregate([{ $match: match }, { $group: { _id: '$root', count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $project: { _id: true } }], {
            allowDiskUse: true,
            maxTimeMS: consts.DB_MAX_TIME_MESSAGES
        })
        .toArray();
    if (!shared.length) {
        return [];
    }

    const groups = new Map();
    const cursor = collection
        .find({ user, root: { $in: shared.map(group => group._id), $exists: true } }, { projection: { _id: true, root: true, mailbox: true, uid: true } })
        .sort({ _id: 1 })
        .maxTimeMS(consts.DB_MAX_TIME_MESSAGES);
    for await (const doc of cursor) {
        const key = doc.root.toString();
        if (!groups.has(key)) {
            groups.set(key, { root: doc.root, docs: [] });
        }
        groups.get(key).docs.push(doc);
    }
    return [...groups.values()].filter(group => group.docs.length > 1);
}

/**
 * Makes the roots of one user usable as JMAP Email ids: documents stored before every message got a
 * root get root = _id, and documents that share a root (copies made before a COPY gave the copy its
 * own root) are separated: the oldest keeps the root, every other one gets its own _id as root.
 * Idempotent, so it can be run again after an interruption.
 *
 * Two documents also share a root for a moment while a message is being moved, so a group is only
 * separated if it is still a group after `settleMs`.
 *
 * @param {Db} database Database holding messages and archived
 * @param {ObjectId} user
 * @param {Object} [options] {settleMs: wait before separating (default 2000)}
 * @returns {Promise<{filled: Number, separated: Number}>}
 */
async function repairUserRoots(database, user, options = {}) {
    const settleMs = options.settleMs ?? 2000;
    const missing = { user, root: { $exists: false } };

    let filled = 0;
    for (const name of ['messages', 'archived']) {
        const result = await database.collection(name).updateMany(missing, [{ $set: { root: '$_id' } }], { writeConcern: 'majority' });
        filled += result.modifiedCount;
    }

    const messages = database.collection('messages');
    let groups = await findDuplicateRoots(messages, user);
    if (groups.length && settleMs) {
        await sleep(settleMs);
        groups = await findDuplicateRoots(
            messages,
            user,
            groups.map(group => group.root)
        );
    }

    // every document but the oldest of a group becomes its own root; the shard key keeps each update targeted
    const updates = groups.flatMap(group =>
        group.docs.slice(1).map(doc => ({
            updateOne: { filter: { _id: doc._id, mailbox: doc.mailbox, uid: doc.uid, root: group.root }, update: { $set: { root: doc._id } } }
        }))
    );
    let separated = 0;
    if (updates.length) {
        const result = await messages.bulkWrite(updates, { ordered: false, writeConcern: 'majority' });
        separated = result.modifiedCount;
    }

    return { filled, separated };
}

/** True once ensureUserRoots has run for the user. */
async function rootsChecked(database, user) {
    return !!(await database.collection('jmap.state').findOne({ _id: user, rootsChecked: { $exists: true } }, { projection: { _id: true } }));
}

/**
 * Runs repairUserRoots once per user. The jmap.state document of the user records that it ran, after
 * which every message of the user has a unique root and lookups can skip the legacy branch
 * (resolveRoots with legacy: false). New messages always get a root and copies their own one.
 *
 * @param {Db} database
 * @param {ObjectId} user
 * @param {Object} [options] Passed to repairUserRoots
 * @returns {Promise<{repaired: Boolean, filled?: Number, separated?: Number}>}
 */
async function ensureUserRoots(database, user, options) {
    if (await rootsChecked(database, user)) {
        return { repaired: false };
    }
    const result = await repairUserRoots(database, user, options);
    await database.collection('jmap.state').updateOne({ _id: user }, { $set: { rootsChecked: new Date() } }, { upsert: true, writeConcern: 'majority' });
    return Object.assign({ repaired: true }, result);
}

module.exports = { rootOf, resolveRoots, findDuplicateRoots, repairUserRoots, ensureUserRoots, rootsChecked };
