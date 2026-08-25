'use strict';

const db = require('./db');
const consts = require('./consts');

module.exports = {
    resolveMailbox,
    resolveMailboxAsync
};

/**
 * Resolves a folder path for a session into mailbox data.
 *
 * This is the single place where IMAP folder paths are mapped to mailbox documents.
 * Currently every path resolves against the mailboxes of the session user, matching
 * the queries the handlers have always used.
 *
 * Resolves with:
 *   mailboxData - mailbox document or false when not found
 *   path        - path in the owning user's namespace
 *   owner       - user id the mailbox belongs to
 *   shared      - true if the path pointed into a shared namespace
 *   rights      - rights string for shared mailboxes, false for unrestricted access
 *   denied      - true if the mailbox is visible but required rights are missing
 *
 * @param {Object} server IMAP server instance
 * @param {Object} session Session object with user data
 * @param {String} path Folder path to resolve
 * @returns {Promise<Object>} Resolving result
 */
async function resolveMailboxAsync(server, session, path) {
    let mailboxData = await db.database.collection('mailboxes').findOne(
        {
            user: session.user.id,
            path
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    return {
        mailboxData: mailboxData || false,
        path,
        owner: session.user.id,
        shared: false,
        rights: false,
        denied: false
    };
}

function resolveMailbox(server, session, path, callback) {
    resolveMailboxAsync(server, session, path)
        .then(resolved => callback(null, resolved))
        .catch(err => callback(err));
}
