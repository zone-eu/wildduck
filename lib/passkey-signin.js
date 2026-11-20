'use strict';

// Sign-in with a passkey alone: the browser picks a discoverable credential (no user name is
// asked for), and the credential identifies the user. An assertion with user verification (PIN or
// biometrics) proves possession and the person, so it counts as a completed second factor. One
// without user verification is refused here; the same key still works as the second step after
// the password.

const config = require('@zone-eu/wild-config');
const consts = require('./consts');
const { fido2, hexToArrayBuffer, rateLimitResponse, webauthnUsage } = require('./user-handler');

// a sign-in takes seconds; the challenge does not need to live longer than this
const CHALLENGE_TTL = 5 * 60;

const challengeKey = challenge => `passkey:challenge:${challenge}`;

function failure(message, code, responseCode = 403) {
    const err = new Error(message);
    err.code = code;
    err.responseCode = responseCode;
    return err;
}

class PasskeySignIn {
    constructor({ users, redis, userHandler }) {
        this.users = users;
        this.redis = redis;
        this.userHandler = userHandler;
    }

    /** A challenge for any of the user's passkeys: no allowCredentials, user verification required */
    async options(data) {
        const options = await fido2(data.rpId).assertionOptions();
        const challenge = Buffer.from(options.challenge).toString('hex');
        await this.redis
            .multi()
            .hmset(challengeKey(challenge), { challenge, origin: data.origin, created: new Date().toISOString() })
            .expire(challengeKey(challenge), CHALLENGE_TTL)
            .exec();
        return {
            challenge,
            rpId: data.rpId || config.webauthn.rpId,
            allowCredentials: [],
            userVerification: 'required',
            timeout: CHALLENGE_TTL * 1000
        };
    }

    /**
     * Verifies an assertion against the challenge and the credential's owner.
     *
     * @returns {Promise<Object>} the user, username, address, scope and the credential used
     */
    async signIn(data, meta) {
        const [[, challengeData]] = await this.redis.multi().hgetall(challengeKey(data.challenge)).del(challengeKey(data.challenge)).exec();
        if (!challengeData || !challengeData.challenge) {
            throw failure('Unknown or expired challenge', 'ChallengeNotFound', 404);
        }

        const ipLimit = await this.userHandler.rateLimitIP(meta, 0);
        if (ipLimit && !ipLimit.success) {
            throw rateLimitResponse(ipLimit);
        }

        // only the matching credential comes back ($ projection on the query's array match)
        const userData = await this.users.collection('users').findOne(
            { 'webauthn.credentials.rawId': Buffer.from(data.rawId, 'hex') },
            {
                projection: {
                    _id: true,
                    username: true,
                    address: true,
                    disabled: true,
                    suspended: true,
                    disabledScopes: true,
                    require2faEnabled: true,
                    'webauthn.credentials.$': true
                },
                maxTimeMS: consts.DB_MAX_TIME_USERS
            }
        );
        const credential = userData && userData.webauthn.credentials[0];
        // the user handle, when the authenticator returns one, must name the same user
        const otherUser = credential && data.userHandle && Buffer.from(data.userHandle, 'hex').toString() !== userData._id.toString();
        if (!credential || otherUser) {
            await this.userHandler.rateLimitIP(meta, 1);
            throw failure('This passkey is not registered', 'PasskeyNotFound');
        }

        const scope = meta.requiredScope || 'master';
        const logMeta = Object.assign({}, meta, { action: 'authentication', source: 'passkey', credential: credential._id });
        /** Logs the refusal and returns the error to throw */
        const refusal = async (message, code, result) => {
            await this.userHandler.logAuthEvent(userData._id, Object.assign(logMeta, { result })).catch(() => false);
            return failure(message, code);
        };

        const userLimit = await this.userHandler.rateLimitUser(userData._id, meta, 0);
        if (userLimit && !userLimit.success) {
            throw rateLimitResponse(userLimit);
        }
        if (userData.disabled || userData.suspended) {
            throw await refusal('Authentication failed', 'AuthFailed', userData.disabled ? 'disabled' : 'suspended');
        }
        if ((userData.disabledScopes || []).includes(scope)) {
            throw await refusal('Access to requested service disabled', 'InvalidAuthScope', 'scope_disabled');
        }

        let authnResult;
        try {
            authnResult = await fido2(data.rpId).assertionResult(
                {
                    rawId: hexToArrayBuffer(data.rawId),
                    response: {
                        clientDataJSON: hexToArrayBuffer(data.clientDataJSON),
                        authenticatorData: hexToArrayBuffer(data.authenticatorData),
                        // the user handle is checked above against the credential's owner
                        signature: hexToArrayBuffer(data.signature)
                    }
                },
                {
                    challenge: hexToArrayBuffer(challengeData.challenge),
                    origin: challengeData.origin,
                    factor: 'either',
                    publicKey: credential.publicKey,
                    prevCounter: credential.counter || 0,
                    userHandle: null,
                    rpId: data.rpId || config.webauthn.rpId
                }
            );
        } catch {
            await this.userHandler.rateLimit(userData._id.toString(), meta, 1).catch(() => false);
            throw await refusal('Passkey verification failed', 'AuthFailed', 'fail');
        }

        if (!authnResult.authnrData.get('flags').has('UV')) {
            // a key without PIN or biometrics: it works after the password, not alone
            throw await refusal('This key needs your password first', 'UserVerificationRequired', 'fail');
        }

        await Promise.all([
            this.users
                .collection('users')
                .updateOne(
                    { _id: userData._id, 'webauthn.credentials._id': credential._id },
                    { $set: webauthnUsage(authnResult) },
                    { maxTimeMS: consts.DB_MAX_TIME_USERS }
                ),
            this.userHandler.rateLimitReleaseUser(userData._id).catch(() => false),
            this.userHandler.logAuthEvent(userData._id, Object.assign(logMeta, { result: 'success' })).catch(() => false)
        ]);

        return {
            user: userData._id,
            username: userData.username,
            address: userData.address,
            scope,
            require2faEnabled: !!userData.require2faEnabled,
            credential: credential._id.toString()
        };
    }
}

module.exports = { PasskeySignIn };
