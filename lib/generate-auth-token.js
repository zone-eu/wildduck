'use strict';

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
 * @param {Object} [options] Authentication-assurance metadata for master API sessions, plus sess/ip for the MCP auth log.
 * @returns {Promise<String>} Plaintext credential.
 */
module.exports = async (userHandler, mcpTokenHandler, user, scope, options) => {
    if (scope !== 'mcp') {
        return await userHandler.generateAuthToken(user, options);
    }

    if (!mcpTokenHandler) {
        let err = new Error('MCP authentication is not available');
        err.code = 'AuthFailed';
        throw err;
    }

    return await mcpTokenHandler.createSession(user, options);
};
