'use strict';

const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const { publish, DOMAINALIAS_CREATED, DOMAINALIAS_DELETED } = require('../events');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

const aliasIdParam = {
    type: 'string',
    pattern: '^[0-9a-f]{24}$',
    minLength: 24,
    maxLength: 24,
    wdLowercase: true,
    wdRequired: true,
    description: 'ID of the Alias'
};

const domainName = (description, required) => {
    const schema = {
        type: 'string',
        maxLength: 255,
        minLength: 1,
        description
    };
    if (required) {
        schema.wdRequired = true;
    }
    return schema;
};

module.exports = (db, server) => {
    server.get(
        {
            name: 'getDomainAliases',
            path: '/domainaliases',
            tags: ['DomainAliases'],
            summary: 'List registered Domain Aliases',
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                pathParams: {},
                queryParams: {
                    query: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Partial match of a Domain Alias or Domain name'
                    },
                    limit: { $ref: 'wd:pageLimit' },
                    next: {
                        $ref: 'wd:cursor',
                        description: 'Cursor value for next page, retrieved from nextCursor response value'
                    },
                    previous: {
                        $ref: 'wd:cursor',
                        description: 'Cursor value for previous page, retrieved from previousCursor response value'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetDomainAliasesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                query: { type: 'string', description: 'Custom query string' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                results: {
                                    type: 'array',
                                    description: 'Aliases listing',
                                    items: {
                                        type: 'object',
                                        title: 'GetDomainAliasesResult',
                                        properties: {
                                            id: { type: 'string', description: 'ID of the Domain Alias' },
                                            alias: { type: 'string', description: 'Domain Alias' },
                                            domain: { type: 'string', description: 'The domain this alias applies to' }
                                        },
                                        required: ['id', 'alias', 'domain']
                                    }
                                }
                            },
                            required: ['success', 'total', 'page', 'previousCursor', 'nextCursor', 'results']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaliases'));

            let query = values.query;
            let limit = values.limit;
            let pageNext = values.next;
            let pagePrevious = values.previous;

            let filter = query
                ? {
                      $or: [
                          {
                              alias: {
                                  $regex: tools.escapeRegexStr(query),
                                  $options: ''
                              }
                          },

                          {
                              domain: {
                                  $regex: tools.escapeRegexStr(query),
                                  $options: ''
                              }
                          }
                      ]
                  }
                : {};

            let total = await db.users.collection('domainaliases').countDocuments(filter);

            let opts = {
                limit,
                query: filter,
                fields: {
                    // FIXME: hack to keep alias in response
                    alias: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        alias: true,
                        domain: true
                    }
                },
                paginatedField: 'alias',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = await mongopagingFindWrapper(db.users.collection('domainaliases'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let response = {
                success: true,
                query,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || []).map(domainData => ({
                    id: domainData._id.toString(),
                    alias: domainData.alias,
                    domain: domainData.domain
                }))
            };

            return res.json(response);
        })
    );

    server.post(
        {
            path: '/domainaliases',
            tags: ['DomainAliases'],
            summary: 'Create new Domain Alias',
            name: 'createDomainAlias',
            description: 'Add a new Alias for a Domain. This allows to accept mail on username@domain and username@alias',
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    alias: domainName('Domain Alias', true),
                    domain: domainName('Domain name this Alias applies to', true),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'CreateDomainAliasResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Domain Alias' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).createAny('domainaliases'));

            let alias = tools.normalizeDomain(values.alias);
            let domain = tools.normalizeDomain(values.domain);

            let aliasData;

            try {
                aliasData = await db.users.collection('domainaliases').findOne(
                    {
                        alias
                    },
                    {
                        projection: { _id: 1 }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (aliasData) {
                res.status(400);
                return res.json({
                    error: 'This domain alias already exists',
                    code: 'AliasExists'
                });
            }

            let r;

            try {
                // insert alias address to email address registry
                r = await db.users.collection('domainaliases').insertOne({
                    alias,
                    domain,
                    created: new Date()
                });

                try {
                    await db.users.collection('domaincache').insertMany([{ domain: alias }, { domain }]);
                } catch {
                    // ignore
                }
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let insertId = r.insertedId;

            await publish(db.redis, {
                ev: DOMAINALIAS_CREATED,
                domainalias: insertId,
                alias,
                domain
            });

            return res.json({
                success: !!insertId,
                id: insertId
            });
        })
    );

    server.get(
        {
            path: '/domainaliases/resolve/:alias',
            tags: ['DomainAliases'],
            summary: 'Resolve ID for a domain alias',
            name: 'resolveDomainAlias',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                pathParams: {
                    alias: domainName('Alias domain', true)
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ResolveDomainAliasIdResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'Unique ID (24 byte hex)' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaliases'));

            let alias = tools.normalizeDomain(values.alias);

            let aliasData;
            try {
                aliasData = await db.users.collection('domainaliases').findOne(
                    {
                        alias
                    },
                    {
                        projection: { _id: 1 }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!aliasData) {
                res.status(404);
                return res.json({
                    error: 'This alias does not exist',
                    code: 'AliasNotFound'
                });
            }

            return res.json({
                success: true,
                id: aliasData._id.toString()
            });
        })
    );

    server.get(
        {
            path: '/domainaliases/:alias',
            tags: ['DomainAliases'],
            summary: 'Request Alias information',
            name: 'getDomainAlias',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    alias: aliasIdParam
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetDomainAliasResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Alias' },
                                alias: { type: 'string', description: 'Alias domain' },
                                domain: { type: 'string', description: 'Alias target' },
                                created: { type: 'string', format: 'date-time', description: 'Datestring of the time the alias was created' }
                            },
                            required: ['success', 'id', 'alias', 'domain', 'created']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaliases'));

            let alias = new ObjectId(values.alias);

            let aliasData;
            try {
                aliasData = await db.users.collection('domainaliases').findOne({
                    _id: alias
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!aliasData) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown alias',
                    code: 'AliasNotFound'
                });
            }

            return res.json({
                success: true,
                id: aliasData._id.toString(),
                alias: aliasData.alias,
                domain: aliasData.domain,
                created: aliasData.created
            });
        })
    );

    server.del(
        {
            path: '/domainaliases/:alias',
            tags: ['DomainAliases'],
            summary: 'Delete an Alias',
            name: 'deleteDomainAlias',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                pathParams: { alias: aliasIdParam },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).deleteAny('domainaliases'));

            let alias = new ObjectId(values.alias);

            let aliasData;
            try {
                aliasData = await db.users.collection('domainaliases').findOne(
                    {
                        _id: alias
                    },
                    {
                        projection: { _id: 1 }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!aliasData) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown email alias identifier',
                    code: 'AliasNotFound'
                });
            }

            let r;
            try {
                // delete address from email address registry
                r = await db.users.collection('domainaliases').deleteOne({
                    _id: alias
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (r.deletedCount) {
                await publish(db.redis, {
                    ev: DOMAINALIAS_DELETED,
                    domainalias: alias,
                    alias: aliasData.alias,
                    domain: aliasData.domain
                });
            }

            return res.json({
                success: !!r.deletedCount
            });
        })
    );
};
