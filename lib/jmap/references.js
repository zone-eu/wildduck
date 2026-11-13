'use strict';

// Result references (RFC 8620 3.7): an argument named "#foo" whose value is {resultOf, name, path}
// takes the value at `path` of an earlier method response. `path` is a JSON Pointer (RFC 6901) with
// one extension: "*" maps the rest of the path over every item of an array, flattening arrays the
// items yield. Only own properties are followed, so a path can not reach __proto__ or friends.

const { setOwn } = require('./types/common');

const has = (object, key) => Object.hasOwn(object, key);

class ReferenceError extends Error {
    constructor(type, message) {
        super(message);
        this.type = type;
    }
}

// RFC 6901 3: ~1 is "/", ~0 is "~", in that order
const decodeToken = token => token.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * Evaluates a JSON Pointer with the "*" extension.
 *
 * @param {*} value Root value
 * @param {String} path For example "/list/*\/threadId"
 * @returns {*} The referenced value
 * @throws {ReferenceError} type invalidResultReference if the path does not resolve
 */
function evaluatePointer(value, path) {
    if (path === '') {
        return value;
    }
    if (typeof path !== 'string' || path[0] !== '/') {
        throw new ReferenceError('invalidResultReference', 'path must be a JSON Pointer');
    }
    return walk(value, path.slice(1).split('/').map(decodeToken));
}

// walks from tokens[index] on; the index moves instead of the token list being copied at every step, so a
// long path costs linear time also under "*"
function walk(value, tokens, index = 0) {
    if (index === tokens.length) {
        return value;
    }
    const token = tokens[index];

    if (Array.isArray(value)) {
        if (token === '*') {
            return value.flatMap(item => {
                const result = walk(item, tokens, index + 1);
                return Array.isArray(result) ? result : [result];
            });
        }
        if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= value.length) {
            throw new ReferenceError('invalidResultReference', `no array element "${token}"`);
        }
        return walk(value[Number(token)], tokens, index + 1);
    }

    if (value && typeof value === 'object' && has(value, token)) {
        return walk(value[token], tokens, index + 1);
    }
    throw new ReferenceError('invalidResultReference', `no property "${token}"`);
}

/**
 * Replaces the "#foo" arguments of a method call with the referenced values.
 *
 * @param {Object} args Method arguments
 * @param {Array} responses Responses so far, as [name, arguments, callId] triples
 * @returns {Object} New arguments object
 * @throws {ReferenceError} invalidArguments if "foo" and "#foo" are both given, invalidResultReference otherwise
 */
function resolveReferences(args, responses) {
    const resolved = {};
    // defined, not assigned: an argument named __proto__ stays an own property and never becomes the prototype
    const set = (key, value) => setOwn(resolved, key, value);
    for (const key of Object.keys(args)) {
        if (key[0] !== '#') {
            set(key, args[key]);
            continue;
        }
        const name = key.slice(1);
        if (name === '__proto__') {
            throw new ReferenceError('invalidArguments', `"${key}" is not a valid argument name`);
        }
        if (has(args, name)) {
            throw new ReferenceError('invalidArguments', `both "${name}" and "${key}" given`);
        }
        const reference = args[key];
        if (
            !reference ||
            typeof reference !== 'object' ||
            typeof reference.resultOf !== 'string' ||
            typeof reference.name !== 'string' ||
            typeof reference.path !== 'string'
        ) {
            throw new ReferenceError('invalidResultReference', `"${key}" is not a ResultReference`);
        }
        // the earliest response with that call id and method name (RFC 8620 3.7)
        const response = responses.find(entry => entry[2] === reference.resultOf && entry[0] === reference.name);
        if (!response) {
            throw new ReferenceError('invalidResultReference', `no "${reference.name}" response for "${reference.resultOf}"`);
        }
        set(name, evaluatePointer(response[1], reference.path));
    }
    return resolved;
}

module.exports = { evaluatePointer, resolveReferences, ReferenceError };
