/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const crypto = require('crypto');
const ObjectId = require('mongodb').ObjectId;
const { Fido2Lib } = require('fido2-lib');

const expect = chai.expect;
chai.config.includeStack = true;

const UserHandler = require('../../lib/user-handler');

describe('Pending 2FA Nonce Handling', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    it('should restore the pending 2FA nonce after a failed TOTP verification', async () => {
        const calls = [];
        const seed = 'JBSWY3DPEHPK3PXP';
        const user = new ObjectId();
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
            token: '000000',
            totpNonce: crypto.randomBytes(20).toString('hex')
        });

        expect(result).to.be.false;
        expect(calls).to.deep.equal(['consumePending', 'restore:pending2fa:test']);
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
