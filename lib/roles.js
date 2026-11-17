'use strict';

const config = require('@zone-eu/wild-config');
const AccessControl = require('accesscontrol');
const RoleHandler = require('./role-handler');
const db = require('./db');
const consts = require('./consts');

const ac = new AccessControl(Object.fromEntries(Object.entries(config.api?.roles || {}).map(([name, grants]) => [name, RoleHandler.resourceGrants(grants)])));
const userRoles = new WeakMap();
const operations = ['create', 'read', 'update', 'delete'];
const denied = Object.freeze({
    granted: false,
    attributes: [],
    filter: () => ({})
});

function createRoleHandler(users) {
    return new RoleHandler({
        users: users || db.users,
        database: db.database
    });
}

// Validate the policy shape synchronously; assignment validation also checks the database
// at write boundaries. User and token roles keep their names.
function validatePolicy(data) {
    if (data.role !== undefined && data.role !== null) {
        RoleHandler.validateName(data.role);
    }

    RoleHandler.validateRestrictions(data.permissions);
}

module.exports.validatePolicy = validatePolicy;

module.exports.validateAssignment = async (data, users) => {
    validatePolicy(data);

    if (data.role !== undefined && data.role !== null) {
        await createRoleHandler(users).validateAssignment(data.role);
    }
};

module.exports.recheckAssignment = (user, role, users) => {
    if (!role) {
        return role;
    }

    return createRoleHandler(users).recheckAssignment(user, role);
};

module.exports.initialize = () => createRoleHandler().initialize();

module.exports.resolveTokenRole = async (name, users) => {
    const roleData = await createRoleHandler(users).resolve(name);
    return roleData._id;
};

// Stored roles remain names. Authenticated requests receive an opaque handle for
// roles.can(), backed by a snapshot of the role grants and user restrictions.
module.exports.forUser = async (tokenRole, userData = {}, users) => {
    validatePolicy(userData);
    RoleHandler.validateName(tokenRole);

    const roleHandler = createRoleHandler(users);
    const isMasterToken = tokenRole === 'user';

    if (!isMasterToken && userData.role) {
        await roleHandler.resolve(userData.role, { allowDeleted: true });
    }

    const roleName = isMasterToken ? userData.role || 'user' : tokenRole;
    let roleData = await roleHandler.resolve(roleName, { allowDeleted: isMasterToken });
    if (roleData.deleted) {
        roleData = await roleHandler.resolve('user');
    }

    const access = new AccessControl({ snapshot: RoleHandler.resourceGrants(roleData.permissions) });
    const resolvedName = roleData._id;
    const roleHandle = Object.freeze({
        toString: () => resolvedName,
        toJSON: () => resolvedName
    });

    userRoles.set(roleHandle, {
        access,
        grants: structuredClone(roleData.permissions),
        permissions: structuredClone(userData.permissions || {}),
        master: isMasterToken
    });

    return roleHandle;
};

module.exports.can = (role, permissions) => {
    const context = role && typeof role === 'object' && userRoles.get(role);

    // Static names are for internal synchronous consumers only. Authenticated requests
    // always carry a database snapshot, including root and explicit service tokens.
    const grants = context ? context.access.can('snapshot') : ac.can(role);
    if (context) {
        permissions = context.permissions;
    }

    if (permissions === undefined || permissions === null) {
        return grants;
    }

    RoleHandler.validateRestrictions(permissions);

    const result = {};
    for (const operation of operations) {
        for (const possession of ['Own', 'Any']) {
            const method = operation + possession;
            result[method] = resource => {
                if (resource !== 'custom' && Object.hasOwn(permissions, resource) && permissions[resource][operation] === false) {
                    return denied;
                }

                return grants[method](resource);
            };
        }
    }

    return result;
};

// Compare the union with the caller's attributes using AccessControl's own glob
// semantics, including exclusions and nested paths. A boolean grant alone is insufficient.
function containsAttributes(allowed, candidate) {
    const comparison = new AccessControl({
        allowed: { resource: { 'read:any': allowed } },
        candidate: { resource: { 'read:any': candidate } },
        empty: {}
    });
    const original = comparison.can(['allowed', 'empty']).readAny('resource').attributes.sort();
    const combined = comparison.can(['allowed', 'candidate']).readAny('resource').attributes.sort();
    return original.length === combined.length && original.every((attribute, index) => attribute === combined[index]);
}

module.exports.canGrant = (role, definition) => {
    const candidate = RoleHandler.validateGrants(definition);
    const grants = module.exports.can(role);
    // This explicit grant is unrestricted delegation authority, bundled only with root.
    if (grants.updateAny('rolegrants').granted) {
        return true;
    }

    for (const resource of Object.keys(RoleHandler.resourceGrants(definition))) {
        for (const operation of operations) {
            for (const possession of ['Own', 'Any']) {
                const method = operation + possession;
                const requested = candidate[method](resource);
                if (!requested.granted) {
                    continue;
                }
                const allowed = grants[method](resource);
                if (!allowed.granted || !containsAttributes(allowed.attributes, requested.attributes)) {
                    return false;
                }
            }
        }
    }

    const custom = module.exports.getEffectivePermissions(role).custom;
    return Object.entries(definition.custom || {}).every(([name, allowed]) => !allowed || (Object.hasOwn(custom, name) && custom[name] === true));
};

// Called after the normal users grant filters the input, before any user mutation.
// Internal UserHandler consumers still validate assignments without an HTTP caller.
module.exports.validatePolicyWrite = async (request, data, { users = db.users, user } = {}) => {
    if (data.role === undefined && data.permissions === undefined) {
        return;
    }

    const permission = getUserPermission(request, user, user ? 'update' : 'create', 'userpermissions');
    request.validate(permission);

    const policy = permission.filter(Object.fromEntries(['role', 'permissions'].filter(field => data[field] !== undefined).map(field => [field, data[field]])));
    delete data.role;
    delete data.permissions;
    Object.assign(data, policy);
    if ((data.role === undefined && data.permissions === undefined) || module.exports.can(request.role).updateAny('rolegrants').granted) {
        return;
    }

    let roleName = data.role;
    if (roleName === undefined && user) {
        const userData = await users.collection('users').findOne({ _id: user }, { projection: { role: 1 }, maxTimeMS: consts.DB_MAX_TIME_USERS });
        if (!userData) {
            return;
        }
        roleName = userData.role;
    }

    const roleHandler = createRoleHandler(users);
    if (data.role !== undefined && data.role !== null) {
        await roleHandler.validateAssignment(data.role);
    }
    let roleData = await roleHandler.resolve(roleName || 'user', { allowDeleted: data.role === undefined });
    if (roleData.deleted) {
        roleData = await roleHandler.resolve('user');
    }
    request.validate({ granted: module.exports.canGrant(request.role, roleData.permissions) });
};

function getUserPermission(request, user, operation, resource = 'users') {
    const possession = request.user && user && request.user === user.toString() ? 'Own' : 'Any';
    return module.exports.can(request.role)[operation + possession](resource);
}

// Derive booleans through the same permission checks used by routes, including Any-to-Own inheritance.
module.exports.getEffectivePermissions = role => {
    const context = role && typeof role === 'object' && userRoles.get(role);
    const definition = context ? context.grants : config.api?.roles?.[role] || {};
    const customRestrictions = context?.permissions?.custom || {};
    const grants = module.exports.can(role);
    return {
        resources: Object.fromEntries(
            Object.keys(RoleHandler.resourceGrants(definition)).map(resource => [
                resource,
                Object.fromEntries(
                    operations.flatMap(operation =>
                        ['Own', 'Any'].map(possession => [`${operation}:${possession.toLowerCase()}`, grants[operation + possession](resource).granted])
                    )
                )
            ])
        ),
        custom: Object.fromEntries(
            Object.entries(definition.custom || {}).map(([name, allowed]) => [
                name,
                allowed && !(Object.hasOwn(customRestrictions, name) && customRestrictions[name] === false)
            ])
        )
    };
};

module.exports.getPolicyResponse = (request, userData) => {
    const permission = getUserPermission(request, userData._id, 'read');
    if (!permission.granted) {
        return {};
    }
    return permission.filter({
        role: userData.role,
        permissions: userData.permissions,
        ...(request.user === userData._id.toString() ? { effectivePermissions: module.exports.getEffectivePermissions(request.role) } : {})
    });
};

// Authentication endpoints can return account capabilities to callers allowed to read that account's policy.
module.exports.getAuthPolicyResponse = async (request, userData) => {
    const permission = getUserPermission(request, userData._id, 'read');
    if (!permission.granted) {
        return {};
    }
    const role = await module.exports.forUser('user', userData);
    return permission.filter({
        role: userData.role,
        permissions: userData.permissions,
        effectivePermissions: module.exports.getEffectivePermissions(role)
    });
};

module.exports.isMasterUserToken = request => {
    if (!request.accessToken || !request.accessToken.user) {
        return false;
    }

    return !!userRoles.get(request.role)?.master;
};

module.exports.policySchemas = () => ({
    role: {
        type: ['string', 'null'],
        minLength: 1,
        maxLength: 128,
        description: 'Role name; null restores the user role. Writing requires the matching userpermissions grant and delegation authority for the role.'
    },
    permissions: {
        type: ['object', 'null'],
        description:
            'Resource CRUD restrictions and custom capability booleans. False denies; true inherits. Replaces the previous map; null or {} clears it. Writing requires the matching userpermissions grant and delegation authority for the role.',
        properties: { custom: { type: 'object', additionalProperties: { type: 'boolean' } } },
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
        effectivePermissions: {
            type: 'object',
            description: 'Resolved capability booleans. Missing resources or capabilities are denied; resource attribute restrictions still apply.',
            properties: {
                resources: {
                    type: 'object',
                    additionalProperties: {
                        type: 'object',
                        properties: Object.fromEntries(
                            operations.flatMap(operation => ['own', 'any'].map(possession => [`${operation}:${possession}`, { type: 'boolean' }]))
                        ),
                        additionalProperties: false
                    }
                },
                custom: { type: 'object', additionalProperties: { type: 'boolean' } }
            },
            additionalProperties: false
        },
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
