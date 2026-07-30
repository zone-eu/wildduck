'use strict';

const GetUsersResult = {
    type: 'object',
    title: 'GetUsersResult',
    additionalProperties: true,
    properties: {
        id: { type: 'string', description: 'Users unique ID (24byte hex)' },
        username: { type: 'string', description: 'Username of the User' },
        name: { type: 'string', description: 'Name of the User' },
        address: { type: 'string', description: 'Main email address of the User' },
        tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the User' },
        targets: { type: 'array', items: { type: 'string' }, description: 'List of forwarding targets' },
        enabled2fa: { type: 'array', items: { type: 'string' }, description: 'List of enabled 2FA methods' },
        autoreply: { type: 'boolean', description: 'Is autoreply enabled or not (start time may still be in the future or end time in the past)' },
        encryptMessages: { type: 'boolean', description: 'If true then received messages are encrypted' },
        encryptForwarded: { type: 'boolean', description: 'If true then forwarded messages are encrypted' },
        quota: {
            type: 'object',
            title: 'Quota',
            additionalProperties: true,
            description: 'Quota usage limits',
            properties: {
                allowed: { type: 'number', description: 'Allowed quota of the user in bytes' },
                used: { type: 'number', description: 'Space used in bytes' }
            }
        },
        metaData: { description: 'Custom metadata value. Included if metaData query argument was true' },
        internalData: {
            description: 'Custom metadata value for internal use. Included if internalData query argument was true and request was not made using user-role token'
        },
        hasPasswordSet: { type: 'boolean', description: 'If true then the User has a password set and can authenticate' },
        activated: { type: 'boolean', description: 'Is the account activated' },
        disabled: { type: 'boolean', description: 'If true then user can not authenticate or receive any new mail' },
        suspended: { type: 'boolean', description: 'If true then user can not authenticate' }
    }
};

module.exports = { GetUsersResult };
