'use strict';

const Joi = require('joi');
const MongoPaging = require('mongo-cursor-pagination');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const { nextPageCursorSchema, previousPageCursorSchema, pageNrSchema, sessSchema, sessIPSchema } = require('../schemas');
const { successRes, totalRes, pageRes, previousCursorRes, nextCursorRes } = require('../schemas/response/general-schemas');

module.exports = (db, server) => {
    server.get(
        {
            name: 'getWebhooks',
            path: '/webhooks',
            tags: ['Webhooks'],
            summary: 'List registered Webhooks',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    type: Joi.string()
                        .empty('')
                        .lowercase()
                        .max(128)
                        .description('Prefix or exact match. Prefix match must end with ".*", eg "channel.*". Use "*" for all types'),
                    user: Joi.string().hex().lowercase().length(24).description('User ID'),
                    limit: Joi.number().default(20).min(1).max(250).description('How many records to return'),
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    page: pageNrSchema,
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            total: totalRes,
                            page: pageRes,
                            previousCursor: previousCursorRes,
                            nextCursor: nextCursorRes,
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('Webhooks unique ID (24 byte hex)'),
                                        type: Joi.array().items(Joi.string()).required().description('An array of event types this webhook matches'),
                                        user: Joi.string().required().description('User ID or null'),
                                        url: Joi.string().required().description('Webhook URL')
                                    }).$_setFlag('objectName', 'GetWebhooksResult')
                                )
                                .required()
                                .description('Webhook listing')
                        }).$_setFlag('objectName', 'GetWebhooksResponse')
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
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            let permission;
            let ownOnly = false;
            permission = roles.can(req.role).readAny('webhooks');
            if (!permission.granted && req.user && ObjectId.isValid(req.user)) {
                permission = roles.can(req.role).readOwn('webhooks');
                if (permission.granted) {
                    ownOnly = true;
                }
            }
            // permissions check
            req.validate(permission);

            let query = {};

            if (result.value.type) {
                query.type = result.value.type;
            }

            let user = result.value.user ? new ObjectId(result.value.user) : null;
            if (ownOnly) {
                user = new ObjectId(req.user);
            }
            if (user) {
                query.user = user;
            }

            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;

            let total = await db.users.collection('webhooks').countDocuments(query);

            let opts = {
                limit,
                query,
                fields: {
                    // FIXME: hack to keep _id in response
                    _id: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        type: true,
                        user: true,
                        url: true
                    }
                },
                // _id gets removed in response if not explicitly set in paginatedField
                paginatedField: '_id',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.users.collection('webhooks'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!listing.hasPrevious) {
                page = 1;
            }

            let response = {
                success: true,
                type: result.value.type,
                user,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || []).map(webhookData => {
                    let values = {
                        id: webhookData._id.toString(),
                        type: webhookData.type,
                        user: webhookData.user ? webhookData.user.toString() : null,
                        url: webhookData.url
                    };

                    return permission.filter(values);
                })
            };

            return res.json(response);
        })
    );

    server.post(
        {
            path: '/webhooks',
            tags: ['Webhooks'],
            summary: 'Create new Webhook',
            name: 'createWebhook',
            validationObjs: {
                requestBody: {
                    type: Joi.array()
                        .items(Joi.string().trim().max(128).lowercase())
                        .required()
                        .description('An array of event types to match. For prefix match use ".*" at the end (eg. "user.*") or "*" for all types'),
                    user: Joi.string().hex().lowercase().length(24).description('User ID to match (only makes sense for user specific resources)'),
                    url: Joi.string()
                        .uri({ scheme: [/smtps?/, /https?/], allowRelative: false, relativeOnly: false })
                        .required()
                        .description('URL to POST data to'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('ID of the Webhook')
                        }).$_setFlag('objectName', 'CreateWebhookResponse')
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
            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).createOwn('webhooks');
            } else {
                permission = roles.can(req.role).createAny('webhooks');
            }

            req.validate(permission);

            result.value = permission.filter(result.value);

            let type = result.value.type;
            let user = result.value.user ? new ObjectId(result.value.user) : null;
            let url = result.value.url;

            let userData;
            if (user) {
                try {
                    userData = await db.users.collection('users').findOne(
                        {
                            _id: user
                        },
                        {
                            projection: {
                                address: true
                            }
                        }
                    );
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                if (!userData) {
                    res.status(404);
                    return res.json({
                        error: 'This user does not exist',
                        code: 'UserNotFound'
                    });
                }
            }

            let webhookData = {
                type,
                user,
                url,
                created: new Date()
            };

            let r;
            // insert alias address to email address registry
            try {
                r = await db.users.collection('webhooks').insertOne(webhookData);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let insertId = r.insertedId;

            return res.json({
                success: !!insertId,
                id: insertId
            });
        })
    );

    server.del(
        {
            path: '/webhooks/:webhook',
            tags: ['Webhooks'],
            summary: 'Delete a webhook',
            name: 'deleteWebhook',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { webhook: Joi.string().hex().lowercase().length(24).required().description('ID of the Webhook') },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({ success: successRes }).$_setFlag('objectName', 'SuccessResponse')
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

            let webhook = new ObjectId(result.value.webhook);

            let webhookData;
            try {
                webhookData = await db.users.collection('webhooks').findOne({
                    _id: webhook
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            // permissions check
            if (req.user && webhookData && webhookData.user && req.user === webhookData.user.toString()) {
                req.validate(roles.can(req.role).deleteOwn('webhooks'));
            } else {
                req.validate(roles.can(req.role).deleteAny('webhooks'));
            }

            if (!webhookData) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown webhook identifier',
                    code: 'WebhookNotFound'
                });
            }

            // delete address from email address registry
            let r;
            try {
                r = await db.users.collection('webhooks').deleteOne({
                    _id: webhook
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return res.json({
                success: !!r.deletedCount
            });
        })
    );
};
