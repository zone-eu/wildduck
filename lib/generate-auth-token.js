'use strict';

const config = require('@zone-eu/wild-config');
const consts = require('./consts');

/**
 * Generates the credential requested by an interactive authentication flow.
 *
 * The regular API credential and the MCP credential deliberately have different
 * formats and stores. Keeping the choice in one helper prevents a 2FA completion
 * route from accidentally turning an MCP login into a general API session.
 *
 * @param {Object} userHandler User handler used for regular API access tokens.
 * @param {Object} mcpTokenHandler MCP token handler used for MCP-only credentials.
 * @param {ObjectId} user Authenticated user.
 * @param {String} scope Requested authentication scope.
 * @param {Object} [meta] Authentication metadata.
 * @returns {Promise<String>} Plaintext credential.
 */
module.exports = async (userHandler, mcpTokenHandler, user, scope, meta) => {
    if (scope !== 'mcp') {
        return await userHandler.generateAuthToken(user);
    }

    if (!mcpTokenHandler) {
        let err = new Error('MCP authentication is not available');
        err.code = 'AuthFailed';
        throw err;
    }

    meta = meta || {};
    let tokenLifetime = config.api.accessControl.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME;
    let entry = await mcpTokenHandler.create(user, {
        description: 'MCP login',
        expires: new Date(Date.now() + tokenLifetime * 1000),
        sess: meta.sess,
        ip: meta.ip
    });

    return entry.token;
};
