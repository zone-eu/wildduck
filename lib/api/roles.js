'use strict';

const RoleHandler = require('../role-handler');
const roles = require('../roles');
const consts = require('../consts');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

const roleNameParam = {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    wdRequired: true,
    description: 'Unique role name'
};
const permissionMap = {
    type: 'object',
    description: 'Resource maps of CRUD own/any grants and attribute allowlists',
    additionalProperties: {
        type: 'object',
        additionalProperties: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 256 }
        }
    }
};
const roleFields = {
    id: { type: 'string', description: 'Unique role name' },
    name: { type: 'string' },
    description: { type: 'string' },
    permissions: permissionMap,
    isSystem: { type: 'boolean' },
    created: { type: 'string', format: 'date-time' },
    updated: { type: 'string', format: 'date-time' }
};
const roleRequired = Object.keys(roleFields);
const roleResponse = {
    200: {
        description: 'Success',
        model: {
            type: 'object',
            title: 'RoleResponse',
            properties: {
                success: { $ref: 'wd:successRes' },
                ...roleFields
            },
            required: ['success', ...roleRequired]
        }
    }
};
const metadata = {
    sess: { $ref: 'wd:sess' },
    ip: { $ref: 'wd:ip' }
};

function serializeRole(role) {
    return {
        id: role._id,
        name: role.name,
        description: role.description || '',
        permissions: role.permissions,
        isSystem: !!role.isSystem,
        created: role.created,
        updated: role.updated
    };
}

module.exports = (db, server) => {
    const roleHandler = new RoleHandler({ users: db.users, database: db.database });
    const collection = db.users.collection('roles');

    server.route({
        method: 'GET',
        url: '/roles',
        schema: {
            summary: 'List roles',
            description: 'Lists active roles with pagination.',
            tags: ['Roles']
        },
        config: {
            name: 'getRoles',
            validationObjs: {
                pathParams: {},
                queryParams: {
                    limit: { $ref: 'wd:pageLimit' },
                    next: { $ref: 'wd:cursor' },
                    previous: { $ref: 'wd:cursor' },
                    ...metadata
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetRolesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                results: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: roleFields,
                                        required: roleRequired
                                    }
                                }
                            },
                            required: ['success', 'total', 'page', 'previousCursor', 'nextCursor', 'results']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const permission = roles.can(req.role).readAny('roles');
            req.validate(permission);

            const values = req.params;
            const filter = {
                deleted: { $ne: true }
            };
            const total = await collection.countDocuments(filter, { maxTimeMS: consts.DB_MAX_TIME_USERS });

            const result = await mongopagingFindWrapper(collection, {
                limit: values.limit,
                query: filter,
                fields: {
                    _id: 1,
                    name: 1,
                    description: 1,
                    permissions: 1,
                    isSystem: 1,
                    created: 1,
                    updated: 1
                },
                findOptions: { maxTimeMS: consts.DB_MAX_TIME_USERS },
                paginatedField: 'name',
                sortAscending: true,
                ...(values.next ? { next: values.next } : {}),
                ...(values.previous ? { previous: values.previous } : {})
            });

            const response = {
                success: true,
                total,
                page: result.page,
                previousCursor: result.previousCursor,
                nextCursor: result.nextCursor,
                results: roles.filterFields(permission, result.listing.results.map(serializeRole))
            };

            return reply.send(response);
        }
    });

    server.route({
        method: 'POST',
        url: '/roles',
        schema: {
            summary: 'Create a role',
            description: 'Creates a persistent custom role.',
            tags: ['Roles']
        },
        config: {
            name: 'createRole',
            validationObjs: {
                requestBody: {
                    name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128,
                        wdTrim: true,
                        wdRequired: true
                    },
                    description: {
                        type: 'string',
                        maxLength: 1024,
                        default: ''
                    },
                    permissions: { ...permissionMap, wdRequired: true },
                    ...metadata
                },
                queryParams: {},
                pathParams: {},
                response: roleResponse
            }
        },
        async handler(req, reply) {
            const permission = roles.can(req.role).createAny('roles');
            req.validate(permission);

            const values = permission.filter(req.params);
            const roleData = {
                name: values.name,
                description: values.description,
                permissions: values.permissions
            };
            const role = await roleHandler.create(roleData);

            const response = roles.filterResponseBody(roles.can(req.role).readAny('roles'), {
                success: true,
                ...serializeRole(role)
            });

            return reply.send(response);
        }
    });

    server.route({
        method: 'GET',
        url: '/roles/:role',
        schema: {
            summary: 'Get a role',
            description: 'Returns one active role.',
            tags: ['Roles']
        },
        config: {
            name: 'getRole',
            validationObjs: {
                queryParams: metadata,
                pathParams: {
                    role: roleNameParam
                },
                response: roleResponse
            }
        },
        async handler(req, reply) {
            const permission = roles.can(req.role).readAny('roles');
            req.validate(permission);

            const role = await roleHandler.get(req.params.role);

            const response = roles.filterResponseBody(permission, {
                success: true,
                ...serializeRole(role)
            });

            return reply.send(response);
        }
    });

    server.route({
        method: 'PUT',
        url: '/roles/:role',
        schema: {
            summary: 'Update a role',
            description: 'Updates a custom role description and replaces its permissions.',
            tags: ['Roles']
        },
        config: {
            name: 'updateRole',
            validationObjs: {
                requestBody: {
                    description: { type: 'string', maxLength: 1024 },
                    permissions: permissionMap,
                    ...metadata
                },
                queryParams: {},
                pathParams: {
                    role: roleNameParam
                },
                response: roleResponse
            }
        },
        async handler(req, reply) {
            const permission = roles.can(req.role).updateAny('roles');
            req.validate(permission);

            const values = permission.filter(req.params);
            const update = {
                description: values.description,
                permissions: values.permissions
            };
            const role = await roleHandler.update(req.params.role, update);

            const response = roles.filterResponseBody(roles.can(req.role).readAny('roles'), {
                success: true,
                ...serializeRole(role)
            });

            return reply.send(response);
        }
    });

    server.route({
        method: 'DELETE',
        url: '/roles/:role',
        schema: {
            summary: 'Delete a role',
            description: 'Tombstones a custom role and schedules removal of user assignments. System roles cannot be deleted.',
            tags: ['Roles']
        },
        config: {
            name: 'deleteRole',
            validationObjs: {
                queryParams: metadata,
                pathParams: {
                    role: roleNameParam
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeleteRoleResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            req.validate(roles.can(req.role).deleteAny('roles'));

            await roleHandler.delete(req.params.role);

            return reply.send({ success: true });
        }
    });
};
