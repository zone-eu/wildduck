'use strict';

const ObjectId = require('mongodb').ObjectId;
const { objectIdSchema } = require('../schemas/json-schemas');
const tools = require('../tools');
const roles = require('../roles');

const tagParam = {
    type: 'string',
    maxLength: 128,
    minLength: 1,
    wdTrim: true,
    wdRequired: true,
    description: 'Tag to look for'
};

const domainBody = description => ({
    type: 'string',
    maxLength: 255,
    minLength: 1,
    wdRequired: true,
    description
});

const createResponse = title => ({
    200: {
        description: 'Success',
        model: {
            type: 'object',
            title,
            properties: {
                success: { $ref: 'wd:successRes' },
                id: { type: 'string', description: 'ID for the created record' }
            },
            required: ['success', 'id']
        }
    }
});

const listResponse = (title, itemTitle, action) => ({
    200: {
        description: 'Success',
        model: {
            type: 'object',
            title,
            properties: {
                success: { $ref: 'wd:successRes' },
                results: {
                    type: 'array',
                    description: 'Domain list',
                    items: {
                        type: 'object',
                        title: itemTitle,
                        properties: {
                            id: { type: 'string', description: 'Entry ID' },
                            domain: { type: 'string', description: `${action === 'allow' ? 'Allowlisted' : 'Blocklisted'} domain name` },
                            action: { type: 'string', description: `Action: \`${action}\``, examples: [action] }
                        },
                        required: ['id', 'domain', 'action']
                    }
                }
            },
            required: ['success', 'results']
        }
    }
});

module.exports = (db, server) => {
    const createListingHandler = action =>
        async function handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).createAny('domainaccess'));

            let domain = tools.normalizeDomain(values.domain);
            let tag = values.tag;
            let tagview = tag.toLowerCase();

            let r;
            try {
                r = await db.database.collection('domainaccess').findOneAndUpdate(
                    {
                        tagview,
                        domain
                    },
                    {
                        $setOnInsert: {
                            tag,
                            tagview,
                            domain
                        },

                        $set: {
                            action
                        }
                    },
                    {
                        upsert: true,
                        projection: { _id: true },
                        returnDocument: 'after'
                    }
                );
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: !!(r && r.value),
                id: ((r && r.value && r.value._id) || '').toString()
            });
        };

    const listDomainsHandler = action =>
        async function handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaccess'));

            let tag = values.tag;
            let tagview = tag.toLowerCase();

            let domains;
            try {
                domains = await db.database
                    .collection('domainaccess')
                    .find({
                        tagview,
                        action
                    })
                    .sort({
                        domain: 1
                    })
                    .toArray();
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!domains) {
                domains = [];
            }

            return reply.send({
                success: true,
                results: domains.map(domainData => ({
                    id: domainData._id.toString(),
                    domain: domainData.domain,
                    action
                }))
            });
        };

    server.route({
        method: 'POST',
        url: '/domainaccess/:tag/allow',
        schema: {
            summary: 'Add domain to allowlist',
            description: 'If an email is sent from a domain that is listed in the allowlist then it is never marked as spam. Lists apply for tagged users.',
            tags: ['DomainAccess']
        },
        config: {
            name: 'createAllowedDomain',
            validationObjs: {
                requestBody: {
                    domain: domainBody('Domain name to allowlist for users/addresses that include this tag'),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {
                    tag: tagParam
                },
                response: createResponse('CreateAllowedDomainResponse')
            }
        },
        handler: createListingHandler('allow')
    });

    server.route({
        method: 'POST',
        url: '/domainaccess/:tag/block',
        schema: {
            summary: 'Add domain to blocklist',
            description: 'If an email is sent from a domain that is listed in the blocklist then it is always marked as spam. Lists apply for tagged users.',
            tags: ['DomainAccess']
        },
        config: {
            name: 'createBlockedDomain',
            validationObjs: {
                requestBody: {
                    domain: domainBody('Domain name to blocklist for users/addresses that include this tag'),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {
                    tag: tagParam
                },
                response: createResponse('CreateBlockedDomainResponse')
            }
        },
        handler: createListingHandler('block')
    });

    server.route({
        method: 'GET',
        url: '/domainaccess/:tag/allow',
        schema: {
            summary: 'List allowlisted domains',
            tags: ['DomainAccess']
        },
        config: {
            name: 'getAllowedDomains',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    tag: tagParam
                },
                response: listResponse('GetAllowedDomainsResponse', 'GetAllowedDomainResult', 'allow')
            }
        },
        handler: listDomainsHandler('allow')
    });

    server.route({
        method: 'GET',
        url: '/domainaccess/:tag/block',
        schema: {
            summary: 'List blocklisted domains',
            tags: ['DomainAccess']
        },
        config: {
            name: 'getBlockedDomains',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    tag: tagParam
                },
                response: listResponse('GetBlockedDomainsResponse', 'GetBlockedDomainResult', 'block')
            }
        },
        handler: listDomainsHandler('block')
    });

    server.route({
        method: 'DELETE',
        url: '/domainaccess/:domain',
        schema: {
            summary: 'Delete a Domain from listing',
            tags: ['DomainAccess']
        },
        config: {
            name: 'deleteDomainListing',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    domain: objectIdSchema("Listed domain's unique ID", { wdRequired: true })
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeleteDomainListingResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                deleted: { type: 'string', description: "Deleted domain's unique ID" }
                            },
                            required: ['success', 'deleted']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).deleteAny('domainaccess'));

            let domain = new ObjectId(values.domain);

            let r;

            try {
                r = await db.database.collection('domainaccess').deleteOne({
                    _id: domain
                });
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
                success: true,
                deleted: domain
            });
        }
    });
};
