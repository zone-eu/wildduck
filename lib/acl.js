'use strict';

const config = require('@zone-eu/wild-config');
const ObjectId = require('mongodb').ObjectId;
const db = require('./db');
const tools = require('./tools');
const consts = require('./consts');
const { OTHER_USERS_NAMESPACE_PREFIX, SHARED_NAMESPACE_PREFIX, ACL_RIGHTS } = require('../imap-core/lib/imap-tools');

// All rights defined by RFC 4314 in canonical order ("lrswipkxtea"). The "p" (post)
// right is stored but has no effect as WildDuck mailboxes can not be posted to directly
const RIGHTS = Object.values(ACL_RIGHTS).join('');

// Hierarchy prefixes of the grant based namespaces, keyed by namespace name.
// "other" holds mailboxes of other users, "shared" holds mailboxes of shared
// accounts (team mailboxes)
const NAMESPACES = {
    other: OTHER_USERS_NAMESPACE_PREFIX,
    shared: SHARED_NAMESPACE_PREFIX
};

module.exports = {
    RIGHTS,
    ACL_RIGHTS,
    OTHER_USERS_NAMESPACE_PREFIX,
    SHARED_NAMESPACE_PREFIX,
    ownerNamespace,
    isEnabled,
    hasRight,
    validateRightsUpdate,
    normalizeRights,
    formatResponseRights,
    applyRights,
    parsePath,
    formatPath,
    formatQuotaRoot,
    parseQuotaRoot,
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
    getAccountGrant,
    asyncGetAccountGrant,
    listAccountGrants,
    asyncListAccountGrants,
    setAccountGrant,
    asyncSetAccountGrant,
    deleteAccountGrant,
    asyncDeleteAccountGrant,
    getOwnerMailboxIds,
    asyncGetOwnerMailboxIds,
    getSharedMailboxes,
    asyncGetSharedMailboxes,
    asyncGetSharedEntries,
    listOwnerGrants,
    asyncListOwnerGrants,
    getTenantScope,
    checkTenantScope,
    asyncCheckTenantScope
};

/**
 * Returns the namespace name the mailboxes of an owner are exposed under: shared
 * accounts (team mailboxes) live in the shared namespace, mailboxes of regular
 * users in the other users namespace
 */
function ownerNamespace(ownerData) {
    return ownerData && ownerData.shared ? 'shared' : 'other';
}

/**
 * Splits a folder path into namespace information. Paths under a grant based
 * namespace prefix resolve into the namespace name, an owner identifier and the
 * path in the owner's namespace
 */
function parsePath(path) {
    path = (path || '').toString();

    for (let namespace of Object.keys(NAMESPACES)) {
        let prefix = NAMESPACES[namespace];
        if (path !== prefix && path.indexOf(prefix + '/') !== 0) {
            continue;
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
            namespace,
            identifier,
            path: ownerParts.join('/')
        };
    }

    return { shared: false, path };
}

/**
 * Formats a path in the owner's namespace as a virtual path for the sharee
 */
function formatPath(namespace, identifier, path) {
    return NAMESPACES[namespace] + '/' + identifier + '/' + path;
}

/**
 * Formats the quota root name for mailboxes owned by another account
 */
function formatQuotaRoot(namespace, identifier) {
    return NAMESPACES[namespace] + '/' + identifier;
}

/**
 * Splits a quota root name into namespace information. The quota root of another
 * account is a grant based namespace prefix followed by the username only
 */
function parseQuotaRoot(root) {
    root = (root || '').toString();

    for (let namespace of Object.keys(NAMESPACES)) {
        let prefix = NAMESPACES[namespace];
        if (root.indexOf(prefix + '/') !== 0) {
            continue;
        }

        return {
            shared: true,
            namespace,
            identifier: root.substr(prefix.length + 1)
        };
    }

    return { shared: false, root };
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
 * Returns the configured tenant scope for ACL grants. "domaingroup" (the default)
 * limits sharing to users of the same primary address domain or domain group,
 * "server" allows sharing between all users of the server
 */
function getTenantScope() {
    return config.imap && config.imap.acl && config.imap.acl.scope === 'server' ? 'server' : 'domaingroup';
}

/**
 * Returns the primary address domain of a user or false
 */
function getUserDomain(userData) {
    if (!userData || !userData.address || userData.address.indexOf('@') < 0) {
        return false;
    }
    return tools.normalizeDomain(userData.address.substr(userData.address.lastIndexOf('@') + 1));
}

/**
 * Loads the primary address of a user unless already provided
 */
async function loadUserAddress(user) {
    if (user && user.address) {
        return user;
    }

    let userId = user && user._id ? user._id : user;
    if (!userId) {
        return false;
    }

    let userData = await db.users.collection('users').findOne(
        {
            _id: userId
        },
        {
            projection: {
                address: true
            },
            maxTimeMS: consts.DB_MAX_TIME_USERS
        }
    );

    return userData || false;
}

/**
 * Returns tenant keys for a list of domains. Domains that belong to a domain group
 * share the key of the group, other domains only match themselves
 */
async function asyncGetTenantKeys(domains) {
    let groups = await db.users
        .collection('domaingroups')
        .find({
            domain: { $in: domains }
        })
        .maxTimeMS(consts.DB_MAX_TIME_USERS)
        .toArray();

    let groupMap = new Map(groups.map(groupData => [groupData.domain, groupData.group]));

    let keys = new Map();
    for (let domain of domains) {
        keys.set(domain, groupMap.has(domain) ? 'group:' + groupMap.get(domain) : 'domain:' + domain);
    }
    return keys;
}

/**
 * Checks if two users belong to the same tenant scope. With the "domaingroup" scope
 * users must share the primary address domain or their domains must belong to the
 * same domain group. Users without a primary address never match anyone
 */
async function asyncCheckTenantScope(owner, grantee) {
    if (getTenantScope() === 'server') {
        return true;
    }

    let [ownerData, granteeData] = await Promise.all([loadUserAddress(owner), loadUserAddress(grantee)]);

    let ownerDomain = getUserDomain(ownerData);
    let granteeDomain = getUserDomain(granteeData);

    if (!ownerDomain || !granteeDomain) {
        return false;
    }

    if (ownerDomain === granteeDomain) {
        return true;
    }

    let keys = await asyncGetTenantKeys([ownerDomain, granteeDomain]);
    return keys.get(ownerDomain) === keys.get(granteeDomain);
}

function checkTenantScope(owner, grantee, callback) {
    asyncCheckTenantScope(owner, grantee)
        .then(sameTenant => callback(null, sameTenant))
        .catch(err => callback(err));
}

/**
 * Checks if a rights argument from SETACL is syntactically valid. Accepts an optional
 * +/- modifier prefix and the obsolete RFC 2086 virtual rights "c" and "d".
 * Uppercase rights are not allowed by RFC 4314
 */
function validateRightsUpdate(rights) {
    return /^[+-]?[lrswipkxteacd]*$/.test((rights || '').toString());
}

/**
 * Normalizes a rights string to canonical order. Maps the obsolete RFC 2086 virtual
 * rights following the first pairing sanctioned by RFC 4314 section 2.1.1: "c" is the
 * union of "k" and "x", "d" is the union of "t" and "e". Removes duplicates and
 * unknown rights
 */
function normalizeRights(rights) {
    let seen = new Set();
    (rights || '')
        .toString()
        .toLowerCase()
        .replace(/c/g, 'kx')
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
 * Formats a rights string for ACL, MYRIGHTS and LISTRIGHTS responses. RFC 4314
 * section 2.1.1 requires the virtual "c" and "d" rights to be included whenever a
 * member right of theirs is present, so that RFC 2086 clients keep working.
 * Storage stays canonical, only responses carry the virtual rights
 */
function formatResponseRights(rights) {
    rights = normalizeRights(rights);
    let result = rights;
    if (hasRight(rights, ACL_RIGHTS.CREATE) || hasRight(rights, ACL_RIGHTS.DELETE_MAILBOX)) {
        result += 'c';
    }
    if (hasRight(rights, ACL_RIGHTS.DELETE_MESSAGES) || hasRight(rights, ACL_RIGHTS.EXPUNGE)) {
        result += 'd';
    }
    return result;
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
 * Resolves an ACL identifier (a username) to user data. Identifiers reserved by
 * RFC 4314 ("anyone", "anonymous" and dash prefixed negative rights identifiers)
 * never resolve, even if a user with such a name exists. With the grantee option
 * shared accounts do not resolve either: team mailboxes can not hold grants
 * themselves, only be granted from
 */
async function asyncResolveIdentifier(identifier, options) {
    options = options || {};

    identifier = (identifier || '').toString().trim();
    if (!identifier || identifier.charAt(0) === '-' || ['anyone', 'anonymous'].includes(identifier.toLowerCase())) {
        return false;
    }

    let userData = await db.users.collection('users').findOne(
        {
            unameview: tools.uview(identifier)
        },
        {
            projection: {
                _id: true,
                username: true,
                shared: true
            },
            maxTimeMS: consts.DB_MAX_TIME_USERS
        }
    );

    if (!userData || (options.grantee && userData.shared)) {
        return false;
    }

    return userData;
}

function resolveIdentifier(identifier, options, callback) {
    if (!callback && typeof options === 'function') {
        callback = options;
        options = {};
    }

    asyncResolveIdentifier(identifier, options)
        .then(userData => callback(null, userData))
        .catch(err => callback(err));
}

/**
 * Returns the rights string a user holds for a mailbox. The owner always holds all
 * rights. For everyone else the mailbox specific grant wins if it exists, otherwise
 * the account wide grant of the owner applies (RFC 4314 section 2: rights of the most
 * specific applicable entry). A mailbox grant always carries rights (an empty update
 * removes it), so its mere presence overrides the account grant, which is what lets a
 * single folder be narrowed below the account default
 */
async function asyncGetMailboxRights(mailboxData, user) {
    if (!mailboxData || !mailboxData.user || !user) {
        return '';
    }

    if (mailboxData.user.toString() === user.toString()) {
        return RIGHTS;
    }

    let aclData = await asyncGetGrant(mailboxData._id, user);
    if (aclData) {
        return normalizeRights(aclData.rights) || '';
    }

    let accountData = await asyncGetAccountGrant(mailboxData.user, user);
    return (accountData && normalizeRights(accountData.rights)) || '';
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
    let aclData = await db.database.collection('acls').findOne(
        {
            type: 'mailbox',
            resource: mailbox,
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
        .collection('acls')
        .find({
            type: 'mailbox',
            resource: mailbox
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

    let r = await db.database.collection('acls').updateOne(
        {
            type: 'mailbox',
            resource: mailboxData._id,
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

    let existing = await db.database.collection('acls').countDocuments(
        {
            type: 'mailbox',
            resource: mailboxData._id
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
        await db.database.collection('acls').insertOne({
            type: 'mailbox',
            resource: mailboxData._id,
            user: grantee._id,
            owner: mailboxData.user,
            rights,
            subscribed: true,
            created: new Date()
        });
    } catch (err) {
        if (err.code === 11000) {
            // lost the race against a concurrent insert, update the existing entry instead
            await db.database.collection('acls').updateOne(
                {
                    type: 'mailbox',
                    resource: mailboxData._id,
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
    let r = await db.database.collection('acls').deleteOne({
        type: 'mailbox',
        resource: mailbox,
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
 * Returns the account wide ACL entry a grantee holds for an owner. Account grants are
 * not tied to a specific mailbox: they carry a null resource and are keyed by the owner
 */
async function asyncGetAccountGrant(owner, user) {
    let aclData = await db.database.collection('acls').findOne(
        {
            type: 'mailbox',
            resource: null,
            owner,
            user
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    return aclData || false;
}

function getAccountGrant(owner, user, callback) {
    asyncGetAccountGrant(owner, user)
        .then(aclData => callback(null, aclData))
        .catch(err => callback(err));
}

/**
 * Lists the account wide ACL entries of an owner with grantee usernames resolved.
 * Entries whose grantee can not be resolved are filtered from the listing but never
 * deleted here, mirroring asyncListGrants
 */
async function asyncListAccountGrants(owner) {
    let aclList = await db.database
        .collection('acls')
        .find({
            type: 'mailbox',
            resource: null,
            owner
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

function listAccountGrants(owner, callback) {
    asyncListAccountGrants(owner)
        .then(grants => callback(null, grants))
        .catch(err => callback(err));
}

/**
 * Returns the ids of every mailbox an owner has. Used to fan a DROP notification across
 * an owner's mailboxes when an account wide grant is narrowed, since the notifier only
 * kicks a session whose selected mailbox matches the payload
 */
async function asyncGetOwnerMailboxIds(owner) {
    let mailboxes = await db.database
        .collection('mailboxes')
        .find({
            user: owner
        })
        .project({
            _id: true
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    return mailboxes.map(mailboxData => mailboxData._id);
}

function getOwnerMailboxIds(owner, callback) {
    asyncGetOwnerMailboxIds(owner)
        .then(ids => callback(null, ids))
        .catch(err => callback(err));
}

/**
 * Creates or updates the account wide ACL entry of a grantee for an owner. An empty
 * rights string removes the entry. Mirrors asyncSetGrant but targets the owner rather
 * than a single mailbox
 */
async function asyncSetAccountGrant(ownerData, grantee, rights) {
    rights = normalizeRights(rights);

    if (!rights) {
        await asyncDeleteAccountGrant(ownerData._id, grantee._id);
        return { removed: true };
    }

    let r = await db.database.collection('acls').updateOne(
        {
            type: 'mailbox',
            resource: null,
            owner: ownerData._id,
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

    let existing = await db.database.collection('acls').countDocuments(
        {
            type: 'mailbox',
            resource: null,
            owner: ownerData._id
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (existing >= consts.MAX_ACL_ENTRIES) {
        let err = new Error('Too many ACL entries for this account');
        err.code = 'AclLimitReached';
        err.imapResponse = 'LIMIT';
        err.responseCode = 400;
        throw err;
    }

    try {
        await db.database.collection('acls').insertOne({
            type: 'mailbox',
            resource: null,
            owner: ownerData._id,
            user: grantee._id,
            rights,
            subscribed: true,
            created: new Date()
        });
    } catch (err) {
        if (err.code === 11000) {
            // lost the race against a concurrent insert, update the existing entry instead
            await db.database.collection('acls').updateOne(
                {
                    type: 'mailbox',
                    resource: null,
                    owner: ownerData._id,
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

function setAccountGrant(ownerData, grantee, rights, callback) {
    asyncSetAccountGrant(ownerData, grantee, rights)
        .then(result => callback(null, result))
        .catch(err => callback(err));
}

/**
 * Removes the account wide ACL entry of a grantee for an owner
 */
async function asyncDeleteAccountGrant(owner, user) {
    let r = await db.database.collection('acls').deleteOne({
        type: 'mailbox',
        resource: null,
        owner,
        user
    });

    return { removed: r.deletedCount > 0 };
}

function deleteAccountGrant(owner, user, callback) {
    asyncDeleteAccountGrant(owner, user)
        .then(result => callback(null, result))
        .catch(err => callback(err));
}

/**
 * Lists the ACL entries other users have granted to a user, joined with mailbox and
 * owner data and filtered by the tenant scope. Returns {aclData, mailboxData,
 * ownerData} entries.
 *
 * Grants whose mailbox no longer exists are removed as a side effect (the mailboxes
 * collection lives in the same database, so a missing mailbox is authoritative).
 * Grants whose owner can not be resolved are only filtered: the users database
 * might be a separate, temporarily degraded cluster
 */
async function asyncGetSharedEntries(user, options) {
    options = options || {};

    let aclList = await db.database
        .collection('acls')
        .find({
            type: 'mailbox',
            resource: { $ne: null },
            user
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    if (options.requireLookup) {
        aclList = aclList.filter(aclData => hasRight(normalizeRights(aclData.rights), ACL_RIGHTS.LOOKUP));
    }

    if (options.subscribedOnly) {
        aclList = aclList.filter(aclData => aclData.subscribed !== false);
    }

    if (!aclList.length) {
        return [];
    }

    let mailboxes = await db.database
        .collection('mailboxes')
        .find({
            _id: { $in: aclList.map(aclData => aclData.resource) },
            hidden: { $ne: true }
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    let mailboxesById = new Map(mailboxes.map(mailboxData => [mailboxData._id.toString(), mailboxData]));

    // lazily remove grants that point to deleted mailboxes
    let orphaned = aclList.filter(aclData => !mailboxesById.has(aclData.resource.toString()));
    if (orphaned.length) {
        db.database
            .collection('acls')
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
            username: true,
            address: true,
            shared: true
        })
        .maxTimeMS(consts.DB_MAX_TIME_USERS)
        .toArray();

    let ownersById = new Map(owners.map(userData => [userData._id.toString(), userData]));

    // resolve tenant keys for the user and all owners with a single group lookup
    let tenantKeys = false;
    let userKey = false;
    if (getTenantScope() !== 'server') {
        let granteeData = await loadUserAddress(user);
        let granteeDomain = getUserDomain(granteeData);
        if (!granteeDomain) {
            // without a primary address domain nothing is shared with the user
            return [];
        }

        let domains = new Set([granteeDomain]);
        for (let ownerData of owners) {
            let ownerDomain = getUserDomain(ownerData);
            if (ownerDomain) {
                domains.add(ownerDomain);
            }
        }

        tenantKeys = await asyncGetTenantKeys(Array.from(domains));
        userKey = tenantKeys.get(granteeDomain);
    }

    let result = [];
    for (let aclData of aclList) {
        let mailboxData = mailboxesById.get(aclData.resource.toString());
        if (!mailboxData) {
            continue;
        }
        let ownerData = ownersById.get(mailboxData.user.toString());
        if (!ownerData) {
            continue;
        }
        if (tenantKeys) {
            let ownerDomain = getUserDomain(ownerData);
            if (!ownerDomain || tenantKeys.get(ownerDomain) !== userKey) {
                // the owner is not in the same tenant scope
                continue;
            }
        }
        result.push({ aclData, mailboxData, ownerData });
    }

    return result;
}

/**
 * Lists mailboxes other users have shared with a user as mailbox entries with
 * virtual paths in the shared namespace. Only mailboxes with the "l" right are
 * returned and special use flags of other users are not exposed
 */
async function asyncGetSharedMailboxes(user, options) {
    options = options || {};

    let entries = await asyncGetSharedEntries(user, {
        requireLookup: true,
        subscribedOnly: options.subscribedOnly
    });

    return entries.map(({ mailboxData, ownerData }) => {
        let entry = Object.assign({}, mailboxData, {
            path: formatPath(ownerNamespace(ownerData), ownerData.username, mailboxData.path)
        });
        // do not expose special use flags of other users
        delete entry.specialUse;
        return entry;
    });
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

/**
 * Lists the ACL entries of all mailboxes a user owns, with grantee usernames
 * resolved. Entries whose grantee can not be resolved are filtered from the
 * listing but never deleted here. Grants pointing to deleted mailboxes are
 * removed as a side effect
 */
async function asyncListOwnerGrants(owner) {
    let aclList = await db.database
        .collection('acls')
        .find({
            type: 'mailbox',
            resource: { $ne: null },
            owner
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    if (!aclList.length) {
        return [];
    }

    let mailboxes = await db.database
        .collection('mailboxes')
        .find({
            _id: { $in: aclList.map(aclData => aclData.resource) }
        })
        .project({
            path: true
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray();

    let mailboxesById = new Map(mailboxes.map(mailboxData => [mailboxData._id.toString(), mailboxData]));

    // lazily remove grants that point to deleted mailboxes
    let orphaned = aclList.filter(aclData => !mailboxesById.has(aclData.resource.toString()));
    if (orphaned.length) {
        db.database
            .collection('acls')
            .deleteMany({
                _id: { $in: orphaned.map(aclData => aclData._id) }
            })
            .catch(() => false);
    }

    let grantees = await db.users
        .collection('users')
        .find({
            _id: { $in: aclList.map(aclData => aclData.user) }
        })
        .project({
            username: true
        })
        .maxTimeMS(consts.DB_MAX_TIME_USERS)
        .toArray();

    let usernames = new Map(grantees.map(userData => [userData._id.toString(), userData.username]));

    return aclList
        .filter(aclData => mailboxesById.has(aclData.resource.toString()) && usernames.has(aclData.user.toString()))
        .map(aclData => ({
            mailbox: aclData.resource,
            path: mailboxesById.get(aclData.resource.toString()).path,
            user: aclData.user,
            username: usernames.get(aclData.user.toString()),
            rights: normalizeRights(aclData.rights),
            subscribed: aclData.subscribed !== false,
            created: aclData.created
        }));
}

function listOwnerGrants(owner, callback) {
    asyncListOwnerGrants(owner)
        .then(result => callback(null, result))
        .catch(err => callback(err));
}
