'use strict';

const Joi = require('joi');
const tools = require('../tools');
const roles = require('../roles');
const { sessSchema, sessIPSchema, booleanSchema } = require('../schemas');
const { successRes } = require('../schemas/response/general-schemas');

// allow overriding the following consts using the key format `const:archive:time`

module.exports = (db, server, settingsHandler) => {
    server.get(
        {
            name: 'getSettings',
            path: '/settings',
            tags: ['Settings'],
            summary: 'List registered Settings',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    filter: Joi.string().empty('').trim().max(128).description('Optional partial match of the Setting key'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            filter: Joi.string().description('Partial match if requested'),
                            settings: Joi.array()
                                .items(
                                    Joi.object({
                                        key: Joi.string().required().description('Setting key'),
                                        value: Joi.alternatives()
                                            .try(Joi.string().description('Setting value'), Joi.number().description('Setting value'))
                                            .required()
                                            .description('Setting value'),
                                        name: Joi.string().required().description('Setting name'),
                                        description: Joi.string().required().description('Setting description'),
                                        type: Joi.string().required().description('Value subtype'),
                                        custom: booleanSchema.required().description('If true then the value is set')
                                    })
                                        .$_setFlag('objectName', 'GetSettingsResult')
                                        .required()
                                )
                                .description('Setting listing')
                                .required()
                        }).$_setFlag('objectName', 'GetSettingsResponse')
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
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            let permission = roles.can(req.role).readAny('settings');
            // permissions check
            req.validate(permission);

            let settings = await settingsHandler.list(result.value.filter);

            let response = {
                success: true,
                filter: result.value.filter,
                settings
            };

            return res.json(response);
        })
    );

    server.post(
        {
            path: '/settings/:key',
            tags: ['Settings'],
            summary: 'Create or Update Setting',
            description: 'Create a new or update an existing setting',
            name: 'createSetting',
            validationObjs: {
                requestBody: {
                    value: Joi.any()
                        .when('key', {
                            switch: settingsHandler.keys.map(entry => ({
                                is: entry.key,
                                then: entry.schema
                            }))
                        })
                        .required()
                        .description('Setting value'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    key: Joi.string()
                        .empty('')
                        .valid(...settingsHandler.keys.map(entry => entry.key))
                        .required()
                        .description('Key of the Setting')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            key: Joi.string().required().description('Key of the Setting')
                        }).$_setFlag('objectName', 'CreateSettingResponse')
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
            let permission = roles.can(req.role).createAny('settings');
            req.validate(permission);

            result.value = permission.filter(result.value);

            let key = result.value.key;
            let value = result.value.value;

            let storedValue;
            try {
                storedValue = await settingsHandler.set(key, value);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return res.json({
                success: !!storedValue,
                key
            });
        })
    );

    server.get(
        {
            path: '/settings/:key',
            tags: ['Settings'],
            summary: 'Get Setting value',
            name: 'getSetting',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    key: Joi.string().empty('').max(128).required().description('Key of the Setting')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            key: Joi.string().required().description('Key of the Setting'),
                            value: Joi.alternatives()
                                .try(Joi.string().description('Setting value'), Joi.number().description('Setting value'))
                                .description('Setting value'),
                            error: Joi.string().description('Error if present').example('Key was not found')
                        }).$_setFlag('objectName', 'GetSettingResponse')
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
            let permission = roles.can(req.role).readAny('settings');
            req.validate(permission);

            let key = result.value.key;

            let value;
            try {
                value = await settingsHandler.get(key, {});
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return res.json({
                success: value !== undefined,
                key,
                value,
                error: value === undefined ? 'Key was not found' : undefined
            });
        })
    );
};
