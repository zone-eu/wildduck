'use strict';

// Which messages JMAP exposes, in one place: not flagged \Deleted, not in a hidden mailbox and not
// waiting for the garbage collector (exp with a passed rdate, for example the messages of a deleted
// mailbox). Every query on messages starts from visibleQuery(), every lookup by id checks isVisible().

const { loadMailboxes } = require('./types/mailbox');

// the message fields isVisible() reads, for projections of lookups by id
const VISIBILITY_FIELDS = { mailbox: true, undeleted: true, exp: true, rdate: true };

/**
 * The base query of the account's visible messages.
 *
 * @returns {Promise<Object>}
 */
async function visibleQuery(context) {
    const { hidden } = await loadMailboxes(context);
    const query = { user: context.account.user, undeleted: true, $nor: [{ exp: true, rdate: { $lte: Date.now() } }] };
    if (hidden.length) {
        query.mailbox = { $nin: hidden };
    }
    return query;
}

/**
 * A predicate for message documents loaded with VISIBILITY_FIELDS.
 *
 * @returns {Promise<Function>} doc => Boolean
 */
async function visibility(context) {
    const { hidden } = await loadMailboxes(context);
    const hiddenIds = new Set(hidden.map(id => id.toString()));
    const now = Date.now();
    return doc => doc.undeleted !== false && !(doc.exp && doc.rdate <= now) && !(doc.mailbox && hiddenIds.has(doc.mailbox.toString()));
}

module.exports = { visibleQuery, visibility, VISIBILITY_FIELDS };
