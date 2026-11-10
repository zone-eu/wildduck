'use strict';

const config = require('@zone-eu/wild-config');
const AccessControl = require('accesscontrol');
const ac = new AccessControl();

ac.setGrants(config.api.roles);

config.on('reload', () => {
    ac.setGrants(config.api.roles);
});

const userRoles = new WeakMap();
const operations = ['create', 'read', 'update', 'delete'];
const denied = Object.freeze({ granted: false, attributes: [], filter: () => ({}) });

function policyError(message) {
    return Object.assign(new Error(message), { code: 'InputValidationError', responseCode: 400 });
}

function isPolicyMap(value) {
    return !!value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validatePolicy(data) {
    if (data.role !== undefined && data.role !== null && (typeof data.role !== 'string' || !Object.hasOwn(config.api.roles, data.role))) {
        throw policyError('Unknown user role');
    }
    const permissions = data.permissions;
    if (permissions === undefined || permissions === null) {
        return;
    }
    const resources = new Set(ac.getResources());
    if (!isPolicyMap(permissions)) {
        throw policyError('Permissions must be a resource map');
    }
    for (const [resource, settings] of Object.entries(permissions)) {
        if (!resources.has(resource) || !isPolicyMap(settings)) {
            throw policyError('Unknown permission resource or invalid settings');
        }
        for (const [operation, value] of Object.entries(settings)) {
            if (!operations.includes(operation) || typeof value !== 'boolean') {
                throw policyError('Permissions only support boolean CRUD settings');
            }
        }
    }
}

module.exports.validatePolicy = validatePolicy;

// Request-local opaque role handles let existing roles.can(req.role) checks retain their
// interface. No global mutable current-user state, and no policy data in access logs.
module.exports.forUser = (tokenRole, userData) => {
    validatePolicy(userData);
    const role = tokenRole === 'user' ? userData.role || 'user' : tokenRole;
    if (!Object.hasOwn(config.api.roles, role)) {
        throw policyError('Unknown role');
    }
    const handle = Object.freeze({ toString: () => role, toJSON: () => role });
    userRoles.set(handle, { role, permissions: structuredClone(userData.permissions || {}), master: tokenRole === 'user' });
    return handle;
};

module.exports.can = (role, permissions) => {
    const context = role && typeof role === 'object' && userRoles.get(role);
    if (context) {
        ({ role, permissions } = context);
    }
    if (permissions === undefined || permissions === null) {
        return ac.can(role);
    }
    validatePolicy({ permissions });
    const grants = ac.can(role);
    const result = {};
    for (const operation of operations) {
        for (const possession of ['Own', 'Any']) {
            const method = operation + possession;
            // Deny both paths: Own grants inherit Any, and routes may fall back to Any.
            result[method] = resource =>
                Object.hasOwn(permissions, resource) && permissions[resource][operation] === false ? denied : grants[method](resource);
        }
    }
    return result;
};

function getPolicyReadPermission(request, user) {
    const grants = module.exports.can(request.role);
    return request.user && request.user === user.toString() ? grants.readOwn('users') : grants.readAny('users');
}

module.exports.getPolicyResponse = (request, userData) => {
    const permission = getPolicyReadPermission(request, userData._id);
    return permission.granted ? permission.filter({ role: userData.role, permissions: userData.permissions }) : {};
};

module.exports.isMasterUserToken = request => !!(request.accessToken && request.accessToken.user && userRoles.get(request.role)?.master);

module.exports.policySchemas = () => ({
    role: { type: ['string', 'null'], description: 'Configured role name; null restores the user role.' },
    permissions: {
        type: ['object', 'null'],
        description: 'Resource maps of boolean create, read, update and delete restrictions. Replaces the previous map; null or {} clears it.',
        additionalProperties: {
            type: 'object',
            properties: Object.fromEntries(operations.map(operation => [operation, { type: 'boolean' }])),
            additionalProperties: false
        }
    }
});

module.exports.policyResponseSchemas = () => {
    const schemas = module.exports.policySchemas();
    return {
        role: { ...schemas.role, description: 'Stored role name or null.' },
        permissions: {
            ...schemas.permissions,
            description: 'Stored resource restrictions or null.'
        }
    };
};

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
 * `results` are filtered, since totals and cursors are not resource fields. Routes with another
 * listing envelope must name it explicitly so a resource's array fields cannot bypass filtering.
 * Any other value is returned unchanged.
 *
 * Framework-agnostic: it takes the body itself, so choosing the body out of a particular
 * server's response arguments stays in the web layer rather than in the permissions module.
 *
 * @param {Object} permission Result of roles.can(role).readOwn(resource) or similar.
 * @param {*} body Response body to filter.
 * @param {String} [listKey='results'] Route's listing envelope key.
 * @returns {*} The body with unlisted fields removed, or the original value when it is not a
 *   filterable resource body.
 */
module.exports.filterResponseBody = (permission, body, listKey = 'results') => {
    let isResourceBody =
        body &&
        typeof body === 'object' &&
        Object.getPrototypeOf(body) === Object.prototype &&
        !Object.prototype.hasOwnProperty.call(body, 'error') &&
        body.success !== false;

    if (!isResourceBody) {
        return body;
    }

    return Array.isArray(body[listKey])
        ? Object.assign({}, body, { [listKey]: module.exports.filterFields(permission, body[listKey]) })
        : Object.assign({ success: true }, module.exports.filterFields(permission, body));
};
