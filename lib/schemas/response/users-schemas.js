'use strict';

const Joi = require('joi');
const { booleanSchema } = require('../../schemas');
const { quotaRes } = require('./general-schemas');

const GetUsersResult = Joi.object({
    id: Joi.string().required().description('Users unique ID (24byte hex)'),
    username: Joi.string().required().description('Username of the User'),
    name: Joi.string().required().description('Name of the User'),
    address: Joi.string().required().description('Main email address of the User'),
    tags: Joi.array().items(Joi.string()).required().description('List of tags associated with the User'),
    targets: Joi.array().items(Joi.string()).required().description('List of forwarding targets'),
    enabled2fa: Joi.array().items(Joi.string()).required().description('List of enabled 2FA methods'),
    autoreply: booleanSchema.required().description('Is autoreply enabled or not (start time may still be in the future or end time in the past)'),
    encryptMessages: booleanSchema.required().description('If true then received messages are encrypted'),
    encryptForwarded: booleanSchema.required().description('If true then forwarded messages are encrypted'),
    quota: quotaRes,
    metaData: Joi.object().description('Custom metadata value. Included if metaData query argument was true'),
    internalData: Joi.object().description(
        'Custom metadata value for internal use. Included if internalData query argument was true and request was not made using user-role token'
    ),
    hasPasswordSet: booleanSchema.required().description('If true then the User has a password set and can authenticate'),
    activated: booleanSchema.required().description('Is the account activated'),
    disabled: booleanSchema.required().description('If true then user can not authenticate or receive any new mail'),
    suspended: booleanSchema.required().description('If true then user can not authenticate')
}).$_setFlag('objectName', 'GetUsersResult');

module.exports = { GetUsersResult };
