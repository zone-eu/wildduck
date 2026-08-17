'use strict';

// Central validation engine for migrated API routes.
//
// This is THE documented Ajv configuration for the WildDuck API (the goal of
// the Fastify migration requires it to live in one place):
//
//   - allErrors: true            restify-era Joi ran with abortEarly: false
//   - coerceTypes: false         Ajv's own coercion accepts values Joi
//                                rejected ('0x10', '', 'Infinity' as numbers,
//                                numbers as strings). All coercion is done by
//                                the convert pre-pass below, replicating Joi
//                                {convert: true} semantics exactly.
//   - useDefaults: true          Joi .default() equivalents live in standard
//                                JSON Schema `default` keywords. The convert
//                                pass deletes empty-string values (Joi
//                                .empty('')) before validation so defaults
//                                apply to them as well.
//   - strict: false              schemas carry wd* conversion annotations and
//                                are shared with @fastify/swagger
//
// Validation runs on the MERGED path+query+body params object, exactly like
// the Joi setup did (body-declared fields may legally arrive via querystring,
// see docs/in-depth/api-validation.md). Per-route unknown-key behavior is
// controlled with additionalProperties (Joi allowUnknown).
//
// Conversion annotations understood by the convert pre-pass (all inert for
// Ajv itself):
//   wdType: 'number'|'boolean'|'date'|'binary'   Joi conversion target
//   wdEmpty: true                                Joi .empty('') - empty string
//                                                becomes undefined
//   wdTrim: true                                 Joi .trim()
//   wdLowercase: true                            Joi .lowercase()
//   wdMaxBytes: n                                Joi.binary().max(n)
//   wdValidator: '<name>'                        named custom validator below
//
// Dates convert to real Date instances and Buffers stay Buffers, matching
// what handlers received from Joi; such keys carry no JSON Schema `type`.

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const net = require('net');
const EJSON = require('mongodb-extended-json');
const { isEmailValid, isDomainValid, uriRegex } = require('@hapi/address');
const { tlds } = require('@hapi/tlds');
const { MAX_SUB_MAILBOXES, MAX_MAILBOX_NAME_LENGTH } = require('../consts');

const ajv = new Ajv({
    allErrors: true,
    coerceTypes: false,
    useDefaults: true,
    strict: false,
    allowUnionTypes: true,
    // minLength/maxLength count UTF-16 code units, the way String.length and
    // therefore Joi's .min()/.max() always counted them. Ajv's default counts
    // unicode code points instead, which both accepts strings the API used to
    // reject (any astral character counts as one instead of two) and turns
    // every length check into a full scan of the value: a 1MB html field costs
    // over a millisecond of CPU per request.
    unicode: false,
    // ajv reports `unicode` as deprecated but still honors it, and strict mode
    // is off, so there is nothing left worth printing at boot
    logger: false
});

addFormats(ajv);

// real (non-inert) keyword: validates that the convert pre-pass produced the
// expected native instance. Converted dates/buffers carry no JSON Schema
// `type`, so this is what catches failed conversions, including inside anyOf
// alternatives where the pre-pass intentionally swallows conversion errors.
ajv.addKeyword({
    keyword: 'wdInstanceof',
    validate: function wdInstanceof(schemaValue, data) {
        let valid = false;
        if (schemaValue === 'Date') {
            valid = data instanceof Date && !isNaN(data.getTime());
        } else if (schemaValue === 'Buffer') {
            valid = Buffer.isBuffer(data);
        }
        if (!valid) {
            // the keyword reports its own message; the generic renderer would
            // otherwise need verbose error objects to learn the expected type
            wdInstanceof.errors = [
                {
                    keyword: 'wdInstanceof',
                    message: `must be a valid ${String(schemaValue).toLowerCase()}`,
                    params: { wdInstanceof: schemaValue }
                }
            ];
        }
        return valid;
    },
    errors: true
});

// Joi.date().greater('now'): evaluated against the wall clock at request time
ajv.addKeyword({
    keyword: 'wdDateGtNow',
    validate: function wdDateGtNow(schemaValue, data) {
        return !schemaValue || (data instanceof Date && data.getTime() > Date.now());
    },
    errors: false
});

// Joi number conversion: trimmed decimal/scientific notation only, no hex,
// no empty string, no Infinity
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

// booleanSchema from lib/schemas.js: case-insensitive truthy/falsy lists
const TRUTHY = new Set(['y', 'true', 'yes', 'on', '1']);
const FALSY = new Set(['n', 'false', 'no', 'off', '0']);

const convertError = (path, message) => ({ path, message });

const conversions = {
    number(value, path, errors) {
        let nr;
        if (typeof value === 'number') {
            nr = value;
        } else if (typeof value === 'string') {
            const trimmed = value.trim();
            if (NUMBER_RE.test(trimmed)) {
                nr = Number(trimmed);
            }
        }
        if (nr === undefined || !Number.isFinite(nr)) {
            errors.push(convertError(path, `"${path}" must be a number`));
            return value;
        }
        if (Math.abs(nr) > Number.MAX_SAFE_INTEGER) {
            // Joi.number() rejects values outside the safe integer range
            errors.push(convertError(path, `"${path}" must be a safe number`));
        }
        return nr;
    },

    boolean(value, path, errors) {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number' && (value === 1 || value === 0)) {
            return value === 1;
        }
        if (typeof value === 'string') {
            const normalized = value.toLowerCase();
            if (TRUTHY.has(normalized)) {
                return true;
            }
            if (FALSY.has(normalized)) {
                return false;
            }
        }
        errors.push(convertError(path, `"${path}" must be a boolean`));
        return value;
    },

    // plain Joi.boolean(): only true/false and 'true'/'false' strings
    // (case-insensitive), unlike the lenient shared booleanSchema
    booleanStrict(value, path, errors) {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            const normalized = value.toLowerCase();
            if (normalized === 'true') {
                return true;
            }
            if (normalized === 'false') {
                return false;
            }
        }
        errors.push(convertError(path, `"${path}" must be a boolean`));
        return value;
    },

    date(value, path, errors) {
        let date;
        if (value instanceof Date) {
            date = value;
        } else if (typeof value === 'number') {
            date = new Date(value);
        } else if (typeof value === 'string') {
            const trimmed = value.trim();
            date = /^[+-]?\d+$/.test(trimmed) ? new Date(Number(trimmed)) : new Date(trimmed);
        }
        if (!date || isNaN(date.getTime())) {
            errors.push(convertError(path, `"${path}" must be a valid date`));
            return value;
        }
        return date;
    },

    binary(value, path, errors) {
        if (Buffer.isBuffer(value)) {
            return value;
        }
        if (typeof value === 'string') {
            return Buffer.from(value, 'utf8');
        }
        errors.push(convertError(path, `"${path}" must be a buffer or a string`));
        return value;
    }
};

const webhookUrlRegex = uriRegex({ scheme: [/smtps?/, /https?/], allowRelative: false, relativeOnly: false }).regex;
const smtpUrlRegex = uriRegex({ scheme: [/smtps?/], allowRelative: false, relativeOnly: false }).regex;
const plainUriRegex = uriRegex().regex;

// named custom validators replicating lib/schemas.js exactly; a validator can
// transform the value (return it) and push errors
const validators = {
    mongoCursor(value, path, errors) {
        if (typeof value !== 'string') {
            errors.push(convertError(path, `"${path}" must be a string`));
            return value;
        }
        if (/[^a-zA-Z0-9\-_]/.test(value)) {
            errors.push(convertError(path, `"${path}" contains an invalid value`));
            return value;
        }
        try {
            EJSON.parse(Buffer.from(value, 'base64url'));
        } catch {
            errors.push(convertError(path, `"${path}" contains an invalid value`));
        }
        return value;
    },

    metaData(value, path, errors) {
        let parsed;
        let str = value;

        if (typeof value === 'object' && value !== null) {
            try {
                parsed = value;
                str = JSON.stringify(value);
            } catch {
                errors.push(convertError(path, `"${path}" contains an invalid value`));
                return value;
            }
        } else if (typeof value === 'string') {
            try {
                parsed = JSON.parse(value);
            } catch {
                errors.push(convertError(path, `"${path}" contains an invalid value`));
                return value;
            }
        } else {
            errors.push(convertError(path, `"${path}" contains an invalid value`));
            return value;
        }

        str = str.trim();
        if (!str || str.length > 1024 * 1024) {
            errors.push(convertError(path, `"${path}" must be shorter than 1MB`));
            return value;
        }
        // Joi.object() rejected arrays as well
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            errors.push(convertError(path, `"${path}" must be an object`));
            return value;
        }
        return str;
    },

    mailboxPath(value, path, errors) {
        if (typeof value !== 'string') {
            errors.push(convertError(path, `"${path}" must be a string`));
            return value;
        }
        const parts = value.split('/');
        if (parts.length > MAX_SUB_MAILBOXES) {
            errors.push(convertError(path, `The mailbox path cannot be more than ${MAX_SUB_MAILBOXES} levels deep`));
            return value;
        }
        for (const part of parts) {
            if (part.length > MAX_MAILBOX_NAME_LENGTH) {
                errors.push(convertError(path, `Any part of the mailbox path cannot be longer than ${MAX_MAILBOX_NAME_LENGTH} chars long`));
                return value;
            }
        }
        return value;
    },

    ip(value, path, errors) {
        // sessIPSchema: ipv4 or ipv6, no CIDR
        if (typeof value !== 'string' || !net.isIP(value)) {
            errors.push(convertError(path, `"${path}" must be a valid IP address`));
        }
        return value;
    },

    email(value, path, errors) {
        // Joi.string().email({ tlds: false }): joi delegates to @hapi/address,
        // depending on it directly keeps acceptance identical after joi leaves
        if (typeof value !== 'string' || !isEmailValid(value, { tlds: false })) {
            errors.push(convertError(path, `"${path}" must be a valid email`));
        }
        return value;
    },

    hostname(value, path, errors) {
        // Joi.string().hostname(): a domain name (single segment allowed) or
        // an IP literal (verified equivalent by probe against Joi 18)
        if (typeof value !== 'string' || !(isDomainValid(value, { minDomainSegments: 1 }) || net.isIP(value))) {
            errors.push(convertError(path, `"${path}" must be a valid hostname`));
        }
        return value;
    },

    emailFailoverEmpty(value) {
        // Joi email().failover(''): any invalid value silently becomes ''
        if (typeof value !== 'string' || !isEmailValid(value, { tlds: false })) {
            return '';
        }
        return value;
    },

    domain(value, path, errors) {
        // Joi.string().domain() with default options: two or more segments
        // and the TLD must be on the IANA list (joi's own @hapi/tlds set)
        if (typeof value !== 'string' || !isDomainValid(value, { tlds: { allow: tlds } })) {
            errors.push(convertError(path, `"${path}" must be a valid domain`));
        }
        return value;
    },

    uri(value, path, errors) {
        // plain Joi.string().uri(): any absolute URI
        if (typeof value !== 'string' || !plainUriRegex.test(value)) {
            errors.push(convertError(path, `"${path}" must be a valid uri`));
        }
        return value;
    },

    smtpUrl(value, path, errors) {
        // Joi.string().uri({ scheme: [/smtps?/] }): MTA relay urls
        if (typeof value !== 'string' || !smtpUrlRegex.test(value)) {
            errors.push(convertError(path, `"${path}" must be a valid uri`));
        }
        return value;
    },

    webhookUrl(value, path, errors) {
        // Joi.string().uri({ scheme: [/smtps?/, /https?/] }): joi builds the
        // regex through @hapi/address, use the same builder
        if (typeof value !== 'string' || !webhookUrlRegex.test(value)) {
            errors.push(convertError(path, `"${path}" must be a valid uri`));
        }
        return value;
    }
};

// validator-backed assertion usable inside anyOf alternatives where inert
// convert-pass annotations cannot express "email OR relay url" style unions
ajv.addKeyword({
    keyword: 'wdAssert',
    validate: function wdAssert(schemaValue, data) {
        const scratch = [];
        validators[schemaValue](data, '', scratch);
        if (!scratch.length) {
            return true;
        }
        // report the validator's own wording (the empty path it was called with
        // leaves a `""` prefix to strip). Without this the internal keyword name
        // leaks into the public API error as
        // `must pass "wdAssert" keyword validation`
        wdAssert.errors = [
            {
                keyword: 'wdAssert',
                message: scratch[0].message.replace(/^"" /, ''),
                params: { wdAssert: schemaValue }
            }
        ];
        return false;
    },
    errors: true
});

// shared schema registry: resolvable by the convert pass and registered with
// Ajv (validation) and fastify (@fastify/swagger docs)
const sharedSchemas = new Map();

function addSharedSchema(id, schema) {
    schema = Object.assign({ $id: id }, schema);
    sharedSchemas.set(id, schema);
    ajv.addSchema(schema);
    return schema;
}

// Resolves wd:* $refs at compile time, merging local sibling keys over the
// shared base (mirrors Joi's sharedSchema.default(x).description(y) chains).
// Ajv then compiles the fully resolved tree; swagger keeps the real $refs.
function resolveTree(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return node;
    }
    let resolved = node;
    if (node.$ref && sharedSchemas.has(node.$ref)) {
        const { $ref, ...local } = node;
        const base = sharedSchemas.get($ref);
        const { $id, ...baseRest } = base; // eslint-disable-line no-unused-vars
        resolved = Object.assign({}, baseRest, local);
    }
    const out = {};
    for (const key of Object.keys(resolved)) {
        const value = resolved[key];
        if (key === 'properties' && value && typeof value === 'object') {
            out.properties = {};
            for (const prop of Object.keys(value)) {
                out.properties[prop] = resolveTree(value[prop]);
            }
        } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
            out.items = resolveTree(value);
        } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) {
            out[key] = value.map(branch => resolveTree(branch));
        } else if (['if', 'then', 'else'].includes(key) && value && typeof value === 'object') {
            out[key] = resolveTree(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

// documentation view of a validation schema: the wd* conversion vocabulary is
// internal, OpenAPI consumers get plain JSON Schema with equivalent types
function toDocSchema(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return node;
    }
    const out = {};
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (/^wd[A-Z]/.test(key) && key !== 'wdType') {
            continue;
        }
        if (key === 'wdType') {
            if (!node.type) {
                if (value === 'date') {
                    out.type = 'string';
                    out.format = 'date-time';
                } else if (value === 'binary') {
                    out.type = 'string';
                    out.format = 'binary';
                } else {
                    out.type = value === 'booleanStrict' ? 'boolean' : value;
                }
            }
            continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = toDocSchema(value);
        } else if (Array.isArray(value)) {
            out[key] = value.map(entry => (entry && typeof entry === 'object' && !Array.isArray(entry) ? toDocSchema(entry) : entry));
        } else {
            out[key] = value;
        }
    }
    return out;
}

// build a doc-only object schema for one request part (params, querystring
// or body); Fastify only documents these, validation runs on the merged
// object in the route wrapper
function docPartSchema(defs) {
    const keys = Object.keys(defs || {});
    if (!keys.length) {
        return null;
    }
    const properties = {};
    const required = [];
    for (const key of keys) {
        const resolved = resolveTree(defs[key]);
        if (resolved && resolved.wdRequired) {
            required.push(key);
        }
        properties[key] = toDocSchema(resolved);
    }
    const schema = { type: 'object', properties };
    if (required.length) {
        schema.required = required;
    }
    return schema;
}

// strips every wd* annotation from a finished OpenAPI document (the shared
// $ref components published by @fastify/swagger never pass through
// toDocSchema, so the final specification gets a full sweep)
function stripInternalKeywords(node) {
    if (Array.isArray(node)) {
        return node.map(entry => stripInternalKeywords(entry));
    }
    if (!node || typeof node !== 'object') {
        return node;
    }
    const out = {};
    for (const key of Object.keys(node)) {
        if (/^wd[A-Z]/.test(key)) {
            continue;
        }
        out[key] = stripInternalKeywords(node[key]);
    }
    return out;
}

// compiled cache for if-conditions evaluated during the convert pre-pass
const conditionCache = new WeakMap();
function evalCondition(schema, value) {
    let compiled = conditionCache.get(schema);
    if (!compiled) {
        compiled = ajv.compile(schema);
        conditionCache.set(schema, compiled);
    }
    return compiled(value);
}

// deep clone for params objects and speculative alternative-branch attempts;
// Dates and Buffers are conversion results and travel by reference
function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.map(cloneValue);
    }
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        const out = {};
        for (const key of Object.keys(value)) {
            out[key] = cloneValue(value[key]);
        }
        return out;
    }
    return value;
}

// keywords that make a schema subtree mutate the value during the convert
// pre-pass (wdMaxBytes only reports, it never transforms); `default` counts
// because evalCondition runs with useDefaults enabled
const TRANSFORM_KEYWORDS = ['wdType', 'wdValidator', 'wdEmpty', 'wdTrim', 'wdLowercase', 'wdUppercase', 'wdSingle', 'wdSplitCsv', 'default'];

const branchTransformCache = new WeakMap();
function branchTransforms(node) {
    if (!node || typeof node !== 'object') {
        return false;
    }
    let cached = branchTransformCache.get(node);
    if (cached !== undefined) {
        return cached;
    }
    cached = !Array.isArray(node) && TRANSFORM_KEYWORDS.some(key => node[key] !== undefined);
    if (!cached) {
        for (const key of Object.keys(node)) {
            if (branchTransforms(node[key])) {
                cached = true;
                break;
            }
        }
    }
    branchTransformCache.set(node, cached);
    return cached;
}

// Joi .failover(): substitutes a value instead of pushing an error. Unlike the
// rejecting validators these are meaningful for a null input as well, so the
// convert pre-pass runs them even when the schema declares a type
validators.emailFailoverEmpty.wdFailover = true;

// Joi.binary() coerces ANY string, '' included, into a Buffer, so an .empty('')
// declared next to it could never match the raw value. Conversions marked here
// skip the pre-conversion empty check and are only matched after coercion
conversions.binary.wdCoercesAnyString = true;

// the default Joi .empty(true) list, hoisted out of the per-node walk
const EMPTY_STRING_LIST = [''];

/**
 * The convert pre-pass. Walks the schema/data pair and applies Joi
 * {convert: true} conversions in place. Returns collected conversion errors.
 */
function convertValue(schema, value, path, errors) {
    if (!schema || value === undefined) {
        return value;
    }

    if (value === null) {
        // JSON null skips all conversions. Typed schemas reject it through the
        // Ajv `type` keyword; a typeless schema has no Ajv-side check, so its
        // wdValidator must still run (each validator rejects null the way the
        // Joi custom validator did). Failover validators coerce instead of
        // rejecting, so they have to run for a typed schema too, otherwise a
        // null lands on Ajv and 400s where Joi substituted the failover value
        if (schema.wdValidator && (!schema.type || validators[schema.wdValidator].wdFailover)) {
            return validators[schema.wdValidator](value, path, errors);
        }
        return value;
    }

    // Joi .empty(x): true means [''], a list matches both the raw value and
    // (below) the converted value, mirroring Joi which matches post-coercion
    const emptyList = schema.wdEmpty === true ? EMPTY_STRING_LIST : schema.wdEmpty;
    if (emptyList && !(schema.wdType && conversions[schema.wdType].wdCoercesAnyString) && emptyList.includes(value)) {
        return undefined;
    }

    if (schema.wdTrim && typeof value === 'string') {
        value = value.trim();
        if (emptyList && emptyList.includes(value)) {
            return undefined;
        }
    }

    if (schema.wdLowercase && typeof value === 'string') {
        value = value.toLowerCase();
    }

    if (schema.wdUppercase && typeof value === 'string') {
        value = value.toUpperCase();
    }

    // Joi.array().single(): a bare scalar is wrapped into an array
    if (schema.wdSingle && value !== undefined && !Array.isArray(value)) {
        value = [value];
    }

    // handler-level pattern from the restify era: comma separated string
    // accepted in place of an array (scopes)
    if (schema.wdSplitCsv && typeof value === 'string') {
        value = value
            .split(',')
            .map(entry => entry.trim())
            .filter(entry => entry);
    }

    if (schema.wdType) {
        const preConversion = value;
        value = conversions[schema.wdType](preConversion, path, errors);
        if (emptyList && emptyList.includes(value)) {
            return undefined;
        }
    }

    if (schema.wdMaxBytes && Buffer.isBuffer(value) && value.length > schema.wdMaxBytes) {
        errors.push(convertError(path, `"${path}" must not exceed ${schema.wdMaxBytes} bytes`));
    }

    if (schema.wdValidator) {
        value = validators[schema.wdValidator](value, path, errors);
    }

    if (schema.properties && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        for (const key of Object.keys(schema.properties)) {
            if (value[key] !== undefined) {
                const converted = convertValue(schema.properties[key], value[key], path ? `${path},${key}` : key, errors);
                if (converted === undefined) {
                    delete value[key];
                } else {
                    value[key] = converted;
                }
            }
        }
    }

    if (schema.items && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            value[i] = convertValue(schema.items, value[i], `${path},${i}`, errors);
        }
    }

    if (Array.isArray(schema.allOf)) {
        for (const branch of schema.allOf) {
            if (branch && branch.if && (branch.then || branch.else)) {
                // conditional conversion: only the branch selected by the if
                // condition applies (per-key value schemas in settings)
                const target = evalCondition(branch.if, value) ? branch.then : branch.else;
                if (target) {
                    value = convertValue(target, value, path, errors);
                }
            } else {
                value = convertValue(branch, value, path, errors);
            }
        }
    }

    // alternatives: Joi tried the branches in order and kept the first branch
    // that accepted the converted value, so transforms from non-matching
    // branches must leave no trace. Only branches that carry transforms need
    // the speculative clone-convert-check (conversion errors stay out, a
    // failed branch is not an error); once no later branch can mutate the
    // value the outcome is Ajv's to decide and the loop can stop early.
    for (const branchKey of ['anyOf', 'oneOf']) {
        const branches = schema[branchKey];
        if (Array.isArray(branches)) {
            let lastTransforming = -1;
            for (let i = 0; i < branches.length; i++) {
                if (branchTransforms(branches[i])) {
                    lastTransforming = i;
                }
            }
            for (let i = 0; i <= lastTransforming; i++) {
                const branch = branches[i];
                if (branchTransforms(branch)) {
                    const branchErrors = [];
                    const candidate = convertValue(branch, cloneValue(value), path, branchErrors);
                    if (!branchErrors.length && evalCondition(branch, candidate)) {
                        value = candidate;
                        break;
                    }
                } else if (evalCondition(branch, value)) {
                    // a matching earlier branch: the value stays as it is and
                    // the remaining transforming branches must not touch it
                    break;
                }
            }
        }
    }

    return value;
}

function ajvErrorPath(err) {
    if (err.keyword === 'additionalProperties') {
        const base = err.instancePath.split('/').filter(Boolean);
        base.push(err.params.additionalProperty);
        return base.join(',');
    }
    if (err.keyword === 'required') {
        const base = err.instancePath.split('/').filter(Boolean);
        base.push(err.params.missingProperty);
        return base.join(',');
    }
    return err.instancePath.split('/').filter(Boolean).join(',');
}

function ajvErrorMessage(err, path) {
    if (err.keyword === 'additionalProperties') {
        return `"${err.params.additionalProperty}" is not allowed`;
    }
    if (err.keyword === 'required') {
        return `"${err.params.missingProperty}" is required`;
    }
    if (err.keyword === 'not') {
        return `"${path || 'value'}" contains an invalid value`;
    }
    return `"${path || 'value'}" ${err.message}`;
}

/**
 * Compiles a merged-object validator for a route's validationObjs.
 * Returns validate(params) -> { value, error, details } where details has the
 * same shape tools.validationErrors() produced for Joi results.
 */
function compileRouteValidator(validationObjs, options) {
    options = options || {};

    const properties = {};
    const required = [];

    // Joi allowUnknown applied to nested objects as well: strip explicit
    // additionalProperties: false everywhere inside the tree
    const stripAdditional = node => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return node;
        }
        const out = {};
        for (const key of Object.keys(node)) {
            if (key === 'additionalProperties' && node[key] === false) {
                continue;
            }
            const value = node[key];
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                out[key] = stripAdditional(value);
            } else if (Array.isArray(value)) {
                out[key] = value.map(entry => (entry && typeof entry === 'object' ? stripAdditional(entry) : entry));
            } else {
                out[key] = value;
            }
        }
        return out;
    };

    for (const part of ['pathParams', 'requestBody', 'queryParams']) {
        const defs = validationObjs[part] || {};
        for (const key of Object.keys(defs)) {
            let resolved = resolveTree(defs[key]);
            if (options.allowUnknown) {
                resolved = stripAdditional(resolved);
            }
            properties[key] = resolved;
            if (resolved && resolved.wdRequired) {
                required.push(key);
            }
        }
    }

    const mergedSchema = {
        type: 'object',
        properties,
        additionalProperties: !!options.allowUnknown
    };
    if (required.length) {
        mergedSchema.required = required;
    }
    if (validationObjs.conditions && validationObjs.conditions.length) {
        // cross-key conditionals (Joi .when chains), plain JSON Schema
        // fragments validated against the merged object
        mergedSchema.allOf = validationObjs.conditions.map(condition => resolveTree(condition));
    }

    const compiled = ajv.compile(mergedSchema);

    return params => {
        const errors = [];
        const value = convertValue(mergedSchema, params, '', errors);

        if (!compiled(value)) {
            for (const err of compiled.errors || []) {
                if (err.keyword === 'if') {
                    // the failed then-branch errors are already reported
                    continue;
                }
                const path = ajvErrorPath(err);
                errors.push(convertError(path, ajvErrorMessage(err, path)));
            }
        }

        if (!errors.length) {
            return { value };
        }

        const details = {};
        const messages = [];
        const seen = new Set();
        for (const err of errors) {
            const key = err.path || 'value';
            if (!details[key]) {
                details[key] = err.message;
            }
            if (!seen.has(key + ':' + err.message)) {
                seen.add(key + ':' + err.message);
                messages.push(err.message);
            }
        }

        return {
            value,
            error: messages.join('. '),
            details
        };
    };
}

module.exports = {
    addSharedSchema,
    sharedSchemas,
    resolveTree,
    cloneValue,
    compileRouteValidator,
    docPartSchema,
    stripInternalKeywords
};
