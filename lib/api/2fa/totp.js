'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../../tools');
const roles = require('../../roles');
const { sessSchema, sessIPSchema } = require('../../schemas');
const { userId } = require('../../schemas/request/general-schemas');
const { successRes } = require('../../schemas/response/general-schemas');

module.exports = (db, server, userHandler) => {
    // Create TOTP seed and request a QR code

    server.post(
        {
            path: '/users/:user/2fa/totp/setup',
            tags: ['TwoFactorAuth'],
            summary: 'Generate TOTP seed',
            name: 'generateTOTPSeed',
            description: 'This method generates TOTP seed and QR code for 2FA. User needs to verify the seed value using 2fa/totp/enable endpoint',
            validationObjs: {
                requestBody: {
                    label: Joi.string().empty('').trim().max(255).description('Label text for QR code (defaults to username)'),
                    issuer: Joi.string().trim().max(255).required().description('Description text for QR code (defaults to "WildDuck")'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: { user: userId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            seed: Joi.string().required().description('Generated TOTP seed value'),
                            qrcode: Joi.string().required().description('Base64 encoded QR code')
                        }).$_setFlag('objectName', 'GenerateTOTPSeedResponse')
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
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(result.value.user);
            let totp = await userHandler.setupTotp(user, result.value);

            return res.json({
                success: true,
                seed: totp.secret,
                qrcode: totp.dataUrl
            });
        })
    );

    server.post(
        {
            path: '/users/:user/2fa/totp/enable',
            tags: ['TwoFactorAuth'],
            summary: 'Enable TOTP seed',
            name: 'enableTOTPSeed',
            description: 'This method enables TOTP for a user by verifying the seed value generated from 2fa/totp/setup',
            validationObjs: {
                requestBody: {
                    token: Joi.string().length(6).required().description('6-digit number that matches seed value from 2fa/totp/setup'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: { user: userId },
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
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(result.value.user);
            let { success, disabled2fa } = await userHandler.enableTotp(user, result.value);

            if (!success) {
                res.status(400);
                return res.json({
                    error: 'Invalid authentication token',
                    code: 'InvalidToken'
                });
            }

            if (disabled2fa && req.accessToken && typeof req.accessToken.update === 'function') {
                try {
                    // update access token data for current session after U2F enabled
                    await req.accessToken.update();
                } catch (err) {
                    // ignore
                }
            }

            return res.json({
                success
            });
        })
    );

    server.del(
        {
            path: '/users/:user/2fa/totp',
            tags: ['TwoFactorAuth'],
            summary: 'Disable TOTP auth',
            name: 'disableTOTPAuth',
            description: 'This method disables TOTP for a user. Does not affect other 2FA mechanisms a user might have set up',
            validationObjs: {
                requestBody: {},
                queryParams: { sess: sessSchema, ip: sessIPSchema },
                pathParams: { user: userId },
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
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(result.value.user);
            let success = await userHandler.disableTotp(user, result.value);

            return res.json({
                success
            });
        })
    );

    server.post(
        {
            path: '/users/:user/2fa/totp/check',
            tags: ['TwoFactorAuth'],
            summary: 'Validate TOTP Token',
            name: 'validateTOTPToken',
            description: 'This method checks if a TOTP token provided by a User is valid for authentication',
            validationObjs: {
                requestBody: {
                    token: Joi.string().length(6).required().description('6-digit number'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: { user: userId },
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
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let user = new ObjectId(result.value.user);
            let totp = await userHandler.checkTotp(user, result.value);

            if (!totp) {
                res.status(403);
                return res.json({
                    error: 'Failed to validate TOTP',
                    code: 'InvalidToken'
                });
            }

            return res.json({
                success: true
            });
        })
    );

    server.del(
        {
            path: '/users/:user/2fa',
            tags: ['TwoFactorAuth'],
            summary: 'Disable 2FA',
            name: 'disable2FA',
            description: 'This method disables all 2FA mechanisms a user might have set up',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { user: userId },
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
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(result.value.user);
            let success = await userHandler.disable2fa(user, result.value);

            return res.json({
                success
            });
        })
    );
};
