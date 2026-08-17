'use strict';

const ObjectId = require('mongodb').ObjectId;
const { objectIdSchema } = require('../schemas/json-schemas');
const roles = require('../roles');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

const webhookIdParam = objectIdSchema('ID of the Webhook', { wdRequired: true });

module.exports = (db, server) => {
    server.route({
        method: 'GET',
        url: '/webhooks',
        schema: {
            summary: 'List registered Webhooks',
            tags: ['Webhooks']
        },
        config: {
            name: 'getWebhooks',
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    type: {
                        type: 'string',
                        maxLength: 128,
                        minLength: 1,
                        wdEmpty: true,
                        wdLowercase: true,
                        description: 'Prefix or exact match. Prefix match must end with ".*", eg "channel.*". Use "*" for all types'
                    },
                    user: objectIdSchema('User ID'),
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
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetWebhooksResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                type: { type: 'string', description: 'Optional webhook type filter' },
                                user: { description: 'Optional user filter' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                results: {
                                    type: 'array',
                                    description: 'Webhook listing',
                                    items: {
                                        type: 'object',
                                        title: 'GetWebhooksResult',
                                        properties: {
                                            id: { type: 'string', description: 'Webhooks unique ID (24 byte hex)' },
                                            type: {
                                                type: 'array',
                                                items: { type: 'string' },
                                                description: 'An array of event types this webhook matches'
                                            },
                                            user: { description: 'User ID or null' },
                                            url: { type: 'string', description: 'Webhook URL' },
                                            created: { type: 'string', format: 'date-time', description: 'Created datestring' }
                                        },
                                        // url/created are echoed from the db document and can also be
                                        // stripped by permission.filter for restricted roles
                                        required: ['id', 'type', 'user']
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
            const values = req.params;

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

            if (values.type) {
                query.type = values.type;
            }

            let user = values.user ? new ObjectId(values.user) : null;
            if (ownOnly) {
                user = new ObjectId(req.user);
            }
            if (user) {
                query.user = user;
            }

            let limit = values.limit;
            let pageNext = values.next;
            let pagePrevious = values.previous;

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
                        url: true,
                        created: true
                    }
                },
                // _id gets removed in response if not explicitly set in paginatedField
                paginatedField: '_id',
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
                listingWrapper = await mongopagingFindWrapper(db.users.collection('webhooks'), opts);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let response = {
                success: true,
                type: values.type,
                user,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || []).map(webhookData => {
                    let entry = {
                        id: webhookData._id.toString(),
                        type: webhookData.type,
                        user: webhookData.user ? webhookData.user.toString() : null,
                        url: webhookData.url,
                        created: webhookData.created
                    };

                    return permission.filter(entry);
                })
            };

            return reply.send(response);
        }
    });

    server.route({
        method: 'POST',
        url: '/webhooks',
        schema: {
            summary: 'Create new Webhook',
            tags: ['Webhooks']
        },
        config: {
            name: 'createWebhook',
            validationObjs: {
                requestBody: {
                    type: {
                        type: 'array',
                        items: {
                            type: 'string',
                            maxLength: 128,
                            minLength: 1,
                            wdTrim: true,
                            wdLowercase: true
                        },
                        wdRequired: true,
                        description: 'An array of event types to match. For prefix match use ".*" at the end (eg. "user.*") or "*" for all types'
                    },
                    user: objectIdSchema('User ID to match (only makes sense for user specific resources)'),
                    url: {
                        type: 'string',
                        minLength: 1,
                        wdValidator: 'webhookUrl',
                        wdRequired: true,
                        description: 'URL to POST data to'
                    },
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
                            title: 'CreateWebhookResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Webhook' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            let values = req.params;

            // permissions check
            let permission;
            if (req.user && req.user === values.user) {
                permission = roles.can(req.role).createOwn('webhooks');
            } else {
                permission = roles.can(req.role).createAny('webhooks');
            }

            req.validate(permission);

            values = permission.filter(values);

            let type = values.type;
            let user = values.user ? new ObjectId(values.user) : null;
            let url = values.url;

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
                    return reply.code(500).send({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                if (!userData) {
                    return reply.code(404).send({
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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let insertId = r.insertedId;

            return reply.send({
                success: !!insertId,
                id: insertId
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/webhooks/:webhook',
        schema: {
            summary: 'Delete a webhook',
            tags: ['Webhooks']
        },
        config: {
            name: 'deleteWebhook',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { webhook: webhookIdParam },
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
        async handler(req, reply) {
            const values = req.params;

            let webhook = new ObjectId(values.webhook);

            let webhookData;
            try {
                webhookData = await db.users.collection('webhooks').findOne({
                    _id: webhook
                });
            } catch (err) {
                return reply.code(500).send({
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
                return reply.code(404).send({
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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: !!r.deletedCount
            });
        }
    });
};
