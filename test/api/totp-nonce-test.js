/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const crypto = require('crypto');
const ObjectId = require('mongodb').ObjectId;
const { Fido2Lib } = require('fido2-lib');
const speakeasy = require('speakeasy');
const config = require('@zone-eu/wild-config');

const expect = chai.expect;
chai.config.includeStack = true;

const authRoutes = require('../../lib/api/auth');
const webauthnRoutes = require('../../lib/api/2fa/webauthn');
const UserHandler = require('../../lib/user-handler');

function getAuthenticateRoute(userHandler) {
    const routes = [];
    const server = {
        post(spec, handler) {
            routes.push({ spec, handler });
        },
        del() {},
        get() {}
    };

    authRoutes({}, server, userHandler);
    return routes.find(route => route.spec.path === '/authenticate' && route.spec.name === 'authenticate');
}

function getWebAuthnRoute(userHandler, path, name) {
    const routes = [];
    const server = {
        post(spec, handler) {
            routes.push({ spec, handler });
        },
        del(spec, handler) {
            routes.push({ spec, handler });
        },
        get(spec, handler) {
            routes.push({ spec, handler });
        }
    };

    webauthnRoutes({}, server, userHandler);
    return routes.find(route => route.spec.path === path && route.spec.name === name);
}

function getResponse() {
    return {
        statusCode: 200,
        body: false,
        charSet() {
            return this;
        },
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return body;
        }
    };
}

function assertGranted(permission) {
    if (!permission.granted) {
        throw new Error('Missing privileges');
    }
}

describe('Authenticate Strict 2FA Handling', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let originalStrict2fa;

    beforeEach(() => {
        originalStrict2fa = config.strict2fa;
    });

    afterEach(() => {
        config.strict2fa = originalStrict2fa;
    });

    it('should return a pending 2FA nonce instead of a token when strict2fa is enabled', async () => {
        config.strict2fa = true;

        const user = new ObjectId();
        const twoFactorNonce = crypto.randomBytes(20).toString('hex');
        const calls = [];

        const route = getAuthenticateRoute({
            asyncAuthenticate: async () => [
                {
                    user,
                    username: 'totpuser',
                    address: 'totpuser@example.com',
                    scope: 'master',
                    require2fa: ['totp'],
                    require2faEnabled: true,
                    requirePasswordChange: false
                },
                user
            ],
            generatePending2faNonce: async (authUser, data) => {
                calls.push(['pending', authUser.toString(), data]);
                return twoFactorNonce;
            },
            generateAuthToken: async () => {
                throw new Error('generateAuthToken should not be called');
            }
        });

        const res = getResponse();
        await route.handler(
            {
                method: 'POST',
                url: '/authenticate',
                route: { spec: route.spec },
                params: {
                    username: 'totpuser',
                    password: 'totpsecret',
                    token: true
                },
                role: 'root',
                validate: assertGranted
            },
            res
        );

        expect(res.statusCode).to.equal(200);
        expect(res.body.token).to.not.exist;
        expect(res.body.twoFactorNonce).to.equal(twoFactorNonce);
        expect(res.body.totpNonce).to.equal(twoFactorNonce);
        expect(calls).to.deep.equal([
            [
                'pending',
                user.toString(),
                {
                    methods: ['totp'],
                    tokenRequested: true
                }
            ]
        ]);
    });

    it('should return a token and standalone TOTP nonce when strict2fa is disabled', async () => {
        config.strict2fa = false;

        const user = new ObjectId();
        const accessToken = crypto.randomBytes(20).toString('hex');
        const totpNonce = crypto.randomBytes(20).toString('hex');
        const calls = [];

        const route = getAuthenticateRoute({
            asyncAuthenticate: async () => [
                {
                    user,
                    username: 'legacytotpuser',
                    address: 'legacytotpuser@example.com',
                    scope: 'master',
                    require2fa: ['totp'],
                    require2faEnabled: true,
                    requirePasswordChange: false
                },
                user
            ],
            generateAuthToken: async authUser => {
                calls.push(['token', authUser.toString()]);
                return accessToken;
            },
            generatePending2faNonce: async (authUser, data) => {
                calls.push(['pending', authUser.toString(), data]);
                return totpNonce;
            }
        });

        const res = getResponse();
        await route.handler(
            {
                method: 'POST',
                url: '/authenticate',
                route: { spec: route.spec },
                params: {
                    username: 'legacytotpuser',
                    password: 'totpsecret',
                    token: true
                },
                role: 'root',
                validate: assertGranted
            },
            res
        );

        expect(res.statusCode).to.equal(200);
        expect(res.body.token).to.equal(accessToken);
        expect(res.body.twoFactorNonce).to.not.exist;
        expect(res.body.totpNonce).to.equal(totpNonce);
        expect(calls).to.deep.equal([
            ['token', user.toString()],
            [
                'pending',
                user.toString(),
                {
                    methods: ['totp'],
                    tokenRequested: false
                }
            ]
        ]);
    });
});

describe('Pending 2FA Nonce Handling', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    it('should restore the pending 2FA nonce after a failed TOTP verification', async () => {
        const calls = [];
        const seed = 'JBSWY3DPEHPK3PXP';
        const user = new ObjectId();
        const validToken = speakeasy.totp({
            secret: seed,
            encoding: 'base32'
        });
        const invalidToken = validToken === '000000' ? '000001' : '000000';
        const handler = {
            redis: {
                exists: async () => 0,
                multi() {
                    return {
                        set() {
                            return this;
                        },
                        expire() {
                            return this;
                        },
                        exec: async () => []
                    };
                }
            },
            users: {
                collection() {
                    return {
                        findOne: async () => ({
                            enabled2fa: ['totp'],
                            seed
                        })
                    };
                }
            },
            rateLimit: async () => ({ success: true }),
            rateLimitReleaseUser: async () => false,
            logAuthEvent: async () => false,
            consumePending2faAuth: async () => {
                calls.push('consumePending');
                return {
                    user,
                    key: 'pending2fa:test',
                    data: {
                        user: user.toString(),
                        methods: '["totp"]',
                        tokenRequested: 'true'
                    },
                    expires: Date.now() + 5 * 60 * 1000
                };
            },
            restorePending2faAuth: async consumedPending2faAuth => {
                calls.push(`restore:${consumedPending2faAuth.key}`);
                return true;
            }
        };

        const result = await UserHandler.prototype.checkTotp.call(handler, user, {
            token: invalidToken,
            totpNonce: crypto.randomBytes(20).toString('hex')
        });

        expect(result).to.be.false;
        expect(calls).to.deep.equal(['consumePending', 'restore:pending2fa:test']);
    });

    it('should restore the standalone TOTP nonce after a failed TOTP verification when strict2fa is disabled', async () => {
        const originalStrict2fa = config.strict2fa;
        config.strict2fa = false;

        try {
            const calls = [];
            const seed = 'JBSWY3DPEHPK3PXP';
            const user = new ObjectId();
            const validToken = speakeasy.totp({
                secret: seed,
                encoding: 'base32'
            });
            const invalidToken = validToken === '000000' ? '000001' : '000000';
            const handler = {
                redis: {
                    exists: async () => 0,
                    multi() {
                        return {
                            set() {
                                return this;
                            },
                            expire() {
                                return this;
                            },
                            exec: async () => []
                        };
                    }
                },
                users: {
                    collection() {
                        return {
                            findOne: async () => ({
                                enabled2fa: ['totp'],
                                seed
                            })
                        };
                    }
                },
                rateLimit: async () => ({ success: true }),
                rateLimitReleaseUser: async () => false,
                logAuthEvent: async () => false,
                consumePending2faAuth: async () => {
                    calls.push('consumePending');
                    return {
                        user,
                        key: 'pending2fa:test',
                        data: {
                            user: user.toString(),
                            methods: '["totp"]',
                            tokenRequested: 'false'
                        },
                        expires: Date.now() + 5 * 60 * 1000
                    };
                },
                restorePending2faAuth: async consumedPending2faAuth => {
                    calls.push(`restore:${consumedPending2faAuth.key}`);
                    return true;
                }
            };

            const result = await UserHandler.prototype.checkTotp.call(handler, user, {
                token: invalidToken,
                totpNonce: crypto.randomBytes(20).toString('hex')
            });

            expect(result).to.be.false;
            expect(calls).to.deep.equal(['consumePending', 'restore:pending2fa:test']);
        } finally {
            config.strict2fa = originalStrict2fa;
        }
    });

    it('should validate and consume a pending 2FA nonce, then restore it with the remaining TTL', async () => {
        const user = new ObjectId();
        const twoFactorNonce = crypto.randomBytes(20).toString('hex');
        let restoredHmsetArgs;
        let restoredPexpireArgs;

        const handler = {
            redis: {
                eval: async () => [
                    1,
                    5 * 60 * 1000,
                    'user',
                    user.toString(),
                    'methods',
                    '["totp"]',
                    'tokenRequested',
                    'true',
                    'created',
                    Date.now().toString()
                ],
                multi() {
                    return {
                        hmset(...args) {
                            restoredHmsetArgs = args;
                            return this;
                        },
                        pexpire(...args) {
                            restoredPexpireArgs = args;
                            return this;
                        },
                        exec: async () => []
                    };
                }
            }
        };

        const consumedPending2faAuth = await UserHandler.prototype.consumePending2faAuth.call(handler, user, twoFactorNonce, 'totp', {
            code: 'InvalidTotpNonce'
        });
        const restored = await UserHandler.prototype.restorePending2faAuth.call(handler, consumedPending2faAuth);

        expect(consumedPending2faAuth.tokenRequested).to.be.true;
        expect(consumedPending2faAuth.methods).to.deep.equal(['totp']);
        expect(restored).to.be.true;
        expect(restoredHmsetArgs[0]).to.equal(consumedPending2faAuth.key);
        expect(restoredHmsetArgs[1].user).to.equal(user.toString());
        expect(restoredPexpireArgs[0]).to.equal(consumedPending2faAuth.key);
        expect(restoredPexpireArgs[1]).to.be.above(0);
        expect(restoredPexpireArgs[1]).to.be.at.most(5 * 60 * 1000);
    });

    it('should accept a legacy U2F pending nonce for WebAuthn authentication challenge', async () => {
        const user = new ObjectId();
        const twoFactorNonce = crypto.randomBytes(20).toString('hex');
        const rawId = Buffer.from('001122', 'hex');
        let storedChallengeData;
        let storedChallengeTtl;

        const handler = Object.assign(Object.create(UserHandler.prototype), {
            redis: {
                multi() {
                    const commands = [];
                    return {
                        hgetall(key) {
                            commands.push(['hgetall', key]);
                            return this;
                        },
                        pttl(key) {
                            commands.push(['pttl', key]);
                            return this;
                        },
                        hmset(key, data) {
                            commands.push(['hmset', key, data]);
                            storedChallengeData = data;
                            return this;
                        },
                        expire(key, ttl) {
                            commands.push(['expire', key, ttl]);
                            storedChallengeTtl = ttl;
                            return this;
                        },
                        exec: async () => {
                            if (commands[0][0] === 'hgetall') {
                                return [
                                    [
                                        null,
                                        {
                                            user: user.toString(),
                                            methods: '["u2f"]',
                                            tokenRequested: 'true',
                                            created: Date.now().toString()
                                        }
                                    ],
                                    [null, 42 * 1000]
                                ];
                            }
                            return commands.map(() => [null, 1]);
                        }
                    };
                }
            },
            users: {
                collection() {
                    return {
                        findOne: async () => ({
                            _id: user,
                            address: 'u2fuser@example.com',
                            username: 'u2fuser',
                            enabled2fa: ['u2f'],
                            webauthn: {
                                credentials: [
                                    {
                                        _id: new ObjectId(),
                                        rawId,
                                        type: 'public-key'
                                    }
                                ]
                            }
                        })
                    };
                }
            }
        });

        const authenticationOptions = await UserHandler.prototype.webauthnGetAuthenticationOptions.call(handler, user, {
            origin: 'https://example.com',
            authenticatorAttachment: 'cross-platform',
            twoFactorNonce
        });

        expect(authenticationOptions.allowCredentials).to.deep.equal([
            {
                rawId: rawId.toString('hex'),
                type: 'public-key'
            }
        ]);
        expect(storedChallengeData.twoFactorNonce).to.equal(twoFactorNonce);
        expect(storedChallengeData.ttl).to.be.above(0);
        expect(storedChallengeData.ttl).to.be.at.most(42);
        expect(storedChallengeTtl).to.equal(storedChallengeData.ttl);
    });

    it('should pass the 2FA nonce through WebAuthn assertion and issue the pending token', async () => {
        const user = new ObjectId();
        const twoFactorNonce = crypto.randomBytes(20).toString('hex');
        const accessToken = crypto.randomBytes(20).toString('hex');
        const challenge = crypto.randomBytes(32).toString('hex');
        const calls = [];

        const route = getWebAuthnRoute(
            {
                webauthnAssertAuthentication: async (authUser, data) => {
                    calls.push(['assert', authUser.toString(), data.twoFactorNonce]);
                    return {
                        authenticated: true,
                        credential: new ObjectId().toString(),
                        pending2fa: {
                            user,
                            key: 'pending2fa:test',
                            data: {
                                user: user.toString(),
                                methods: '["webauthn"]',
                                tokenRequested: 'true'
                            },
                            tokenRequested: true,
                            expires: Date.now() + 5 * 60 * 1000
                        }
                    };
                },
                generateAuthToken: async authUser => {
                    calls.push(['token', authUser.toString()]);
                    return accessToken;
                },
                restorePending2faAuth: async pending2fa => {
                    calls.push(['restore', pending2fa.key]);
                    return true;
                }
            },
            '/users/:user/2fa/webauthn/authentication-assertion',
            'assertWebAuthN'
        );

        const res = getResponse();
        await route.handler(
            {
                method: 'POST',
                url: `/users/${user}/2fa/webauthn/authentication-assertion`,
                route: { spec: route.spec },
                params: {
                    user: user.toString(),
                    challenge,
                    rawId: '00',
                    clientDataJSON: '00',
                    authenticatorData: '00',
                    signature: '00',
                    twoFactorNonce,
                    token: false
                },
                role: 'root',
                validate: assertGranted
            },
            res
        );

        expect(res.statusCode).to.equal(200);
        expect(res.body.token).to.equal(accessToken);
        expect(res.body.response.authenticated).to.be.true;
        expect(res.body.response.pending2fa).to.not.exist;
        expect(calls).to.deep.equal([
            ['assert', user.toString(), twoFactorNonce],
            ['token', user.toString()]
        ]);
    });

    it('should reject a WebAuthn assertion nonce that was not bound to the challenge', async () => {
        const user = new ObjectId();
        const challenge = crypto.randomBytes(32).toString('hex');
        const handler = {
            redis: {
                multi() {
                    return {
                        hgetall() {
                            return this;
                        },
                        del() {
                            return this;
                        },
                        exec: async () => [
                            [
                                null,
                                {
                                    challenge,
                                    user: user.toString(),
                                    origin: 'https://example.com'
                                }
                            ],
                            [null, 1]
                        ]
                    };
                }
            }
        };

        let err;
        try {
            await UserHandler.prototype.webauthnAssertAuthentication.call(handler, user, {
                challenge,
                rawId: '00',
                clientDataJSON: '00',
                authenticatorData: '00',
                signature: '00',
                twoFactorNonce: crypto.randomBytes(20).toString('hex')
            });
        } catch (E) {
            err = E;
        }

        expect(err).to.exist;
        expect(err.code).to.equal('Invalid2faNonce');
    });

    it('should not update WebAuthn counter when pending 2FA nonce consumption fails', async () => {
        const user = new ObjectId();
        const challenge = crypto.randomBytes(32).toString('hex');
        const twoFactorNonce = crypto.randomBytes(20).toString('hex');
        const calls = [];
        const originalAssertionResult = Fido2Lib.prototype.assertionResult;

        Fido2Lib.prototype.assertionResult = async () => {
            calls.push('assertionResult');
            return {
                authnrData: new Map([['counter', 2]])
            };
        };

        const handler = {
            redis: {
                multi() {
                    return {
                        hgetall() {
                            return this;
                        },
                        del() {
                            return this;
                        },
                        exec: async () => [
                            [
                                null,
                                {
                                    challenge,
                                    user: user.toString(),
                                    origin: 'https://example.com',
                                    twoFactorNonce
                                }
                            ],
                            [null, 1]
                        ]
                    };
                }
            },
            users: {
                collection() {
                    return {
                        findOne: async () => ({
                            enabled2fa: ['webauthn'],
                            webauthn: {
                                credentials: [
                                    {
                                        _id: new ObjectId(),
                                        rawId: Buffer.from('00', 'hex'),
                                        publicKey: Buffer.from('public-key'),
                                        counter: 1,
                                        type: 'public-key'
                                    }
                                ]
                            }
                        }),
                        updateOne: async () => {
                            calls.push('updateCounter');
                        }
                    };
                }
            },
            consumePending2faAuth: async () => {
                calls.push('consumePending');
                const err = new Error('Invalid or expired 2FA nonce');
                err.response = 'NO';
                err.responseCode = 403;
                err.code = 'Invalid2faNonce';
                throw err;
            }
        };

        let err;
        try {
            await UserHandler.prototype.webauthnAssertAuthentication.call(handler, user, {
                challenge,
                rawId: '00',
                clientDataJSON: '00',
                authenticatorData: '00',
                signature: '00',
                twoFactorNonce
            });
        } catch (E) {
            err = E;
        } finally {
            Fido2Lib.prototype.assertionResult = originalAssertionResult;
        }

        expect(err).to.exist;
        expect(err.code).to.equal('Invalid2faNonce');
        expect(calls).to.deep.equal(['assertionResult', 'consumePending']);
    });
});
