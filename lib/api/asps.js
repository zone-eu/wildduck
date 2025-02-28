'use strict';

const config = require('wild-config');
const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const mobileconfig = require('mobileconfig');
const { randomUUID: uuid } = require('crypto');
const consts = require('../consts');
const certs = require('../certs').get('api.mobileconfig');
const tools = require('../tools');
const roles = require('../roles');
const util = require('util');
const { sessSchema, sessIPSchema, booleanSchema } = require('../schemas');
const { userId } = require('../schemas/request/general-schemas');
const { successRes } = require('../schemas/response/general-schemas');

module.exports = (db, server, userHandler) => {
    const mobileconfigGetSignedConfig = util.promisify(mobileconfig.getSignedConfig.bind(mobileconfig));

    server.get(
        {
            path: '/users/:user/asps',
            tags: ['ApplicationPasswords'],
            summary: 'List Application Passwords',
            name: 'getASPs',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    showAll: booleanSchema.default(false).description('If not true then skips entries with a TTL set'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { user: userId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('ID of the Application Password'),
                                        description: Joi.string().required().description('Description'),
                                        scopes: Joi.array()
                                            .items(
                                                Joi.string()
                                                    .required()
                                                    .valid(...consts.SCOPES, '*')
                                            )
                                            .required()
                                            .description('Allowed scopes for the Application Password'),
                                        lastUse: Joi.object({
                                            time: Joi.date().required().description('Datestring of last use or false if password has not been used'),
                                            event: Joi.string().required().description('Event ID of the security log for the last authentication')
                                        })
                                            .required()
                                            .$_setFlag('objectName', 'LastUse')
                                            .description('Information about last use'),
                                        created: Joi.date().required().description('Datestring'),
                                        expires: Joi.date().required().description('Application password expires after the given date')
                                    }).$_setFlag('objectName', 'GetASPsResult')
                                )
                                .required()
                                .description('Event listing')
                        }).$_setFlag('objectName', 'GetASPsResponse')
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
                req.validate(roles.can(req.role).readOwn('asps'));
            } else {
                req.validate(roles.can(req.role).readAny('asps'));
            }

            let user = new ObjectId(result.value.user);
            let showAll = result.value.showAll;

            let userData;

            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            address: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let asps;
            try {
                asps = await db.users
                    .collection('asps')
                    .find({
                        user
                    })
                    .sort({ _id: 1 })
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!asps) {
                asps = [];
            }

            return res.json({
                success: true,

                results: asps
                    .filter(asp => {
                        if (showAll) {
                            return true;
                        }
                        if (asp.ttl) {
                            return false;
                        }
                        return true;
                    })
                    .map(asp => ({
                        id: asp._id.toString(),
                        description: asp.description,
                        scopes: asp.scopes.includes('*') ? [...consts.SCOPES] : asp.scopes,
                        lastUse: {
                            time: asp.used || false,
                            event: asp.authEvent || false
                        },
                        expires: asp.expires,
                        created: asp.created
                    }))
            });
        })
    );

    server.get(
        {
            path: '/users/:user/asps/:asp',
            tags: ['ApplicationPasswords'],
            summary: 'Request ASP information',
            name: 'getASP',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { user: userId, asp: Joi.string().hex().lowercase().length(24).required().description('ID of the Application Password') },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('ID of the Application Password'),
                            description: Joi.string().required().description('Description'),
                            scopes: Joi.array()
                                .items(
                                    Joi.string()
                                        .valid(...consts.SCOPES, '*')
                                        .required()
                                )
                                .required()
                                .description('Allowed scopes for the Application Password'),
                            lastUse: Joi.object({
                                time: Joi.date().required().description('Datestring of last use or false if password has not been used'),
                                event: Joi.string().required().description('Event ID of the security log for the last authentication')
                            })
                                .required()
                                .$_setFlag('objectName', 'LastUse')
                                .description('Information about last use'),
                            created: Joi.date().required().description('Datestring'),
                            expires: Joi.date().required().description('Application password expires after the given date')
                        }).$_setFlag('objectName', 'GetASPResponse')
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
                req.validate(roles.can(req.role).readOwn('asps'));
            } else {
                req.validate(roles.can(req.role).readAny('asps'));
            }

            let user = new ObjectId(result.value.user);
            let asp = new ObjectId(result.value.asp);

            let aspData;

            try {
                aspData = await db.users.collection('asps').findOne({
                    _id: asp,
                    user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!aspData) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown ASP key',
                    code: 'AspNotFound'
                });
            }

            return res.json({
                success: true,
                id: aspData._id.toString(),
                description: aspData.description,
                scopes: aspData.scopes.includes('*') ? [...consts.SCOPES] : aspData.scopes,
                lastUse: {
                    time: aspData.used || false,
                    event: aspData.authEvent || false
                },
                expires: asp.expires,
                created: aspData.created
            });
        })
    );

    server.post(
        {
            path: '/users/:user/asps',
            tags: ['ApplicationPasswords'],
            summary: 'Create new Application Password',
            name: 'createASP',
            validationObjs: {
                requestBody: {
                    description: Joi.string().trim().max(255).required().description('Description for the Application Password entry'),
                    scopes: Joi.array()
                        .items(
                            Joi.string()
                                .valid(...consts.SCOPES, '*')
                                .required()
                        )
                        .unique()
                        .description(
                            'List of scopes this Password applies to. Special scope "*" indicates that this password can be used for any scope except "master"'
                        ),
                    address: Joi.string()
                        .empty('')
                        .email({ tlds: false })
                        .description(
                            'E-mail address to be used as the account address in mobileconfig file. Must be one of the listed identity addresses of the user. Defaults to the main address of the user'
                        ),
                    password: Joi.string()
                        .empty('')
                        .pattern(/^[a-z]{16}$/, { name: 'password' })
                        .description('Optional pregenerated password. Must be 16 characters, latin letters only.'),
                    generateMobileconfig: booleanSchema
                        .default(false)
                        .description('If true then result contains a mobileconfig formatted file with account config'),
                    ttl: Joi.number().empty([0, '']).description('TTL in seconds for this password. Every time password is used, TTL is reset to this value'),
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
                            id: Joi.string().required().description('ID of the Application Password'),
                            password: Joi.string()
                                .required()
                                .description(
                                    'Application Specific Password. Generated password is whitespace agnostic, so it could be displayed to the client as "abcd efgh ijkl mnop" instead of "abcdefghijklmnop"'
                                ),
                            mobileconfig: Joi.string()
                                .required()
                                .description(
                                    'Base64 encoded mobileconfig file. Generated profile file should be sent to the client with Content-Type value of application/x-apple-aspen-config.'
                                ),
                            name: Joi.string().required().description('Account name'),
                            address: Joi.string().required().description('Account address or the address specified in params of this endpoint')
                        }).$_setFlag('objectName', 'CreateASPResponse')
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

            if (typeof req.params.scopes === 'string') {
                req.params.scopes = req.params.scopes
                    .split(',')
                    .map(scope => scope.trim())
                    .filter(scope => scope);
            }

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
                req.validate(roles.can(req.role).createOwn('asps'));
            } else {
                req.validate(roles.can(req.role).createAny('asps'));
            }

            let user = new ObjectId(result.value.user);
            let generateMobileconfig = result.value.generateMobileconfig;
            let scopes = result.value.scopes || ['*'];
            let description = result.value.description;

            if (scopes.includes('*')) {
                scopes = ['*'];
            }

            if (generateMobileconfig && !scopes.includes('*') && ((!scopes.includes('imap') && !scopes.includes('pop3')) || !scopes.includes('smtp'))) {
                res.status(400);
                return res.json({
                    error: 'Profile file requires either imap or pop3 and smtp scopes',
                    code: 'InvalidAuthScope'
                });
            }

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            username: true,
                            name: true,
                            address: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let accountType;
            let accountHost;
            let accountPort;
            let accountSecure;
            let accountAddress;
            let accountName;

            if (result.value.address) {
                let addressData;
                try {
                    addressData = await db.users.collection('addresses').findOne({
                        addrview: tools.normalizeAddress(result.value.address, false, {
                            removeLabel: true,
                            removeDots: true
                        })
                    });
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                if (!addressData || !addressData.user.equals(userData._id)) {
                    res.status(404);
                    return res.json({
                        error: 'Invalid or unknown address',
                        code: 'AddressNotFound'
                    });
                }

                accountName = addressData.name || userData.name || '';
                accountAddress = addressData.address;
            } else {
                accountName = userData.name || '';
                accountAddress = userData.address;
            }

            let asp = await userHandler.generateASP(user, result.value);

            if (!generateMobileconfig) {
                return res.json({
                    success: true,
                    id: asp.id,
                    password: asp.password
                });
            }

            let profileOpts = {};
            Object.keys(config.api.mobileconfig || {}).forEach(key => {
                profileOpts[key] = (config.api.mobileconfig[key] || '')
                    .toString()
                    .replace(/\{email\}/g, accountAddress)
                    .replace(/\{name\}/g, accountName)
                    .trim();
            });

            if (scopes.includes('*') || scopes.includes('imap')) {
                // prefer IMAP
                accountType = 'EmailTypeIMAP';
                accountHost = config.imap.setup.hostname;
                accountPort = config.imap.setup.port || config.imap.port;
                accountSecure = !!config.imap.setup.secure;
            } else {
                accountType = 'EmailTypePOP';
                accountHost = config.pop3.setup.hostname;
                accountPort = config.pop3.setup.port || config.pop3.port;
                accountSecure = !!config.pop3.setup.secure;
            }

            let profile = await mobileconfigGetSignedConfig(
                {
                    PayloadType: 'Configuration',
                    PayloadVersion: 1,
                    PayloadIdentifier: profileOpts.identifier + '.' + userData._id,
                    PayloadUUID: uuid(),
                    PayloadDisplayName: description || profileOpts.displayName,
                    PayloadDescription: profileOpts.displayDescription,
                    PayloadOrganization: profileOpts.organization || 'WildDuck Mail Server',

                    PayloadContent: [
                        {
                            PayloadType: 'com.apple.mail.managed',
                            PayloadVersion: 1,
                            PayloadIdentifier: profileOpts.identifier + '.' + userData._id,
                            PayloadUUID: uuid(),
                            PayloadDisplayName: 'Email Account',
                            PayloadDescription: 'Configures email account',
                            PayloadOrganization: profileOpts.organization || 'WildDuck Mail Server',

                            EmailAccountDescription: profileOpts.accountDescription,
                            EmailAccountName: accountName,
                            EmailAccountType: accountType,
                            EmailAddress: accountAddress,
                            IncomingMailServerAuthentication: 'EmailAuthPassword',
                            IncomingMailServerHostName: accountHost,
                            IncomingMailServerPortNumber: accountPort,
                            IncomingMailServerUseSSL: accountSecure,
                            IncomingMailServerUsername: accountAddress,
                            IncomingPassword: asp.password,
                            OutgoingPasswordSameAsIncomingPassword: true,
                            OutgoingMailServerAuthentication: 'EmailAuthPassword',
                            OutgoingMailServerHostName: config.smtp.setup.hostname,
                            OutgoingMailServerPortNumber: config.smtp.setup.port || config.smtp.port,
                            OutgoingMailServerUseSSL: 'secure' in config.smtp.setup ? !!config.smtp.setup.secure : config.smtp.secure,
                            OutgoingMailServerUsername: accountAddress,
                            PreventMove: false,
                            PreventAppSheet: false,
                            SMIMEEnabled: false,
                            allowMailDrop: true
                        }
                    ]
                },
                certs
            );

            return res.json({
                success: true,
                id: asp.id,
                name: accountName,
                address: accountAddress,
                password: asp.password,
                mobileconfig: profile.toString('base64')
            });
        })
    );

    server.del(
        {
            path: '/users/:user/asps/:asp',
            tags: ['ApplicationPasswords'],
            summary: 'Delete an Application Password',
            name: 'deleteASP',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { user: userId, asp: Joi.string().hex().lowercase().length(24).required().description('ID of the Application Password') },
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
                req.validate(roles.can(req.role).deleteOwn('asps'));
            } else {
                req.validate(roles.can(req.role).deleteAny('asps'));
            }

            let user = new ObjectId(result.value.user);
            let asp = new ObjectId(result.value.asp);

            await userHandler.deleteASP(user, asp, result.value);

            return res.json({
                success: true
            });
        })
    );
};
