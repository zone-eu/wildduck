'use strict';

const ObjectId = require('mongodb').ObjectId;
const roles = require('../roles');
const consts = require('../consts');
const { objectIdSchema } = require('../schemas/json-schemas');

module.exports = (db, server, apnClient) => {
    server.route({
        method: 'GET',
        url: '/users/:user/pushsubscriptions',
        schema: {
            summary: 'List push subscriptions for a user',
            tags: ['PushSubscriptions']
        },
        config: {
            name: 'getPushSubscriptions',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetPushSubscriptionsResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: {
                                    type: 'array',
                                    description: 'Push subscription listing',
                                    items: {
                                        type: 'object',
                                        title: 'GetPushSubscriptionsResult',
                                        properties: {
                                            id: { type: 'string', description: 'Subscription ID' },
                                            deviceToken: {
                                                type: 'string',
                                                description: 'APNs device token. Omitted for users reading their own subscriptions; visible to admin roles'
                                            },
                                            accountId: { type: 'string', description: 'APS account ID' },
                                            subTopic: { type: 'string', description: 'APS subtopic' },
                                            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Monitored mailboxes' },
                                            created: { type: 'string', format: 'date-time', description: 'Created datestring' },
                                            updated: { type: 'string', format: 'date-time', description: 'Updated datestring' }
                                        },
                                        required: ['id', 'accountId', 'subTopic', 'mailboxes', 'created', 'updated']
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
            let permission;
            if (req.user && req.user === values.user) {
                permission = roles.can(req.role).readOwn('pushsubscriptions');
            } else {
                permission = roles.can(req.role).readAny('pushsubscriptions');
            }
            req.validate(permission);

            let user = new ObjectId(values.user);

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

            return reply.send({
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
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/pushsubscriptions/:subscription',
        schema: {
            summary: 'Delete a push subscription',
            tags: ['PushSubscriptions']
        },
        config: {
            name: 'deletePushSubscription',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    subscription: objectIdSchema('Subscription ID', { wdRequired: true })
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeletePushSubscriptionResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).deleteOwn('pushsubscriptions'));
            } else {
                req.validate(roles.can(req.role).deleteAny('pushsubscriptions'));
            }

            let user = new ObjectId(values.user);
            let subscription = new ObjectId(values.subscription);

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
                return reply.code(404).send({
                    error: 'Subscription not found',
                    code: 'SubscriptionNotFound'
                });
            }

            return reply.send({
                success: true
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/pushsubscriptions/notify',
        schema: {
            summary: 'Trigger an APNs push notification for a user',
            description:
                "Manually sends an Apple Push Notification to the user's registered devices, the same notification that is emitted automatically when new mail arrives. Intended for administrative and debugging use.",
            tags: ['PushSubscriptions']
        },
        config: {
            name: 'notifyPushSubscriptions',
            validationObjs: {
                requestBody: {
                    mailbox: objectIdSchema(
                        'Restrict the notification to subscriptions monitoring this mailbox. If not set, all monitored mailboxes are notified'
                    ),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'NotifyPushSubscriptionsResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                notified: { type: 'number', description: 'Number of push subscriptions a notification was queued for' }
                            },
                            required: ['success', 'notified']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // admin-only operation: triggering a push is a distinct capability from managing subscriptions
            req.validate(roles.can(req.role).createAny('pushnotifications'));

            if (!apnClient) {
                return reply.code(404).send({
                    error: 'Apple Push Notification service is not enabled',
                    code: 'PushServiceDisabled'
                });
            }

            let user = new ObjectId(values.user);

            let query = { user };
            if (values.mailbox) {
                query.mailboxIds = new ObjectId(values.mailbox);
            }

            let subscriptions = await db.database
                .collection('pushsubscriptions')
                .find(query, { projection: { _id: 1, mailboxIds: 1 }, maxTimeMS: consts.DB_MAX_TIME_MAILBOXES })
                .toArray();

            if (!subscriptions.length) {
                return reply.send({
                    success: true,
                    notified: 0
                });
            }

            // Collect the distinct mailboxes to notify. notify() debounces and coalesces per user.
            let mailboxIds = new Map();
            if (values.mailbox) {
                let mailboxId = new ObjectId(values.mailbox);
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

            return reply.send({
                success: true,
                notified: subscriptions.length
            });
        }
    });
};
