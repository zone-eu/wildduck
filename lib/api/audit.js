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
    server.post(
        {
            path: '/audit',
            tags: ['Audit'],
            summary: 'Create new audit',
            name: 'createAudit',
            description: 'Initiates a message audit',
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
        tools.responseWrapper(async (req, res) => {
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

            return res.json({
                success: true,
                id: audit.toString()
            });
        })
    );

    server.get(
        {
            path: '/audit/:audit',
            tags: ['Audit'],
            summary: 'Request Audit Info',
            name: 'getAudit',
            description: 'This method returns information about stored audit',
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
        tools.responseWrapper(async (req, res) => {
            // permissions check
            req.validate(roles.can(req.role).readAny('audit'));

            let auditData = await db.database.collection('audits').findOne({ _id: new ObjectId(req.params.audit) });
            if (!auditData) {
                res.status(404);
                return res.json({
                    error: 'Audit not found',
                    code: 'AuditNotFoundError'
                });
            }

            res.status(200);
            return res.json({
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
        })
    );

    server.get(
        {
            path: '/audit/:audit/export.mbox',
            tags: ['Audit'],
            name: 'getAuditEmails',
            summary: 'Export Audited Emails',
            description: 'This method returns a mailbox file that contains all audited emails',
            validationObjs: {
                requestBody: {},
                queryParams: {},
                pathParams: { audit: auditIdParam },
                response: { 200: { description: 'Success' } }
            },
            responseType: 'application/octet-stream'
        },
        tools.responseWrapper(async (req, res) => {
            // permissions check
            req.validate(roles.can(req.role).readAny('audit'));

            let output = await mboxExport(auditHandler, new ObjectId(req.params.audit));
            if (!output) {
                res.status(404);
                return res.json({
                    error: 'Audit not found',
                    code: 'AuditNotFoundError'
                });
            }

            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment; filename=export.mbox');

            output.on('error', err => {
                log.error('Audit', `Failed processing audit ${req.params.audit}: ${err.message}`);
                try {
                    res.end();
                } catch (err) {
                    //ignore
                }
            });

            output.pipe(res);
        })
    );
};
