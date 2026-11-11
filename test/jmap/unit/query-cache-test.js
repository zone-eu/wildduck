/* eslint no-unused-expressions: 0 */
'use strict';

const crypto = require('crypto');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { diff, canonical, queryState, parseQueryState, store, load } = require('../../../lib/jmap/query-cache');

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

/** A Redis stand in with the commands store() and load() use */
function fakeRedis() {
    const data = new Map();
    return {
        data,
        strlen: async key => (data.has(key) ? data.get(key).length : 0),
        expire: async () => 1,
        set: async (key, value) => data.set(key, Buffer.from(value)),
        getBuffer: async key => data.get(key) || null
    };
}

const contextFor = (accountId, redis) => ({
    account: { id: accountId, user: new ObjectId() },
    options: { accessSecret: 'secret', queryCache: { ttl: 60, maxIds: 5 } },
    deps: { redis }
});

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

    describe('store and load', () => {
        it('keeps the longer of two lists of the same state', async () => {
            const redis = fakeRedis();
            const context = contextFor('u1', redis);
            await store(context, 'q1', { ids: [id(1), id(2), id(3)], complete: false });
            await store(context, 'q1', { ids: [id(1)], complete: false });
            expect(await load(context, 'q1')).to.deep.equal({ ids: [id(1), id(2), id(3)], complete: false });
            await store(context, 'q1', { ids: [id(1), id(2), id(3)], complete: true });
            expect(await load(context, 'q1')).to.deep.equal({ ids: [id(1), id(2), id(3)], complete: true });
            await store(context, 'q1', { ids: [], complete: false });
            expect((await load(context, 'q1')).complete).to.be.true;
        });

        it('does not keep a list longer than maxIds', async () => {
            const redis = fakeRedis();
            const context = contextFor('u1', redis);
            await store(context, 'q2', { ids: Array.from({ length: 6 }, (item, i) => id(i)), complete: true });
            expect(await load(context, 'q2')).to.equal(null);
        });
    });
});
