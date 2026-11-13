/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* global before, after */
'use strict';

// lib/outbound.js with stand ins for the settings, the Redis counter and the queue, and the counter
// scripts it uses (lib/lua/ttlreserve.lua next to lib/lua/ttlcounter.lua) against Redis.

const crypto = require('crypto');
const { expect } = require('chai');
const Redis = require('ioredis');
const config = require('@zone-eu/wild-config');
const redisUrl = require('../lib/redis-url');
const counterScripts = require('../lib/counters');
const outbound = require('../lib/outbound');

describe('outbound', () => {
    const user = { _id: 'u1', recipients: 0 };
    const settingsHandler = values => ({ getMulti: async () => Object.assign({ 'const:max:recipients': 100, 'const:max:rcpt_to': 10 }, values) });

    // stand in of lib/counters.js: ttlcounter reads (count 0) and ttlreserve, which counts only what fits
    function counters(sent, options = {}) {
        const calls = [];
        const state = { sent };
        return {
            calls,
            state,
            asyncTTLCounter: async (key, count, max) => {
                calls.push({ key, count, max });
                return { success: state.sent < max, value: state.sent, ttl: 3600 };
            },
            asyncTTLReserve: async (key, count, max) => {
                calls.push({ key, count, max, reserve: true });
                if (options.failReserve) {
                    throw new Error('Redis is down');
                }
                if (count > 0 && state.sent + count > max) {
                    return { success: false, value: state.sent, ttl: 3600 };
                }
                state.sent = Math.max(state.sent + count, 0);
                return { success: true, value: state.sent, ttl: 3600 };
            }
        };
    }

    const rejection = async promise => {
        try {
            await promise;
        } catch (err) {
            return err;
        }
        throw new Error('expected a rejection');
    };

    describe('checkRecipientLimits', () => {
        it('takes the account limit first, then the system setting', async () => {
            const counter = counters(0);
            expect(
                await outbound.checkRecipientLimits({ settingsHandler: settingsHandler(), counters: counter }, { _id: 'u1', recipients: 7 }, 3)
            ).to.deep.equal({
                maxRecipients: 7,
                sent: 0
            });
            expect(await outbound.checkRecipientLimits({ settingsHandler: settingsHandler(), counters: counter }, user, 3)).to.deep.equal({
                maxRecipients: 100,
                sent: 0
            });
            expect(counter.calls.map(call => [call.key, call.count])).to.deep.equal([
                ['wdr:u1', 0],
                ['wdr:u1', 0]
            ]);
        });

        it('refuses too many recipients for one message', async () => {
            const err = await rejection(outbound.checkRecipientLimits({ settingsHandler: settingsHandler(), counters: counters(0) }, user, 11));
            expect(err).to.include({ code: 'TooMany', responseCode: 403, maxRcptTo: 10 });
        });

        it('refuses a message the daily limit can not take', async () => {
            const err = await rejection(outbound.checkRecipientLimits({ settingsHandler: settingsHandler(), counters: counters(95) }, user, 6));
            expect(err).to.include({ code: 'RateLimitedError', responseCode: 403, maxRecipients: 100 });
            expect(err.message).to.match(/^You reached a daily sending limit for your account\. Limit expires in 1 hours$/);
        });
    });

    describe('queueMessage', () => {
        function maildropper(options = {}) {
            const state = { pushed: [], canceled: [], removed: [] };
            state.pushStream = async pushOptions => {
                state.pushed.push(pushOptions);
                if (options.failPush) {
                    throw Object.assign(new Error('rejected'), { code: 'MessageRejected' });
                }
                return { id: pushOptions.id };
            };
            state.cancelQueued = async id => {
                state.canceled.push(id);
                return { success: true };
            };
            state.removeMessageAsync = async id => {
                state.removed.push(id);
                return true;
            };
            return state;
        }

        const queue = (deps, to, onQueued) => outbound.queueMessage(deps, { user: 'u1', to }, Buffer.from('x'), 50, onQueued);

        it('reserves the recipients and queues the message', async () => {
            const drop = maildropper();
            const counter = counters(0);
            const id = await queue({ maildropper: drop, counters: counter }, ['a@example.com', 'b@example.com']);
            expect(id).to.equal(drop.pushed[0].id);
            expect(counter.calls).to.deep.equal([{ key: 'wdr:u1', count: 2, max: 50, reserve: true }]);
            expect(counter.state.sent).to.equal(2);
            expect(drop.canceled).to.deep.equal([]);
        });

        it('refuses a message the reservation can not take, before anything is queued', async () => {
            const drop = maildropper();
            const counter = counters(49);
            const err = await rejection(queue({ maildropper: drop, counters: counter }, ['a@example.com', 'b@example.com']));
            expect(err).to.include({ code: 'RateLimitedError', responseCode: 403, maxRecipients: 50 });
            expect(drop.pushed).to.deep.equal([]);
            expect(counter.state.sent).to.equal(49);
        });

        it('queues nothing when the reservation fails', async () => {
            const drop = maildropper();
            const err = await rejection(queue({ maildropper: drop, counters: counters(0, { failReserve: true }) }, ['a@example.com']));
            expect(err).to.include({ code: 'InternalDatabaseError', responseCode: 500 });
            expect(drop.pushed).to.deep.equal([]);
        });

        it('takes the message back and releases the reservation when the onQueued step fails', async () => {
            const drop = maildropper();
            const counter = counters(0);
            const seen = [];
            const onQueued = async id => {
                seen.push(id);
                throw new Error('record not stored');
            };
            const err = await rejection(queue({ maildropper: drop, counters: counter }, ['a@example.com'], onQueued));
            expect(err.message).to.equal('record not stored');
            expect(seen).to.deep.equal([drop.pushed[0].id]);
            expect(drop.canceled).to.deep.equal([drop.pushed[0].id]);
            expect(counter.state.sent).to.equal(0);
        });

        it('removes a half stored message and releases the reservation when the push fails', async () => {
            const drop = maildropper({ failPush: true });
            const counter = counters(0);
            const err = await rejection(queue({ maildropper: drop, counters: counter }, ['a@example.com']));
            expect(err.code).to.equal('MessageRejected');
            expect(drop.removed).to.deep.equal([drop.pushed[0].id]);
            expect(counter.calls.map(call => call.count)).to.deep.equal([1, -1]);
            expect(counter.state.sent).to.equal(0);
        });
    });

    describe('recipient counter scripts (Redis)', function () {
        let redis;
        let scripts;
        const keys = [];
        const key = () => {
            const name = `wdr:test-${crypto.randomBytes(6).toString('hex')}`;
            keys.push(name);
            return name;
        };

        before(async function () {
            redis = new Redis(
                Object.assign({}, typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis, {
                    lazyConnect: true,
                    maxRetriesPerRequest: 1,
                    retryStrategy: () => null
                })
            );
            try {
                await redis.connect();
            } catch {
                // eslint-disable-next-line no-invalid-this
                this.skip();
            }
            scripts = counterScripts(redis);
        });

        after(async () => {
            if (redis && redis.status === 'ready') {
                if (keys.length) {
                    await redis.del(...keys);
                }
                await redis.quit();
            }
        });

        it('lets exactly one of eight parallel reservations of 400 take the last 400', async () => {
            const name = key();
            await scripts.asyncTTLCounter(name, 1600, 2000, 86400);
            const results = await Promise.all(Array.from({ length: 8 }, () => scripts.asyncTTLReserve(name, 400, 2000, false)));
            expect(results.filter(result => result.success).length).to.equal(1);
            expect(Number(await redis.get(name))).to.equal(2000);
            results.filter(result => !result.success).forEach(result => expect(result.value).to.equal(2000));
        });

        it('counts in the window of ttlcounter, and ttlcounter keeps counting on the same key', async () => {
            const name = key();
            const first = await scripts.asyncTTLReserve(name, 3, 10, 600);
            expect(first).to.include({ success: true, value: 3 });
            expect(first.ttl).to.be.within(599, 600);
            // a reservation that does not fit changes nothing
            expect(await scripts.asyncTTLReserve(name, 8, 10, 600)).to.include({ success: false, value: 3 });
            // the ZoneMTA plugin counts with ttlcounter on the same key: the window stays
            await redis.expire(name, 300);
            expect(await scripts.asyncTTLCounter(name, 2, 10, 600)).to.include({ success: true, value: 5 });
            expect(await redis.ttl(name)).to.be.within(299, 300);
            expect(await scripts.asyncTTLReserve(name, 5, 10, 600)).to.include({ success: true, value: 10 });
            expect(await redis.ttl(name)).to.be.within(299, 300);
            expect(await scripts.asyncTTLCounter(name, 0, 10, 600)).to.include({ success: false, value: 10 });
        });

        it('releases without going below zero, without creating the key and keeping the window', async () => {
            const name = key();
            await scripts.asyncTTLReserve(name, 4, 10, 600);
            await redis.expire(name, 300);
            expect(await scripts.asyncTTLReserve(name, -3, 10, 600)).to.include({ success: true, value: 1 });
            expect(await redis.ttl(name)).to.be.within(299, 300);
            expect(await scripts.asyncTTLReserve(name, -5, 10, 600)).to.include({ success: true, value: 0 });
            expect(await redis.get(name)).to.equal('0');

            const gone = key();
            expect(await scripts.asyncTTLReserve(gone, -5, 10, 600)).to.include({ success: true, value: 0 });
            expect(await redis.exists(gone)).to.equal(0);
        });

        it('counts nothing without a limit', async () => {
            const name = key();
            expect(await scripts.asyncTTLReserve(name, 5, 0, 600)).to.include({ success: true, value: 0 });
            expect(await scripts.asyncTTLReserve(name, -5, 0, 600)).to.include({ success: true, value: 0 });
            expect(await redis.exists(name)).to.equal(0);
        });

        it('starts a new window on a key left without an expiry', async () => {
            const name = key();
            await redis.set(name, '2');
            await scripts.asyncTTLReserve(name, 1, 10, 600);
            expect(await redis.ttl(name)).to.be.within(599, 600);
        });
    });
});
