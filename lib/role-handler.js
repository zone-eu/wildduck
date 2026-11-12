'use strict';

const { isDeepStrictEqual } = require('util');
const config = require('@zone-eu/wild-config');
const AccessControl = require('accesscontrol');
const TaskHandler = require('./task-handler');
const consts = require('./consts');

const operations = ['create', 'read', 'update', 'delete'];
const queryOptions = { maxTimeMS: consts.DB_MAX_TIME_USERS };

function roleError(message, code = 'InputValidationError', responseCode = 400) {
    const err = new Error(message);
    err.code = code;
    err.responseCode = responseCode;
    return err;
}

function isPlainObject(value) {
    if (!value) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateName(name) {
    if (
        typeof name !== 'string' ||
        !name.length ||
        name.length > 128 ||
        name.trim() !== name ||
        // eslint-disable-next-line no-control-regex
        /[\x00-\x1f\x7f]/.test(name)
    ) {
        throw roleError('Invalid role name');
    }

    return name;
}

function validateDescription(description) {
    if (description !== undefined && (typeof description !== 'string' || description.length > 1024)) {
        throw roleError('Invalid description');
    }
}

function validateGrants(permissions) {
    if (!isPlainObject(permissions)) {
        throw roleError('Permissions must be a resource map');
    }

    for (const grants of Object.values(permissions)) {
        if (!isPlainObject(grants)) {
            throw roleError('Invalid grant map');
        }

        for (const [action, attributes] of Object.entries(grants)) {
            if (
                !/^(create|read|update|delete):(own|any)$/.test(action) ||
                !Array.isArray(attributes) ||
                !attributes.every(attribute => typeof attribute === 'string' && attribute.length > 0 && attribute.length <= 256)
            ) {
                throw roleError('Grants require CRUD own/any operations and attribute lists');
            }
        }
    }

    try {
        const access = new AccessControl({ role: permissions });
        access.can('role');
    } catch {
        throw roleError('Invalid permission attributes');
    }
}

function validateRestrictions(permissions) {
    if (permissions === undefined || permissions === null) {
        return;
    }

    if (!isPlainObject(permissions)) {
        throw roleError('Permissions must be a resource map');
    }

    for (const settings of Object.values(permissions)) {
        if (!isPlainObject(settings)) {
            throw roleError('Invalid permission settings');
        }

        for (const [operation, value] of Object.entries(settings)) {
            if (!operations.includes(operation) || typeof value !== 'boolean') {
                throw roleError('Permissions only support boolean CRUD settings');
            }
        }
    }
}

function matchesSystemRole(roleData, systemFields) {
    return !!roleData && Object.entries(systemFields).every(([field, value]) => isDeepStrictEqual(roleData[field], value));
}

class RoleHandler {
    constructor(options) {
        this.users = options.users;
        this.collection = this.users.collection('roles');
        this.taskHandler = new TaskHandler({
            database: options.database
        });
        this.definitions = options.definitions || config.api.roles;
    }

    async initialize() {
        if (!isPlainObject(this.definitions)) {
            throw roleError('System roles must be a role map');
        }

        // Validate every definition before changing any stored role.
        for (const [name, permissions] of Object.entries(this.definitions)) {
            validateName(name);
            validateGrants(permissions);
        }

        await this.collection.createIndex({ name: 1 }, { name: 'role_name', unique: true });

        for (const [name, permissions] of Object.entries(this.definitions)) {
            await this.reconcileSystemRole(name, permissions);
        }
    }

    async reconcileSystemRole(name, permissions) {
        const conflict = await this.collection.findOne(
            {
                name,
                _id: { $ne: name }
            },
            queryOptions
        );
        if (conflict) {
            throw roleError(`Conflicting identity for system role ${name}`, 'RoleIdentityConflict', 500);
        }

        const existingRole = await this.collection.findOne({ _id: name }, queryOptions);

        // The string _id is the immutable role name. The marker distinguishes a bundled
        // definition from an unrelated custom role that now conflicts with the source.
        if (existingRole && existingRole.systemSource !== name) {
            throw roleError(`Conflicting identity for system role ${name}`, 'RoleIdentityConflict', 500);
        }

        const systemFields = {
            name,
            description: '',
            permissions,
            isSystem: true,
            deleted: false,
            systemSource: name
        };
        if (matchesSystemRole(existingRole, systemFields)) {
            return;
        }

        const now = new Date();

        try {
            if (existingRole) {
                // A second initializer must not advance updated after the first repaired it.
                const changedFields = Object.entries(systemFields).map(([field, value]) => ({ [field]: { $ne: value } }));

                await this.collection.updateOne(
                    {
                        _id: name,
                        systemSource: name,
                        $or: changedFields
                    },
                    {
                        $set: {
                            ...systemFields,
                            updated: now
                        }
                    },
                    queryOptions
                );
            } else {
                await this.collection.insertOne({
                    _id: name,
                    ...systemFields,
                    created: now,
                    updated: now
                });
            }
        } catch (err) {
            if (err.code !== 11000) {
                throw err;
            }

            // Another worker may have won the insert. Only accept the same identity.
            const concurrentRole = await this.collection.findOne({ _id: name }, queryOptions);
            if (!matchesSystemRole(concurrentRole, systemFields)) {
                throw roleError(`Conflicting identity for system role ${name}`, 'RoleIdentityConflict', 500);
            }
        }
    }

    async get(name) {
        const roleData = await this.collection.findOne(
            {
                _id: validateName(name),
                deleted: { $ne: true }
            },
            queryOptions
        );
        if (!roleData) {
            throw roleError('Role not found', 'RoleNotFound', 404);
        }

        return roleData;
    }

    async resolve(name, { allowDeleted = false } = {}) {
        const roleData = await this.collection.findOne({ _id: validateName(name) }, queryOptions);
        if (!roleData) {
            throw roleError('Unknown role', 'UnknownRole', 403);
        }

        if (roleData.deleted) {
            if (!allowDeleted || roleData.isSystem) {
                throw roleError('Role has been deleted', 'UnknownRole', 403);
            }
        } else {
            validateGrants(roleData.permissions);
        }

        return roleData;
    }

    async validateAssignment(name) {
        const roleData = await this.collection.findOne(
            {
                _id: validateName(name),
                deleted: { $ne: true }
            },
            queryOptions
        );
        if (!roleData) {
            throw roleError('Unknown user role');
        }

        return name;
    }

    async create(data) {
        validateName(data.name);
        validateGrants(data.permissions);
        validateDescription(data.description);

        const now = new Date();
        const roleData = {
            _id: data.name,
            name: data.name,
            description: data.description || '',
            permissions: structuredClone(data.permissions),
            isSystem: false,
            deleted: false,
            created: now,
            updated: now
        };

        try {
            await this.collection.insertOne(roleData);
        } catch (err) {
            if (err.code === 11000) {
                throw roleError('Role name already exists', 'RoleExists', 409);
            }

            throw err;
        }

        return roleData;
    }

    async update(name, data) {
        const roleData = await this.get(name);
        if (roleData.isSystem === true) {
            throw roleError('System roles cannot be modified', 'SystemRoleProtected', 403);
        }

        const changes = {};
        if (data.description !== undefined) {
            validateDescription(data.description);
            changes.description = data.description;
        }

        if (data.permissions !== undefined) {
            validateGrants(data.permissions);
            changes.permissions = structuredClone(data.permissions);
        }

        const result = await this.collection.findOneAndUpdate(
            {
                _id: roleData._id,
                deleted: { $ne: true },
                isSystem: { $ne: true },
                name: roleData.name
            },
            {
                $set: {
                    ...changes,
                    updated: new Date()
                }
            },
            {
                ...queryOptions,
                returnDocument: 'after'
            }
        );
        if (!result) {
            throw roleError('Role not found', 'RoleNotFound', 404);
        }

        return result;
    }

    async delete(name) {
        const roleData = await this.get(name);
        if (roleData.isSystem === true) {
            throw roleError('System roles cannot be deleted', 'SystemRoleProtected', 403);
        }

        // Queue first: a crash after the tombstone must never lose cleanup. The task retries
        // while the role remains active. Tombstones reserve names permanently so old tokens
        // cannot acquire a recreated role.
        await this.taskHandler.ensure('role-delete', { role: roleData._id }, { role: roleData._id });

        const result = await this.collection.updateOne(
            {
                _id: roleData._id,
                deleted: { $ne: true },
                isSystem: { $ne: true },
                name: roleData.name
            },
            {
                $set: {
                    deleted: true,
                    updated: new Date()
                }
            },
            queryOptions
        );
        if (!result.matchedCount) {
            throw roleError('Role not found', 'RoleNotFound', 404);
        }

        return true;
    }

    async recheckAssignment(user, role) {
        const roleData = await this.collection.findOne({ _id: role }, queryOptions);
        if (!roleData || roleData.deleted) {
            // Conditional removal preserves a concurrent reassignment to a different role.
            await this.users.collection('users').updateOne(
                {
                    _id: user,
                    role
                },
                {
                    $unset: { role: '' }
                },
                queryOptions
            );
        }
    }
}

module.exports = RoleHandler;
module.exports.validateName = validateName;
module.exports.validateGrants = validateGrants;
module.exports.validateRestrictions = validateRestrictions;
