'use strict';

const crypto = require('crypto');
const ObjectId = require('mongodb').ObjectId;
const consts = require('./consts');
const tools = require('./tools');

const MCP_TOKEN_PREFIX = 'wdmcp_';
const MCP_TOKEN_PATTERN = /^wdmcp_[a-f0-9]{64}$/;
const MCP_TOKEN_ROLE = 'mcp:read';
const MCP_TOKEN_AUDIENCE = 'mcp';
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

class McpTokenHandler {
    constructor(options) {
        this.users = options.users;
        this.collection = this.users.collection('mcptokens');
    }

    static isToken(value) {
        return typeof value === 'string' && MCP_TOKEN_PATTERN.test(value);
    }

    static hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    async resolveUser(identifier) {
        identifier = (identifier || '').toString().trim();

        let user;
        if (tools.isId(identifier)) {
            user = await databaseCall(() =>
                this.users.collection('users').findOne(
                    { _id: new ObjectId(identifier) },
                    {
                        projection: {
                            _id: true,
                            username: true,
                            address: true,
                            authVersion: true,
                            disabled: true,
                            suspended: true
                        },
                        maxTimeMS: consts.DB_MAX_TIME_USERS
                    }
                )
            );
        } else if (identifier.includes('@')) {
            let address = tools.normalizeAddress(identifier, false, {
                removeLabel: true,
                removeDots: true
            });
            let addressData = await databaseCall(() =>
                this.users.collection('addresses').findOne(
                    { addrview: address },
                    {
                        projection: { user: true },
                        maxTimeMS: consts.DB_MAX_TIME_USERS
                    }
                )
            );
            if (addressData && addressData.user) {
                user = await databaseCall(() =>
                    this.users.collection('users').findOne(
                        { _id: addressData.user },
                        {
                            projection: {
                                _id: true,
                                username: true,
                                address: true,
                                authVersion: true,
                                disabled: true,
                                suspended: true
                            },
                            maxTimeMS: consts.DB_MAX_TIME_USERS
                        }
                    )
                );
            }
        } else if (identifier) {
            user = await databaseCall(() =>
                this.users.collection('users').findOne(
                    { unameview: tools.uview(identifier) },
                    {
                        projection: {
                            _id: true,
                            username: true,
                            address: true,
                            authVersion: true,
                            disabled: true,
                            suspended: true
                        },
                        maxTimeMS: consts.DB_MAX_TIME_USERS
                    }
                )
            );
        }

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

        let userData = await databaseCall(() =>
            this.users.collection('users').findOne(
                { _id: user },
                {
                    projection: {
                        _id: true,
                        authVersion: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            )
        );
        if (!userData) {
            throw createError('This user does not exist', 'UserNotFound', 404);
        }

        let expires = data.expires ? new Date(data.expires) : undefined;
        if (expires && (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())) {
            throw createError('Expiration time must be in the future', 'InputValidationError', 400);
        }

        let token = MCP_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
        let entry = {
            user,
            hash: McpTokenHandler.hashToken(token),
            description,
            role: MCP_TOKEN_ROLE,
            audience: MCP_TOKEN_AUDIENCE,
            authVersion: Number(userData.authVersion) || 0,
            created: new Date()
        };
        if (expires) {
            entry.expires = expires;
        }

        let result = await databaseCall(() => this.collection.insertOne(entry));

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
                .find(
                    { user },
                    {
                        projection: {
                            hash: false
                        },
                        maxTimeMS: consts.DB_MAX_TIME_USERS
                    }
                )
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

    async revoke(user, token) {
        user = user instanceof ObjectId ? user : new ObjectId(user);
        token = token instanceof ObjectId ? token : new ObjectId(token);

        let result = await databaseCall(() => this.collection.deleteOne({ _id: token, user }));
        if (!result.deletedCount) {
            throw createError('This MCP token does not exist', 'McpTokenNotFound', 404);
        }

        return true;
    }

    async authenticate(token) {
        if (!McpTokenHandler.isToken(token)) {
            throw createError('Invalid MCP bearer token', 'InvalidMcpToken', 401);
        }

        let now = new Date();
        let tokenData = await databaseCall(() =>
            this.collection.findOne(
                { hash: McpTokenHandler.hashToken(token) },
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            )
        );

        if (
            !tokenData ||
            tokenData.role !== MCP_TOKEN_ROLE ||
            tokenData.audience !== MCP_TOKEN_AUDIENCE ||
            (tokenData.expires && tokenData.expires.getTime() <= now.getTime())
        ) {
            throw createError('Invalid MCP bearer token', 'InvalidMcpToken', 401);
        }

        let userData = await databaseCall(() =>
            this.users.collection('users').findOne(
                { _id: tokenData.user },
                {
                    projection: {
                        _id: true,
                        username: true,
                        address: true,
                        authVersion: true,
                        disabled: true,
                        suspended: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            )
        );

        if (
            !userData ||
            userData.disabled ||
            userData.suspended ||
            (Number(userData.authVersion) || 0) !== (Number(tokenData.authVersion) || 0)
        ) {
            throw createError('Invalid MCP bearer token', 'InvalidMcpToken', 401);
        }

        let usedBefore = new Date(now.getTime() - LAST_USE_UPDATE_INTERVAL);
        this.collection
            .updateOne(
                {
                    _id: tokenData._id,
                    $or: [{ used: { $exists: false } }, { used: { $lte: usedBefore } }]
                },
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
module.exports.MCP_TOKEN_ROLE = MCP_TOKEN_ROLE;
module.exports.LAST_USE_UPDATE_INTERVAL = LAST_USE_UPDATE_INTERVAL;
