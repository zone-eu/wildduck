'use strict';

const ObjectId = require('mongodb').ObjectId;
const roles = require('../roles');
const { MCP_TOKEN_ROLES, MCP_TOKEN_AUDIENCE } = require('../mcp-token-handler');
const { objectIdSchema } = require('../schemas/json-schemas');

const tokenIdParam = objectIdSchema('ID of the MCP access token', { wdRequired: true });

const tokenMetadataProperties = {
    id: { type: 'string', description: 'ID of the MCP access token' },
    description: { type: 'string', description: 'Human-readable token description' },
    role: {
        type: 'string',
        enum: [...MCP_TOKEN_ROLES],
        description: 'Access level of the token. Only the read level exists today; treat this as an open set.'
    },
    audience: { type: 'string', enum: [MCP_TOKEN_AUDIENCE], description: 'Fixed MCP token audience' },
    created: { type: 'string', format: 'date-time', description: 'Token creation time' },
    // optional dates stay typeless: fast-json-stringify would coerce a missing
    // or null value on a typed field
    expires: { description: 'Fixed expiration time, if configured' },
    lastUse: { description: 'Most recent rate-limited token-use timestamp' }
};

const tokenMetadataRequired = ['id', 'description', 'role', 'audience', 'created'];

const tokenMetadata = {
    type: 'object',
    title: 'McpTokenMetadata',
    properties: tokenMetadataProperties,
    required: tokenMetadataRequired
};

module.exports = (server, mcpTokenHandler) => {
    server.route({
        method: 'POST',
        url: '/users/:user/mcp-tokens',
        schema: {
            summary: 'Create an MCP access token',
            description: 'Creates a read-only MCP personal access token. The plaintext token is returned only by this response.',
            tags: ['MCPAccessTokens']
        },
        config: {
            name: 'createMcpToken',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {
                    description: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 255,
                        wdTrim: true,
                        wdRequired: true,
                        description: 'Human-readable token description'
                    },
                    expires: {
                        wdType: 'dateIso',
                        wdInstanceof: 'Date',
                        wdDateGtNow: true,
                        description: 'Optional fixed expiration time in the future'
                    },
                    role: {
                        type: 'string',
                        enum: [...MCP_TOKEN_ROLES],
                        default: 'mcp:read',
                        description: 'Access level to grant. Only the read level exists today.'
                    }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'CreateMcpTokenResponse',
                            properties: {
                                ...tokenMetadataProperties,
                                success: { $ref: 'wd:successRes' },
                                token: {
                                    type: 'string',
                                    pattern: '^wdmcp_\\d[a-f0-9]{72}$',
                                    description: 'Plaintext bearer token. This value is returned only once.'
                                }
                            },
                            required: [...tokenMetadataRequired, 'success', 'token']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).createOwn('mcptokens'));
            } else {
                req.validate(roles.can(req.role).createAny('mcptokens'));
            }

            let entry = await mcpTokenHandler.create(new ObjectId(values.user), values);
            return reply.send({ success: true, ...entry });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/mcp-tokens',
        schema: {
            summary: 'List MCP access tokens',
            description: 'Lists MCP token metadata without token hashes or plaintext secrets.',
            tags: ['MCPAccessTokens']
        },
        config: {
            name: 'getMcpTokens',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetMcpTokensResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: { type: 'array', items: tokenMetadata, description: 'MCP token metadata' }
                            },
                            required: ['success', 'results']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('mcptokens'));
            } else {
                req.validate(roles.can(req.role).readAny('mcptokens'));
            }

            return reply.send({
                success: true,
                results: await mcpTokenHandler.list(new ObjectId(values.user))
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/mcp-tokens/:token',
        schema: {
            summary: 'Revoke an MCP access token',
            description: 'Immediately revokes an MCP access token by its record ID.',
            tags: ['MCPAccessTokens']
        },
        config: {
            name: 'deleteMcpToken',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' }, token: tokenIdParam },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).deleteOwn('mcptokens'));
            } else {
                req.validate(roles.can(req.role).deleteAny('mcptokens'));
            }

            await mcpTokenHandler.revoke(new ObjectId(values.user), new ObjectId(values.token), {
                sess: values.sess,
                ip: values.ip
            });
            return reply.send({ success: true });
        }
    });
};
