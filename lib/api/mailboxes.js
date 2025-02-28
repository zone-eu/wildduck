'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const imapTools = require('../../imap-core/lib/imap-tools');
const tools = require('../tools');
const roles = require('../roles');
const util = require('util');
const { sessSchema, sessIPSchema, booleanSchema, mailboxPathValidator } = require('../schemas');
const { userId, mailboxId } = require('../schemas/request/general-schemas');
const { successRes } = require('../schemas/response/general-schemas');
const { GetMailboxesResult } = require('../schemas/response/mailboxes-schemas');
const { MAX_MAILBOX_NAME_LENGTH, MAX_SUB_MAILBOXES } = require('../consts');

module.exports = (db, server, mailboxHandler) => {
    const getMailboxCounter = util.promisify(tools.getMailboxCounter);
    const updateMailbox = util.promisify(mailboxHandler.update.bind(mailboxHandler));
    const deleteMailbox = util.promisify(mailboxHandler.del.bind(mailboxHandler));
    const createMailbox = mailboxHandler.createAsync.bind(mailboxHandler);

    server.get(
        {
            path: '/users/:user/mailboxes',
            tags: ['Mailboxes'],
            summary: 'List Mailboxes for a User',
            name: 'getMailboxes',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: userId
                },
                queryParams: {
                    specialUse: booleanSchema.default(false).description('Should the response include only folders with specialUse flag set.'),
                    showHidden: booleanSchema.default(false).description('Hidden folders are not included in the listing by default.'),
                    counters: booleanSchema
                        .default(false)
                        .description('Should the response include counters (total + unseen). Counters come with some overhead.'),
                    sizes: booleanSchema
                        .default(false)
                        .description(
                            'Should the response include mailbox size in bytes. Size numbers come with a lot of overhead as an aggregated query is ran.'
                        ),
                    sess: sessSchema,
                    ip: sessIPSchema
                },

                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            results: Joi.array().items(GetMailboxesResult).description('List of user mailboxes').required()
                        }).$_setFlag('objectName', 'GetMailboxesResponse')
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
                req.validate(roles.can(req.role).readOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).readAny('mailboxes'));
            }

            let user = new ObjectId(result.value.user);
            let counters = result.value.counters;
            let sizes = result.value.sizes;

            let sizeValues = false;

            let userData;
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

            if (sizes) {
                try {
                    sizeValues = await db.database
                        .collection('messages')
                        .aggregate([
                            {
                                $match: {
                                    user
                                }
                            },
                            {
                                $project: {
                                    mailbox: '$mailbox',
                                    size: '$size'
                                }
                            },
                            {
                                $group: {
                                    _id: '$mailbox',
                                    mailboxSize: {
                                        $sum: '$size'
                                    }
                                }
                            }
                        ])
                        .toArray();
                } catch (err) {
                    // ignore
                }
            }

            let mailboxes;
            try {
                mailboxes = await db.database
                    .collection('mailboxes')
                    .find({
                        user
                    })
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!mailboxes) {
                mailboxes = [];
            }

            if (result.value.specialUse) {
                mailboxes = mailboxes.filter(mailboxData => mailboxData.path === 'INBOX' || mailboxData.specialUse);
            }

            if (!result.value.showHidden) {
                mailboxes = mailboxes.filter(mailboxData => !mailboxData.hidden);
            }

            mailboxes = mailboxes
                .map(mailboxData => mailboxData)
                .sort((a, b) => {
                    if (a.path === 'INBOX') {
                        return -1;
                    }
                    if (b.path === 'INBOX') {
                        return 1;
                    }
                    if (a.path.indexOf('INBOX/') === 0 && b.path.indexOf('INBOX/') !== 0) {
                        return -1;
                    }
                    if (a.path.indexOf('INBOX/') !== 0 && b.path.indexOf('INBOX/') === 0) {
                        return 1;
                    }
                    if (a.subscribed !== b.subscribed) {
                        return (a.subscribed ? 0 : 1) - (b.subscribed ? 0 : 1);
                    }
                    return a.path.localeCompare(b.path);
                });

            let responses = [];

            let counterOps = [];

            for (let mailboxData of mailboxes) {
                let path = mailboxData.path.split('/');
                let name = path.pop();

                let response = {
                    id: mailboxData._id.toString(),
                    name,
                    path: mailboxData.path,
                    specialUse: mailboxData.specialUse,
                    modifyIndex: mailboxData.modifyIndex,
                    subscribed: mailboxData.subscribed,
                    hidden: !!mailboxData.hidden,
                    encryptMessages: !!mailboxData.encryptMessages
                };

                if (mailboxData.retention) {
                    response.retention = mailboxData.retention;
                }

                if (sizeValues) {
                    for (let sizeValue of sizeValues) {
                        if (mailboxData._id.equals(sizeValue._id)) {
                            response.size = sizeValue.mailboxSize;
                            break;
                        }
                    }
                }

                if (!counters) {
                    responses.push(response);
                    continue;
                }

                let total, unseen;

                counterOps.push(
                    (async () => {
                        try {
                            total = await getMailboxCounter(db, mailboxData._id, false);
                        } catch (err) {
                            // ignore
                        }
                        response.total = total;
                    })()
                );

                counterOps.push(
                    (async () => {
                        try {
                            unseen = await getMailboxCounter(db, mailboxData._id, 'unseen');
                        } catch (err) {
                            // ignore
                        }
                        response.unseen = unseen;
                    })()
                );

                responses.push(response);
            }

            if (counterOps.length) {
                await Promise.all(counterOps);
            }

            return res.json({
                success: true,
                results: responses
            });
        })
    );

    server.post(
        {
            path: '/users/:user/mailboxes',
            summary: 'Create new Mailbox',
            name: 'createMailbox',
            validationObjs: {
                pathParams: { user: userId },
                requestBody: {
                    path: Joi.string()
                        .regex(/\/{2,}|\/$/, { invert: true })
                        .max(MAX_MAILBOX_NAME_LENGTH * MAX_SUB_MAILBOXES + 127)
                        .custom(mailboxPathValidator, 'Mailbox path validation')
                        .required()
                        .description('Full path of the mailbox, folders are separated by slashes, ends with the mailbox name (unicode string)'),
                    hidden: booleanSchema.default(false).description('Is the folder hidden or not. Hidden folders can not be opened in IMAP.'),
                    retention: Joi.number()
                        .min(0)
                        .description('Retention policy for the created Mailbox. Milliseconds after a message added to mailbox expires. Set to 0 to disable.'),
                    sess: sessSchema,
                    encryptMessages: booleanSchema.default(false).description('If true then messages in this mailbox are encrypted'),
                    ip: sessIPSchema
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: mailboxId
                        }).$_setFlag('objectName', 'CreateMailboxResponse')
                    }
                }
            },
            tags: ['Mailboxes']
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
                req.validate(roles.can(req.role).createOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).createAny('mailboxes'));
            }

            let user = new ObjectId(result.value.user);
            let path = imapTools.normalizeMailbox(result.value.path);
            let retention = result.value.retention;

            let opts = {
                subscribed: true,
                hidden: !!result.value.hidden,
                encryptMessages: !!result.value.encryptMessages
            };

            if (retention) {
                opts.retention = retention;
            }

            let status, id;

            let data = await createMailbox(user, path, opts);
            status = data.status;
            id = data.id;

            return res.json({
                success: !!status,
                id
            });
        })
    );

    server.get(
        {
            path: '/users/:user/mailboxes/:mailbox',
            summary: 'Request Mailbox information',
            name: 'getMailbox',
            tags: ['Mailboxes'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    path: Joi.string()
                        .regex(/\/{2,}|\/$/, { invert: true })
                        .description('If mailbox is specified as `resolve` in the path then use this param as mailbox path instead of the given mailbox id.'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    mailbox: mailboxId.allow('resolve')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: mailboxId,
                            name: Joi.string().required().description('Name for the mailbox (unicode string)'),
                            path: Joi.string()
                                .required()
                                .description('Full path of the mailbox, folders are separated by slashes, ends with the mailbox name (unicode string)'),
                            specialUse: Joi.string()
                                .required()
                                .example('\\Draft')
                                .description('Either special use identifier or null. One of Drafts, Junk, Sent or Trash'),
                            modifyIndex: Joi.number().required().description('Modification sequence number. Incremented on every change in the mailbox.'),
                            subscribed: booleanSchema.required().description('Mailbox subscription status. IMAP clients may unsubscribe from a folder.'),
                            hidden: booleanSchema.required().description('Is the folder hidden or not'),
                            encryptMessages: booleanSchema.required().description('If true then messages in this mailbox are encrypted'),
                            total: Joi.number().required().description('How many messages are stored in this mailbox'),
                            unseen: Joi.number().required().description('How many unseen messages are stored in this mailbox')
                        }).$_setFlag('objectName', 'GetMailboxResponse')
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
                req.validate(roles.can(req.role).readOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).readAny('mailboxes'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = result.value.mailbox !== 'resolve' ? new ObjectId(result.value.mailbox) : 'resolve';

            let userData;

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

            let mailboxQuery = {
                _id: mailbox,
                user
            };

            if (mailbox === 'resolve') {
                mailboxQuery = {
                    path: result.value.path,
                    user
                };
            }

            let mailboxData;
            try {
                mailboxData = await db.database.collection('mailboxes').findOne(mailboxQuery);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!mailboxData) {
                res.status(404);
                return res.json({
                    error: 'This mailbox does not exist',
                    code: 'NoSuchMailbox'
                });
            }

            mailbox = mailboxData._id;

            let path = mailboxData.path.split('/');
            let name = path.pop();

            let total, unseen;

            try {
                total = await getMailboxCounter(db, mailboxData._id, false);
            } catch (err) {
                // ignore
            }

            try {
                unseen = await getMailboxCounter(db, mailboxData._id, 'unseen');
            } catch (err) {
                // ignore
            }

            return res.json({
                success: true,
                id: mailbox,
                name,
                path: mailboxData.path,
                specialUse: mailboxData.specialUse,
                modifyIndex: mailboxData.modifyIndex,
                subscribed: mailboxData.subscribed,
                hidden: !!mailboxData.hidden,
                encryptMessages: !!mailboxData.encryptMessages,
                total,
                unseen
            });
        })
    );

    server.put(
        {
            path: '/users/:user/mailboxes/:mailbox',
            summary: 'Update Mailbox information',
            name: 'updateMailbox',
            tags: ['Mailboxes'],
            validationObjs: {
                requestBody: {
                    path: Joi.string()
                        .regex(/\/{2,}|\/$/, { invert: true })
                        .max(MAX_MAILBOX_NAME_LENGTH * MAX_SUB_MAILBOXES + 127)
                        .custom(mailboxPathValidator, 'Mailbox path validation')
                        .description('Full path of the mailbox, use this to rename an existing Mailbox'),
                    retention: Joi.number()
                        .empty('')
                        .min(0)
                        .description(
                            'Retention policy for the Mailbox (in ms). Changing retention value only affects messages added to this folder after the change'
                        ),
                    subscribed: booleanSchema.description('Change Mailbox subscription state'),
                    encryptMessages: booleanSchema.description('If true then messages in this mailbox are encrypted'),
                    hidden: booleanSchema.description('Is the folder hidden or not. Hidden folders can not be opened in IMAP.'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { user: userId, mailbox: mailboxId },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes
                        }).$_setFlag('objectName', 'SuccessResponse')
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
                req.validate(roles.can(req.role).updateOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).updateAny('mailboxes'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);

            let updates = {};
            let update = false;
            Object.keys(result.value || {}).forEach(key => {
                if (!['user', 'mailbox'].includes(key)) {
                    updates[key] = result.value[key];
                    update = true;
                }
            });

            if (!update) {
                res.status(400);
                return res.json({
                    error: 'Nothing was changed'
                });
            }

            await updateMailbox(user, mailbox, updates);

            return res.json({
                success: true
            });
        })
    );

    server.del(
        {
            path: '/users/:user/mailboxes/:mailbox',
            summary: 'Delete a Mailbox',
            name: 'deleteMailbox',
            tags: ['Mailboxes'],
            validationObjs: {
                pathParams: { user: userId, mailbox: mailboxId },
                queryParams: { sess: sessSchema, ip: sessIPSchema },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes
                        }).$_setFlag('objectName', 'SuccessResponse')
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
                req.validate(roles.can(req.role).deleteOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).deleteAny('mailboxes'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);

            await deleteMailbox(user, mailbox);

            return res.json({
                success: true
            });
        })
    );
};
