/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const crypto = require('crypto');
const ObjectId = require('mongodb').ObjectId;

const expect = chai.expect;
chai.config.includeStack = true;

const UserHandler = require('../../lib/user-handler');

describe('TOTP Nonce Handling', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    it('should stop checkTotp if validateTotpNonce fails', async () => {
        const calls = [];
        const handler = {
            rateLimit: async () => {
                calls.push('rateLimit');
                return { success: true };
            },
            validateTotpNonce: async () => {
                calls.push('validate');
                const err = new Error('Invalid or expired TOTP nonce');
                err.response = 'NO';
                err.responseCode = 403;
                err.code = 'InvalidTotpNonce';
                throw err;
            }
        };

        let err;
        try {
            await UserHandler.prototype.checkTotp.call(handler, new ObjectId(), {
                token: '000000',
                totpNonce: crypto.randomBytes(20).toString('hex'),
                accessTokenHash: crypto.randomBytes(32).toString('hex')
            });
        } catch (E) {
            err = E;
        }

        expect(err).to.exist;
        expect(err.code).to.equal('InvalidTotpNonce');
        expect(calls).to.deep.equal(['rateLimit', 'validate']);
    });

    it('should restore the nonce after a failed TOTP verification', async () => {
        const calls = [];
        const accessTokenHash = crypto.randomBytes(32).toString('hex');
        const seed = 'JBSWY3DPEHPK3PXP';
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
            validateTotpNonce: async () => {
                calls.push('validate');
                return {
                    user: new ObjectId(),
                    key: 'totpnonce:test',
                    accessTokenHash,
                    expires: Date.now() + 5 * 60 * 1000
                };
            },
            restoreTotpNonce: async consumedTotpNonce => {
                calls.push(`restore:${consumedTotpNonce.key}`);
                return true;
            }
        };

        const result = await UserHandler.prototype.checkTotp.call(handler, new ObjectId(), {
            token: '000000',
            totpNonce: crypto.randomBytes(20).toString('hex'),
            accessTokenHash
        });

        expect(result).to.be.false;
        expect(calls[0]).to.equal('validate');
        expect(calls).to.include('restore:totpnonce:test');
    });

    it('should validate and consume a nonce, then restore it with the remaining TTL', async () => {
        const user = new ObjectId();
        const totpNonce = crypto.randomBytes(20).toString('hex');
        const accessTokenHash = crypto.randomBytes(32).toString('hex');
        let restoredArgs;

        const handler = {
            redis: {
                eval: async () => [1, 5 * 60 * 1000],
                set: async (...args) => {
                    restoredArgs = args;
                }
            }
        };

        const consumedTotpNonce = await UserHandler.prototype.validateTotpNonce.call(handler, user, totpNonce, accessTokenHash);
        const restored = await UserHandler.prototype.restoreTotpNonce.call(handler, consumedTotpNonce);

        expect(restored).to.be.true;
        expect(restoredArgs[0]).to.equal(consumedTotpNonce.key);
        expect(restoredArgs[1]).to.equal(accessTokenHash);
        expect(restoredArgs[2]).to.equal('PX');
        expect(restoredArgs[3]).to.be.above(0);
        expect(restoredArgs[3]).to.be.at.most(5 * 60 * 1000);
    });
});
