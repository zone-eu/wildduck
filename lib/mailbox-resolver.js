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
 * the handlers have always used. If ACL support is enabled then paths under a grant
 * based namespace prefix resolve against the owner's namespace and the rights the
 * session user holds for the mailbox. The namespace must match the kind of the
 * owner: mailboxes of shared accounts (team mailboxes) are only reachable through
 * the shared namespace, mailboxes of regular users only through the other users
 * namespace.
 *
 * Users without any rights for an existing shared mailbox never learn about its
 * existence: such paths resolve exactly like missing mailboxes.
 *
 * Resolves with:
 *   mailboxData    - mailbox document or false when not found or not visible
 *   account        - true if the path is the account node itself (mailboxData is false);
 *                    the ACL commands act on the owner's account wide grant in this case
 *   path           - path in the owning user's namespace
 *   owner          - user id the mailbox belongs to
 *   ownerName      - canonical username of the owner for shared mailboxes
 *   ownerNamespace - namespace name of the owner for shared mailboxes
 *   shared         - true if the path pointed into a grant based namespace
 *   rights         - rights string for shared mailboxes, false for unrestricted access
 *   denied         - true if the mailbox is visible but options.requireRights are missing
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
            ownerNamespace: false,
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
        ownerNamespace: false,
        shared: true,
        rights: '',
        denied: false
    };

    if (!parsed.identifier) {
        // the namespace prefixes themselves ("Shared/", "Other Users/") are virtual
        // hierarchy entries with no owner
        return notFound;
    }

    let ownerData = await acl.asyncResolveIdentifier(parsed.identifier);
    if (!ownerData) {
        return notFound;
    }

    if (acl.ownerNamespace(ownerData) !== parsed.namespace) {
        // the namespace must match the kind of the owner: team mailboxes are only
        // reachable through the shared namespace, mailboxes of regular users only
        // through the other users namespace
        return notFound;
    }

    let isOwner = ownerData._id.toString() === session.user.id.toString();

    let requireRights = []
        .concat(options.requireRights || [])
        .join('')
        .split('');

    if (!parsed.path) {
        // the account node itself (eg. "Shared/<team>", "Other Users/<user>") is not a
        // selectable mailbox, but the ACL commands act on the owner's account wide grant
        let rights;
        if (isOwner) {
            rights = acl.RIGHTS;
        } else {
            let accountGrant = await acl.asyncGetAccountGrant(ownerData._id, session.user.id);
            rights = (accountGrant && acl.normalizeRights(accountGrant.rights)) || '';
        }

        if (!rights.length) {
            // without an account wide grant the node must appear nonexistent
            return notFound;
        }

        if (!isOwner && !(await acl.asyncCheckTenantScope(ownerData._id, session.user.id))) {
            // grants that cross the tenant scope behave as if they do not exist
            return notFound;
        }

        return {
            mailboxData: false,
            account: true,
            path: '',
            owner: ownerData._id,
            ownerName: ownerData.username,
            ownerNamespace: acl.ownerNamespace(ownerData),
            shared: true,
            rights,
            denied: !requireRights.every(right => rights.indexOf(right) >= 0)
        };
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

    if (!isOwner && !(await acl.asyncCheckTenantScope(mailboxData.user, session.user.id))) {
        // grants that cross the tenant scope behave as if they do not exist
        return notFound;
    }

    return {
        mailboxData,
        path: parsed.path,
        owner: mailboxData.user,
        ownerName: ownerData.username,
        ownerNamespace: acl.ownerNamespace(ownerData),
        shared: true,
        rights,
        denied: !requireRights.every(right => rights.indexOf(right) >= 0)
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
