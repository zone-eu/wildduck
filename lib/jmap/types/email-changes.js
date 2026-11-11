'use strict';

// Email/changes (RFC 8621 4.3) from the change journal.

const { URN } = require('../capabilities');
const { formatId } = require('../ids');
const { requireAccount, checkArguments } = require('./common');
const { mailState, parseState, entriesSince, maxChangesOf, foldEntries, changeLists, formatState } = require('../state');

// Folds journal entries into Email changes. A move (EXPUNGE then EXISTS of one root) is an update, a
// message created and destroyed inside the window is left out, and \Deleted set or cleared over IMAP
// reads as destroyed or created.
const emailFold = {
    key: entry => (entry.root || entry.message ? formatId('email', entry.root || entry.message) : null),
    fold(map, entry) {
        const id = this.key(entry);
        if (!id) {
            return;
        }
        const current = map.get(id);
        const gone = entry.command === 'EXPUNGE' || (entry.command === 'FETCH' && (entry.flags || []).some(flag => flag.toLowerCase() === '\\deleted'));
        if (gone) {
            if (current === 'created') {
                map.delete(id);
                map.set(id, 'dropped');
            } else {
                map.set(id, 'destroyed');
            }
        } else if (entry.command === 'EXISTS') {
            map.set(id, current === 'destroyed' ? 'updated' : current === 'dropped' || !current ? 'created' : current);
        } else if (entry.command === 'FETCH') {
            map.set(id, current === 'created' ? 'created' : 'updated');
        }
    }
};

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const since = parseState(context, args.sinceState);
    const maxChanges = maxChangesOf(args);
    const entries = await entriesSince(context, since, { message: { $exists: true } });
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
