'use strict';

const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const { publish, AUTOREPLY_USER_DISABLED, AUTOREPLY_USER_ENABLED } = require('../events');

// autoreply start/end: a date or boolean false to disable the check
// (Joi.date().empty('').allow(false))
const autoreplyBoundary = description => ({
    wdEmpty: true,
    anyOf: [{ wdType: 'date', wdInstanceof: 'Date' }, { const: false }],
    description
});

const autoreplyTextField = (maxLength, description) => ({
    type: 'string',
    maxLength,
    wdTrim: true,
    description
});

module.exports = (db, server) => {
    server.put(
        {
            path: '/users/:user/autoreply',
            tags: ['Autoreplies'],
            summary: 'Update Autoreply information',
            name: 'updateAutoreply',
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    status: { $ref: 'wd:boolean', description: 'Is the autoreply enabled (true) or not (false)' },
                    name: autoreplyTextField(128, 'Name that is used for the From: header in autoreply message'),
                    subject: autoreplyTextField(2 * 1024, 'Subject line for the autoreply. If empty then uses subject of the original message'),
                    text: autoreplyTextField(128 * 1024, 'Plaintext formatted content of the autoreply message'),
                    html: autoreplyTextField(128 * 1024, 'HTML formatted content of the autoreply message'),
                    start: autoreplyBoundary('Datestring of the start of the autoreply or boolean false to disable start checks'),
                    end: autoreplyBoundary('Datestring of the end of the autoreply or boolean false to disable end checks'),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UpdateAutoreplyResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'Autoreply ID' }
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
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).updateAny('autoreplies'));
            }

            let user = new ObjectId(values.user);
            values.user = user;

            if (typeof values.status === 'boolean') {
                const r = await db.users.collection('users').updateOne({ _id: user }, { $set: { autoreply: values.status } });
                if (!r.matchedCount) {
                    res.status(404);
                    return res.json({
                        error: 'Unknown user',
                        code: 'UserNotFound'
                    });
                }
                if (r.modifiedCount) {
                    await publish(db.redis, {
                        ev: values.status ? AUTOREPLY_USER_ENABLED : AUTOREPLY_USER_DISABLED,
                        user
                    });
                }
            } else {
                const userData = await db.users.collection('users').findOne({ _id: user }, { projection: { _id: true, autoreply: true } });
                if (!userData) {
                    res.status(404);
                    return res.json({
                        error: 'Unknown user',
                        code: 'UserNotFound'
                    });
                }
            }

            values.created = new Date();
            values.created.setMilliseconds(0);
            values.created = values.created.toISOString();

            const autoreplyData = await db.database.collection('autoreplies').findOneAndUpdate({ user }, { $set: values }, { returnDocument: 'after', upsert: true });

            server.loggelf({
                short_message: `[AUTOREPLY] ${autoreplyData.lastErrorObject?.upserted ? 'create' : 'update'}`,
                _mail_action: `${autoreplyData.lastErrorObject?.upserted ? 'Create' : 'Update'} autoreply`,
                _user: user,
                _autoreply_id: autoreplyData.value?._id.toString(),
                _autoreply_status: autoreplyData.value?.status,
                _autoreply_name: autoreplyData.value?.name,
                _autoreply_subject: autoreplyData.value?.subject,
                _autoreply_start: autoreplyData.value?.start,
                _autoreply_end: autoreplyData.value?.end,
                _autoreply_created: autoreplyData.value?.created,
                _sess: values.sess,
                _ip: values.ip
            });

            return res.json({
                success: true,
                id: autoreplyData.value._id.toString()
            });
        })
    );

    server.get(
        {
            path: '/users/:user/autoreply',
            tags: ['Autoreplies'],
            summary: 'Request Autoreply information',
            name: 'getAutoreply',
            jsonSchema: true,
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
                            title: 'GetAutoreplyResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                status: { type: 'boolean', description: 'Is the autoreply enabled (true) or not (false)' },
                                name: { type: 'string', description: 'Name that is used for the From: header in autoreply message' },
                                subject: {
                                    type: 'string',
                                    description: 'Subject line for the autoreply. If empty then uses subject of the original message'
                                },
                                text: { type: 'string', description: 'Plaintext formatted content of the autoreply message' },
                                html: { type: 'string', description: 'HTML formatted content of the autoreply message' },
                                start: { type: 'string', format: 'date-time', description: 'Datestring of the start of the autoreply or undefined if missing' },
                                end: { type: 'string', format: 'date-time', description: 'Datestring of the end of the autoreply or undefined if missing' },
                                created: { type: 'string', format: 'date-time', description: 'Datestring of when the Autoreply was created or undefined if missing' }
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
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).readAny('autoreplies'));
            }

            let user = new ObjectId(values.user);

            let entry = await db.database.collection('autoreplies').findOne({ user });

            entry = entry || {};
            return res.json({
                success: true,
                status: !!entry.status,
                name: entry.name || '',
                subject: entry.subject || '',
                text: entry.text || '',
                html: entry.html || '',
                start: entry.start || undefined,
                end: entry.end || undefined,
                created: entry.created || entry._id?.getTimestamp() || undefined
            });
        })
    );

    server.del(
        {
            path: '/users/:user/autoreply',
            tags: ['Autoreplies'],
            summary: 'Delete Autoreply information',
            name: 'deleteAutoreply',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' }
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
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).deleteOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).deleteAny('autoreplies'));
            }

            let user = new ObjectId(values.user);

            let r = await db.users.collection('users').updateOne({ _id: user }, { $set: { autoreply: false } });
            if (r.modifiedCount) {
                await publish(db.redis, {
                    ev: AUTOREPLY_USER_DISABLED,
                    user
                });
            }

            const autoreplyData = await db.database.collection('autoreplies').findOneAndDelete({ user }, { projection: { _id: true } });

            server.loggelf({
                short_message: '[AUTOREPLY] Delete',
                _mail_action: 'Delete autoreply',
                _user: user,
                _autoreply_id: autoreplyData.value?._id.toString(),
                _sess: values.sess,
                _ip: values.ip
            });

            return res.json({
                success: true
            });
        })
    );
};
