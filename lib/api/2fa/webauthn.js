'use strict';

const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../../tools');
const roles = require('../../roles');
const { sessSchema, sessIPSchema, booleanSchema } = require('../../schemas');
const { userId } = require('../../schemas/request/general-schemas');
const { successRes } = require('../../schemas/response/general-schemas');

module.exports = (db, server, userHandler) => {
    server.get(
        {
            path: '/users/:user/2fa/webauthn/credentials',
            tags: ['TwoFactorAuth'],
            summary: 'Get WebAuthN credentials for a user',
            name: 'getWebAuthN',
            description: 'This method returns the list of WebAuthN credentials for a given user',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { user: userId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            credentials: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('Credential ID'),
                                        rawId: Joi.string().hex().required().description('Raw ID string of the credential in hex'),
                                        description: Joi.string().required().description('Descriptive name for the authenticator'),
                                        authenticatorAttachment: Joi.string()
                                            .required()
                                            .description(
                                                'Indicates whether authenticators is a part of the OS ("platform"), or roaming authenticators ("cross-platform")'
                                            )
                                            .example('platform')
                                    })
                                )
                                .required()
                                .description('List of credentials')
                        }).$_setFlag('objectName', 'GetWebAuthNResponse')
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
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let user = new ObjectId(result.value.user);

            let userData = await db.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        _id: true,
                        webauthn: true
                    }
                }
            );

            return res.json({
                success: true,
                credentials:
                    (userData.webauthn &&
                        userData.webauthn.credentials &&
                        userData.webauthn.credentials.map(credentialData => ({
                            id: credentialData._id.toString(),
                            rawId: credentialData.rawId.toString('hex'),
                            description: credentialData.description,
                            authenticatorAttachment: credentialData.authenticatorAttachment
                        }))) ||
                    []
            });
        })
    );

    server.del(
        {
            path: '/users/:user/2fa/webauthn/credentials/:credential',
            tags: ['TwoFactorAuth'],
            summary: 'Remove WebAuthN authenticator',
            name: 'deleteWebAuthN',
            description: 'This method deletes the given WebAuthN authenticator for given user.',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    credential: Joi.string().hex().lowercase().length(24).required().description('Credential ID')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            deleted: booleanSchema.required().description('Specifies whether the given credential has been deleted')
                        }).$_setFlag('objectName', 'DeleteWebAuthNResponse')
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
            let credential = new ObjectId(result.value.credential);

            let deleted = await userHandler.webauthnRemove(user, credential, result.value);

            return res.json({
                success: true,
                deleted
            });
        })
    );

    // Get webauthn challenge
    server.post(
        {
            path: '/users/:user/2fa/webauthn/registration-challenge',
            tags: ['TwoFactorAuth'],
            summary: 'Get the WebAuthN registration challenge',
            name: 'initiateWebAuthNRegistration',
            description: 'This method initiates the WebAuthN authenticator registration challenge',
            validationObjs: {
                requestBody: {
                    description: Joi.string().empty('').max(1024).required().description('Descriptive name for the authenticator'),
                    origin: Joi.string().empty('').uri().required().description('Origin'),

                    authenticatorAttachment: Joi.string()
                        .valid('platform', 'cross-platform')
                        .example('cross-platform')
                        .default('cross-platform')
                        .description(
                            'Indicates whether authenticators should be part of the OS ("platform"), or can be roaming authenticators ("cross-platform")'
                        ),

                    rpId: Joi.string().hostname().empty('').description('Relaying party ID. Is domain.'),

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
                            registrationOptions: Joi.object({
                                challenge: Joi.string().hex().required().description('Challenge as a hex string'),
                                user: Joi.object({
                                    id: userId,
                                    name: Joi.string().required().description('User address or name'),
                                    displayName: Joi.string().required().description('User display name or username')
                                }),
                                authenticatorSelection: Joi.object({
                                    authenticatorAttachment: Joi.string().required().description('"platform" or "cross-platform"')
                                })
                                    .required()
                                    .description('Data about the authenticator'),
                                rp: Joi.object({
                                    name: Joi.string().required().description('Rp name'),
                                    id: Joi.string().required().description('Rp ID. Domain'),
                                    icon: Joi.string().description('Rp icon. data/image string in base64 format')
                                })
                                    .required()
                                    .description('Relaying party data'),
                                excludeCredentials: Joi.array()
                                    .items(
                                        Joi.object({
                                            rawId: Joi.string().description('Raw ID of the credential as hex string').required(),
                                            type: Joi.string().required().description('Type of the credential'),
                                            transports: Joi.array()
                                                .items(Joi.string().required())
                                                .required()
                                                .description(
                                                    'Credential transports. If authenticatorAttachment is "platform" then ["internal"] otherwise ["usb", "nfc", "ble"]'
                                                )
                                        })
                                    )
                                    .description('List of credentials to exclude')
                            })
                        }).$_setFlag('objectName', 'InitiateWebAuthNRegistrationResponse')
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
            let registrationOptions = await userHandler.webauthnGetRegistrationOptions(user, result.value);

            return res.json({
                success: true,
                registrationOptions
            });
        })
    );

    server.post(
        {
            path: '/users/:user/2fa/webauthn/registration-attestation',
            tags: ['TwoFactorAuth'],
            summary: 'Attestate WebAuthN authenticator',
            name: 'attestateWebAuthNRegistration',
            description: 'Attestation is used to verify the authenticity of the authenticator and provide assurances about its features.',
            validationObjs: {
                requestBody: {
                    challenge: Joi.string().empty('').hex().max(2048).required().description('Challenge as hex string'),
                    rawId: Joi.string().empty('').hex().max(2048).required().description('Credential ID/RawID as hex string'),
                    clientDataJSON: Joi.string()
                        .empty('')
                        .hex()
                        .max(1024 * 1024)
                        .required()
                        .description('Clientside data JSON as hex string'),
                    attestationObject: Joi.string()
                        .empty('')
                        .hex()
                        .max(1024 * 1024)
                        .required()
                        .description('Attestation object represented as a hex string'),

                    rpId: Joi.string().hostname().empty('').description('Relaying party ID. Is domain.'),

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
                            id: Joi.string().required().description('Credential ID'),
                            rawId: Joi.string().hex().required().description('Credential RawID as a hex string'),
                            description: Joi.string().required().description('Description for the authenticator'),
                            authenticatorAttachment: Joi.string().required().description('Specifies whether authenticator is "platform" or "cross-platform"')
                        }).$_setFlag('objectName', 'AttestateWebAuthNRegistrationResponse')
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

            let response = await userHandler.webauthnAttestateRegistration(user, result.value);

            return res.json({
                success: true,
                response
            });
        })
    );

    // Get webauthn challenge
    server.post(
        {
            path: '/users/:user/2fa/webauthn/authentication-challenge',
            tags: ['TwoFactorAuth'],
            summary: 'Begin WebAuthN authentication challenge',
            name: 'authenticateWebAuthN',
            description: 'This method retrieves the WebAuthN PublicKeyCredentialRequestOptions object to use it for authentication',
            validationObjs: {
                requestBody: {
                    origin: Joi.string().empty('').uri().required().description('Origin domain'),
                    authenticatorAttachment: Joi.string()
                        .valid('platform', 'cross-platform')
                        .example('cross-platform')
                        .default('cross-platform')
                        .description(
                            'Indicates whether authenticators should be part of the OS ("platform"), or can be roaming authenticators ("cross-platform")'
                        ),

                    rpId: Joi.string().hostname().empty('').description('Relaying party ID. Domain'),

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
                            authenticationOptions: Joi.object({
                                challenge: Joi.string().hex().required().description('Challenge as hex string'),
                                allowCredentials: Joi.array()
                                    .items(
                                        Joi.object({
                                            rawId: Joi.string().hex().required().description('RawId of the credential as hex string'),
                                            type: Joi.string().required().description('Credential type')
                                        })
                                    )
                                    .required()
                                    .description('Allowed credential(s) based on the request'),
                                rpId: Joi.string().description('Relaying Party ID. Domain'),
                                rawChallenge: Joi.string().description('Raw challenge bytes. ArrayBuffer'),
                                attestation: Joi.string().description('Attestation string. `direct`/`indirect`/`none`'),
                                extensions: Joi.object({}).description('Any credential extensions'),
                                userVerification: Joi.string().description('User verification type. `required`/`preferred`/`discouraged`'),
                                timeout: Joi.number().description('Timeout in milliseconds (ms)')
                            })
                                .required()
                                .description('PublicKeyCredentialRequestOptions object')
                        }).$_setFlag('objectName', 'AuthenticateWebAuthNResponse')
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
                req.validate(roles.can(req.role).createOwn('authentication'));
            } else {
                req.validate(roles.can(req.role).createAny('authentication'));
            }

            let user = new ObjectId(result.value.user);
            let authenticationOptions = await userHandler.webauthnGetAuthenticationOptions(user, result.value);

            return res.json({
                success: true,
                authenticationOptions
            });
        })
    );

    server.post(
        {
            path: '/users/:user/2fa/webauthn/authentication-assertion',
            tags: ['TwoFactorAuth'],
            summary: 'WebAuthN authentication Assertion',
            name: 'assertWebAuthN',
            description: 'Assert WebAuthN authentication request and actually authenticate the user',
            validationObjs: {
                requestBody: {
                    challenge: Joi.string().empty('').hex().max(2048).required().description('Challenge of the credential as hex string'),
                    rawId: Joi.string().empty('').hex().max(2048).required().description('RawId of the credential'),
                    clientDataJSON: Joi.string()
                        .empty('')
                        .hex()
                        .max(1024 * 1024)
                        .required()
                        .description('Client data JSON as hex string'),
                    authenticatorData: Joi.string()
                        .empty('')
                        .hex()
                        .max(1024 * 1024)
                        .required()
                        .description('Authentication data as hex string'),

                    signature: Joi.string()
                        .empty('')
                        .hex()
                        .max(1024 * 1024)
                        .required()
                        .description('Private key encrypted signature to verify with public key on the server. Hex string'),

                    rpId: Joi.string().hostname().empty('').description('Relaying party ID. Domain'),

                    token: booleanSchema.default(false).description('If true response will contain the user auth token'),

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
                            response: Joi.object({
                                authenticated: booleanSchema.required().description('Authentication status'),
                                credential: Joi.string().required().description('WebAuthN credential ID')
                            })
                                .required()
                                .description('Auth data'),
                            token: Joi.string().description('User auth token')
                        }).$_setFlag('objectName', 'AssertWebAuthNResponse')
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

            let permission;

            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).createOwn('authentication');
            } else {
                permission = roles.can(req.role).createAny('authentication');
            }

            // permissions check
            req.validate(permission);

            // filter out unallowed fields
            result.value = permission.filter(result.value);

            let user = new ObjectId(result.value.user);

            let authData = await userHandler.webauthnAssertAuthentication(user, result.value);

            let authResponse = {
                success: true,
                response: authData
            };

            if (result.value.token) {
                try {
                    authResponse.token = await userHandler.generateAuthToken(user);
                } catch (err) {
                    let response = {
                        error: err.message,
                        code: err.code || 'AuthFailed',
                        id: user.toString()
                    };
                    res.status(403);
                    return res.json(response);
                }
            }

            return res.json(permission.filter(authResponse));
        })
    );
};
