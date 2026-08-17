'use strict';

const GetAddressesResult = {
    type: 'object',
    title: 'GetAddressesResult',
    additionalProperties: true,
    properties: {
        id: { type: 'string', description: 'ID of the Address' },
        name: { type: 'string', description: 'Identity name' },
        address: { type: 'string', description: 'E-mail address string' },
        user: { type: 'string', description: 'User ID this address belongs to if this is a User address' },
        forwarded: { type: 'boolean', description: 'If true then it is a forwarded address' },
        forwardedDisabled: { type: 'boolean', description: 'If true then the forwarded address is disabled' },
        targets: { type: 'array', items: { type: 'string' }, description: 'List of forwarding targets' },
        tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the Address' },
        metaData: { description: 'Metadata object (if available)' },
        internalData: { description: 'Internal metadata object (if available), not included for user-role requests' }
    }
};

const GetUserAddressesResult = {
    type: 'object',
    title: 'GetUserAddressesResult',
    additionalProperties: true,
    properties: {
        id: { type: 'string', description: 'ID of the Address' },
        name: { type: 'string', description: 'Identity name' },
        address: { type: 'string', description: 'E-mail address string' },
        main: { type: 'boolean', description: 'Indicates if this is the default address for the User' },
        created: { description: 'Datestring of the time the address was created' },
        tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the Address' },
        metaData: { description: 'Metadata object (if available)' },
        internalData: { description: 'Internal metadata object (if available), not included for user-role requests' }
    }
};

const GetUserAddressesregisterResult = {
    type: 'object',
    title: 'GetUserAddressesregisterResult',
    additionalProperties: true,
    properties: {
        id: { type: 'string', description: 'ID of the Address' },
        name: { type: 'string', description: 'Name from address header' },
        address: { type: 'string', description: 'E-mail Address' }
    }
};

const AddressLimits = {
    type: 'object',
    title: 'AddressLimits',
    additionalProperties: true,
    description: 'Account limits and usage',
    properties: {
        forwards: {
            type: 'object',
            title: 'Forwards',
            additionalProperties: true,
            description: 'Forwarding quota',
            properties: {
                allowed: { type: 'number', description: 'How many messages per 24 hours can be forwarded' },
                used: { type: 'number', description: 'How many messages are forwarded during current 24 hour period' },
                ttl: { description: 'Time until the end of current 24 hour period or false if not available' }
            }
        }
    }
};

const AutoreplyInfo = {
    type: 'object',
    title: 'AutoreplyInfo',
    additionalProperties: true,
    description: 'Autoreply information',
    properties: {
        status: { type: 'boolean', description: 'If true, then autoreply is enabled for this address' },
        start: { description: 'Either a date string or boolean false to disable start time checks' },
        end: { description: 'Either a date string or boolean false to disable end time checks' },
        name: { type: 'string', description: 'Name that is used for the From: header in autoreply message' },
        subject: { type: 'string', description: 'Autoreply subject line' },
        text: { type: 'string', description: 'Autoreply plaintext content' },
        html: { type: 'string', description: 'Autoreply HTML content' }
    }
};

module.exports = { GetAddressesResult, GetUserAddressesResult, GetUserAddressesregisterResult, AddressLimits, AutoreplyInfo };
