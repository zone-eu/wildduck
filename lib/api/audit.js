'use strict';

const log = require('npmlog');
const { objectIdSchema, dateOrFalse } = require('../schemas/json-schemas');
const tools = require('../tools');
const roles = require('../roles');
const mboxExport = require('../mbox-export');
const ObjectId = require('mongodb').ObjectId;

const auditIdParam = objectIdSchema('ID of the Audit', { wdRequired: true });

// a date or boolean false (Joi.date().empty('').allow(false))
const auditBoundary = dateOrFalse;

module.exports = (db, server, auditHandler) => {
    server.route({
        method: 'POST',
        url: '/audit',
        schema: {
            summary: 'Create new audit',
            description: 'Initiates a message audit',
            tags: ['Audit']
        },
        config: {
            name: 'createAudit',
            validationObjs: {
                requestBody: {
                    user: { $ref: 'wd:userId' },
                    start: auditBoundary('Start time as ISO date'),
                    end: auditBoundary('End time as ISO date'),
                    expires: {
                        wdEmpty: true,
                        wdType: 'date',
                        wdInstanceof: 'Date',
                        wdDateGtNow: true,
                        wdRequired: true,
                        description: 'Expiration date. Audit data is deleted after this date'
                    },
                    notes: {
                        type: 'string',
                        maxLength: 1024,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Optional audit notes'
                    },
                    meta: { $ref: 'wd:metaData', description: 'Optional metadata, must be an object or JSON formatted string' },
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
                            title: 'CreateAuditResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID for the created Audit' }
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
            req.validate(roles.can(req.role).updateAny('audit'));

            let user = new ObjectId(values.user);
            let start = values.start;
            let end = values.end;
            let expires = values.expires;
            let notes = values.notes;
            let meta = values.meta;

            if (meta && typeof meta === 'string') {
                try {
                    meta = JSON.parse(meta);
                } catch (err) {
                    meta = undefined;
                }
            }

            let audit = await auditHandler.create({
                user,
                start,
                end,
                expires,
                notes,
                meta
            });

            return reply.send({
                success: true,
                id: audit.toString()
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/audit/:audit',
        schema: {
            summary: 'Request Audit Info',
            description: 'This method returns information about stored audit',
            tags: ['Audit']
        },
        config: {
            name: 'getAudit',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    audit: auditIdParam
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetAuditResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Audit' },
                                user: { type: 'string', description: 'ID of the User' },
                                start: { description: 'Start time as ISO date' },
                                end: { description: 'End time as ISO date' },
                                expires: { description: 'Expiration date. Audit data is deleted after this date' },
                                notes: { description: 'Optional audit notes' },
                                meta: { type: 'object', additionalProperties: true, description: 'Custom metadata for this audit' },
                                deleted: { type: 'boolean', description: 'If true then audit has been deleted' },
                                deletedTime: { description: 'Time the audit was deleted' },
                                audited: { type: 'number', description: 'How many messages have been audited' },
                                lastAuditedMessage: { description: 'Timestamp of the last audited message' },
                                import: {
                                    type: 'object',
                                    description: 'Audit import data',
                                    properties: {
                                        status: { type: 'string', description: 'Status of the audit' },
                                        failed: { type: 'number', description: 'How many messages failed' },
                                        copied: { type: 'number', description: 'How many messages copied' }
                                    },
                                    required: ['status', 'failed', 'copied']
                                }
                            },
                            required: ['success', 'id', 'user', 'expires', 'import']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            // permissions check
            req.validate(roles.can(req.role).readAny('audit'));

            let auditData = await db.database.collection('audits').findOne({ _id: new ObjectId(req.params.audit) });
            if (!auditData) {
                return reply.code(404).send({
                    error: 'Audit not found',
                    code: 'AuditNotFoundError'
                });
            }

            return reply.code(200).send({
                success: true,
                id: auditData._id.toString(),
                user: auditData.user.toString(),
                start: auditData.start && auditData.start.toISOString(),
                end: auditData.end && auditData.end.toISOString(),
                expires: auditData.expires && auditData.expires.toISOString(),
                notes: auditData.notes,
                meta: auditData.meta ? tools.formatMetaData(auditData.meta) : undefined,
                deleted: !!auditData.deleted,
                deletedTime: auditData.deletedTime ? auditData.deletedTime.toISOString() : undefined,
                audited: auditData.audited,
                lastAuditedMessage: auditData.lastAuditedMessage ? auditData.lastAuditedMessage.toISOString() : undefined,
                import: auditData.import
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/audit/:audit/export.mbox',
        schema: {
            summary: 'Export Audited Emails',
            description: 'This method returns a mailbox file that contains all audited emails',
            tags: ['Audit']
        },
        config: {
            name: 'getAuditEmails',
            validationObjs: {
                requestBody: {},
                queryParams: {},
                pathParams: { audit: auditIdParam },
                response: { 200: { description: 'Success' } }
            }
        },
        async handler(req, reply) {
            // permissions check
            req.validate(roles.can(req.role).readAny('audit'));

            const auditId = new ObjectId(req.params.audit);
            const auditData = await db.database.collection('audits').findOne({ _id: auditId }, { projection: { _id: true } });
            if (!auditData) {
                return reply.code(404).send({
                    error: 'Audit not found',
                    code: 'AuditNotFoundError'
                });
            }

            let output = await mboxExport(auditHandler, auditId);

            reply.header('Content-Type', 'application/octet-stream');
            reply.header('Content-Disposition', 'attachment; filename=export.mbox');

            output.on('error', err => {
                log.error('Audit', `Failed processing audit ${req.params.audit}: ${err.message}`);
                try {
                    reply.raw.end();
                } catch (err) {
                    //ignore
                }
            });

            return reply.send(output);
        }
    });
};
