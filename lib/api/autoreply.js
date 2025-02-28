'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const { sessSchema, sessIPSchema, booleanSchema } = require('../schemas');
const { publish, AUTOREPLY_USER_DISABLED, AUTOREPLY_USER_ENABLED } = require('../events');
const { userId } = require('../schemas/request/general-schemas');
const { successRes } = require('../schemas/response/general-schemas');

module.exports = (db, server) => {
    server.put(
        {
            path: '/users/:user/autoreply',
            tags: ['Autoreplies'],
            summary: 'Update Autoreply information',
            name: 'updateAutoreply',
            validationObjs: {
                requestBody: {
                    status: booleanSchema.description('Is the autoreply enabled (true) or not (false)'),
                    name: Joi.string().allow('').trim().max(128).description('Name that is used for the From: header in autoreply message'),
                    subject: Joi.string()
                        .allow('')
                        .trim()
                        .max(2 * 1024)
                        .description('Subject line for the autoreply. If empty then uses subject of the original message'),
                    text: Joi.string()
                        .allow('')
                        .trim()
                        .max(128 * 1024)
                        .description('Plaintext formatted content of the autoreply message'),
                    html: Joi.string()
                        .allow('')
                        .trim()
                        .max(128 * 1024)
                        .description('HTML formatted content of the autoreply message'),
                    start: Joi.date().empty('').allow(false).description('Datestring of the start of the autoreply or boolean false to disable start checks'),
                    end: Joi.date().empty('').allow(false).description('Datestring of the end of the autoreply or boolean false to disable end checks'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('Autoreply ID')
                        }).$_setFlag('objectName', 'UpdateAutoreplyResponse')
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
                req.validate(roles.can(req.role).updateOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).updateAny('autoreplies'));
            }

            let user = new ObjectId(result.value.user);
            result.value.user = user;

            if (typeof result.value.status === 'boolean') {
                const r = await db.users.collection('users').updateOne({ _id: user }, { $set: { autoreply: result.value.status } });
                if (!r.matchedCount) {
                    res.status(404);
                    return res.json({
                        error: 'Unknown user',
                        code: 'UserNotFound'
                    });
                }
                if (r.modifiedCount) {
                    await publish(db.redis, {
                        ev: result.value.status ? AUTOREPLY_USER_ENABLED : AUTOREPLY_USER_DISABLED,
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

            result.value.created = new Date();
            result.value.created.setMilliseconds(0);
            result.value.created = result.value.created.toISOString();

            const autoreplyData = await db.database
                .collection('autoreplies')
                .findOneAndUpdate({ user }, { $set: result.value }, { returnDocument: 'after', upsert: true });

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
                _sess: result.value.sess,
                _ip: result.value.ip
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
                            status: booleanSchema.description('Is the autoreply enabled (true) or not (false)'),
                            name: Joi.string().allow('').trim().max(128).description('Name that is used for the From: header in autoreply message'),
                            subject: Joi.string()
                                .allow('')
                                .trim()
                                .max(2 * 1024)
                                .description('Subject line for the autoreply. If empty then uses subject of the original message'),
                            text: Joi.string()
                                .allow('')
                                .trim()
                                .max(128 * 1024)
                                .description('Plaintext formatted content of the autoreply message'),
                            html: Joi.string()
                                .allow('')
                                .trim()
                                .max(128 * 1024)
                                .description('HTML formatted content of the autoreply message'),
                            start: Joi.date()
                                .empty('')
                                .allow(false)
                                .description('Datestring of the start of the autoreply or boolean false to disable start checks'),
                            end: Joi.date().empty('').allow(false).description('Datestring of the end of the autoreply or boolean false to disable end checks'),
                            created: Joi.date().required().description('Datestring of when the Autoreply was created')
                        }).$_setFlag('objectName', 'GetAutoreplyResponse')
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
                req.validate(roles.can(req.role).readOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).readAny('autoreplies'));
            }

            let user = new ObjectId(result.value.user);

            let entry = await db.database.collection('autoreplies').findOne({ user });

            entry = entry || {};
            return res.json({
                success: true,
                status: !!entry.status,
                name: entry.name || '',
                subject: entry.subject || '',
                text: entry.text || '',
                html: entry.html || '',
                start: entry.start || false,
                end: entry.end || false,
                created: entry.created || entry._id?.getTimestamp() || false
            });
        })
    );

    server.del(
        {
            path: '/users/:user/autoreply',
            tags: ['Autoreplies'],
            summary: 'Delete Autoreply information',
            name: 'deleteAutoreply',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: { 200: { description: 'Success', model: Joi.object({ success: successRes }).$_setFlag('objectName', 'SuccessResponse') } }
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
                req.validate(roles.can(req.role).deleteOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).deleteAny('autoreplies'));
            }

            let user = new ObjectId(result.value.user);

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
                _sess: result.value.sess,
                _ip: result.value.ip
            });

            return res.json({
                success: true
            });
        })
    );
};
