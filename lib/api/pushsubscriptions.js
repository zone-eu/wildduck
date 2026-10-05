'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const consts = require('../consts');
const { sessSchema, sessIPSchema } = require('../schemas');
const { userId } = require('../schemas/request/general-schemas');
const { successRes } = require('../schemas/response/general-schemas');

module.exports = (db, server, apnClient) => {
    server.get(
        {
            path: '/users/:user/pushsubscriptions',
            tags: ['PushSubscriptions'],
            summary: 'List push subscriptions for a user',
            name: 'getPushSubscriptions',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { user: userId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('Subscription ID'),
                                        deviceToken: Joi.string().description('APNs device token. Omitted for users reading their own subscriptions; visible to admin roles'),
                                        accountId: Joi.string().required().description('APS account ID'),
                                        subTopic: Joi.string().required().description('APS subtopic'),
                                        mailboxes: Joi.array().items(Joi.string()).required().description('Monitored mailboxes'),
                                        created: Joi.date().required().description('Created datestring'),
                                        updated: Joi.date().required().description('Updated datestring')
                                    }).$_setFlag('objectName', 'GetPushSubscriptionsResult')
                                )
                                .required()
                                .description('Push subscription listing')
                        }).$_setFlag('objectName', 'GetPushSubscriptionsResponse')
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
                permission = roles.can(req.role).readOwn('pushsubscriptions');
            } else {
                permission = roles.can(req.role).readAny('pushsubscriptions');
            }
            req.validate(permission);

            let user = new ObjectId(result.value.user);

            let subscriptions = await db.database
                .collection('pushsubscriptions')
                .find({ user }, { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES })
                .sort({ created: 1 })
                .toArray();

            // Resolve mailboxIds to current paths so the listing reflects renames, not the registration snapshot.
            let mailboxIds = new Set();
            for (let sub of subscriptions) {
                for (let mailboxId of sub.mailboxIds || []) {
                    mailboxIds.add(mailboxId.toString());
                }
            }

            let pathByMailboxId = new Map();
            if (mailboxIds.size) {
                let mailboxes = await db.database
                    .collection('mailboxes')
                    .find(
                        {
                            user,
                            _id: { $in: Array.from(mailboxIds, id => new ObjectId(id)) }
                        },
                        {
                            projection: { _id: 1, path: 1 },
                            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                        }
                    )
                    .toArray();
                for (let mailbox of mailboxes) {
                    pathByMailboxId.set(mailbox._id.toString(), mailbox.path);
                }
            }

            return res.json({
                success: true,
                results: subscriptions.map(sub =>
                    // permission.filter redacts attributes the role is not granted (e.g. deviceToken for read:own)
                    permission.filter({
                        id: sub._id.toString(),
                        deviceToken: sub.deviceToken,
                        accountId: sub.accountId,
                        subTopic: sub.subTopic,
                        // resolved from mailboxIds; deleted mailboxes are omitted
                        mailboxes: (sub.mailboxIds || []).map(mailboxId => pathByMailboxId.get(mailboxId.toString())).filter(Boolean),
                        created: sub.created,
                        updated: sub.updated
                    })
                )
            });
        })
    );

    server.del(
        {
            path: '/users/:user/pushsubscriptions/:subscription',
            tags: ['PushSubscriptions'],
            summary: 'Delete a push subscription',
            name: 'deletePushSubscription',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    subscription: Joi.string().hex().lowercase().length(24).required().description('Subscription ID')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes
                        }).$_setFlag('objectName', 'DeletePushSubscriptionResponse')
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
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('pushsubscriptions'));
            } else {
                req.validate(roles.can(req.role).deleteAny('pushsubscriptions'));
            }

            let user = new ObjectId(result.value.user);
            let subscription = new ObjectId(result.value.subscription);

            let r = await db.database.collection('pushsubscriptions').deleteOne(
                {
                    _id: subscription,
                    user
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                }
            );

            if (!r.deletedCount) {
                res.status(404);
                return res.json({
                    error: 'Subscription not found',
                    code: 'SubscriptionNotFound'
                });
            }

            return res.json({
                success: true
            });
        })
    );

    server.post(
        {
            path: '/users/:user/pushsubscriptions/notify',
            tags: ['PushSubscriptions'],
            summary: 'Trigger an APNs push notification for a user',
            description:
                'Manually sends an Apple Push Notification to the user\'s registered devices, the same notification that is emitted automatically when new mail arrives. Intended for administrative and debugging use.',
            name: 'notifyPushSubscriptions',
            validationObjs: {
                requestBody: {
                    mailbox: Joi.string()
                        .hex()
                        .lowercase()
                        .length(24)
                        .description('Restrict the notification to subscriptions monitoring this mailbox. If not set, all monitored mailboxes are notified'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: { user: userId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            notified: Joi.number().required().description('Number of push subscriptions a notification was queued for')
                        }).$_setFlag('objectName', 'NotifyPushSubscriptionsResponse')
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

            // admin-only operation: triggering a push is a distinct capability from managing subscriptions
            req.validate(roles.can(req.role).createAny('pushnotifications'));

            if (!apnClient) {
                res.status(404);
                return res.json({
                    error: 'Apple Push Notification service is not enabled',
                    code: 'PushServiceDisabled'
                });
            }

            let user = new ObjectId(result.value.user);

            let query = { user };
            if (result.value.mailbox) {
                query.mailboxIds = new ObjectId(result.value.mailbox);
            }

            let subscriptions = await db.database
                .collection('pushsubscriptions')
                .find(query, { projection: { _id: 1, mailboxIds: 1 }, maxTimeMS: consts.DB_MAX_TIME_MAILBOXES })
                .toArray();

            if (!subscriptions.length) {
                return res.json({
                    success: true,
                    notified: 0
                });
            }

            // Collect the distinct mailboxes to notify. notify() debounces and coalesces per user.
            let mailboxIds = new Map();
            if (result.value.mailbox) {
                let mailboxId = new ObjectId(result.value.mailbox);
                mailboxIds.set(mailboxId.toString(), mailboxId);
            } else {
                for (let sub of subscriptions) {
                    for (let mailboxId of sub.mailboxIds || []) {
                        mailboxIds.set(mailboxId.toString(), mailboxId);
                    }
                }
            }

            for (let mailboxId of mailboxIds.values()) {
                apnClient.notify(user, mailboxId);
            }

            return res.json({
                success: true,
                notified: subscriptions.length
            });
        })
    );
};
