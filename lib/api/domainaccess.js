'use strict';

const ObjectId = require('mongodb').ObjectId;
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
        tools.responseWrapper(async (req, res) => {
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
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return res.json({
                success: !!(r && r.value),
                id: ((r && r.value && r.value._id) || '').toString()
            });
        });

    const listDomainsHandler = action =>
        tools.responseWrapper(async (req, res) => {
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
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!domains) {
                domains = [];
            }

            return res.json({
                success: true,
                results: domains.map(domainData => ({
                    id: domainData._id.toString(),
                    domain: domainData.domain,
                    action
                }))
            });
        });

    server.post(
        {
            path: '/domainaccess/:tag/allow',
            tags: ['DomainAccess'],
            summary: 'Add domain to allowlist',
            name: 'createAllowedDomain',
            description: 'If an email is sent from a domain that is listed in the allowlist then it is never marked as spam. Lists apply for tagged users.',
            jsonSchema: true,
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
        createListingHandler('allow')
    );

    server.post(
        {
            path: '/domainaccess/:tag/block',
            tags: ['DomainAccess'],
            summary: 'Add domain to blocklist',
            name: 'createBlockedDomain',
            description: 'If an email is sent from a domain that is listed in the blocklist then it is always marked as spam. Lists apply for tagged users.',
            jsonSchema: true,
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
        createListingHandler('block')
    );

    server.get(
        {
            path: '/domainaccess/:tag/allow',
            tags: ['DomainAccess'],
            summary: 'List allowlisted domains',
            name: 'getAllowedDomains',
            jsonSchema: true,
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
        listDomainsHandler('allow')
    );

    server.get(
        {
            path: '/domainaccess/:tag/block',
            tags: ['DomainAccess'],
            summary: 'List blocklisted domains',
            name: 'getBlockedDomains',
            jsonSchema: true,
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
        listDomainsHandler('block')
    );

    server.del(
        {
            path: '/domainaccess/:domain',
            tags: ['DomainAccess'],
            summary: 'Delete a Domain from listing',
            name: 'deleteDomainListing',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    domain: {
                        type: 'string',
                        pattern: '^[0-9a-f]{24}$',
                        minLength: 24,
                        maxLength: 24,
                        wdLowercase: true,
                        wdRequired: true,
                        description: "Listed domain's unique ID"
                    }
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
        tools.responseWrapper(async (req, res) => {
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
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!r.deletedCount) {
                res.status(404);
                return res.json({
                    error: 'Domain was not found',
                    code: 'DomainNotFound'
                });
            }

            return res.json({
                success: true,
                deleted: domain
            });
        })
    );
};
