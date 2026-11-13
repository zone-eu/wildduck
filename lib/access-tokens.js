'use strict';

// Verification of user access tokens (the 40 hex character tokens POST /authenticate issues with
// token: true), shared by the REST API and the JMAP service so both accept exactly the same tokens.

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const consts = require('./consts');

const TOKEN_FORMAT = /^[a-fA-F0-9]{40}$/;

// The data a token record was signed over; tokens issued before authVersion existed sign less
function signedData(accessToken, tokenData) {
    if (!('authVersion' in tokenData)) {
        return { token: accessToken, user: tokenData.user, role: tokenData.role };
    }
    const data = { token: accessToken, user: tokenData.user, authVersion: tokenData.authVersion, role: tokenData.role };
    if ('mfaRequired' in tokenData || 'mfaVerified' in tokenData || 'passwordChangeRequired' in tokenData) {
        data.mfaRequired = tokenData.mfaRequired;
        data.mfaVerified = tokenData.mfaVerified;
        data.passwordChangeRequired = tokenData.passwordChangeRequired;
    }
    return data;
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/**
 * Whether a token record was signed for this token with this secret. Reads and changes nothing, so a
 * long lived request can check its token again without refreshing the token's session.
 *
 * @param {String} accessToken The token as presented
 * @param {Object} tokenData The tn:token:<hash> record
 * @param {String} secret accessControl.secret
 * @returns {Boolean}
 */
function validSignature(accessToken, tokenData, secret) {
    if (!tokenData || typeof tokenData.s !== 'string') {
        return false;
    }
    const data = 'authVersion' in tokenData ? Object.assign({}, tokenData, { authVersion: Number(tokenData.authVersion) || 0 }) : tokenData;
    return hmac(secret, JSON.stringify(signedData(accessToken, data))) === tokenData.s;
}

// For a token with a lifetime: checks the age, refreshes the TTL and works out its 2FA assurance.
// Returns null for an expired token (and removes it).
async function checkSession(accessToken, tokenHash, tokenData, options) {
    const tokenTTL = Number(tokenData.ttl);
    const tokenLifetime = options.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME;
    if ((Date.now() - Number(tokenData.created)) / 1000 >= tokenLifetime) {
        await options.redis.del('tn:token:' + tokenHash).catch(() => false);
        return null;
    }

    const assuranceRecorded = 'mfaRequired' in tokenData && 'mfaVerified' in tokenData && 'passwordChangeRequired' in tokenData;
    const mfaRequired = assuranceRecorded && tokenData.mfaRequired === 'true';
    let mfaVerified = assuranceRecorded && tokenData.mfaVerified === 'true';
    // set when a later 2FA completion verified this token through the side key
    let mfaProofVerified = false;
    if (mfaRequired && !mfaVerified) {
        try {
            const proof = await options.redis.get('tn:token:mfa:' + tokenHash);
            mfaProofVerified = proof === options.userHandler.getAuthTokenMfaProof(tokenHash, tokenData.user, tokenData.authVersion);
        } catch {
            // treat as unverified
        }
        mfaVerified = mfaProofVerified;
    }

    // token is still usable, increase session length
    try {
        const refresh = options.redis.multi().expire('tn:token:' + tokenHash, tokenTTL);
        if (mfaProofVerified) {
            refresh.expire('tn:token:mfa:' + tokenHash, tokenTTL);
        }
        await refresh.exec();
    } catch {
        // ignore
    }

    return { assuranceRecorded, mfaRequired, mfaVerified, passwordChangeRequired: assuranceRecorded && tokenData.passwordChangeRequired === 'true' };
}

/**
 * Verifies a user access token.
 *
 * @param {String} accessToken The token as presented
 * @param {Object} options {redis, users (users database), userHandler, secret (accessControl.secret), roles (configured role names), tokenLifetime,
 *   projection (more user fields to read)}
 * @returns {Promise<Object|null>} null for an unknown, invalid, expired or revoked token, otherwise
 *   {role, user, hash, authVersion, session, userData} where session (2FA assurance) is null for tokens without a lifetime
 * @throws {Error} InternalDatabaseError when the token store can not be read
 */
async function verifyAccessToken(accessToken, options) {
    if (typeof accessToken !== 'string' || !TOKEN_FORMAT.test(accessToken)) {
        return null;
    }
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');

    let tokenData;
    try {
        tokenData = await options.redis.hgetall('tn:token:' + tokenHash);
    } catch (err) {
        err.responseCode = 500;
        err.code = 'InternalDatabaseError';
        throw err;
    }
    if (!tokenData || !tokenData.user || !tokenData.role || !options.roles[tokenData.role]) {
        return null;
    }
    if ('authVersion' in tokenData) {
        tokenData.authVersion = Number(tokenData.authVersion) || 0;
    }

    if (!validSignature(accessToken, tokenData, options.secret)) {
        // rogue token or invalidated secret
        return null;
    }

    let session = null;
    if (tokenData.ttl && !isNaN(tokenData.ttl) && Number(tokenData.ttl) > 0) {
        session = await checkSession(accessToken, tokenHash, tokenData, options);
        if (!session) {
            return null;
        }
    }

    let userData = null;
    if (/^[0-9a-f]{24}$/i.test(tokenData.user)) {
        // callers may want more fields of the user (options.projection), read in the same lookup
        const projection = Object.assign({ authVersion: true, disabled: true, suspended: true }, options.projection);
        userData = await options.users.collection('users').findOne({ _id: new ObjectId(tokenData.user) }, { projection });
        // unknown user, expired session (the password or 2FA changed since), or a locked out account
        if (!userData || (Number(tokenData.authVersion) || 0) < (Number(userData.authVersion) || 0) || userData.disabled || userData.suspended) {
            return null;
        }
    }

    return { role: tokenData.role, user: tokenData.user, hash: tokenHash, authVersion: tokenData.authVersion, session, userData };
}

module.exports = { verifyAccessToken, validSignature };
