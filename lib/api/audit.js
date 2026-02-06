'use strict';

const log = require('npmlog');
const Joi = require('joi');
const tools = require('../tools');
const roles = require('../roles');
const mboxExport = require('../mbox-export');
const ObjectId = require('mongodb').ObjectId;
const { sessSchema, sessIPSchema, metaDataSchema } = require('../schemas');
const { userId } = require('../schemas/request/general-schemas');
const { successRes } = require('../schemas/response/general-schemas');

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
                    user: userId,
                    start: Joi.date().empty('').allow(false).description('Start time as ISO date'),
                    end: Joi.date().empty('').allow(false).description('End time as ISO date'),
                    expires: Joi.date().empty('').greater('now').required().description('Expiration date. Audit data is deleted after this date'),
                    notes: Joi.string().trim().max(1024).empty('').description('Optional audit notes'),
                    meta: metaDataSchema.label('meta').description('Optional metadata, must be an object or JSON formatted string'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('ID for the created Audit')
                        }).$_setFlag('objectName', 'CreateAuditResponse')
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
            req.validate(roles.can(req.role).updateAny('audit'));

            let user = new ObjectId(result.value.user);
            let start = result.value.start;
            let end = result.value.end;
            let expires = result.value.expires;
            let notes = result.value.notes;
            let meta = result.value.meta;

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
                    audit: Joi.string().hex().lowercase().length(24).required().description('ID of the Audit')
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('ID of the Audit'),
                            user: userId,
                            start: Joi.date().empty('').allow(false).description('Start time as ISO date'),
                            end: Joi.date().empty('').allow(false).description('End time as ISO date'),
                            expires: Joi.date().required().description('Expiration date. Audit data is deleted after this date'),
                            notes: Joi.string().description('Optional audit notes'),
                            meta: Joi.object().description('Custom metadata for this audit'),
                            deleted: Joi.boolean().description('If true then audit has been deleted'),
                            deletedTime: Joi.date().description('Time the audit was deleted'),
                            audited: Joi.number().description('How many messages have been audited'),
                            lastAuditedMessage: Joi.date().description('Timestamp of the last audited message'),
                            import: Joi.object({
                                status: Joi.string().required().description('Status of the audit'),
                                failed: Joi.number().required().description('How many messages failed'),
                                copied: Joi.number().required().description('How many messages copied')
                            })
                                .required()
                                .description('Audit import data')
                        }).$_setFlag('objectName', 'GetAuditResponse')
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
                pathParams: { audit: Joi.string().hex().lowercase().length(24).required().description('ID of the Audit') },
                response: { 200: { description: 'Success', model: Joi.binary() } }
            },
            responseType: 'application/octet-stream'
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
