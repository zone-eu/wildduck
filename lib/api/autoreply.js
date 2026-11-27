'use strict';

const ObjectId = require('mongodb').ObjectId;
const { dateOrFalse } = require('../schemas/json-schemas');
const roles = require('../roles');

// autoreply start/end: a date or boolean false to disable the check
// (Joi.date().empty('').allow(false))
const autoreplyBoundary = dateOrFalse;

const autoreplyTextField = (maxLength, description) => ({
    type: 'string',
    maxLength,
    wdTrim: true,
    description
});

module.exports = (db, server, autoreplyHandler) => {
    server.route({
        method: 'PUT',
        url: '/users/:user/autoreply',
        schema: {
            summary: 'Update the autoreply',
            description: 'Enables, disables or updates the vacation autoreply of a user.',
            tags: ['Autoreplies']
        },
        config: {
            name: 'updateAutoreply',
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
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).updateAny('autoreplies'));
            }

            const autoreplyData = await autoreplyHandler.set(new ObjectId(values.user), values, { sess: values.sess, ip: values.ip });

            return reply.send({
                success: true,
                id: autoreplyData._id.toString()
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/autoreply',
        schema: {
            summary: 'Get the autoreply',
            description: 'Returns the vacation autoreply settings of a user.',
            tags: ['Autoreplies']
        },
        config: {
            name: 'getAutoreply',
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
                                created: {
                                    type: 'string',
                                    format: 'date-time',
                                    description: 'Datestring of when the Autoreply was created or undefined if missing'
                                }
                            },
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
                req.validate(roles.can(req.role).readOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).readAny('autoreplies'));
            }

            let user = new ObjectId(values.user);

            let entry = await db.database.collection('autoreplies').findOne({ user });

            entry = entry || {};
            return reply.send({
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
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/autoreply',
        schema: {
            summary: 'Delete the autoreply',
            description: 'Deletes the vacation autoreply of a user.',
            tags: ['Autoreplies']
        },
        config: {
            name: 'deleteAutoreply',
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
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).deleteOwn('autoreplies'));
            } else {
                req.validate(roles.can(req.role).deleteAny('autoreplies'));
            }

            await autoreplyHandler.delete(new ObjectId(values.user), { sess: values.sess, ip: values.ip });

            return reply.send({
                success: true
            });
        }
    });
};
