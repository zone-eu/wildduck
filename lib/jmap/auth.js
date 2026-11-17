'use strict';

// Authentication of JMAP requests (RFC 8620 8.2): Bearer user access tokens, and HTTP Basic with an
// application specific password that has the jmap scope (or the account password while 2FA is off).
//
// HTTP is stateless and clients send the same Basic credentials with every request, while checking an
// application password costs a password hash. A verified credential is therefore remembered in Redis for
// a few minutes, under an HMAC of the credential (never the credential itself) and together with the
// account's authVersion, so changing the password or 2FA setup ends the cached entry at once. Failed
// attempts are never cached and go through the user handler, which applies the usual failure limits.

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { verifyAccessToken, validSignature, tokenSecretProof } = require('../access-tokens');
const consts = require('../consts');
const tools = require('../tools');

const SCOPE = 'jmap';
const USER_PROJECTION = { projection: { username: true, address: true, name: true, authVersion: true, disabled: true, suspended: true, disabledScopes: true } };

class AuthError extends Error {
    /**
     * @param {String} message
     * @param {Number} [status=401] 429 while the account is locked out by failed logins
     * @param {Number} [retryAfter] Seconds until a locked out account can try again
     */
    constructor(message, status, retryAfter) {
        super(message);
        this.status = status || 401;
        this.retryAfter = retryAfter;
    }
}

const usable = userData => userData && !userData.disabled && !userData.suspended && !(userData.disabledScopes || []).includes(SCOPE);

/**
 * Whether a verified access token is a JMAP credential: a user token (role user) of a user account, with
 * its assurance state recorded at issue (tokens issued before that existed, and tokens without a lifetime,
 * have none), its 2FA step done and no password change pending.
 */
function acceptedToken(verified) {
    const session = verified && verified.session;
    if (!session || verified.role !== 'user' || !session.assuranceRecorded) {
        return false;
    }
    return !(session.mfaRequired && !session.mfaVerified) && !session.passwordChangeRequired;
}

function parseBasic(value) {
    let decoded;
    try {
        decoded = Buffer.from(value, 'base64').toString('utf8');
    } catch {
        return null;
    }
    const separator = decoded.indexOf(':');
    if (separator <= 0) {
        return null;
    }
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

class JmapAuth {
    /**
     * @param {Object} options {redis, users (users database), userHandler, accessSecret, roles, tokenLifetime, cacheSecret, cacheTtl (seconds)}
     */
    constructor(options) {
        this.options = options;
    }

    async loadUser(id) {
        return this.options.users.collection('users').findOne({ _id: new ObjectId(id) }, USER_PROJECTION);
    }

    /** True while the account may use JMAP (exists, not disabled or suspended, jmap scope not disabled) */
    async usableUser(id) {
        return usable(await this.loadUser(id));
    }

    async fromBearer(token) {
        const verified = await verifyAccessToken(token, {
            redis: this.options.redis,
            users: this.options.users,
            userHandler: this.options.userHandler,
            secret: this.options.accessSecret,
            roles: this.options.roles,
            tokenLifetime: this.options.tokenLifetime,
            // the user fields JMAP needs, read in the lookup the token check makes anyway
            projection: USER_PROJECTION.projection
        });
        // verifyAccessToken loads the user only for a user id, so usable() also refuses other subjects
        if (!acceptedToken(verified) || !usable(verified.userData)) {
            return null;
        }
        // the token a PushSubscription created with it is bound to (by hash, the token itself is not kept);
        // the proof that ties the subscription to the token's signature is computed only when a
        // subscription needs it, not on every request
        const secret = this.options.accessSecret;
        const userData = Object.assign(verified.userData, { authToken: verified.hash });
        Object.defineProperty(userData, 'authTokenProof', {
            get: () => tokenSecretProof(verified.hash, verified.signature, secret),
            enumerable: false
        });
        return userData;
    }

    /**
     * Checks again that the credential a long lived request (an event stream) was opened with is still
     * good, without side effects: no password hashing, no failure counting, no refresh of the token TTL.
     * Costs one user read plus one Redis read for a Bearer token, one user read (and one application
     * password read) for Basic.
     *
     * @param {String} header The Authorization header the request was authenticated with
     * @param {Object} userData The user document authenticate() answered for it
     * @returns {Promise<Boolean>}
     */
    async stillValid(header, userData) {
        if (userData.authToken) {
            const match = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
            return !!match && this.bearerStillValid(match[1], userData);
        }
        const cached = { user: userData._id.toString(), authVersion: String(Number(userData.authVersion) || 0), asp: userData.authAsp || '' };
        return !!(await this.fromCache(cached));
    }

    // the token record still exists (not revoked, not idle expired), is signed with the current secret,
    // has not outlived the token lifetime, and the account's authVersion has not moved past it
    async bearerStillValid(token, userData) {
        const [tokenData, current] = await Promise.all([this.options.redis.hgetall(`tn:token:${userData.authToken}`), this.loadUser(userData._id)]);
        if (!tokenData || tokenData.role !== 'user' || !validSignature(token, tokenData, this.options.accessSecret)) {
            return false;
        }
        const lifetime = (this.options.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME) * 1000;
        if (!(Date.now() - Number(tokenData.created) < lifetime)) {
            return false;
        }
        return usable(current) && (Number(tokenData.authVersion) || 0) >= (Number(current.authVersion) || 0);
    }

    cacheKey(credentials) {
        const mac = crypto.createHmac('sha256', this.options.cacheSecret).update(`${credentials.username}\0${credentials.password}`).digest('hex');
        return `jmap:auth:${mac}`;
    }

    // a cached credential stays valid while the account is usable, its authVersion is unchanged and,
    // for an application password, that password still exists
    async fromCache(cached) {
        const userData = await this.loadUser(cached.user);
        if (!usable(userData) || String(Number(userData.authVersion) || 0) !== cached.authVersion) {
            return null;
        }
        if (cached.asp) {
            const asp = await this.options.users
                .collection('asps')
                .findOne({ _id: new ObjectId(cached.asp), user: userData._id }, { projection: { _id: true, expires: true } });
            if (!asp || tools.aspExpired(asp)) {
                return null;
            }
        }
        return userData;
    }

    async fromBasic(credentials, meta) {
        const key = this.cacheKey(credentials);
        const cached = await this.options.redis.hgetall(key).catch(() => null);
        if (cached && cached.user) {
            const userData = await this.fromCache(cached);
            if (userData) {
                // a warm cache entry does not outlive a lockout caused by failed logins
                const limited = await this.options.userHandler.rateLimitUser(userData._id, meta, 0);
                if (!limited.success) {
                    throw new AuthError('Too many failed logins', 429, limited.ttl);
                }
                return Object.assign(userData, { authAsp: cached.asp || null });
            }
            await this.options.redis.del(key).catch(() => false);
        }

        const [result] = await this.options.userHandler.asyncAuthenticate(credentials.username, credentials.password, SCOPE, meta);
        // the account password is not accepted for a protocol scope once 2FA is enabled
        if (!result || (result.scope === 'master' && result.require2fa)) {
            return null;
        }
        const userData = await this.loadUser(result.user);
        if (!usable(userData)) {
            return null;
        }
        const asp = result.asp ? result.asp.toString() : null;
        await this.options.redis
            .multi()
            .hset(key, { user: userData._id.toString(), authVersion: String(Number(userData.authVersion) || 0), asp: asp || '' })
            .expire(key, this.options.cacheTtl)
            .exec()
            .catch(() => false);
        return Object.assign(userData, { authAsp: asp });
    }

    /**
     * Authenticates a request from its Authorization header.
     *
     * @param {String} header Authorization header value
     * @param {Object} meta {ip, sess} for the authentication log
     * @returns {Promise<Object>} The user document
     * @throws {AuthError} With status 401 when the credentials are missing or not accepted
     */
    async authenticate(header, meta) {
        const match = /^(Basic|Bearer)\s+(\S+)\s*$/i.exec(header || '');
        let userData = null;
        if (match && match[1].toLowerCase() === 'bearer') {
            userData = await this.fromBearer(match[2]);
        } else if (match) {
            const credentials = parseBasic(match[2]);
            userData = credentials
                ? await this.fromBasic(credentials, Object.assign({ protocol: 'JMAP' }, meta)).catch(err => {
                      if (err.code === 'RateLimitedError') {
                          throw new AuthError('Too many failed logins', 429, err.ttl);
                      }
                      // refused (invalid scope, ...) is a 401; a failing database is not
                      if (err.responseCode && err.responseCode < 500) {
                          return null;
                      }
                      throw err;
                  })
                : null;
        }
        if (!userData) {
            throw new AuthError(match ? 'Invalid credentials' : 'Authentication required');
        }
        return userData;
    }
}

module.exports = { JmapAuth, AuthError };
