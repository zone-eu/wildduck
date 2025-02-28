'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const { sessSchema, sessIPSchema } = require('../schemas');
const { successRes } = require('../schemas/response/general-schemas');

module.exports = (db, server) => {
    server.post(
        {
            path: '/domainaccess/:tag/allow',
            tags: ['DomainAccess'],
            summary: 'Add domain to allowlist',
            name: 'createAllowedDomain',
            description: 'If an email is sent from a domain that is listed in the allowlist then it is never marked as spam. Lists apply for tagged users.',
            validationObjs: {
                requestBody: {
                    domain: Joi.string()
                        .max(255)
                        //.hostname()
                        .required()
                        .description('Domain name to allowlist for users/addresses that include this tag'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    tag: Joi.string().trim().max(128).required().description('Tag to look for')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('ID for the created record')
                        }).$_setFlag('objectName', 'CreateAllowedDomainResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            req.validate(roles.can(req.role).createAny('domainaccess'));

            let domain = tools.normalizeDomain(result.value.domain);
            let tag = result.value.tag;
            let tagview = tag.toLowerCase();
            let action = 'allow';

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
        })
    );

    server.post(
        {
            path: '/domainaccess/:tag/block',
            tags: ['DomainAccess'],
            summary: 'Add domain to blocklist',
            name: 'createBlockedDomain',
            description: 'If an email is sent from a domain that is listed in the blocklist then it is always marked as spam. Lists apply for tagged users.',
            validationObjs: {
                requestBody: {
                    domain: Joi.string()
                        .max(255)
                        //.hostname()
                        .required()
                        .description('Domain name to blocklist for users/addresses that include this tag'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    tag: Joi.string().trim().max(128).required().description('Tag to look for')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('ID for the created record')
                        }).$_setFlag('objectName', 'CreateBlockedDomainResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            req.validate(roles.can(req.role).createAny('domainaccess'));

            let domain = tools.normalizeDomain(result.value.domain);
            let tag = result.value.tag;
            let tagview = tag.toLowerCase();
            let action = 'block';

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
        })
    );

    server.get(
        {
            path: '/domainaccess/:tag/allow',
            tags: ['DomainAccess'],
            summary: 'List allowlisted domains',
            name: 'getAllowedDomains',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    tag: Joi.string().trim().max(128).required().description('Tag to look for')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('Entry ID'),
                                        domain: Joi.string().required().description('Allowlisted domain name'),
                                        action: Joi.string().required().description('Action: `allow`').example('allow')
                                    })
                                        .required()
                                        .$_setFlag('objectName', 'GetAllowedDomainResult')
                                )
                                .description('Domain list')
                                .required()
                        }).$_setFlag('objectName', 'GetAllowedDomainsResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaccess'));

            let tag = result.value.tag;
            let tagview = tag.toLowerCase();
            let action = 'action';

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
        })
    );

    server.get(
        {
            path: '/domainaccess/:tag/block',
            tags: ['DomainAccess'],
            summary: 'List blocklisted domains',
            name: 'getBlockedDomains',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    tag: Joi.string().trim().max(128).required().description('Tag to look for')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('Entry ID'),
                                        domain: Joi.string().required().description('Blocklisted domain name'),
                                        action: Joi.string().required().description('Action: `block`').example('block')
                                    })
                                        .required()
                                        .$_setFlag('objectName', 'GetBlockedDomainResult')
                                )
                                .description('Domain list')
                                .required()
                        }).$_setFlag('objectName', 'GetBlockedDomainsResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaccess'));

            let tag = result.value.tag;
            let tagview = tag.toLowerCase();
            let action = 'block';

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
        })
    );

    server.del(
        {
            path: '/domainaccess/:domain',
            tags: ['DomainAccess'],
            summary: 'Delete a Domain from listing',
            name: 'deleteDomainListing',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    domain: Joi.string().hex().lowercase().length(24).required().description("Listed domain's unique ID")
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            deleted: Joi.string().required().description("Deleted domain's unique ID")
                        }).$_setFlag('objectName', 'DeleteDomainListingResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            req.validate(roles.can(req.role).deleteAny('domainaccess'));

            let domain = new ObjectId(result.value.domain);

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
