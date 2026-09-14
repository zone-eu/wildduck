'use strict';

const config = require('@zone-eu/wild-config');
const AccessControl = require('accesscontrol');
const ac = new AccessControl();

ac.setGrants(config.api.roles);

config.on('reload', () => {
    ac.setGrants(config.api.roles);
});

module.exports.can = role => ac.can(role);

// A grant's attribute list is normally a plain list of field names, which needs none of the
// glob machinery accesscontrol runs for it: the library rebuilds a Notation and renormalizes
// the list for every element of an array, which measures 10 ms on a 50 message listing against
// 0.015 ms for reading the named keys. Anything carrying a glob, a negation or a dotted path is
// handed back to the library rather than reimplemented here, so the guard is a whitelist and
// every character notation treats specially falls back by construction.
const PLAIN_ATTRIBUTE = /^[A-Za-z0-9_]+$/;

function pickAttributes(value, attributes) {
    // The library throws on a value that is not an object; passing it through is deliberate,
    // since the only values that reach this are already-built response bodies
    if (!value || typeof value !== 'object') {
        return value;
    }

    let result = {};
    for (let attribute of attributes) {
        // own properties only, which is what the library reads too: a name that resolves
        // through the prototype chain is not a field of this document
        if (Object.hasOwn(value, attribute)) {
            result[attribute] = value[attribute];
        }
    }
    return result;
}

/**
 * Applies a permission's field allowlist to a value.
 *
 * Nested values are shared with the input rather than copied, exactly as `permission.filter`
 * does for a plain attribute list, so the result is meant for a payload about to be serialized
 * rather than one that is kept and mutated.
 *
 * @param {Object} permission Result of roles.can(role).readOwn(resource) or similar.
 * @param {Object|Array} data Value to filter.
 * @returns {Object|Array} Value with unlisted fields removed.
 */
module.exports.filterFields = (permission, data) => {
    let attributes = permission.attributes || [];

    if (!attributes.every(attribute => PLAIN_ATTRIBUTE.test(attribute))) {
        return permission.filter(data);
    }

    return Array.isArray(data) ? data.map(entry => pickAttributes(entry, attributes)) : pickAttributes(data, attributes);
};

/**
 * Applies a read permission's field allowlist to a response body.
 *
 * Only a plain-object success body is rewritten. An error body is left alone: it carries no
 * resource fields, the filter would empty it, and it is recognised by an `error` key or an
 * explicit `success:false` rather than by a falsy error value, so a body reporting failure
 * through either is never rewritten into a success. A buffer or a stream is not a resource, and
 * picking keys off one would destroy the response. A listing keeps its envelope: only its
 * `results` are filtered, since totals and cursors are not resource fields. Any other value is
 * returned unchanged.
 *
 * Framework-agnostic: it takes the body itself, so choosing the body out of a particular
 * server's response arguments stays in the web layer rather than in the permissions module.
 *
 * @param {Object} permission Result of roles.can(role).readOwn(resource) or similar.
 * @param {*} body Response body to filter.
 * @returns {*} The body with unlisted fields removed, or the original value when it is not a
 *   filterable resource body.
 */
module.exports.filterResponseBody = (permission, body) => {
    let isResourceBody =
        body &&
        typeof body === 'object' &&
        Object.getPrototypeOf(body) === Object.prototype &&
        !Object.prototype.hasOwnProperty.call(body, 'error') &&
        body.success !== false;

    if (!isResourceBody) {
        return body;
    }

    return Array.isArray(body.results)
        ? Object.assign({}, body, { results: module.exports.filterFields(permission, body.results) })
        : Object.assign({ success: true }, module.exports.filterFields(permission, body));
};
