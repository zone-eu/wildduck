'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../../tools');
const roles = require('../../roles');
const { sessSchema, sessIPSchema } = require('../../schemas');
const { userId } = require('../../schemas/request/general-schemas');
const { successRes } = require('../../schemas/response/general-schemas');

// Custom 2FA needs to be enabled if your website handles its own 2FA and you want to disable
// master password usage for IMAP/POP/SMTP clients

module.exports = (db, server, userHandler) => {
    server.put(
        {
            path: '/users/:user/2fa/custom',
            tags: ['TwoFactorAuth'],
            summary: 'Enable custom 2FA for a user',
            name: 'enableCustom2FA',
            description: 'This method disables account password for IMAP/POP3/SMTP',
            validationObjs: {
                requestBody: {
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
            let userHandlerResponse = await userHandler.enableCustom2fa(user, result.value);

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
            let disabled2fa = await userHandler.disableCustom2fa(user, result.value);

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
