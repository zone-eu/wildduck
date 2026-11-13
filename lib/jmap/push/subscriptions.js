'use strict';

// PushSubscription records (RFC 8620 7.2) in the jmap.push collection.
//
// A subscription belongs to the credentials that created it, not only to the user: an application
// password, the account password (for one authVersion) or one access token. Only those credentials see
// it, and it ends with them: deleting the application password, changing the account password or the
// token running out destroys it. The binding is checked before every push and whenever the user
// handler announces a credential change.
//
//   {_id, user, cred: 'asp:<id>' | 'pw' | 'tok:<token hash>', asp, token, authVersion,
//    deviceClientId, url, keys: {p256dh, auth} | null, types: [..] | null, expires,
//    verificationCode, verified, verifyFailures, verifyBy, vapid: key id, created, purgeAt,
//    pushed: {type: state} (states of the last push), attempt, retryAt, failures}

const { ObjectId } = require('mongodb');
const consts = require('../../consts');
const tools = require('../../tools');

const COLLECTION = 'jmap.push';
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
const USER_PROJECTION = { authVersion: true, disabled: true, suspended: true, disabledScopes: true };

const collection = deps => deps.database.collection(COLLECTION);

/**
 * The credentials of a request: {cred, asp, token, authVersion}.
 *
 * @param {Object} userData the authenticated user (authAsp for an application password, authToken for a Bearer token)
 */
function credentialsOf(userData) {
    const authVersion = Number(userData.authVersion) || 0;
    if (userData.authToken) {
        return { cred: `tok:${userData.authToken}`, token: userData.authToken, authVersion };
    }
    if (userData.authAsp) {
        return { cred: `asp:${userData.authAsp}`, asp: new ObjectId(userData.authAsp), authVersion };
    }
    return { cred: 'pw', authVersion };
}

/** True while an unverified subscription may still be verified and a subscription has not expired */
const alive = (doc, now) => doc.expires > now && (doc.verified || !doc.verifyBy || doc.verifyBy > now);

/**
 * The live subscriptions of a set of credentials. Expired ones, and unverified ones past their grace
 * period, are removed on the way (a TTL index removes the rest).
 */
async function listOwned(deps, user, cred, limit) {
    const docs = await collection(deps).find({ user, cred }, { maxTimeMS: MAX_TIME_MS }).limit(limit).toArray();
    const now = new Date();
    const dead = docs.filter(doc => !alive(doc, now));
    if (dead.length) {
        await collection(deps).deleteMany({ _id: { $in: dead.map(doc => doc._id) }, user });
    }
    return docs.filter(doc => alive(doc, now));
}

/**
 * Whether the credentials of a subscription are still good.
 *
 * @param {Object} deps {users, redis}
 * @param {Object} doc the subscription
 * @param {Object} options {tokenLifetime: seconds, userData: the user document when already read}
 * @returns {Promise<'ok'|'inactive'|'revoked'>} inactive: the account can not use JMAP right now
 *   (disabled, suspended, scope disabled); revoked: the credentials are gone for good
 */
async function bindingOf(deps, doc, options = {}) {
    const userData =
        options.userData !== undefined
            ? options.userData
            : await deps.users.collection('users').findOne({ _id: doc.user }, { projection: USER_PROJECTION, maxTimeMS: MAX_TIME_MS });
    if (!userData) {
        return 'revoked';
    }
    const authVersion = Number(userData.authVersion) || 0;
    if (doc.asp) {
        const asp = await deps.users
            .collection('asps')
            .findOne({ _id: doc.asp, user: doc.user }, { projection: { _id: true, expires: true }, maxTimeMS: MAX_TIME_MS });
        if (!asp || tools.aspExpired(asp)) {
            return 'revoked';
        }
    } else if (doc.token) {
        const token = await deps.redis.hgetall(`tn:token:${doc.token}`);
        const lifetime = (options.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME) * 1000;
        if (
            !token ||
            token.user !== doc.user.toString() ||
            (Number(token.authVersion) || 0) < authVersion ||
            (Number(token.ttl) > 0 && Date.now() - Number(token.created) >= lifetime)
        ) {
            return 'revoked';
        }
    } else if (authVersion !== doc.authVersion) {
        return 'revoked';
    }
    if (userData.disabled || userData.suspended || (userData.disabledScopes || []).includes('jmap')) {
        return 'inactive';
    }
    return 'ok';
}

/**
 * Removes the subscriptions of a user whose credentials are gone (after a password change, deletion of
 * an application password or of the user).
 *
 * @returns {Promise<Number>} how many were removed
 */
async function removeRevoked(deps, user, options = {}) {
    const docs = await collection(deps)
        .find({ user }, { projection: { _id: true, user: true, asp: true, token: true, authVersion: true }, maxTimeMS: MAX_TIME_MS })
        .limit(1000)
        .toArray();
    if (!docs.length) {
        return 0;
    }
    const userData = await deps.users.collection('users').findOne({ _id: user }, { projection: USER_PROJECTION, maxTimeMS: MAX_TIME_MS });
    const revoked = [];
    for (const doc of docs) {
        if ((await bindingOf(deps, doc, Object.assign({}, options, { userData }))) === 'revoked') {
            revoked.push(doc._id);
        }
    }
    if (revoked.length) {
        await collection(deps).deleteMany({ _id: { $in: revoked }, user });
    }
    return revoked.length;
}

module.exports = { COLLECTION, MAX_TIME_MS, USER_PROJECTION, collection, credentialsOf, listOwned, bindingOf, removeRevoked, alive };
