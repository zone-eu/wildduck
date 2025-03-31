'use strict';

const Joi = require('joi');
const { booleanSchema } = require('../../schemas');
const { addressId, addressEmail } = require('../request/general-schemas');

const GetAddressesResult = Joi.object({
    id: Joi.string().required().description('ID of the Address'),
    name: Joi.string().description('Identity name'),
    address: Joi.string().required().description('E-mail address string'),
    user: Joi.string().required().description('User ID this address belongs to if this is a User address'),
    forwarded: booleanSchema.required().description('If true then it is a forwarded address'),
    forwardedDisabled: booleanSchema.required().description('If true then the forwarded address is disabled'),
    targets: Joi.array().items(Joi.string()).description('List of forwarding targets'),
    tags: Joi.array().items(Joi.string()).required().description('List of tags associated with the Address'),
    metaData: Joi.object({}).description('Metadata object (if available)'),
    internalData: Joi.object({}).description('Internal metadata object (if available), not included for user-role requests')
}).$_setFlag('objectName', 'GetAddressesResult');

const GetUserAddressesResult = Joi.object({
    id: addressId,
    name: Joi.string().description('Identity name'),
    address: addressEmail,
    main: booleanSchema.required().description('Indicates if this is the default address for the User'),
    created: Joi.date().required().description('Datestring of the time the address was created'),
    tags: Joi.array().items(Joi.string()).required().description('List of tags associated with the Address'),
    metaData: Joi.object({}).description('Metadata object (if available)'),
    internalData: Joi.object({}).description('Internal metadata object (if available), not included for user-role requests')
}).$_setFlag('objectName', 'GetUserAddressesResult');

const GetUserAddressesregisterResult = Joi.object({
    id: addressId,
    name: Joi.string().description('Name from address header'),
    address: addressEmail
}).$_setFlag('objectName', 'GetUserAddressesregisterResult');

const AddressLimits = Joi.object({
    forwards: Joi.object({
        allowed: Joi.number().required().description('How many messages per 24 hours can be forwarded'),
        used: Joi.number().required().description('How many messages are forwarded during current 24 hour period'),
        ttl: Joi.number().required().description('Time until the end of current 24 hour period')
    })
        .required()
        .description('Forwarding quota')
        .$_setFlag('objectName', 'Forwards')
})
    .required()
    .description('Account limits and usage')
    .$_setFlag('objectName', 'AddressLimits');

const AutoreplyInfo = Joi.object({
    status: booleanSchema.required().description('If true, then autoreply is enabled for this address'),
    name: Joi.string().description('Name that is used for the From: header in autoreply message'),
    subject: Joi.string().description('Autoreply subject line'),
    text: Joi.string().description('Autoreply plaintext content'),
    html: Joi.string().description('Autoreply HTML content')
})
    .required()
    .description('Autoreply information')
    .$_setFlag('objectName', 'AutoreplyInfo');

module.exports = { GetAddressesResult, GetUserAddressesResult, GetUserAddressesregisterResult, AddressLimits, AutoreplyInfo };
