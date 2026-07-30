'use strict';

// Shared JSON Schema definitions for the migrated API routes. Each schema is
// the exact counterpart of a shared Joi schema from lib/schemas.js or
// lib/schemas/request|response/general-schemas.js (the Joi originals remain
// until every module is migrated). Registered with the central Ajv instance
// (lib/fastify/validation.js) and, for OpenAPI generation, with fastify.
//
// Usage in route validationObjs: { user: { $ref: 'wd:userId' } } or with
// local overrides that merge over the shared base:
// { specialUse: { $ref: 'wd:boolean', default: false, description: '...' } }

const { addSharedSchema } = require('../fastify/validation');

// Joi.string().hex().lowercase().length(24).required()
const userId = addSharedSchema('wd:userId', {
    type: 'string',
    pattern: '^[0-9a-f]{24}$',
    minLength: 24,
    maxLength: 24,
    wdLowercase: true,
    wdRequired: true,
    description: 'Example: `507f1f77bcf86cd799439011`\nID of the User'
});

const mailboxId = addSharedSchema('wd:mailboxId', {
    type: 'string',
    pattern: '^[0-9a-f]{24}$',
    minLength: 24,
    maxLength: 24,
    wdLowercase: true,
    wdRequired: true,
    description: 'ID of the Mailbox'
});

// Joi.number().min(1).required()
const messageId = addSharedSchema('wd:messageId', {
    type: 'number',
    minimum: 1,
    wdType: 'number',
    wdRequired: true,
    description: 'Message ID'
});

// sessSchema: Joi.string().max(255) (Joi strings reject '' by default)
const sess = addSharedSchema('wd:sess', {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    description: 'Session identifier for the logs'
});

// sessIPSchema: Joi.string().ip({ cidr: 'forbidden' })
const ip = addSharedSchema('wd:ip', {
    type: 'string',
    minLength: 1,
    wdValidator: 'ip',
    description: 'IP address for the logs '
});

// booleanSchema: Joi.boolean().empty('').truthy(...).falsy(...)
const boolean = addSharedSchema('wd:boolean', {
    type: 'boolean',
    wdType: 'boolean',
    wdEmpty: true
});

// pageLimitSchema: Joi.number().default(20).min(1).max(250)
const pageLimit = addSharedSchema('wd:pageLimit', {
    type: 'number',
    minimum: 1,
    maximum: 250,
    default: 20,
    wdType: 'number',
    description: 'How many records to return'
});

// pageNrSchema: Joi.number().default(1)
const pageNr = addSharedSchema('wd:pageNr', {
    type: 'number',
    default: 1,
    wdType: 'number',
    description: 'Current page number. Informational only, page numbers start from 1'
});

// mongoCursorSchema: trim, empty(''), base64url EJSON, max 1024
const cursor = addSharedSchema('wd:cursor', {
    type: 'string',
    maxLength: 1024,
    wdTrim: true,
    wdEmpty: true,
    wdValidator: 'mongoCursor'
});

// metaDataSchema: object or JSON string, normalized to a string
const metaData = addSharedSchema('wd:metaData', {
    wdValidator: 'metaData'
});

// usernameSchema: lowercase, username regex, 1..128
const username = addSharedSchema('wd:username', {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z0-9-]+(?:[._=:][a-z0-9-]+)*(?:@[a-z0-9-]+(?:[._=:][a-z0-9-]+)*)?$",
    wdLowercase: true
});

// ---- response side (serialization via fast-json-stringify) ----

// successRes: booleanSchema.required()
const successRes = addSharedSchema('wd:successRes', {
    type: 'boolean',
    description: 'Indicates successful response'
});

const totalRes = addSharedSchema('wd:totalRes', {
    type: 'number',
    description: 'How many results were found'
});

const pageRes = addSharedSchema('wd:pageRes', {
    type: 'number',
    description: 'Current page number. Derived from page query argument'
});

// alternatives(string, boolean): cursor string or false
const previousCursorRes = addSharedSchema('wd:previousCursorRes', {
    anyOf: [{ type: 'string' }, { type: 'boolean' }],
    description: 'Either a cursor string or false if there are not any previous results'
});

const nextCursorRes = addSharedSchema('wd:nextCursorRes', {
    anyOf: [{ type: 'string' }, { type: 'boolean' }],
    description: 'Either a cursor string or false if there are not any next results'
});

module.exports = {
    userId,
    mailboxId,
    messageId,
    sess,
    ip,
    boolean,
    pageLimit,
    pageNr,
    cursor,
    metaData,
    username,
    successRes,
    totalRes,
    pageRes,
    previousCursorRes,
    nextCursorRes
};
