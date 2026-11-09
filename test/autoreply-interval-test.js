'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const autoreply = require('../lib/autoreply');
const consts = require('../lib/consts');

describe('Autoreply interval', () => {
    async function checkInterval(userData, expected, loadUser = false, suppliedPartial = false) {
        const calls = {};
        const configuredInterval = 4 * 3600 * 1000;
        const user = new ObjectId();
        const redis = {
            multi() {
                return {
                    zremrangebyscore(key, start, end) {
                        calls.cutoff = end;
                        return this;
                    },
                    zadd() {
                        return this;
                    },
                    pexpire(key, duration) {
                        calls.expiry = duration;
                        return this;
                    },
                    expire() {
                        throw new Error('Expected millisecond expiry through pexpire');
                    },
                    exec(callback) {
                        callback(null, [[null, 1], [null, 1], [null, 1]]);
                    }
                };
            }
        };
        const options = {
            sender: 'sender@example.com',
            userData: loadUser ? undefined : suppliedPartial ? {} : userData,
            db: {
                database: {
                    collection() {
                        return { async findOne() { return { value: JSON.stringify(configuredInterval) }; } };
                    }
                },
                users: {
                    collection() {
                        return {
                            async findOne(query) {
                                expect(query._id).to.equal(user);
                                calls.loaded = true;
                                return userData;
                            }
                        };
                    }
                },
                redis
            },
            chunks: [Buffer.from('From: sender@example.com\r\nTo: user@example.com\r\nSubject: Test\r\n\r\nBody')],
            messageHandler: {
                counters: {
                    ttlcounter(key, count, max, window, callback) {
                        calls.dailyCap = max;
                        callback(null, { success: false });
                    }
                }
            }
        };
        const started = Date.now();
        expect(await autoreply(options, { _id: user })).to.equal(false);
        expect(calls.expiry).to.equal(expected);
        expect(calls.cutoff).to.be.at.least(started - expected);
        expect(calls.cutoff).to.be.at.most(Date.now() - expected);
        expect(calls.dailyCap).to.equal(consts.MAX_AUTOREPLIES);
        expect(!!calls.loaded).to.equal(loadUser || suppliedPartial || !Object.hasOwn(userData, 'autoreplyInterval'));
    }

    it('uses the per-user interval without changing the existing expiry and daily cap semantics', async () => {
        await checkInterval({ autoreplyInterval: 60000 }, 60000);
    });

    it('inherits the deployment interval for missing or zero user values', async () => {
        await checkInterval({}, 4 * 3600 * 1000);
        await checkInterval({ autoreplyInterval: 0 }, 4 * 3600 * 1000);
    });

    it('loads the user from the users database when it was not supplied', async () => {
        await checkInterval({ autoreplyInterval: 120000 }, 120000, true);
    });

    it('loads the interval when a library caller supplies partial user data', async () => {
        await checkInterval({ autoreplyInterval: 120000 }, 120000, false, true);
    });
});
