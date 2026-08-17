'use strict';

const ObjectId = require('mongodb').ObjectId;
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

    server.route({
        method: 'POST',
        url: '/users/:user/2fa/totp/setup',
        schema: {
            summary: 'Generate TOTP seed',
            description: 'This method generates TOTP seed and QR code for 2FA. User needs to verify the seed value using 2fa/totp/enable endpoint',
            tags: ['TwoFactorAuth']
        },
        config: {
            name: 'generateTOTPSeed',
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
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(values.user);
            let totp = await userHandler.setupTotp(user, values);

            return reply.send({
                success: true,
                seed: totp.secret,
                qrcode: totp.dataUrl
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/2fa/totp/enable',
        schema: {
            summary: 'Enable TOTP seed',
            description: 'This method enables TOTP for a user by verifying the seed value generated from 2fa/totp/setup',
            tags: ['TwoFactorAuth']
        },
        config: {
            name: 'enableTOTPSeed',
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
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(values.user);
            let { success, disabled2fa } = await userHandler.enableTotp(user, values);

            if (!success) {
                return reply.code(400).send({
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

            return reply.send({
                success
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/2fa/totp',
        schema: {
            summary: 'Disable TOTP auth',
            description: 'This method disables TOTP for a user. Does not affect other 2FA mechanisms a user might have set up',
            tags: ['TwoFactorAuth']
        },
        config: {
            name: 'disableTOTPAuth',
            validationObjs: {
                requestBody: {},
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                pathParams: { user: { $ref: 'wd:userId' } },
                response: successResponse
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(values.user);
            let success = await userHandler.disableTotp(user, values);

            return reply.send({
                success
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/2fa/totp/check',
        schema: {
            summary: 'Validate TOTP Token',
            description: 'This method checks if a TOTP token provided by a User is valid for authentication',
            tags: ['TwoFactorAuth']
        },
        config: {
            name: 'validateTOTPToken',
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
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).createOwn('authentication'));
            } else {
                req.validate(roles.can(req.role).createAny('authentication'));
            }

            let user = new ObjectId(values.user);
            let totp = await userHandler.checkTotp(user, values);

            if (!totp) {
                return reply.code(403).send({
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

                    return reply.code(403).send({
                        error: err.message,
                        code: err.code || 'AuthFailed',
                        id: user.toString()
                    });
                }
            }

            return reply.send(response);
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/2fa',
        schema: {
            summary: 'Disable 2FA',
            description: 'This method disables all 2FA mechanisms a user might have set up',
            tags: ['TwoFactorAuth']
        },
        config: {
            name: 'disable2FA',
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
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(values.user);
            let success = await userHandler.disable2fa(user, values);

            return reply.send({
                success
            });
        }
    });
};
