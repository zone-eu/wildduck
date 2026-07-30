'use strict';

const ObjectId = require('mongodb').ObjectId;
const tools = require('../../tools');
const roles = require('../../roles');

const successResponse = {
    200: {
        description: 'Success',
        model: {
            type: 'object',
            title: 'SuccessResponse',
            properties: { success: { $ref: 'wd:successRes' } },
            required: ['success']
        }
    }
};

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
                    label: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Label text for QR code (defaults to username)'
                    },
                    issuer: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdRequired: true,
                        description: 'Description text for QR code (defaults to "WildDuck")'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GenerateTOTPSeedResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                seed: { type: 'string', description: 'Generated TOTP seed value' },
                                qrcode: { type: 'string', description: 'Base64 encoded QR code' }
                            },
                            required: ['success', 'seed', 'qrcode']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
                    token: {
                        type: 'string',
                        minLength: 6,
                        maxLength: 6,
                        wdRequired: true,
                        description: '6-digit number that matches seed value from 2fa/totp/setup'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: { user: { $ref: 'wd:userId' } },
                response: successResponse
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                pathParams: { user: { $ref: 'wd:userId' } },
                response: successResponse
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
                    token: {
                        type: 'string',
                        minLength: 6,
                        maxLength: 6,
                        wdRequired: true,
                        description: '6-digit number'
                    },
                    totpNonce: {
                        type: 'string',
                        pattern: '^[0-9a-fA-F]{40}$',
                        minLength: 40,
                        maxLength: 40,
                        wdRequired: true,
                        description: 'Short-lived nonce returned by /authenticate'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ValidateTOTPTokenResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                token: { type: 'string', description: 'User auth token returned when this check completes a pending 2FA login' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('authentication'));
            } else {
                req.validate(roles.can(req.role).createAny('authentication'));
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

            let response = {
                success: true
            };

            if (totp.pending2fa && totp.pending2fa.tokenRequested) {
                try {
                    response.token = await userHandler.generateAuthToken(user);
                } catch (err) {
                    await userHandler.restorePending2faAuth(totp.pending2fa);

                    res.status(403);
                    return res.json({
                        error: err.message,
                        code: err.code || 'AuthFailed',
                        id: user.toString()
                    });
                }
            }

            return res.json(response);
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
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { user: { $ref: 'wd:userId' } },
                response: successResponse
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
