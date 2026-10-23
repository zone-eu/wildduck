'use strict';

const tools = require('../tools');
const roles = require('../roles');

const domainSchema = { type: 'string', minLength: 1, maxLength: 255, wdValidator: 'domain', wdRequired: true, description: 'Domain name' };
const groupSchema = {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    wdTrim: true,
    wdRequired: true,
    description: 'Name of the domain group. Users of domains in the same group may share mailboxes with each other'
};

const successModel = title => ({
    type: 'object',
    title,
    properties: {
        success: { $ref: 'wd:successRes' }
    },
    required: ['success']
});

module.exports = (db, server) => {
    server.route({
        method: 'GET',
        url: '/domaingroups',
        schema: {
            summary: 'List Domain Group entries',
            description: 'Lists the domains assigned to domain groups, optionally limited to one group.',
            tags: ['DomainGroups']
        },
        config: {
            name: 'getDomainGroups',
            validationObjs: {
                requestBody: {},
                pathParams: {},
                queryParams: {
                    group: { type: 'string', minLength: 1, maxLength: 128, wdTrim: true, wdEmpty: true, description: 'Only list domains of this group' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetDomainGroupsResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: {
                                    type: 'array',
                                    description: 'Domain Group entries',
                                    items: {
                                        type: 'object',
                                        title: 'GetDomainGroupsResult',
                                        properties: {
                                            domain: { type: 'string', description: 'Domain name' },
                                            group: { type: 'string', description: 'Name of the domain group' }
                                        },
                                        required: ['domain', 'group']
                                    }
                                }
                            },
                            required: ['success', 'results']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).readAny('domaingroups'));

            let filter = {};
            if (values.group) {
                filter.group = values.group;
            }

            let entries;
            try {
                entries = await db.users.collection('domaingroups').find(filter).sort({ group: 1, domain: 1 }).toArray();
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: true,
                results: entries.map(entryData => ({
                    domain: entryData.domain,
                    group: entryData.group
                }))
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/domaingroups',
        schema: {
            summary: 'Add a Domain to a Domain Group',
            description: 'Users of domains in the same group may share mailboxes with each other. A domain can belong to one group only.',
            tags: ['DomainGroups']
        },
        config: {
            name: 'createDomainGroup',
            validationObjs: {
                requestBody: {
                    domain: domainSchema,
                    group: groupSchema
                },
                pathParams: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: successModel('CreateDomainGroupResponse')
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).createAny('domaingroups'));

            let domain = tools.normalizeDomain(values.domain);
            let group = values.group;

            let existing;
            try {
                existing = await db.users.collection('domaingroups').findOne({ domain });
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (existing) {
                if (existing.group === group) {
                    return reply.send({
                        success: true
                    });
                }
                return reply.code(400).send({
                    error: 'This domain already belongs to another group',
                    code: 'DomainAlreadyGrouped'
                });
            }

            try {
                await db.users.collection('domaingroups').insertOne({
                    domain,
                    group,
                    created: new Date()
                });
            } catch (err) {
                if (err.code === 11000) {
                    return reply.code(400).send({
                        error: 'This domain already belongs to another group',
                        code: 'DomainAlreadyGrouped'
                    });
                }
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: true
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/domaingroups/:domain',
        schema: {
            summary: 'Remove a Domain from its Domain Group',
            description: 'Removes the domain from its group. Grants that now cross a tenant boundary stop resolving immediately.',
            tags: ['DomainGroups']
        },
        config: {
            name: 'deleteDomainGroup',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    domain: domainSchema
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: successModel('DeleteDomainGroupResponse')
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).deleteAny('domaingroups'));

            let r;
            try {
                r = await db.users.collection('domaingroups').deleteOne({ domain: tools.normalizeDomain(values.domain) });
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!r.deletedCount) {
                return reply.code(404).send({
                    error: 'Domain was not found',
                    code: 'DomainNotFound'
                });
            }

            return reply.send({
                success: true
            });
        }
    });
};
