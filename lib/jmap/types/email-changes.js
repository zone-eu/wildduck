'use strict';

// Email/changes (RFC 8621 4.3) from the change journal.

const { URN } = require('../capabilities');
const { formatId } = require('../ids');
const { requireAccount, checkArguments } = require('./common');
const { mailState, parseState, entriesSince, maxChangesOf, foldEntries, changeLists, formatState } = require('../state');
const consts = require('../../consts');
const { loadMailboxes } = require('./mailbox');

// What a journal entry means for the Email it describes. Messages with \Deleted are invisible to JMAP.
//   appear:    the Email became visible (new message, restore, \Deleted cleared)
//   arrive:    the second half of a move, the Email is visible in its new mailbox
//   change:    flags, labels or the first half of a move
//   gone:      the Email is no longer visible (expunged, \Deleted set, moved while carrying \Deleted)
//   invisible: a new message stored with \Deleted, never seen by a client
function effectOf(entry) {
    const move = entry.origin === consts.JOURNAL_ORIGIN.MOVE;
    switch (entry.command) {
        case 'EXISTS':
            if (entry.deleted) {
                return move ? 'gone' : 'invisible';
            }
            return move ? 'arrive' : 'appear';
        case 'EXPUNGE':
            return !move || entry.deleted ? 'gone' : 'change';
        case 'FETCH':
            if ((entry.flags || []).some(flag => flag.toLowerCase() === '\\deleted')) {
                return 'gone';
            }
            return entry.deletedChangedTo === false ? 'appear' : 'change';
        default:
            return null;
    }
}

// effect -> state of the id so far in the window -> new state. 'dropped' is an Email created and
// destroyed inside the window, left out of the answer. A move is EXPUNGE then EXISTS of one root, so it
// reads as an update (journals written before the EXPUNGE carried an origin: destroyed then arrive).
const TRANSITIONS = {
    appear: { none: 'created', created: 'created', updated: 'updated', destroyed: 'updated', dropped: 'created' },
    arrive: { none: 'updated', created: 'created', updated: 'updated', destroyed: 'updated', dropped: 'created' },
    change: { none: 'updated', created: 'created', updated: 'updated', destroyed: 'destroyed', dropped: 'dropped' },
    gone: { none: 'destroyed', created: 'dropped', updated: 'destroyed', destroyed: 'destroyed', dropped: 'dropped' },
    invisible: { none: 'dropped', created: 'created', updated: 'updated', destroyed: 'destroyed', dropped: 'dropped' }
};

// An Email first seen in the safety window (`known`) starts as updated: the client may hold it already, so
// it is never reported as created, and a later destroy is reported instead of being left out (RFC 8620 5.2
// allows reporting an id again).
const emailFold = {
    key: entry => (entry.root || entry.message ? formatId('email', entry.root || entry.message) : null),
    fold(map, entry, known) {
        const id = this.key(entry);
        const effect = id && effectOf(entry);
        if (effect) {
            map.set(id, TRANSITIONS[effect][map.get(id) || (known ? 'updated' : 'none')]);
        }
    }
};

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const since = parseState(context, args.sinceState);
    const maxChanges = maxChangesOf(args);
    // messages in hidden mailboxes are not exposed, so their journal entries are skipped
    const { hidden } = await loadMailboxes(context);
    const filter = Object.assign({ message: { $exists: true } }, hidden.length ? { mailbox: { $nin: hidden } } : {});
    const entries = await entriesSince(context, since, filter);
    const { changes: folded, last, more } = await foldEntries(entries, emailFold, maxChanges);
    for (const [id, kind] of folded) {
        if (kind === 'dropped') {
            folded.delete(id);
        }
    }
    const { state } = await mailState(context);
    return {
        accountId: context.account.id,
        oldState: args.sinceState,
        newState: more ? formatState(context, last || since) : state,
        hasMoreChanges: more,
        ...changeLists(folded)
    };
}

module.exports = { capability: URN.mail, methods: { 'Email/changes': changes }, emailFold };
