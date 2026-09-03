'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const ObjectId = require('mongodb').ObjectId;
const consts = require('./consts');
const tools = require('./tools');
const counters = require('./counters');
const { publish, MCP_TOKEN_CREATED, MCP_TOKEN_DELETED } = require('./events');

// Why this is a collection of its own rather than an application password: an ASP hashes with
// bcrypt, which is deliberately slow and is paid once per IMAP session. An MCP credential is
// presented on every JSON-RPC POST, several times per agent turn, so the cost model is that of
// an access token rather than a password. Hence a SHA-256 digest of a 256-bit random secret,
// which needs no work factor because there is nothing to guess. The rest of the lifecycle
// deliberately mirrors asps: per user, hashed at rest, revocable, authVersion bound, described,
// optionally expiring, and scope checked.
const MCP_TOKEN_PREFIX = 'wdmcp_';

// Current token format version. The validator dispatches on this digit, so a future format
// change (different secret length, different alphabet, different checksum) is additive
// instead of ambiguous. Tokens without a version were never issued outside development.
const MCP_TOKEN_VERSION = '1';

// prefix, one version digit, 32 random bytes as hex, CRC32 of version+secret as hex
const MCP_TOKEN_PATTERN = /^wdmcp_(\d)([a-f0-9]{64})([a-f0-9]{8})$/;

const MCP_TOKEN_AUDIENCE = 'mcp';

// Access level of a token, stored on the record and resolved into `req.role` at
// authentication. Only the read level exists today; write and send levels join this set and
// config/roles.json, and no issued token needs migrating when they do.
const MCP_TOKEN_ROLE = 'mcp:read';
const MCP_TOKEN_ROLES = new Set([MCP_TOKEN_ROLE]);

// A token in constant use should not cost a write per request, so `used` is only refreshed
// once the stored value is older than this. Consumers must treat it as accurate to within
// this interval, never as a live activity signal.
const LAST_USE_UPDATE_INTERVAL = 5 * 60 * 1000;

function createError(message, code, responseCode) {
    let err = new Error(message);
    err.code = code;
    err.responseCode = responseCode;
    err.formattedMessage = message;
    return err;
}

async function databaseCall(operation) {
    try {
        return await operation();
    } catch (err) {
        if (!err.responseCode) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            err.formattedMessage = 'Database Error';
        }
        throw err;
    }
}

/**
 * CRC32 of the version digit and the secret, as 8 lowercase hex characters. The prefix is
 * excluded because it is constant.
 *
 * @param {String} version Token format version.
 * @param {String} secret Token secret, as lowercase hex.
 * @returns {String} Checksum.
 */
function tokenChecksum(version, secret) {
    return zlib
        .crc32(version + secret)
        .toString(16)
        .padStart(8, '0');
}

/**
 * Parses a token string without touching the database.
 *
 * The checksum is not a security control: it is public and anyone can mint a well-formed
 * value that fails the hash lookup. It exists so a truncated paste fails locally, so secret
 * scanners get fewer false positives, and so malformed bearer credentials are refused before
 * spending a database round trip.
 *
 * @param {*} value Candidate token.
 * @returns {Object|Boolean} Parsed parts, or false when the value is not a usable token.
 */
function parseToken(value) {
    if (typeof value !== 'string') {
        return false;
    }

    let match = value.match(MCP_TOKEN_PATTERN);
    if (!match) {
        return false;
    }

    let [, version, secret, checksum] = match;
    if (version !== MCP_TOKEN_VERSION || tokenChecksum(version, secret) !== checksum) {
        return false;
    }

    return { version, secret, checksum };
}

const USER_PROJECTION = {
    _id: true,
    username: true,
    address: true,
    authVersion: true,
    disabled: true,
    suspended: true,
    disabledScopes: true
};

class McpTokenHandler {
    constructor(options) {
        options = options || {};
        this.users = options.users;
        this.collection = this.users.collection('mcptokens');
        this.redis = options.redis;
        this.counters = options.counters || (this.redis ? counters(this.redis) : false);
        // Reuses UserHandler.logAuthEvent so MCP authentication lands in the same authlog the
        // user already reads, with the same bucketing and retention. Absent in unit tests.
        this.logAuthEvent = options.logAuthEvent || (async () => false);
        // Only the command line tool resolves users; the listener authenticates by hash
        this.userHandler = options.userHandler;
    }

    static isToken(value) {
        return !!parseToken(value);
    }

    static hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    /**
     * Mints a new token string. The secret is the only part carrying entropy; the prefix,
     * version and checksum are all recomputable by anyone.
     *
     * @returns {String} Token.
     */
    static generateToken() {
        let secret = crypto.randomBytes(32).toString('hex');
        return MCP_TOKEN_PREFIX + MCP_TOKEN_VERSION + secret + tokenChecksum(MCP_TOKEN_VERSION, secret);
    }

    /**
     * Resolves a user by id, username or address, for the command line tool.
     *
     * Address resolution goes through UserHandler.checkAddress so an alias domain, a wildcard
     * address or a +label form resolves here exactly as it does at every other WildDuck entry
     * point, rather than only for addresses stored verbatim.
     *
     * @param {String} identifier User id, username or email address.
     * @returns {Promise<Object>} User.
     */
    async resolveUser(identifier) {
        identifier = (identifier || '').toString().trim();

        let query;
        if (tools.isId(identifier)) {
            query = { _id: new ObjectId(identifier) };
        } else if (identifier && this.userHandler) {
            query = await databaseCall(() => this.userHandler.checkAddress(identifier));
        } else if (identifier) {
            // no UserHandler available, which is the unit test shape
            query = { unameview: tools.uview(identifier) };
        }

        let user =
            query &&
            (await databaseCall(() => this.users.collection('users').findOne(query, { projection: USER_PROJECTION, maxTimeMS: consts.DB_MAX_TIME_USERS })));

        if (!user) {
            throw createError('This user does not exist', 'UserNotFound', 404);
        }

        return user;
    }

    async create(user, data) {
        user = user instanceof ObjectId ? user : new ObjectId(user);
        data = data || {};

        let description = (data.description || '').toString().trim();
        if (!description || description.length > 255) {
            throw createError('Description is required and must not exceed 255 characters', 'InputValidationError', 400);
        }

        let role = (data.role || MCP_TOKEN_ROLE).toString();
        if (!MCP_TOKEN_ROLES.has(role)) {
            throw createError('Unknown MCP access level', 'InputValidationError', 400);
        }

        let userData = await databaseCall(() =>
            this.users.collection('users').findOne({ _id: user }, { projection: { _id: true, authVersion: true }, maxTimeMS: consts.DB_MAX_TIME_USERS })
        );
        if (!userData) {
            throw createError('This user does not exist', 'UserNotFound', 404);
        }

        let expires = data.expires ? new Date(data.expires) : undefined;
        if (expires && (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())) {
            throw createError('Expiration time must be in the future', 'InputValidationError', 400);
        }

        let existingCount = await databaseCall(() => this.collection.countDocuments({ user }));
        if (existingCount >= consts.MAX_MCP_TOKEN_COUNT) {
            let err = createError('Maximum MCP token limit reached', 'TooMany', 403);
            err.details = { count: existingCount, allowed: consts.MAX_MCP_TOKEN_COUNT };
            throw err;
        }

        let token = McpTokenHandler.generateToken();
        let entry = {
            user,
            hash: McpTokenHandler.hashToken(token),
            // Stored alongside the hash, which cannot be reversed, so a future format
            // migration can count the tokens still on the old shape.
            tokenVersion: MCP_TOKEN_VERSION,
            description,
            role,
            audience: MCP_TOKEN_AUDIENCE,
            authVersion: Number(userData.authVersion) || 0,
            created: new Date()
        };
        if (expires) {
            entry.expires = expires;
        }

        let result = await databaseCall(() => this.collection.insertOne(entry));

        await this.recordTokenEvent('create mcp token', MCP_TOKEN_CREATED, { ...entry, _id: result.insertedId }, data);

        return {
            id: result.insertedId.toString(),
            token,
            description: entry.description,
            role: entry.role,
            audience: entry.audience,
            created: entry.created,
            expires: entry.expires
        };
    }

    async list(user) {
        user = user instanceof ObjectId ? user : new ObjectId(user);
        let userData = await databaseCall(() =>
            this.users.collection('users').findOne({ _id: user }, { projection: { _id: true }, maxTimeMS: consts.DB_MAX_TIME_USERS })
        );
        if (!userData) {
            throw createError('This user does not exist', 'UserNotFound', 404);
        }

        let entries = await databaseCall(() =>
            this.collection
                .find({ user }, { projection: { hash: false }, maxTimeMS: consts.DB_MAX_TIME_USERS })
                .sort({ created: -1, _id: -1 })
                .toArray()
        );

        return entries.map(entry => ({
            id: entry._id.toString(),
            description: entry.description,
            role: entry.role,
            audience: entry.audience,
            created: entry.created,
            expires: entry.expires,
            lastUse: entry.used
        }));
    }

    async revoke(user, token, data) {
        user = user instanceof ObjectId ? user : new ObjectId(user);
        token = token instanceof ObjectId ? token : new ObjectId(token);
        data = data || {};

        // Deleted and read in one round trip, so the audit entry can name the description the
        // operator recognises rather than an opaque record id
        let result = await databaseCall(() => this.collection.findOneAndDelete({ _id: token, user }, { projection: { hash: false } }));
        let tokenData = result && result.value;
        if (!tokenData) {
            throw createError('This MCP token does not exist', 'McpTokenNotFound', 404);
        }

        await this.recordTokenEvent('delete mcp token', MCP_TOKEN_DELETED, tokenData, data);

        return true;
    }

    /**
     * Records a token appearing on or leaving an account.
     *
     * Minting a credential that reads the whole mailbox is an account event, so it lands in the
     * same authlog and webhook stream an application password does. Without it the only record
     * of an agent credential on an account is the token listing itself.
     *
     * @param {String} action Authlog action.
     * @param {String} ev Webhook event name.
     * @param {Object} entry Token record, carrying at least the id and description.
     * @param {Object} data Request metadata (sess, ip).
     */
    async recordTokenEvent(action, ev, entry, data) {
        await this.logAuthEvent(entry.user, {
            action,
            mcptoken: entry._id,
            aname: entry.description,
            ...(entry.expires ? { temporary: true } : {}),
            result: 'success',
            protocol: MCP_TOKEN_AUDIENCE,
            sess: data.sess,
            ip: data.ip
        }).catch(() => false);

        await publish(this.redis, {
            ev,
            user: entry.user,
            mcptoken: entry._id,
            description: entry.description
        });
    }

    /**
     * The failure budget for one address.
     *
     * Called with an increment of 1 to spend a failure and with 0 to check before doing any
     * work. Only failures are counted, so a working client never approaches the limit.
     *
     * Honours the same `rl-wl` Redis set the other WildDuck limiters read, so an address an
     * operator has whitelisted is exempt here too rather than only everywhere else.
     *
     * @param {String} ip Remote address.
     * @param {Number} count 1 to spend a failure, 0 to check.
     * @returns {Promise<Boolean>} True while the address is still under the limit.
     */
    async failureBudget(ip, count) {
        if (!this.counters || !ip || !consts.MCP_AUTH_FAILURES) {
            return true;
        }

        try {
            if (this.redis && (await this.redis.sismember('rl-wl', ip))) {
                return true;
            }
            let result = await this.counters.asyncTTLCounter(`mcpauth:${ip}`, count, consts.MCP_AUTH_FAILURES, consts.MCP_AUTH_WINDOW);
            return !!result.success;
        } catch (err) {
            // A failing limiter must not become an authentication bypass, and must not lock
            // everyone out either. Authentication itself still has to succeed on its own.
            return true;
        }
    }

    /**
     * Authenticates a bearer token.
     *
     * Order matters: shape, version and checksum are all local, so a malformed credential is
     * refused without a database round trip. Only the hash lookup authenticates anything.
     *
     * @param {*} token Bearer credential.
     * @param {Object} [meta] Request metadata for the auth log (ip, sess).
     * @returns {Promise<Object>} Token id, user data and the access level.
     */
    async authenticate(token, meta) {
        meta = meta || {};

        let invalid = async (reason, user) => {
            await this.failureBudget(meta.ip, 1);
            if (user) {
                await this.logAuthEvent(user, {
                    action: 'authentication',
                    result: reason,
                    protocol: 'MCP',
                    requiredScope: MCP_TOKEN_AUDIENCE,
                    ip: meta.ip,
                    sess: meta.sess
                }).catch(() => false);
            }
            return createError('Invalid MCP bearer token', 'InvalidMcpToken', 401);
        };

        if (!(await this.failureBudget(meta.ip, 0))) {
            throw createError('Too many failed MCP authentication attempts', 'RateLimitedError', 429);
        }

        if (!parseToken(token)) {
            throw await invalid('malformed');
        }

        let now = new Date();
        let tokenData = await databaseCall(() => this.collection.findOne({ hash: McpTokenHandler.hashToken(token) }, { maxTimeMS: consts.DB_MAX_TIME_USERS }));

        if (!tokenData || tokenData.audience !== MCP_TOKEN_AUDIENCE || !MCP_TOKEN_ROLES.has(tokenData.role)) {
            throw await invalid('unknown');
        }

        if (tokenData.expires && tokenData.expires.getTime() <= now.getTime()) {
            throw await invalid('expired', tokenData.user);
        }

        let userData = await databaseCall(() =>
            this.users.collection('users').findOne({ _id: tokenData.user }, { projection: USER_PROJECTION, maxTimeMS: consts.DB_MAX_TIME_USERS })
        );

        if (!userData) {
            throw await invalid('unknown');
        }

        for (let [condition, reason] of [
            [userData.disabled, 'disabled'],
            [userData.suspended, 'suspended'],
            [(userData.disabledScopes || []).includes(MCP_TOKEN_AUDIENCE), 'scope_disabled'],
            // A password change bumps authVersion, which retires every token the user holds.
            // So does suspending the account, and unsuspending does not lower it again, so a
            // suspension permanently retires the tokens that existed before it and the user
            // has to mint new ones. That is deliberate: a suspension is an administrative
            // action against the account, and a long-lived agent credential should not
            // outlive it silently.
            [(Number(userData.authVersion) || 0) !== (Number(tokenData.authVersion) || 0), 'stale']
        ]) {
            if (condition) {
                throw await invalid(reason, userData._id);
            }
        }

        await this.logAuthEvent(userData._id, {
            action: 'authentication',
            result: 'success',
            protocol: 'MCP',
            requiredScope: MCP_TOKEN_AUDIENCE,
            ip: meta.ip,
            sess: meta.sess
        }).catch(() => false);

        // Deliberately not awaited: a last-use timestamp accurate to LAST_USE_UPDATE_INTERVAL
        // is not worth adding a write to the latency of every tool call.
        this.collection
            .updateOne(
                { _id: tokenData._id, $or: [{ used: { $exists: false } }, { used: { $lte: new Date(now.getTime() - LAST_USE_UPDATE_INTERVAL) } }] },
                { $set: { used: now } }
            )
            .catch(() => false);

        return {
            tokenId: tokenData._id,
            user: userData,
            role: tokenData.role,
            audience: tokenData.audience,
            expires: tokenData.expires
        };
    }
}

module.exports = McpTokenHandler;
module.exports.MCP_TOKEN_AUDIENCE = MCP_TOKEN_AUDIENCE;
module.exports.MCP_TOKEN_PATTERN = MCP_TOKEN_PATTERN;
module.exports.MCP_TOKEN_PREFIX = MCP_TOKEN_PREFIX;
module.exports.MCP_TOKEN_ROLE = MCP_TOKEN_ROLE;
module.exports.MCP_TOKEN_ROLES = MCP_TOKEN_ROLES;
module.exports.MCP_TOKEN_VERSION = MCP_TOKEN_VERSION;
module.exports.LAST_USE_UPDATE_INTERVAL = LAST_USE_UPDATE_INTERVAL;
module.exports.tokenChecksum = tokenChecksum;
module.exports.parseToken = parseToken;
