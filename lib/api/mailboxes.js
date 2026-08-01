'use strict';

const ObjectId = require('mongodb').ObjectId;
const imapTools = require('../../imap-core/lib/imap-tools');
const tools = require('../tools');
const roles = require('../roles');
const util = require('util');
const TaskHandler = require('../task-handler');
const { MAX_MAILBOX_NAME_LENGTH, MAX_SUB_MAILBOXES } = require('../consts');

// Joi used .regex(/\/{2,}|\/$/, { invert: true }): no double or trailing slashes
const mailboxPathSchema = required => {
    const schema = {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MAILBOX_NAME_LENGTH * MAX_SUB_MAILBOXES + 127,
        not: { pattern: '/{2,}|/$' },
        wdValidator: 'mailboxPath',
        description: 'Full path of the mailbox, folders are separated by slashes, ends with the mailbox name (unicode string)'
    };
    if (required) {
        schema.wdRequired = true;
    }
    return schema;
};

const GetMailboxesResult = {
    type: 'object',
    title: 'GetMailboxesResult',
    properties: {
        id: { type: 'string', description: 'ID of the Mailbox' },
        name: { type: 'string', description: 'Name for the mailbox (unicode string)' },
        path: { type: 'string', description: 'Full path of the mailbox, folders are separated by slashes, ends with the mailbox name (unicode string)' },
        specialUse: { description: 'Either special use identifier or null. One of Drafts, Junk, Sent or Trash' },
        modifyIndex: { type: 'number', description: 'Modification sequence number. Incremented on every change in the mailbox.' },
        subscribed: { type: 'boolean', description: 'Mailbox subscription status. IMAP clients may unsubscribe from a folder.' },
        retention: {
            type: 'number',
            description:
                'Default retention policy for this mailbox (in ms). If set then messages added to this mailbox will be automatically deleted after retention time.'
        },
        hidden: { type: 'boolean', description: 'Is the folder hidden or not' },
        encryptMessages: { type: 'boolean', description: 'If true then messages in this mailbox are encrypted' },
        total: { description: 'How many messages are stored in this mailbox' },
        unseen: { description: 'How many unseen messages are stored in this mailbox' },
        size: { type: 'number', description: 'Total size of mailbox in bytes.' }
    },
    required: ['id', 'name', 'path', 'modifyIndex', 'subscribed', 'hidden', 'encryptMessages']
};

const successResponse = title => ({
    200: {
        description: 'Success',
        model: {
            type: 'object',
            title,
            properties: { success: { $ref: 'wd:successRes' } },
            required: ['success']
        }
    }
});

module.exports = (db, server, mailboxHandler) => {
    const getMailboxCounter = tools.getMailboxCounter;
    const updateMailbox = (user, mailbox, updates) =>
        new Promise((resolve, reject) => {
            mailboxHandler.update(user, mailbox, updates, (err, status, mailboxId, updateResult) => {
                if (err) {
                    return reject(err);
                }

                return resolve({
                    status,
                    mailbox: mailboxId,
                    updateResult
                });
            });
        });
    const deleteMailbox = util.promisify(mailboxHandler.del.bind(mailboxHandler));
    const createMailbox = mailboxHandler.createAsync.bind(mailboxHandler);
    const taskHandler = new TaskHandler({ database: db.database });

    server.route({
        method: 'GET',
        url: '/users/:user/mailboxes',
        schema: {
            summary: 'List Mailboxes for a User',
            tags: ['Mailboxes']
        },
        config: {
            name: 'getMailboxes',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                queryParams: {
                    specialUse: { $ref: 'wd:boolean', default: false, description: 'Should the response include only folders with specialUse flag set.' },
                    showHidden: { $ref: 'wd:boolean', default: false, description: 'Hidden folders are not included in the listing by default.' },
                    counters: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'Should the response include counters (total + unseen). Counters come with some overhead.'
                    },
                    sizes: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'Should the response include mailbox size in bytes. Size numbers come with a lot of overhead as an aggregated query is ran.'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },

                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetMailboxesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: { type: 'array', items: GetMailboxesResult, description: 'List of user mailboxes' }
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
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).readAny('mailboxes'));
            }

            let user = new ObjectId(values.user);
            let counters = values.counters;
            let sizes = values.sizes;

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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!mailboxes) {
                mailboxes = [];
            }

            if (values.specialUse) {
                mailboxes = mailboxes.filter(mailboxData => mailboxData.path === 'INBOX' || mailboxData.specialUse);
            }

            if (!values.showHidden) {
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
                            total = await getMailboxCounter(db, mailboxData._id);
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

            return reply.send({
                success: true,
                results: responses
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/mailboxes',
        schema: {
            summary: 'Create new Mailbox',
            tags: ['Mailboxes']
        },
        config: {
            name: 'createMailbox',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                requestBody: {
                    path: mailboxPathSchema(true),
                    hidden: { $ref: 'wd:boolean', default: false, description: 'Is the folder hidden or not. Hidden folders can not be opened in IMAP.' },
                    retention: {
                        type: 'number',
                        minimum: 0,
                        wdType: 'number',
                        description: 'Retention policy for the created Mailbox. Milliseconds after a message added to mailbox expires. Set to 0 to disable.'
                    },
                    sess: { $ref: 'wd:sess' },
                    encryptMessages: { $ref: 'wd:boolean', default: false, description: 'If true then messages in this mailbox are encrypted' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'CreateMailboxResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Mailbox' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).createOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).createAny('mailboxes'));
            }

            let user = new ObjectId(values.user);
            let path = imapTools.normalizeMailbox(values.path);
            let retention = values.retention;

            let opts = {
                subscribed: true,
                hidden: !!values.hidden,
                encryptMessages: !!values.encryptMessages
            };

            if (retention) {
                opts.retention = retention;
            }

            let status, id;

            let data = await createMailbox(user, path, opts);
            status = data.status;
            id = data.id;

            return reply.send({
                success: !!status,
                id
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/mailboxes/:mailbox',
        schema: {
            summary: 'Request Mailbox information',
            tags: ['Mailboxes']
        },
        config: {
            name: 'getMailbox',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    path: {
                        type: 'string',
                        not: { pattern: '/{2,}|/$' },
                        minLength: 1,
                        description: 'If mailbox is specified as `resolve` in the path then use this param as mailbox path instead of the given mailbox id.'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    mailbox: {
                        wdLowercase: true,
                        wdRequired: true,
                        anyOf: [{ type: 'string', pattern: '^[0-9a-f]{24}$' }, { const: 'resolve' }],
                        description: 'ID of the Mailbox'
                    }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetMailboxResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Mailbox' },
                                name: { type: 'string', description: 'Name for the mailbox (unicode string)' },
                                path: {
                                    type: 'string',
                                    description: 'Full path of the mailbox, folders are separated by slashes, ends with the mailbox name (unicode string)'
                                },
                                specialUse: { description: 'Either special use identifier or null. One of Drafts, Junk, Sent or Trash' },
                                modifyIndex: { type: 'number', description: 'Modification sequence number. Incremented on every change in the mailbox.' },
                                subscribed: { type: 'boolean', description: 'Mailbox subscription status. IMAP clients may unsubscribe from a folder.' },
                                hidden: { type: 'boolean', description: 'Is the folder hidden or not' },
                                encryptMessages: { type: 'boolean', description: 'If true then messages in this mailbox are encrypted' },
                                retention: {
                                    type: 'number',
                                    description:
                                        'Retention policy for this mailbox (in ms). If set then messages added to this mailbox will be automatically deleted after retention time.'
                                },
                                total: { description: 'How many messages are stored in this mailbox' },
                                unseen: { description: 'How many unseen messages are stored in this mailbox' }
                            },
                            required: ['success', 'id', 'name', 'path', 'modifyIndex', 'subscribed', 'hidden', 'encryptMessages']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).readAny('mailboxes'));
            }

            let user = new ObjectId(values.user);
            let mailbox = values.mailbox !== 'resolve' ? new ObjectId(values.mailbox) : 'resolve';

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

            let mailboxQuery = {
                _id: mailbox,
                user
            };

            if (mailbox === 'resolve') {
                mailboxQuery = {
                    path: values.path,
                    user
                };
            }

            let mailboxData;
            try {
                mailboxData = await db.database.collection('mailboxes').findOne(mailboxQuery);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!mailboxData) {
                return reply.code(404).send({
                    error: 'This mailbox does not exist',
                    code: 'NoSuchMailbox'
                });
            }

            mailbox = mailboxData._id;

            let path = mailboxData.path.split('/');
            let name = path.pop();

            let total, unseen;

            try {
                total = await getMailboxCounter(db, mailboxData._id);
            } catch (err) {
                // ignore
            }

            try {
                unseen = await getMailboxCounter(db, mailboxData._id, 'unseen');
            } catch (err) {
                // ignore
            }

            return reply.send({
                success: true,
                id: mailbox,
                name,
                path: mailboxData.path,
                specialUse: mailboxData.specialUse,
                modifyIndex: mailboxData.modifyIndex,
                subscribed: mailboxData.subscribed,
                hidden: !!mailboxData.hidden,
                encryptMessages: !!mailboxData.encryptMessages,
                retention: mailboxData.retention,
                total,
                unseen
            });
        }
    });

    server.route({
        method: 'PUT',
        url: '/users/:user/mailboxes/:mailbox',
        schema: {
            summary: 'Update Mailbox information',
            tags: ['Mailboxes']
        },
        config: {
            name: 'updateMailbox',
            validationObjs: {
                requestBody: {
                    path: Object.assign(mailboxPathSchema(false), {
                        description: 'Full path of the mailbox, use this to rename an existing Mailbox'
                    }),
                    retention: {
                        type: 'number',
                        minimum: 0,
                        wdType: 'number',
                        wdEmpty: true,
                        description:
                            'Retention policy for the Mailbox (in ms). Changing retention value updates existing messages in the background using the time each message was added to this mailbox.'
                    },
                    subscribed: { $ref: 'wd:boolean', description: 'Change Mailbox subscription state' },
                    encryptMessages: { $ref: 'wd:boolean', description: 'If true then messages in this mailbox are encrypted' },
                    hidden: { $ref: 'wd:boolean', description: 'Is the folder hidden or not. Hidden folders can not be opened in IMAP.' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { user: { $ref: 'wd:userId' }, mailbox: { $ref: 'wd:mailboxId' } },
                queryParams: {},
                response: successResponse('SuccessResponse')
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).updateAny('mailboxes'));
            }

            let user = new ObjectId(values.user);
            let mailbox = new ObjectId(values.mailbox);

            let updates = {};
            let update = false;
            Object.keys(values || {}).forEach(key => {
                if (!['user', 'mailbox'].includes(key)) {
                    updates[key] = values[key];
                    update = true;
                }
            });

            if (!update) {
                return reply.code(400).send({
                    error: 'Nothing was changed'
                });
            }

            const { updateResult } = await updateMailbox(user, mailbox, updates);

            if ('retention' in updates && updateResult?.changes?.retention) {
                await taskHandler.ensure(
                    'mailbox-retention',
                    { user, mailbox },
                    { user, mailbox, retentionCounter: updateResult.mailbox.retentionCounter || 0 },
                    { updateExistingData: true }
                );
            }

            return reply.send({
                success: true
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/mailboxes/:mailbox',
        schema: {
            summary: 'Delete a Mailbox',
            tags: ['Mailboxes']
        },
        config: {
            name: 'deleteMailbox',
            validationObjs: {
                requestBody: {},
                pathParams: { user: { $ref: 'wd:userId' }, mailbox: { $ref: 'wd:mailboxId' } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                response: successResponse('SuccessResponse')
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).deleteOwn('mailboxes'));
            } else {
                req.validate(roles.can(req.role).deleteAny('mailboxes'));
            }

            let user = new ObjectId(values.user);
            let mailbox = new ObjectId(values.mailbox);

            await deleteMailbox(user, mailbox);

            return reply.send({
                success: true
            });
        }
    });
};
