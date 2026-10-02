'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const roles = require('../roles');
const tools = require('../tools');
const { MCP_TOKEN_ROLES, MCP_TOKEN_AUDIENCE } = require('../mcp-token-handler');
const { sessSchema, sessIPSchema } = require('../schemas');
const { userId } = require('../schemas/request/general-schemas');
const { successRes } = require('../schemas/response/general-schemas');

const tokenId = Joi.string().hex().lowercase().length(24).required().description('ID of the MCP access token');
const tokenMetadata = Joi.object({
    id: tokenId,
    description: Joi.string().required().description('Human-readable token description'),
    role: Joi.string()
        .valid(...MCP_TOKEN_ROLES)
        .required()
        .description('Access level of the token. Only the read level exists today; treat this as an open set.'),
    audience: Joi.string().valid(MCP_TOKEN_AUDIENCE).required().description('Fixed MCP token audience'),
    created: Joi.date().required().description('Token creation time'),
    expires: Joi.date().description('Fixed expiration time, if configured'),
    lastUse: Joi.date().description('Most recent rate-limited token-use timestamp')
}).$_setFlag('objectName', 'McpTokenMetadata');

module.exports = (server, mcpTokenHandler) => {
    server.post(
        {
            path: '/users/:user/mcp-tokens',
            tags: ['MCPAccessTokens'],
            summary: 'Create MCP Access Token',
            description: 'Creates a read-only MCP personal access token. The plaintext token is returned only by this response.',
            name: 'createMcpToken',
            validationObjs: {
                pathParams: { user: userId },
                queryParams: { sess: sessSchema, ip: sessIPSchema },
                requestBody: {
                    description: Joi.string().trim().min(1).max(255).required().description('Human-readable token description'),
                    expires: Joi.date().iso().greater('now').description('Optional fixed expiration time in the future'),
                    role: Joi.string()
                        .valid(...MCP_TOKEN_ROLES)
                        .default('mcp:read')
                        .description('Access level to grant. Only the read level exists today.')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: tokenMetadata
                            .keys({
                                success: successRes,
                                token: Joi.string()
                                    .pattern(/^wdmcp_\d[a-f0-9]{72}$/)
                                    .required()
                                    .description('Plaintext bearer token. This value is returned only once.')
                            })
                            .$_setFlag('objectName', 'CreateMcpTokenResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;
            const result = Joi.object({ ...requestBody, ...queryParams, ...pathParams }).validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('mcptokens'));
            } else {
                req.validate(roles.can(req.role).createAny('mcptokens'));
            }

            let entry = await mcpTokenHandler.create(new ObjectId(result.value.user), result.value);
            return res.json({ success: true, ...entry });
        })
    );

    server.get(
        {
            path: '/users/:user/mcp-tokens',
            tags: ['MCPAccessTokens'],
            summary: 'List MCP Access Tokens',
            description: 'Lists MCP token metadata without token hashes or plaintext secrets.',
            name: 'getMcpTokens',
            validationObjs: {
                pathParams: { user: userId },
                queryParams: { sess: sessSchema, ip: sessIPSchema },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            results: Joi.array().items(tokenMetadata).required().description('MCP token metadata')
                        }).$_setFlag('objectName', 'GetMcpTokensResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;
            const result = Joi.object({ ...requestBody, ...queryParams, ...pathParams }).validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('mcptokens'));
            } else {
                req.validate(roles.can(req.role).readAny('mcptokens'));
            }

            return res.json({
                success: true,
                results: await mcpTokenHandler.list(new ObjectId(result.value.user))
            });
        })
    );

    server.del(
        {
            path: '/users/:user/mcp-tokens/:token',
            tags: ['MCPAccessTokens'],
            summary: 'Revoke MCP Access Token',
            description: 'Immediately revokes an MCP access token by its record ID.',
            name: 'deleteMcpToken',
            validationObjs: {
                pathParams: { user: userId, token: tokenId },
                queryParams: { sess: sessSchema, ip: sessIPSchema },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({ success: successRes }).$_setFlag('objectName', 'SuccessResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;
            const result = Joi.object({ ...requestBody, ...queryParams, ...pathParams }).validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('mcptokens'));
            } else {
                req.validate(roles.can(req.role).deleteAny('mcptokens'));
            }

            await mcpTokenHandler.revoke(new ObjectId(result.value.user), new ObjectId(result.value.token), {
                sess: result.value.sess,
                ip: result.value.ip
            });
            return res.json({ success: true });
        })
    );
};
