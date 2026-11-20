'use strict';

// Passkey sign-in without a user name or password (lib/passkey-signin.js). The result has the shape
// of POST /authenticate, and a token when asked for one.

const roles = require('../roles');
const generateAuthToken = require('../generate-auth-token');
const { PasskeySignIn } = require('../passkey-signin');

const hexString = (maxLength, description, required) =>
    Object.assign({ type: 'string', pattern: '^[0-9a-fA-F]+$', maxLength, minLength: 1, wdEmpty: true, description }, required ? { wdRequired: true } : {});

const rpId = { type: 'string', minLength: 1, wdEmpty: true, wdValidator: 'hostname', description: 'Relying party ID (domain)' };

module.exports = (db, server, userHandler, mcpTokenHandler) => {
    const passkeys = new PasskeySignIn({ users: db.users, redis: db.redis, userHandler });

    server.route({
        method: 'POST',
        url: '/authenticate/passkey/challenge',
        schema: {
            summary: 'Start passkey sign-in',
            description: 'Returns a challenge for signing in with any passkey of this site. No user name is needed; the passkey identifies the user.',
            tags: ['Authentication']
        },
        config: {
            name: 'passkeyChallenge',
            validationObjs: {
                requestBody: {
                    origin: { type: 'string', minLength: 1, wdEmpty: true, wdValidator: 'uri', wdRequired: true, description: 'Origin of the page' },
                    rpId,
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'PasskeyChallengeResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                authenticationOptions: {
                                    type: 'object',
                                    additionalProperties: true,
                                    description: 'Options for navigator.credentials.get(), challenge as hex',
                                    properties: {
                                        challenge: { type: 'string', description: 'Challenge as hex string' },
                                        rpId: { type: 'string', description: 'Relying party ID' },
                                        userVerification: { type: 'string', description: 'Always required' },
                                        timeout: { type: 'number', description: 'Milliseconds' }
                                    }
                                }
                            },
                            required: ['success', 'authenticationOptions']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            req.validate(roles.can(req.role).createAny('authentication'));
            const authenticationOptions = await passkeys.options(req.params);
            return reply.send({ success: true, authenticationOptions });
        }
    });

    server.route({
        method: 'POST',
        url: '/authenticate/passkey',
        schema: {
            summary: 'Sign in with a passkey',
            description:
                'Verifies a passkey assertion and signs in the user the passkey belongs to. User verification (PIN or biometrics) is required and counts as the second factor.',
            tags: ['Authentication']
        },
        config: {
            name: 'passkeyAuthenticate',
            validationObjs: {
                requestBody: {
                    challenge: hexString(2048, 'Challenge from /authenticate/passkey/challenge', true),
                    rawId: hexString(2048, 'Credential ID as hex string', true),
                    clientDataJSON: hexString(1024 * 1024, 'Client data JSON as hex string', true),
                    authenticatorData: hexString(1024 * 1024, 'Authenticator data as hex string', true),
                    signature: hexString(1024 * 1024, 'Signature as hex string', true),
                    userHandle: hexString(512, 'User handle as hex string, when the authenticator returned one'),
                    rpId,
                    scope: { type: 'string', enum: ['master', 'mcp'], default: 'master', description: 'Scope of the token' },
                    token: { $ref: 'wd:boolean', default: false, description: 'If true then the response includes a token for the scope' },
                    appId: { type: 'string', minLength: 1, wdEmpty: true, wdValidator: 'uri', description: 'Application ID, for the log' },
                    protocol: { type: 'string', maxLength: 64, wdEmpty: true, description: 'Protocol for the log, for example "Webmail"' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'PasskeyAuthenticateResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'User ID' },
                                username: { type: 'string', description: 'Username' },
                                address: { type: 'string', description: 'Main address' },
                                scope: { type: 'string', description: 'Scope of the sign-in' },
                                require2fa: { type: 'boolean', description: 'Always false: a verified passkey is the second factor' },
                                require2faEnabled: { type: 'boolean', description: 'Whether 2FA is required for the account' },
                                requirePasswordChange: { type: 'boolean', description: 'Always false for passkey sign-in' },
                                credential: { type: 'string', description: 'ID of the credential used' },
                                token: { type: 'string', description: 'Token for the scope, when asked for' }
                            },
                            required: ['success', 'id', 'username', 'scope']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;
            req.validate(roles.can(req.role).createAny('authentication'));
            const meta = { protocol: values.protocol, sess: values.sess, ip: values.ip, requiredScope: values.scope };
            if (values.appId) {
                meta.appId = values.appId;
            }

            let authData;
            try {
                authData = await passkeys.signIn(values, meta);
            } catch (err) {
                // refusals carry their status; anything else is a server error
                if (!err.responseCode) {
                    throw err;
                }
                return reply.code(err.responseCode).send({ error: err.message, code: err.code });
            }

            const response = {
                success: true,
                id: authData.user.toString(),
                username: authData.username,
                address: authData.address,
                scope: authData.scope,
                require2fa: false,
                require2faEnabled: authData.require2faEnabled,
                requirePasswordChange: false,
                credential: authData.credential
            };
            if (values.token) {
                response.token = await generateAuthToken(userHandler, mcpTokenHandler, authData.user, authData.scope, {
                    mfaRequired: false,
                    mfaVerified: true,
                    passwordChangeRequired: false,
                    sess: values.sess,
                    ip: values.ip
                });
            }
            return reply.send(response);
        }
    });
};
