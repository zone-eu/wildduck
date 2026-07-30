'use strict';

const ObjectId = require('mongodb').ObjectId;
const tools = require('../../tools');
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
    server.put(
        {
            path: '/users/:user/2fa/custom',
            tags: ['TwoFactorAuth'],
            summary: 'Enable custom 2FA for a user',
            name: 'enableCustom2FA',
            description: 'This method disables account password for IMAP/POP3/SMTP',
            jsonSchema: true,
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
        tools.responseWrapper(async (req, res) => {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(values.user);
            let userHandlerResponse = await userHandler.enableCustom2fa(user, values);

            return res.json({
                success: userHandlerResponse.success
            });
        })
    );

    server.del(
        {
            path: '/users/:user/2fa/custom',
            tags: ['TwoFactorAuth'],
            summary: 'Disable custom 2FA for a user',
            name: 'disableCustom2FA',
            description: 'This method disables custom 2FA. If it was the only 2FA set up, then account password for IMAP/POP3/SMTP gets enabled again',
            jsonSchema: true,
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
                res.status(500);
                return res.json({
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

            return res.json({
                success: true
            });
        })
    );
};
