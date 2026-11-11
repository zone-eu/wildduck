/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */
'use strict';

const crypto = require('crypto');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const Redis = require('ioredis');
const config = require('@zone-eu/wild-config');
const redisUrl = require('../../../lib/redis-url');
const { diff, canonical, queryState, parseQueryState, store, load, checkSettings } = require('../../../lib/jmap/query-cache');

/** Applies changes the way RFC 8620 5.6 tells a client to: removed first, then added by ascending index */
function apply(list, changes) {
    const removed = new Set(changes.removed);
    const result = list.filter(id => !removed.has(id));
    for (const item of [...changes.added].sort((a, b) => a.index - b.index)) {
        result.splice(item.index, 0, item.id);
    }
    return result;
}

// a small deterministic random source, so a failing case can be reproduced
function random(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

const id = n => n.toString(16).padStart(24, '0');

const contextFor = (accountId, redis, queryCache = {}) => ({
    account: { id: accountId, user: new ObjectId() },
    options: { accessSecret: 'secret', queryCache: Object.assign({ ttl: 60, maxIds: 5 }, queryCache) },
    deps: { redis }
});

// a query state of the test, 41 characters like a real one
const stateOf = n => `q${id(n)}${n.toString(16).padStart(16, '0')}`;

describe('JMAP query cache', () => {
    describe('diff', () => {
        it('reports nothing for equal lists', () => {
            expect(diff(['a', 'b'], ['a', 'b'])).to.deep.equal({ removed: [], added: [], length: 2 });
        });

        it('reports a moved id as removed and added at its new index', () => {
            const res = diff(['a', 'b', 'c'], ['c', 'a', 'b']);
            expect(res.removed).to.deep.equal(['c']);
            expect(res.added).to.deep.equal([{ id: 'c', index: 0 }]);
        });

        it('reproduces the new list for random edits (property test)', () => {
            const next = random(42);
            for (let round = 0; round < 500; round++) {
                const pool = Array.from({ length: 30 }, (item, i) => id(i));
                const before = pool.filter(() => next() < 0.6).sort(() => next() - 0.5);
                const after = pool.filter(() => next() < 0.6).sort(() => next() - 0.5);
                const res = diff(before, after);
                expect(apply(before, res), `round ${round}`).to.deep.equal(after);
                for (const removed of res.removed) {
                    expect(before).to.include(removed);
                }
                const indexes = res.added.map(item => item.index);
                expect([...indexes].sort((a, b) => a - b)).to.deep.equal(indexes);
            }
        });

        it('keeps the longest run of ids in their old order', () => {
            const res = diff(['a', 'b', 'c', 'd', 'e'], ['b', 'c', 'd', 'e', 'a']);
            expect(res.removed).to.deep.equal(['a']);
            expect(res.added).to.deep.equal([{ id: 'a', index: 4 }]);
        });

        it('ends a partial list at the last id the client keeps', () => {
            // the client held [a, b, c]; n1 and n2 are new, d and e were never sent to it
            const res = diff(['a', 'b', 'c'], ['n1', 'a', 'n2', 'b', 'c', 'd', 'e'], { partial: true });
            expect(res.removed).to.deep.equal([]);
            expect(res.added).to.deep.equal([
                { id: 'n1', index: 0 },
                { id: 'n2', index: 2 }
            ]);
            expect(res.length).to.equal(5);
            expect(apply(['a', 'b', 'c'], res)).to.deep.equal(['n1', 'a', 'n2', 'b', 'c']);
        });

        it('leaves out changes after upToId', () => {
            const before = ['e10', 'e9', 'e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e2', 'e1'];
            const after = ['e11', 'e10', 'e9', 'e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e1'];
            const res = diff(before, after, { upToId: 'e8' });
            expect(res.removed).to.deep.equal([]);
            expect(res.added).to.deep.equal([{ id: 'e11', index: 0 }]);
            expect(apply(before.slice(0, 3), res)).to.deep.equal(after.slice(0, 4));
            // an upToId that is not in the list is ignored
            expect(diff(before, after, { upToId: 'nope' }).removed).to.deep.equal(['e2']);
        });
    });

    describe('query states', () => {
        const context = contextFor('u1', null);
        const anchor = new ObjectId();

        it('does not depend on the key order of the arguments', () => {
            expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).to.equal(canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
            const state = queryState(context, 'Email/query', anchor, { filter: { inMailbox: 'F1', after: 'x' }, sort: null });
            expect(parseQueryState(context, 'Email/query', state, { sort: null, filter: { after: 'x', inMailbox: 'F1' } }).equals(anchor)).to.be.true;
        });

        it('rejects a state of another query, method or account', () => {
            const definition = { filter: null };
            const state = queryState(context, 'Email/query', anchor, definition);
            expect(() => parseQueryState(context, 'Email/query', state, { filter: {} }))
                .to.throw()
                .with.property('type', 'cannotCalculateChanges');
            expect(() => parseQueryState(context, 'Mailbox/query', state, definition))
                .to.throw()
                .with.property('type', 'cannotCalculateChanges');
            expect(() => parseQueryState(contextFor('u2', null), 'Email/query', state, definition))
                .to.throw()
                .with.property('type', 'cannotCalculateChanges');
            expect(() => parseQueryState(context, 'Email/query', `q${crypto.randomBytes(20).toString('hex')}`, definition))
                .to.throw()
                .with.property('type', 'cannotCalculateChanges');
        });
    });

    describe('settings', () => {
        it('refuses a byte budget below one full list and a memory limit above maxIds', () => {
            expect(() => checkSettings({ queryCache: { maxIds: 10000, maxBytes: 1000 } })).to.throw(/maxBytes/);
            expect(() => checkSettings({ queryCache: { maxIds: 100 }, query: { memoryLimit: 101 } })).to.throw(/memoryLimit/);
            expect(() => checkSettings({ queryCache: { maxIds: 100 }, query: { memoryLimit: 100 } })).to.not.throw();
            expect(() => checkSettings({})).to.not.throw();
        });
    });

    describe('store and load (Redis)', function () {
        let redis;
        const users = [];

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
        });

        after(async () => {
            if (redis && redis.status === 'ready') {
                for (const user of users) {
                    await redis.del(`jmap:qc:${user}`, `jmap:qco:${user}`);
                }
                await redis.quit();
            }
        });

        const fresh = (queryCache = {}) => {
            const context = contextFor('u1', redis, queryCache);
            users.push(context.account.user.toString());
            return context;
        };

        it('keeps the longer of two lists of the same state', async () => {
            const context = fresh();
            await store(context, stateOf(1), { ids: [id(1), id(2), id(3)], complete: false });
            await store(context, stateOf(1), { ids: [id(1)], complete: false });
            expect(await load(context, stateOf(1))).to.deep.equal({ ids: [id(1), id(2), id(3)], complete: false });
            await store(context, stateOf(1), { ids: [id(1), id(2), id(3)], complete: true });
            expect(await load(context, stateOf(1))).to.deep.equal({ ids: [id(1), id(2), id(3)], complete: true });
            await store(context, stateOf(1), { ids: [], complete: false });
            expect((await load(context, stateOf(1))).complete).to.be.true;
            expect(await load(context, stateOf(2))).to.equal(null);
        });

        it('does not keep a list longer than maxIds', async () => {
            const context = fresh();
            await store(context, stateOf(2), { ids: Array.from({ length: 6 }, (item, i) => id(i)), complete: true });
            expect(await load(context, stateOf(2))).to.equal(null);
        });

        it('drops the oldest states of a user past the byte budget', async () => {
            // a list of 5 ids takes 1 + 60 + 41 bytes, three of them fit in 320
            const context = fresh({ maxBytes: 320 });
            const list = n => ({ ids: Array.from({ length: 5 }, (item, i) => id(n * 10 + i)), complete: true });
            for (let n = 1; n <= 5; n++) {
                await store(context, stateOf(n), list(n));
            }
            for (let n = 1; n <= 5; n++) {
                expect(await load(context, stateOf(n)), `state ${n}`).to.deep.equal(n <= 2 ? null : list(n));
            }
            const user = context.account.user.toString();
            expect(Number(await redis.hget(`jmap:qc:${user}`, '#'))).to.equal(3 * 102);
            expect(await redis.zcard(`jmap:qco:${user}`)).to.equal(3);
            expect(await redis.ttl(`jmap:qc:${user}`)).to.be.within(1, 60);
        });

        it('drops the oldest states of a user past the entry budget', async () => {
            const context = fresh({ maxEntries: 2 });
            for (let n = 1; n <= 4; n++) {
                await store(context, stateOf(n), { ids: [id(n)], complete: true });
            }
            expect(await load(context, stateOf(2))).to.equal(null);
            expect(await load(context, stateOf(3))).to.deep.equal({ ids: [id(3)], complete: true });
            expect(await load(context, stateOf(4))).to.deep.equal({ ids: [id(4)], complete: true });
        });

        it('keeps the lists of other users apart', async () => {
            const first = fresh({ maxEntries: 1 });
            const second = fresh({ maxEntries: 1 });
            await store(first, stateOf(7), { ids: [id(7)], complete: true });
            await store(second, stateOf(8), { ids: [id(8)], complete: true });
            expect(await load(first, stateOf(7))).to.deep.equal({ ids: [id(7)], complete: true });
            expect(await load(second, stateOf(7))).to.equal(null);
        });
    });
});
