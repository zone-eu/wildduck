'use strict';

const ObjectId = require('mongodb').ObjectId;
const db = require('./db');
const tools = require('./tools');
const consts = require('./consts');
const { SHARED_NAMESPACE_PREFIX, ACL_RIGHTS } = require('../imap-core/lib/imap-tools');

// All rights defined by RFC 4314 in canonical order ("lrswipkxtea"). The "p" (post)
// right is stored but has no effect as WildDuck mailboxes can not be posted to directly
const RIGHTS = Object.values(ACL_RIGHTS).join('');

module.exports = {
    RIGHTS,
    ACL_RIGHTS,
    SHARED_NAMESPACE_PREFIX,
    isEnabled,
    hasRight,
    validateRightsUpdate,
    normalizeRights,
    applyRights,
    parsePath,
    formatPath,
    resolveIdentifier,
    asyncResolveIdentifier,
    getMailboxRights,
    asyncGetMailboxRights,
    getGrant,
    asyncGetGrant,
    listGrants,
    asyncListGrants,
    setGrant,
    asyncSetGrant,
    deleteGrant,
    asyncDeleteGrant,
    getSharedMailboxes,
    asyncGetSharedMailboxes
};

/**
 * Splits a folder path into namespace information. Paths under the shared namespace
 * prefix resolve into an owner identifier and the path in the owner's namespace
 */
function parsePath(path) {
    path = (path || '').toString();

    if (path !== SHARED_NAMESPACE_PREFIX && path.indexOf(SHARED_NAMESPACE_PREFIX + '/') !== 0) {
        return { shared: false, path };
    }

    let parts = path.split('/');
    let identifier = parts[1] || '';
    let ownerParts = parts.slice(2);

    if (ownerParts.length && ownerParts[0].toUpperCase() === 'INBOX') {
        // INBOX is case insensitive
        ownerParts[0] = 'INBOX';
    }

    return {
        shared: true,
        identifier,
        path: ownerParts.join('/')
    };
}

/**
 * Formats a path in another user's namespace as a virtual path for the sharee
 */
function formatPath(identifier, path) {
    return SHARED_NAMESPACE_PREFIX + '/' + identifier + '/' + path;
}

/**
 * Checks if ACL support is enabled for the IMAP server instance
 */
function isEnabled(server) {
    return !!(server && server.options && server.options.acl);
}

/**
 * Checks if a rights string includes a right, eg. hasRight(rights, ACL_RIGHTS.EXPUNGE)
 */
function hasRight(rights, right) {
    return typeof rights === 'string' && rights.indexOf(right) >= 0;
}

/**
 * Checks if a rights argument from SETACL is syntactically valid. Accepts an optional
 * +/- modifier prefix and the obsolete RFC 2086 virtual rights "c" and "d"
 */
function validateRightsUpdate(rights) {
    return /^[+-]?[lrswipkxteacd]*$/i.test((rights || '').toString());
}

/**
 * Normalizes a rights string to canonical order. Maps the obsolete RFC 2086 virtual
 * rights ("c" to "k", "d" to "te"), removes duplicates and unknown rights
 */
function normalizeRights(rights) {
    let seen = new Set();
    (rights || '')
        .toString()
        .toLowerCase()
        .replace(/c/g, 'k')
        .replace(/d/g, 'te')
        .split('')
        .forEach(right => {
            if (RIGHTS.indexOf(right) >= 0) {
                seen.add(right);
            }
        });
    return RIGHTS.split('')
        .filter(right => seen.has(right))
        .join('');
}

/**
 * Applies a SETACL rights argument against an existing rights string. A "+" prefix adds
 * rights, a "-" prefix removes rights, no prefix replaces the existing rights
 */
function applyRights(existing, update) {
    update = (update || '').toString();

    let modifier = '';
    if (/^[+-]/.test(update)) {
        modifier = update.charAt(0);
        update = update.substr(1);
    }

    let rights = normalizeRights(update);

    switch (modifier) {
        case '+':
            return normalizeRights(normalizeRights(existing) + rights);
        case '-': {
            let removed = new Set(rights.split(''));
            return normalizeRights(existing)
                .split('')
                .filter(right => !removed.has(right))
                .join('');
        }
        default:
            return rights;
    }
}

/**
 * Resolves an ACL identifier (a username) to user data
 */
async function asyncResolveIdentifier(identifier) {
    identifier = (identifier || '').toString().trim();
    if (!identifier) {
        return false;
    }

    let userData = await db.users.collection('users').findOne(
        {
            unameview: tools.uview(identifier)
        },
        {
            projection: {
                _id: true,
                username: true
            },
            maxTimeMS: consts.DB_MAX_TIME_USERS
        }
    );

    return userData || false;
}

function resolveIdentifier(identifier, callback) {
    asyncResolveIdentifier(identifier)
        .then(userData => callback(null, userData))
        .catch(err => callback(err));
}

/**
 * Returns the rights string a user holds for a mailbox. The owner always holds all
 * rights, other users hold whatever their ACL entry grants
 */
async function asyncGetMailboxRights(mailboxData, user) {
    if (!mailboxData || !mailboxData.user || !user) {
        return '';
    }

    if (mailboxData.user.toString() === user.toString()) {
        return RIGHTS;
    }

    let aclData = await asyncGetGrant(mailboxData._id, user);
    return (aclData && normalizeRights(aclData.rights)) || '';
}

function getMailboxRights(mailboxData, user, callback) {
    asyncGetMailboxRights(mailboxData, user)
        .then(rights => callback(null, rights))
        .catch(err => callback(err));
}

/**
 * Returns the ACL entry of a user for a mailbox
 */
async function asyncGetGrant(mailbox, user) {
    let aclData = await db.database.collection('mailboxacls').findOne(
        {
            mailbox,
            user
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    return aclData || false;
}

function getGrant(mailbox, user, callback) {
    asyncGetGrant(mailbox, user)
        .then(aclData => callback(null, aclData))
        .catch(err => callback(err));
}

/**
 * Lists ACL entries of a mailbox with grantee usernames resolved from the users
 * collection. Entries whose grantee can not be resolved are filtered from the
 * listing but never deleted here: a missing user document might be a temporary
 * condition of a separate users database
 */
async function asyncListGrants(mailbox) {
    let aclList = await db.database
        .collection('mailboxacls')
        .find({
            mailbox
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    if (!aclList.length) {
        return [];
    }

    let users = await db.users
        .collection('users')
        .find({
            _id: { $in: aclList.map(aclData => aclData.user) }
        })
        .project({
            username: true
        })
        .maxTimeMS(consts.DB_MAX_TIME_USERS)
        .toArray();

    let usernames = new Map(users.map(userData => [userData._id.toString(), userData.username]));

    return aclList
        .filter(aclData => usernames.has(aclData.user.toString()))
        .map(aclData => ({
            user: aclData.user,
            username: usernames.get(aclData.user.toString()),
            rights: normalizeRights(aclData.rights),
            subscribed: aclData.subscribed !== false,
            created: aclData.created
        }));
}

function listGrants(mailbox, callback) {
    asyncListGrants(mailbox)
        .then(grants => callback(null, grants))
        .catch(err => callback(err));
}

/**
 * Creates or updates the ACL entry of a grantee for a mailbox. An empty rights string
 * removes the entry
 */
async function asyncSetGrant(mailboxData, grantee, rights) {
    rights = normalizeRights(rights);

    if (!rights) {
        await asyncDeleteGrant(mailboxData._id, grantee._id);
        return { removed: true };
    }

    let r = await db.database.collection('mailboxacls').updateOne(
        {
            mailbox: mailboxData._id,
            user: grantee._id
        },
        {
            $set: {
                rights
            }
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (r.matchedCount) {
        return { updated: true };
    }

    let existing = await db.database.collection('mailboxacls').countDocuments(
        {
            mailbox: mailboxData._id
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (existing >= consts.MAX_ACL_ENTRIES) {
        let err = new Error('Too many ACL entries for this mailbox');
        err.code = 'AclLimitReached';
        err.imapResponse = 'LIMIT';
        err.responseCode = 400;
        throw err;
    }

    try {
        await db.database.collection('mailboxacls').insertOne({
            mailbox: mailboxData._id,
            user: grantee._id,
            owner: mailboxData.user,
            rights,
            subscribed: true,
            created: new Date()
        });
    } catch (err) {
        if (err.code === 11000) {
            // lost the race against a concurrent insert, update the existing entry instead
            await db.database.collection('mailboxacls').updateOne(
                {
                    mailbox: mailboxData._id,
                    user: grantee._id
                },
                {
                    $set: {
                        rights
                    }
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                }
            );
            return { updated: true };
        }
        throw err;
    }

    return { created: true };
}

function setGrant(mailboxData, grantee, rights, callback) {
    asyncSetGrant(mailboxData, grantee, rights)
        .then(result => callback(null, result))
        .catch(err => callback(err));
}

/**
 * Removes the ACL entry of a grantee for a mailbox
 */
async function asyncDeleteGrant(mailbox, user) {
    let r = await db.database.collection('mailboxacls').deleteOne({
        mailbox,
        user
    });

    return { removed: r.deletedCount > 0 };
}

function deleteGrant(mailbox, user, callback) {
    asyncDeleteGrant(mailbox, user)
        .then(result => callback(null, result))
        .catch(err => callback(err));
}

/**
 * Lists mailboxes other users have shared with a user as mailbox entries with
 * virtual paths in the shared namespace. Only mailboxes with the "l" right are
 * returned and special use flags of other users are not exposed.
 *
 * Grants whose mailbox no longer exists are removed as a side effect (the mailboxes
 * collection lives in the same database, so a missing mailbox is authoritative).
 * Grants whose owner can not be resolved are only filtered: the users database
 * might be a separate, temporarily degraded cluster
 */
async function asyncGetSharedMailboxes(user, options) {
    options = options || {};

    let aclList = await db.database
        .collection('mailboxacls')
        .find({
            user
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    aclList = aclList.filter(
        aclData => hasRight(normalizeRights(aclData.rights), ACL_RIGHTS.LOOKUP) && (!options.subscribedOnly || aclData.subscribed !== false)
    );

    if (!aclList.length) {
        return [];
    }

    let mailboxes = await db.database
        .collection('mailboxes')
        .find({
            _id: { $in: aclList.map(aclData => aclData.mailbox) },
            hidden: { $ne: true }
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    let mailboxesById = new Map(mailboxes.map(mailboxData => [mailboxData._id.toString(), mailboxData]));

    // lazily remove grants that point to deleted mailboxes
    let orphaned = aclList.filter(aclData => !mailboxesById.has(aclData.mailbox.toString()));
    if (orphaned.length) {
        db.database
            .collection('mailboxacls')
            .deleteMany({
                _id: { $in: orphaned.map(aclData => aclData._id) }
            })
            .catch(() => false);
    }

    let owners = await db.users
        .collection('users')
        .find({
            _id: { $in: Array.from(new Set(mailboxes.map(mailboxData => mailboxData.user.toString()))).map(id => new ObjectId(id)) }
        })
        .project({
            username: true
        })
        .maxTimeMS(consts.DB_MAX_TIME_USERS)
        .toArray();

    let ownerNames = new Map(owners.map(userData => [userData._id.toString(), userData.username]));

    let result = [];
    for (let aclData of aclList) {
        let mailboxData = mailboxesById.get(aclData.mailbox.toString());
        if (!mailboxData) {
            continue;
        }
        let ownerName = ownerNames.get(mailboxData.user.toString());
        if (!ownerName) {
            continue;
        }
        let entry = Object.assign({}, mailboxData, {
            path: formatPath(ownerName, mailboxData.path)
        });
        // do not expose special use flags of other users
        delete entry.specialUse;
        result.push(entry);
    }

    return result;
}

function getSharedMailboxes(user, options, callback) {
    if (!callback && typeof options === 'function') {
        callback = options;
        options = {};
    }

    asyncGetSharedMailboxes(user, options)
        .then(result => callback(null, result))
        .catch(err => callback(err));
}
