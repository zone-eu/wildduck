'use strict';

const ObjectId = require('mongodb').ObjectId;
const roles = require('../../roles');

// Custom 2FA needs to be enabled if your website handles its own 2FA and you want to disable
// master password usage for IMAP/POP/SMTP clients

const successResponse = {
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
};

module.exports = (db, server, userHandler) => {
    server.route({
        method: 'PUT',
        url: '/users/:user/2fa/custom',
        schema: {
            summary: 'Enable custom 2FA for a user',
            description: 'This method disables account password for IMAP/POP3/SMTP',
            tags: ['TwoFactorAuth']
        },
        config: {
            name: 'enableCustom2FA',
            validationObjs: {
                requestBody: {
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
            let userHandlerResponse = await userHandler.enableCustom2fa(user, values);

            return reply.send({
                success: userHandlerResponse.success
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/2fa/custom',
        schema: {
            summary: 'Disable custom 2FA for a user',
            description: 'This method disables custom 2FA. If it was the only 2FA set up, then account password for IMAP/POP3/SMTP gets enabled again',
            tags: ['TwoFactorAuth']
        },
        config: {
            name: 'disableCustom2FA',
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
            let disabled2fa = await userHandler.disableCustom2fa(user, values);

            if (!disabled2fa) {
                return reply.code(500).send({
                    error: 'Failed to disable 2FA',
                    code: '2FADisableFailed'
                });
            }

            if (disabled2fa && req.accessToken && typeof req.accessToken.update === 'function') {
                try {
                    // update access token data for current session after custom 2FA disabled
                    await req.accessToken.update();
                } catch (err) {
                    // ignore
                }
            }

            return reply.send({
                success: true
            });
        }
    });
};
