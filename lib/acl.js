'use strict';

const db = require('./db');
const tools = require('./tools');
const consts = require('./consts');

// Rights defined by RFC 4314. The "p" (post) right is stored but has no effect as
// WildDuck mailboxes can not be posted to directly
const RIGHTS = 'lrswipkxtea';

module.exports = {
    RIGHTS,
    isEnabled,
    validateRightsUpdate,
    normalizeRights,
    applyRights,
    resolveIdentifier,
    asyncResolveIdentifier,
    getGrant,
    asyncGetGrant,
    listGrants,
    asyncListGrants,
    setGrant,
    asyncSetGrant,
    deleteGrant,
    asyncDeleteGrant
};

/**
 * Checks if ACL support is enabled for the IMAP server instance
 */
function isEnabled(server) {
    return !!(server && server.options && server.options.acl);
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
