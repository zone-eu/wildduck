'use strict';

// Per user anchors of the change journal, the basis of JMAP state strings for Email, Thread and
// Mailbox (and of the EmailDelivery push state).
//
// The newest journal entry alone is not a usable state: entries expire, and when the newest one does,
// "the newest entry" changes although nothing changed. So the newest id seen is kept in the user's
// jmapstate document and only moves forward. It is maintained lazily, when a state is asked for, which
// keeps every write path (IMAP, POP3, LMTP, the REST API, the Haraka and ZoneMTA plugins) unchanged.
// Ask once per JMAP request, not once per method call.

const { ObjectId } = require('mongodb');
const consts = require('./consts');
const { SettingsHandler } = require('./settings-handler');

const MAX_TIME_MS = 2000;

// The newest journal entry of a user that matches `filter` and is newer than `after`. Both lookups walk
// the {user, _id} index backwards from the newest entry and stop at `after`, so a burst of other
// entries (a big flag change) costs at most the entries since the previous call.
async function newestEntry(journal, user, after, filter = {}) {
    const [entry] = await journal
        .find(Object.assign({ user, _id: { $gt: after } }, filter), { projection: { _id: true } })
        .sort({ _id: -1 })
        .limit(1)
        .maxTimeMS(MAX_TIME_MS)
        .toArray();
    return entry ? entry._id : null;
}

const same = (a, b) => Boolean(a && b && a.equals(b));

// The anchor to use: the newest entry if there is one since the stored anchor, else the stored anchor
// unless it is older than the retention (changes may have expired unseen), else a fresh id
function pick(stored, newest, cutoff) {
    if (newest) {
        return newest;
    }
    if (stored && stored.getTimestamp() >= cutoff) {
        return stored;
    }
    // the start of the current second, not new ObjectId(): ids of other processes do not sort by time
    // inside a second, so an entry written right after this read could sort below an id made here and
    // would never be noticed. Entries written earlier in this second were found by the lookup above.
    return ObjectId.createFromTime(Math.floor(Date.now() / 1000));
}

/**
 * The current anchors of a user: `journal` (newest change of any kind) and `delivery` (newest
 * change that added an Email to the store, every EXISTS except a move).
 *
 * An anchor never moves backwards and does not change while nothing changes. An anchor older than the
 * journal retention, with nothing newer in the journal, is replaced by a fresh id: changes made since
 * may have expired unseen, so a state change is the safe answer, and clients asking for changes since
 * the old anchor get cannotCalculateChanges anyway.
 *
 * @param {Db} database
 * @param {ObjectId} user
 * @param {Object} [options] {retention: journal retention in ms, read from const:journal:time when not given}
 * @returns {Promise<{journal: ObjectId, delivery: ObjectId, retention: Number}>} retention is the journal retention in ms
 */
async function journalAnchors(database, user, options = {}) {
    const retention = options.retention || (await new SettingsHandler({ db: database }).get('const:journal:time')) || consts.JOURNAL_TIME;
    const cutoff = new Date(Date.now() - retention);
    const oldest = ObjectId.createFromTime(Math.floor(cutoff.getTime() / 1000));
    const journal = database.collection('journal');
    const stateCollection = database.collection('jmapstate');

    const stored = (await stateCollection.findOne({ _id: user }, { projection: { journal: true, delivery: true } })) || {};
    const [newest, newestDelivery] = await Promise.all([
        newestEntry(journal, user, stored.journal || oldest),
        newestEntry(journal, user, stored.delivery || oldest, { command: 'EXISTS', origin: { $ne: consts.JOURNAL_ORIGIN.MOVE } })
    ]);

    const anchors = { journal: pick(stored.journal, newest, cutoff), delivery: pick(stored.delivery, newestDelivery, cutoff) };
    if (!same(anchors.journal, stored.journal) || !same(anchors.delivery, stored.delivery)) {
        // $max keeps a newer anchor that a concurrent reader stored first
        await stateCollection.updateOne({ _id: user }, { $max: anchors }, { upsert: true });
    }
    return Object.assign(anchors, { retention });
}

module.exports = { journalAnchors };
