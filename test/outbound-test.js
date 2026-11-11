/* eslint no-unused-expressions: 0 */
'use strict';

// lib/outbound.js with stand ins for the settings, the Redis counter and the queue.

const { expect } = require('chai');
const outbound = require('../lib/outbound');

describe('outbound', () => {
    const user = { _id: 'u1', recipients: 0 };
    const settingsHandler = values => ({ getMulti: async () => Object.assign({ 'const:max:recipients': 100, 'const:max:rcpt_to': 10 }, values) });

    // a ttlcounter stand in: [success, value, ttl], or an error for the increments
    function counters(sent, options = {}) {
        const calls = [];
        return {
            calls,
            asyncTTLCounter: async (key, count, max) => {
                calls.push({ key, count, max });
                if (count && options.failIncrement) {
                    throw new Error('Redis is down');
                }
                return { success: sent < max, value: sent, ttl: 3600 };
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

        it('queues the message and counts its recipients', async () => {
            const queue = maildropper();
            const counter = counters(0);
            const id = await outbound.queueMessage(
                { maildropper: queue, counters: counter },
                { user: 'u1', to: ['a@example.com', 'b@example.com'] },
                Buffer.from('x'),
                50
            );
            expect(id).to.equal(queue.pushed[0].id);
            expect(counter.calls).to.deep.equal([{ key: 'wdr:u1', count: 2, max: 50 }]);
            expect(queue.canceled).to.deep.equal([]);
        });

        it('takes the message out of the queue again when it can not be counted', async () => {
            const queue = maildropper();
            const err = await rejection(
                outbound.queueMessage(
                    { maildropper: queue, counters: counters(0, { failIncrement: true }) },
                    { user: 'u1', to: ['a@example.com'] },
                    Buffer.from('x'),
                    50
                )
            );
            expect(err).to.include({ code: 'InternalDatabaseError', responseCode: 500 });
            expect(queue.canceled).to.deep.equal([queue.pushed[0].id]);
        });

        it('takes the message back without counting it when the onQueued step fails', async () => {
            const queue = maildropper();
            const counter = counters(0);
            const seen = [];
            const onQueued = async id => {
                seen.push(id);
                throw new Error('record not stored');
            };
            const err = await rejection(
                outbound.queueMessage({ maildropper: queue, counters: counter }, { user: 'u1', to: ['a@example.com'] }, Buffer.from('x'), 50, onQueued)
            );
            expect(err.message).to.equal('record not stored');
            expect(seen).to.deep.equal([queue.pushed[0].id]);
            expect(queue.canceled).to.deep.equal([queue.pushed[0].id]);
            expect(counter.calls).to.deep.equal([]);
        });

        it('removes a half stored message when the push fails', async () => {
            const queue = maildropper({ failPush: true });
            const counter = counters(0);
            const err = await rejection(
                outbound.queueMessage({ maildropper: queue, counters: counter }, { user: 'u1', to: ['a@example.com'] }, Buffer.from('x'), 50)
            );
            expect(err.code).to.equal('MessageRejected');
            expect(queue.removed).to.deep.equal([queue.pushed[0].id]);
            expect(counter.calls).to.deep.equal([]);
        });
    });
});
