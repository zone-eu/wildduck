'use strict';

// The JMAP Session resource (RFC 8620 2).

const crypto = require('crypto');
const { formatId } = require('./ids');
const { sessionCapabilities } = require('./capabilities');

/**
 * Builds the session object of a user.
 *
 * @param {Object} userData User document (username, address, name)
 * @param {Object} options {baseUrl, limits, registry, options: the service configuration, capabilities: more session
 *   capabilities without an account part (webpush-vapid)}
 */
function buildSession(userData, options) {
    const accountId = formatId('account', userData._id);
    const accountCapabilities = options.registry.accountCapabilities({ userData, limits: options.limits, options: options.options || {} });
    const base = options.baseUrl.replace(/\/+$/, '');

    const session = {
        capabilities: Object.assign(sessionCapabilities(options.limits, accountCapabilities), options.capabilities),
        accounts: {
            [accountId]: {
                name: userData.address || userData.username,
                isPersonal: true,
                isReadOnly: false,
                accountCapabilities
            }
        },
        primaryAccounts: Object.fromEntries(Object.keys(accountCapabilities).map(urn => [urn, accountId])),
        username: userData.username,
        apiUrl: `${base}/jmap/api/`,
        downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
        uploadUrl: `${base}/jmap/upload/{accountId}/`,
        eventSourceUrl: `${base}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`
    };

    // changes whenever anything above changes (RFC 8620 2: sessionState)
    session.state = 's' + crypto.createHash('sha256').update(JSON.stringify(session)).digest('hex').slice(0, 16);
    return session;
}

module.exports = { buildSession };
