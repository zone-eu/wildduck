'use strict';

// IMAP OBJECTID (RFC 8474): EMAILID, THREADID and MAILBOXID are the JMAP ids of the same objects
// (RFC 8621 1.6), so a client using both protocols sees one identity for each message, thread and
// mailbox. EMAILID follows the message root, which stays the same when a message moves.

const { formatId, parseId } = require('./jmap/ids');
const { rootOf } = require('./message-roots');

/** The formatters imap-core calls (server option objectIds); `message` needs root (or _id) and thread */
const objectIds = {
    email: message => formatId('email', rootOf(message)),
    thread: message => (message.thread ? formatId('thread', message.thread) : null),
    mailbox: mailbox => formatId('mailbox', mailbox)
};

/**
 * The messages query of a SEARCH EMAILID or THREADID key.
 *
 * @param {String} key emailid or threadid
 * @param {String} value the object id the client sent
 * @param {ObjectId} [user] owner of the mailbox searched; with it a THREADID condition can use the
 *   {user, thread} index (user_messages_by_thread) instead of scanning the mailbox
 * @returns {Object|null} a MongoDB condition, or null when the value is not an id of that kind
 */
function searchCondition(key, value, user) {
    if (key === 'threadid') {
        const thread = parseId('thread', value);
        return thread && (user ? { user, thread } : { thread });
    }
    const root = parseId('email', value);
    // a message stored before every message got a root is identified by its _id
    return root && { $or: [{ root }, { _id: root, root: { $exists: false } }] };
}

module.exports = { objectIds, searchCondition };
