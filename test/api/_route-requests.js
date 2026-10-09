'use strict';

// Builds requests for API routes from their validationObjs: a plausible,
// usually valid request per route, and seeded mutations of it for fuzzing.
// Not a test file itself, the mocha glob only picks up *-test.js.

const qs = require('qs');
const { prng } = require('../prng');
const { sharedSchemas } = require('../../lib/fastify/validation');
require('../../lib/schemas/json-schemas'); // populates sharedSchemas

// the shared seeded generator plus below(n): an integer in [0, n). A failing
// case is reproduced from its seed
const createRandom = seed => {
    const rnd = prng(seed);
    rnd.below = max => rnd.int(0, max - 1);
    return rnd;
};

// a $ref schema merged with the keys set next to the $ref (description, default, ...)
const resolve = schema => {
    if (schema && schema.$ref && sharedSchemas.has(schema.$ref)) {
        const { $ref, ...rest } = schema;
        return { ...sharedSchemas.get($ref), ...rest };
    }
    return schema || {};
};

const isRequired = schema => !!resolve(schema).wdRequired;

const HEX24 = /\[0-9a-f\]\{24\}/;

// an arbitrary pattern can not be satisfied in general: the first candidate
// that matches it and the length limits covers the patterns the API uses
// (ids, hex tokens, usernames, message ranges)
const samplePattern = (schema, fixtures) => {
    const hex = length => '0123456789abcdef'.repeat(Math.ceil(length / 16)).slice(0, length);
    const candidates = ['0'.repeat(23) + '1', `fuzz${fixtures.runId}`.toLowerCase(), '1', hex(40), hex(64), hex(32), hex(16), 'fuzz'];
    const pattern = new RegExp(schema.pattern);
    const fits = value => pattern.test(value) && value.length >= (schema.minLength || 0) && value.length <= (schema.maxLength || Infinity);
    return candidates.find(fits) || candidates[1];
};

/**
 * A plausible value for a schema, so that a generated request reaches handler
 * code instead of failing validation.
 *
 * fixtures: {runId, domain, email, ids, path}. ids maps id fields (user,
 * mailbox, ...) to records of the test user, path maps path param names to
 * the value to use for them.
 */
function sampleValue(schema, key, ctx, depth = 0) {
    schema = resolve(schema);
    const { fixtures, rnd } = ctx;

    if (Object.hasOwn(schema, 'const')) {
        return schema.const;
    }
    if (Array.isArray(schema.enum) && schema.enum.length) {
        return rnd.pick(schema.enum);
    }
    const alternatives = schema.anyOf || schema.oneOf;
    if (Array.isArray(alternatives) && alternatives.length) {
        // an alternative with a named validator (email, uri, ...) is the
        // canonical form of a union, otherwise the first one is
        const preferred = alternatives.find(alternative => resolve(alternative).wdValidator) || alternatives[0];
        return sampleValue({ ...preferred, wdRequired: schema.wdRequired }, key, ctx, depth);
    }

    // an id field named like a fixture record (mailbox, user, ...) points at that record
    if (key && Object.hasOwn(fixtures.ids, key) && schema.pattern && HEX24.test(schema.pattern)) {
        return fixtures.ids[key];
    }

    switch (schema.wdValidator) {
        case 'email':
        case 'emailFailoverEmpty':
            return fixtures.email;
        case 'domain':
            return fixtures.domain;
        case 'hostname':
            return `mx.${fixtures.domain}`;
        case 'ip':
            return '127.0.0.1';
        case 'uri':
            return `https://${fixtures.domain}/path`;
        case 'webhookUrl':
            // never delivered anywhere: nothing listens on the discard port
            return 'http://127.0.0.1:9/webhook';
        case 'smtpUrl':
            return `smtp://mx.${fixtures.domain}:25`;
        case 'mailboxPath':
            return `Fuzz/${fixtures.runId}`;
        case 'label':
            return `Label ${fixtures.runId}`;
        case 'metaData':
            return { source: 'fuzz' };
        case 'mongoCursor':
            return undefined;
    }

    if (schema.wdInstanceof === 'Date' || schema.wdType === 'date' || schema.wdType === 'dateIso' || schema.format === 'date-time') {
        return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    }
    if (schema.wdInstanceof === 'Buffer' || schema.wdType === 'binary') {
        return 'Subject: fuzz\r\n\r\nfuzz body\r\n';
    }

    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    switch (type) {
        case 'string': {
            if (schema.format === 'email') {
                return fixtures.email;
            }
            if (schema.pattern) {
                return samplePattern(schema, fixtures);
            }
            const min = Math.max(schema.minLength || 0, 1);
            const max = schema.maxLength || 32;
            return 'fuzz'.repeat(Math.ceil(min / 4)).slice(0, Math.max(min, Math.min(max, 8)));
        }
        case 'number':
        case 'integer':
            return typeof schema.minimum === 'number' ? Math.max(schema.minimum, 1) : 1;
        case 'boolean':
            return rnd.chance(0.5);
        case 'array': {
            if (depth > 4) {
                return [];
            }
            const item = sampleValue(schema.items || {}, null, ctx, depth + 1);
            return item === undefined ? [] : [item];
        }
        case 'object':
            return sampleObject(schema.properties || {}, schema.required || [], ctx, depth + 1);
    }

    // typeless: anything goes, keep it simple
    return schema.wdRequired ? 'fuzz' : undefined;
}

function sampleObject(properties, required, ctx, depth) {
    const out = {};
    for (const [key, schema] of Object.entries(properties)) {
        const needed = required.includes(key) || isRequired(schema);
        if (!needed && !ctx.rnd.chance(ctx.optionalChance)) {
            continue;
        }
        const value = sampleValue(schema, key, ctx, depth);
        if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

/**
 * A request for a route: path params from the fixtures, required fields and a
 * random share of the optional ones.
 *
 * @returns {{pathParams: Object, params: Object}}
 */
function buildRequest(route, { rnd, fixtures, optionalChance = 0.3 }) {
    const ctx = { rnd, fixtures, optionalChance };
    const validationObjs = route.config.validationObjs;

    const pathParams = {};
    for (const [, name] of route.url.matchAll(/:(\w+)/g)) {
        pathParams[name] = Object.hasOwn(fixtures.path, name) ? fixtures.path[name] : sampleValue((validationObjs.pathParams || {})[name] || {}, name, ctx);
    }

    const params = {
        ...sampleObject(validationObjs.queryParams || {}, [], ctx, 0),
        ...sampleObject(validationObjs.requestBody || {}, [], ctx, 0)
    };

    return { pathParams, params };
}

/**
 * app.inject() options for a request. GET, DELETE and HEAD send the params in
 * the query string, everything else as a JSON body.
 */
function toInject(route, { pathParams, params, body }, { token } = {}) {
    const url = route.url.replace(/:(\w+)/g, (match, name) => encodeURIComponent(String(pathParams[name])));
    const headers = token ? { 'x-access-token': token } : {};

    if (['GET', 'DELETE', 'HEAD'].includes(route.method)) {
        const query = qs.stringify(params, { allowDots: true });
        return { method: route.method, url: query ? `${url}?${query}` : url, headers };
    }

    return {
        method: route.method,
        url,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: body !== undefined ? body : JSON.stringify(params)
    };
}

// hostile values: wrong types, extremes, operator injection, prototype keys
const HOSTILE_VALUES = [
    null,
    '',
    ' ',
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 2,
    true,
    [],
    {},
    ['a', 'b'],
    { $gt: '' },
    { $ne: null },
    { $where: 'sleep(1000)' },
    'x'.repeat(70000),
    '\u0000',
    '\ud83d',
    '../../../etc/passwd',
    '<script>alert(1)</script>',
    "'; DROP TABLE users; --",
    '1e1000',
    'NaN',
    'Infinity',
    '0x10',
    'zzzzzzzzzzzzzzzzzzzzzzzz',
    'ÄÖÜ ✉ 😀',
    { constructor: { prototype: { polluted: true } } },
    JSON.parse('{"__proto__": {"polluted": true}}')
];

const deepObject = depth => (depth ? { nested: deepObject(depth - 1) } : 'bottom');

/**
 * Mutates a request in place with one to three of: a hostile value for a
 * random key, a dropped key, an unknown key, a hostile path param, or a body
 * that is not an object at all.
 *
 * @returns {Array<String>} what was done, for the failure message
 */
function mutateRequest(request, rnd) {
    const done = [];
    const count = 1 + rnd.below(3);

    for (let i = 0; i < count; i++) {
        const keys = Object.keys(request.params);
        const pathKeys = Object.keys(request.pathParams);
        switch (rnd.below(7)) {
            case 0:
            case 1:
            case 2: {
                const key = keys.length && rnd.chance(0.8) ? rnd.pick(keys) : `unknown${rnd.below(100)}`;
                const index = rnd.below(HOSTILE_VALUES.length);
                request.params[key] = HOSTILE_VALUES[index];
                done.push(`${key}=hostile[${index}]`);
                break;
            }
            case 3:
                if (keys.length) {
                    const key = rnd.pick(keys);
                    delete request.params[key];
                    done.push(`drop ${key}`);
                }
                break;
            case 4:
                if (pathKeys.length) {
                    const key = rnd.pick(pathKeys);
                    const value = rnd.pick(['zzz', '-1', '0', '%00', 'a'.repeat(300), '../x', '$where']);
                    request.pathParams[key] = value;
                    done.push(`path ${key}=${JSON.stringify(value).slice(0, 20)}`);
                }
                break;
            case 5: {
                const key = keys.length ? rnd.pick(keys) : 'nested';
                request.params[key] = deepObject(40);
                done.push(`${key}=deep`);
                break;
            }
            case 6: {
                const body = rnd.pick(['[]', '[1,2]', '"string"', '42', 'null', '{"broken"', '']);
                request.body = body;
                done.push(`body=${body}`);
                break;
            }
        }
    }

    return done;
}

const routeKey = route => `${route.method} ${route.url}`;

// rejects when a request hangs, so one stuck route fails the test instead of the run
const withTimeout = (promise, ms) => {
    let timer;
    return Promise.race([promise, new Promise((resolve, reject) => (timer = setTimeout(() => reject(new Error(`no response in ${ms}ms`)), ms)))]).finally(() =>
        clearTimeout(timer)
    );
};

module.exports = { createRandom, buildRequest, toInject, mutateRequest, routeKey, withTimeout };
