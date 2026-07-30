'use strict';

const tools = require('../tools');
const roles = require('../roles');

// allow overriding the following consts using the key format `const:archive:time`

const settingValueResponse = description => ({
    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    description
});

module.exports = (db, server, settingsHandler) => {
    server.get(
        {
            name: 'getSettings',
            path: '/settings',
            tags: ['Settings'],
            summary: 'List registered Settings',
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    filter: {
                        type: 'string',
                        maxLength: 128,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Optional partial match of the Setting key'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetSettingsResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                filter: { type: 'string', description: 'Partial match if requested' },
                                settings: {
                                    type: 'array',
                                    description: 'Setting listing',
                                    items: {
                                        type: 'object',
                                        title: 'GetSettingsResult',
                                        properties: {
                                            key: { type: 'string', description: 'Setting key' },
                                            value: settingValueResponse('Setting value'),
                                            name: { type: 'string', description: 'Setting name' },
                                            description: { type: 'string', description: 'Setting description' },
                                            default: settingValueResponse('Default value'),
                                            type: { type: 'string', description: 'Value subtype' },
                                            custom: { type: 'boolean', description: 'If true then the value is set' }
                                        },
                                        required: ['key', 'value', 'name', 'description', 'default', 'type', 'custom']
                                    }
                                }
                            },
                            required: ['success', 'settings']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            let permission = roles.can(req.role).readAny('settings');
            // permissions check
            req.validate(permission);

            let settings = await settingsHandler.list(values.filter);

            let response = {
                success: true,
                filter: values.filter,
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    value: {
                        wdRequired: true,
                        description: 'Setting value'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {
                    key: {
                        type: 'string',
                        wdEmpty: true,
                        enum: settingsHandler.keys.map(entry => entry.key),
                        wdRequired: true,
                        description: 'Key of the Setting'
                    }
                },
                // Joi used value.when('key', { switch: ... }): the value schema
                // depends on which setting key is used
                conditions: settingsHandler.keys.map(entry => ({
                    if: { properties: { key: { const: entry.key } }, required: ['key'] },
                    then: { properties: { value: entry.schema } }
                })),
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'CreateSettingResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                key: { type: 'string', description: 'Key of the Setting' }
                            },
                            required: ['success', 'key']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            let values = req.params;

            // permissions check
            let permission = roles.can(req.role).createAny('settings');
            req.validate(permission);

            values = permission.filter(values);

            let key = values.key;
            let value = values.value;

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
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    key: {
                        type: 'string',
                        maxLength: 128,
                        minLength: 1,
                        wdEmpty: true,
                        wdRequired: true,
                        description: 'Key of the Setting'
                    }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetSettingResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                key: { type: 'string', description: 'Key of the Setting' },
                                value: settingValueResponse('Setting value'),
                                error: { type: 'string', description: 'Error if present', examples: ['Key was not found'] }
                            },
                            required: ['success', 'key']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            // permissions check
            let permission = roles.can(req.role).readAny('settings');
            req.validate(permission);

            let key = values.key;

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
