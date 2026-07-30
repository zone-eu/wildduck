'use strict';

const ObjectId = require('mongodb').ObjectId;
const { objectIdSchema } = require('../../schemas/json-schemas');
const tools = require('../../tools');
const roles = require('../../roles');

const hexString = (maxLength, description, required) => {
    const schema = {
        type: 'string',
        pattern: '^[0-9a-fA-F]+$',
        maxLength,
        minLength: 1,
        wdEmpty: true,
        description
    };
    if (required) {
        schema.wdRequired = true;
    }
    return schema;
};

const rpIdSchema = description => ({
    type: 'string',
    minLength: 1,
    wdEmpty: true,
    wdValidator: 'hostname',
    description
});

const authenticatorAttachmentSchema = {
    type: 'string',
    enum: ['platform', 'cross-platform'],
    default: 'cross-platform',
    examples: ['cross-platform'],
    description: 'Indicates whether authenticators should be part of the OS ("platform"), or can be roaming authenticators ("cross-platform")'
};

const twoFactorNonceSchema = {
    type: 'string',
    pattern: '^[0-9a-fA-F]{40}$',
    minLength: 40,
    maxLength: 40,
    description: 'Short-lived nonce returned by /authenticate'
};

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
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetWebAuthNResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                credentials: {
                                    type: 'array',
                                    description: 'List of credentials',
                                    items: {
                                        type: 'object',
                                        additionalProperties: true,
                                        properties: {
                                            id: { type: 'string', description: 'Credential ID' },
                                            rawId: { type: 'string', description: 'Raw ID string of the credential in hex' },
                                            description: { type: 'string', description: 'Descriptive name for the authenticator' },
                                            authenticatorAttachment: {
                                                type: 'string',
                                                description:
                                                    'Indicates whether authenticators is a part of the OS ("platform"), or roaming authenticators ("cross-platform")',
                                                examples: ['platform']
                                            }
                                        }
                                    }
                                }
                            },
                            required: ['success', 'credentials']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
                            authenticatorAttachment: credentialData.authenticatorAttachment || 'cross-platform'
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
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    credential: objectIdSchema('Credential ID', { wdRequired: true })
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeleteWebAuthNResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                deleted: { type: 'boolean', description: 'Specifies whether the given credential has been deleted' }
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
                    description: {
                        type: 'string',
                        maxLength: 1024,
                        minLength: 1,
                        wdEmpty: true,
                        wdRequired: true,
                        description: 'Descriptive name for the authenticator'
                    },
                    origin: {
                        type: 'string',
                        minLength: 1,
                        wdEmpty: true,
                        wdValidator: 'uri',
                        wdRequired: true,
                        description: 'Origin'
                    },

                    authenticatorAttachment: authenticatorAttachmentSchema,

                    rpId: rpIdSchema('Relaying party ID. Is domain.'),

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
                            title: 'InitiateWebAuthNRegistrationResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                registrationOptions: {
                                    type: 'object',
                                    additionalProperties: true,
                                    properties: {
                                        challenge: { type: 'string', description: 'Challenge as a hex string' },
                                        user: {
                                            type: 'object',
                                            additionalProperties: true,
                                            properties: {
                                                id: { type: 'string', description: 'ID of the User' },
                                                name: { type: 'string', description: 'User address or name' },
                                                displayName: { type: 'string', description: 'User display name or username' }
                                            }
                                        },
                                        authenticatorSelection: {
                                            type: 'object',
                                            additionalProperties: true,
                                            description: 'Data about the authenticator',
                                            properties: {
                                                authenticatorAttachment: { type: 'string', description: '"platform" or "cross-platform"' }
                                            }
                                        },
                                        rp: {
                                            type: 'object',
                                            additionalProperties: true,
                                            description: 'Relaying party data',
                                            properties: {
                                                name: { type: 'string', description: 'Rp name' },
                                                id: { type: 'string', description: 'Rp ID. Domain' },
                                                icon: { type: 'string', description: 'Rp icon. data/image string in base64 format' }
                                            }
                                        },
                                        excludeCredentials: {
                                            type: 'array',
                                            description: 'List of credentials to exclude',
                                            items: {
                                                type: 'object',
                                                additionalProperties: true,
                                                properties: {
                                                    rawId: { type: 'string', description: 'Raw ID of the credential as hex string' },
                                                    type: { type: 'string', description: 'Type of the credential' },
                                                    transports: {
                                                        type: 'array',
                                                        items: { type: 'string' },
                                                        description:
                                                            'Credential transports. If authenticatorAttachment is "platform" then ["internal"] otherwise ["usb", "nfc", "ble"]'
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
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
                    challenge: hexString(2048, 'Challenge as hex string', true),
                    rawId: hexString(2048, 'Credential ID/RawID as hex string', true),
                    clientDataJSON: hexString(1024 * 1024, 'Clientside data JSON as hex string', true),
                    attestationObject: hexString(1024 * 1024, 'Attestation object represented as a hex string', true),

                    rpId: rpIdSchema('Relaying party ID. Is domain.'),

                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        // the handler responds with { success, response } where
                        // response carries the credential data, the old model
                        // documented a flat shape that never matched reality
                        model: {
                            type: 'object',
                            title: 'AttestateWebAuthNRegistrationResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                response: { type: 'object', additionalProperties: true, description: 'Registered credential data' }
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
                    origin: {
                        type: 'string',
                        minLength: 1,
                        wdEmpty: true,
                        wdValidator: 'uri',
                        wdRequired: true,
                        description: 'Origin domain'
                    },
                    authenticatorAttachment: authenticatorAttachmentSchema,

                    rpId: rpIdSchema('Relaying party ID. Domain'),
                    twoFactorNonce: twoFactorNonceSchema,

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
                            title: 'AuthenticateWebAuthNResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                authenticationOptions: {
                                    type: 'object',
                                    additionalProperties: true,
                                    description: 'PublicKeyCredentialRequestOptions object',
                                    properties: {
                                        challenge: { type: 'string', description: 'Challenge as hex string' },
                                        allowCredentials: {
                                            type: 'array',
                                            description: 'Allowed credential(s) based on the request',
                                            items: {
                                                type: 'object',
                                                additionalProperties: true,
                                                properties: {
                                                    rawId: { type: 'string', description: 'RawId of the credential as hex string' },
                                                    type: { type: 'string', description: 'Credential type' }
                                                }
                                            }
                                        },
                                        rpId: { type: 'string', description: 'Relaying Party ID. Domain' },
                                        rawChallenge: { description: 'Raw challenge bytes. ArrayBuffer' },
                                        attestation: { type: 'string', description: 'Attestation string. `direct`/`indirect`/`none`' },
                                        extensions: { type: 'object', additionalProperties: true, description: 'Any credential extensions' },
                                        userVerification: { type: 'string', description: 'User verification type. `required`/`preferred`/`discouraged`' },
                                        timeout: { type: 'number', description: 'Timeout in milliseconds (ms)' }
                                    }
                                }
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
                    challenge: hexString(2048, 'Challenge of the credential as hex string', true),
                    rawId: hexString(2048, 'RawId of the credential', true),
                    clientDataJSON: hexString(1024 * 1024, 'Client data JSON as hex string', true),
                    authenticatorData: hexString(1024 * 1024, 'Authentication data as hex string', true),

                    signature: hexString(1024 * 1024, 'Private key encrypted signature to verify with public key on the server. Hex string', true),

                    rpId: rpIdSchema('Relaying party ID. Domain'),
                    twoFactorNonce: twoFactorNonceSchema,

                    token: { $ref: 'wd:boolean', default: false, description: 'If true response will contain the user auth token' },

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
                            title: 'AssertWebAuthNResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                response: {
                                    type: 'object',
                                    additionalProperties: true,
                                    description: 'Auth data',
                                    properties: {
                                        authenticated: { type: 'boolean', description: 'Authentication status' },
                                        credential: { type: 'string', description: 'WebAuthN credential ID' }
                                    }
                                },
                                token: { type: 'string', description: 'User auth token' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
            let pending2fa = authData.pending2fa;
            delete authData.pending2fa;

            let authResponse = {
                success: true,
                response: authData
            };

            let tokenRequested = result.value.token;
            if (pending2fa) {
                tokenRequested = pending2fa.tokenRequested;
            }

            if (tokenRequested) {
                try {
                    authResponse.token = await userHandler.generateAuthToken(user);
                } catch (err) {
                    if (pending2fa) {
                        await userHandler.restorePending2faAuth(pending2fa);
                    }

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
