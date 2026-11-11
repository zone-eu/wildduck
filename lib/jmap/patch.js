'use strict';

// PatchObject (RFC 8620 5.3): an update given as a map of JSON Pointers (without the leading slash)
// to new values. A null value removes the key, or resets a top level property to its default. A
// pointer may not reach into an array, its parent must exist, and no pointer may be a prefix of
// another. The patch is applied as a whole to a copy of the object; the caller judges the result.

const { SetError } = require('./set-errors');
// setOwn: a "__proto__" token is an ordinary key and never replaces a prototype
const { isObject, setOwn } = require('./types/common');

class PatchError extends SetError {
    /**
     * @param {String} type SetError type, invalidPatch or invalidProperties
     * @param {String} description
     * @param {String[]} [properties] offending properties for invalidProperties
     */
    constructor(type, description, properties) {
        super(type, description, properties ? { properties } : {});
        this.properties = properties;
    }
}

const invalidPatch = description => new PatchError('invalidPatch', description);

/**
 * Splits a patch key into its reference tokens.
 *
 * @param {String} key JSON Pointer without the leading slash
 * @returns {String[]}
 */
function parsePointer(key) {
    if (typeof key !== 'string' || !key.length || key.startsWith('/')) {
        throw invalidPatch(`invalid patch path ${JSON.stringify(key)}`);
    }
    return key.split('/').map(token => {
        if (!token.length || /~(?![01])/.test(token)) {
            throw invalidPatch(`invalid patch path ${JSON.stringify(key)}`);
        }
        return token.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

const own = (object, key) => Object.hasOwn(object, key);

/**
 * Applies a PatchObject.
 *
 * @param {Object} object The current object (not modified)
 * @param {Object} patch The PatchObject
 * @param {Object} [options]
 * @param {Set<String>|String[]} [options.properties] Known top level properties; any other is invalidProperties
 * @returns {{object: Object, properties: Set<String>}} the patched copy and the top level properties the patch touched
 * @throws {PatchError}
 */
function applyPatch(object, patch, options = {}) {
    if (!isObject(patch)) {
        throw invalidPatch('a patch must be an object');
    }
    const known = options.properties ? new Set(options.properties) : null;
    const paths = Object.keys(patch).map(key => ({ key, tokens: parsePointer(key) }));

    const unknown = known ? [...new Set(paths.map(path => path.tokens[0]).filter(property => !known.has(property)))] : [];
    if (unknown.length) {
        throw new PatchError('invalidProperties', `unknown properties: ${unknown.join(', ')}`, unknown);
    }

    // no path may be a prefix of another (compared on decoded tokens)
    const seen = new Set(paths.map(path => JSON.stringify(path.tokens)));
    for (const path of paths) {
        for (let length = 1; length < path.tokens.length; length++) {
            if (seen.has(JSON.stringify(path.tokens.slice(0, length)))) {
                throw invalidPatch(`patch paths overlap at ${path.key}`);
            }
        }
    }

    const result = Object.assign({}, object);
    // containers already copied, so a container is copied once however many paths go through it
    const copied = new Set([result]);
    for (const { key, tokens } of paths) {
        let container = result;
        for (const token of tokens.slice(0, -1)) {
            const next = own(container, token) ? container[token] : undefined;
            if (!isObject(next)) {
                throw invalidPatch(
                    next === undefined || next === null ? `${key}: parent does not exist` : `${key}: can not patch inside a value that is not an object`
                );
            }
            let copy = next;
            if (!copied.has(next)) {
                copy = Object.assign({}, next);
                copied.add(copy);
                setOwn(container, token, copy);
            }
            container = copy;
        }
        const last = tokens[tokens.length - 1];
        if (tokens.length > 1 && patch[key] === null) {
            delete container[last];
        } else {
            setOwn(container, last, patch[key]);
        }
    }

    return { object: result, properties: new Set(paths.map(path => path.tokens[0])) };
}

module.exports = { applyPatch, parsePointer, PatchError };
