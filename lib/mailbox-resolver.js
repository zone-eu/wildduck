'use strict';

const db = require('./db');
const consts = require('./consts');
const acl = require('./acl');

module.exports = {
    resolveMailbox,
    resolveMailboxAsync
};

/**
 * Resolves a folder path for a session into mailbox data.
 *
 * This is the single place where IMAP folder paths are mapped to mailbox documents.
 * Personal paths resolve against the mailboxes of the session user with the queries
 * the handlers have always used. If ACL support is enabled then paths under the
 * shared namespace prefix resolve against the owner's namespace and the rights the
 * session user holds for the mailbox.
 *
 * Users without any rights for an existing shared mailbox never learn about its
 * existence: such paths resolve exactly like missing mailboxes.
 *
 * Resolves with:
 *   mailboxData - mailbox document or false when not found or not visible
 *   path        - path in the owning user's namespace
 *   owner       - user id the mailbox belongs to
 *   ownerName   - canonical username of the owner for shared mailboxes
 *   shared      - true if the path pointed into the shared namespace
 *   rights      - rights string for shared mailboxes, false for unrestricted access
 *   denied      - true if the mailbox is visible but options.requireRights are missing
 *
 * @param {Object} server IMAP server instance
 * @param {Object} session Session object with user data
 * @param {String} path Folder path to resolve
 * @param {Object} [options] Resolving options
 * @param {String} [options.requireRights] Rights that must all be held for shared mailboxes
 * @returns {Promise<Object>} Resolving result
 */
async function resolveMailboxAsync(server, session, path, options) {
    options = options || {};

    let parsed = acl.isEnabled(server) ? acl.parsePath(path) : { shared: false, path };

    if (!parsed.shared) {
        let mailboxData = await db.database.collection('mailboxes').findOne(
            {
                user: session.user.id,
                path: parsed.path
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        );

        return {
            mailboxData: mailboxData || false,
            path: parsed.path,
            owner: session.user.id,
            ownerName: false,
            shared: false,
            rights: false,
            denied: false
        };
    }

    let notFound = {
        mailboxData: false,
        path: parsed.path,
        owner: false,
        ownerName: false,
        shared: true,
        rights: '',
        denied: false
    };

    if (!parsed.identifier || !parsed.path) {
        // "Other Users" and "Other Users/username" are virtual hierarchy entries
        return notFound;
    }

    let ownerData = await acl.asyncResolveIdentifier(parsed.identifier);
    if (!ownerData) {
        return notFound;
    }

    let mailboxData = await db.database.collection('mailboxes').findOne(
        {
            user: ownerData._id,
            path: parsed.path
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (!mailboxData) {
        return notFound;
    }

    let rights = await acl.asyncGetMailboxRights(mailboxData, session.user.id);
    if (!rights.length) {
        // do not disclose the existence of the mailbox
        return notFound;
    }

    let denied = ![]
        .concat(options.requireRights || [])
        .join('')
        .split('')
        .every(right => rights.indexOf(right) >= 0);

    return {
        mailboxData,
        path: parsed.path,
        owner: mailboxData.user,
        ownerName: ownerData.username,
        shared: true,
        rights,
        denied
    };
}

function resolveMailbox(server, session, path, options, callback) {
    if (!callback && typeof options === 'function') {
        callback = options;
        options = {};
    }

    resolveMailboxAsync(server, session, path, options)
        .then(resolved => callback(null, resolved))
        .catch(err => callback(err));
}
