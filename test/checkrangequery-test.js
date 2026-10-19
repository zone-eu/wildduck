/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { expect } = require('chai');
const { checkRangeQuery } = require('../lib/tools');

// Evaluate the uid-field query object the way MongoDB would, for a single uid
const matches = (query, uid) => {
    if ('$not' in query) {
        return !matches(query.$not, uid);
    }
    let ok = true;
    if ('$eq' in query) {
        ok = ok && uid === query.$eq;
    }
    if ('$ne' in query) {
        ok = ok && uid !== query.$ne;
    }
    if ('$in' in query) {
        ok = ok && query.$in.includes(uid);
    }
    if ('$nin' in query) {
        ok = ok && !query.$nin.includes(uid);
    }
    if ('$gte' in query) {
        ok = ok && uid >= query.$gte;
    }
    if ('$lte' in query) {
        ok = ok && uid <= query.$lte;
    }
    return ok;
};

// Brute-force the set of uids in [1, max] that the generated query matches
const matchedSet = (query, max) => {
    let out = [];
    for (let uid = 1; uid <= max; uid++) {
        if (matches(query, uid)) {
            out.push(uid);
        }
    }
    return out;
};

// Deterministic PRNG (MINSTD) so failures are reproducible (Math.random would not be)
const makeRand = seed => () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
};

describe('checkRangeQuery', () => {
    describe('return shapes', () => {
        it('single uid -> $eq', () => {
            expect(checkRangeQuery([5])).to.deep.equal({ $eq: 5 });
        });

        it('single uid negated -> $ne', () => {
            expect(checkRangeQuery([5], true)).to.deep.equal({ $ne: 5 });
        });

        it('contiguous set -> range', () => {
            expect(checkRangeQuery([3, 4, 5, 6])).to.deep.equal({ $gte: 3, $lte: 6 });
        });

        it('contiguous set negated -> $not range', () => {
            expect(checkRangeQuery([3, 4, 5], true)).to.deep.equal({ $not: { $gte: 3, $lte: 5 } });
        });

        it('dense gappy set -> range with $nin', () => {
            expect(checkRangeQuery([1, 2, 4, 5])).to.deep.equal({ $gte: 1, $lte: 5, $nin: [3] });
        });

        it('sparse set -> $in', () => {
            expect(checkRangeQuery([1, 100, 10000])).to.deep.equal({ $in: [1, 100, 10000] });
        });

        it('negated gappy set -> $nin (no range collapse)', () => {
            expect(checkRangeQuery([1, 2, 4], true)).to.deep.equal({ $nin: [1, 2, 4] });
        });
    });

    describe('isContiguous flag', () => {
        it('trusts the flag and skips gap detection -> range despite gaps', () => {
            expect(checkRangeQuery([1, 2, 4], false, true)).to.deep.equal({ $gte: 1, $lte: 4 });
        });

        it('trusts the flag for a negated match', () => {
            expect(checkRangeQuery([1, 2, 4], true, true)).to.deep.equal({ $not: { $gte: 1, $lte: 4 } });
        });
    });

    describe('dense/sparse threshold (gaps > uids.length bails to $in)', () => {
        it('keeps the range when gaps equal the uid count', () => {
            // [1,4]: 2 uids, gaps [2,3] -> 2 gaps, 2 > 2 is false -> dense
            expect(checkRangeQuery([1, 4])).to.deep.equal({ $gte: 1, $lte: 4, $nin: [2, 3] });
        });

        it('falls back to $in once gaps exceed the uid count', () => {
            // [1,5]: 2 uids, gaps [2,3,4] -> 3 gaps, 3 > 2 -> sparse
            expect(checkRangeQuery([1, 5])).to.deep.equal({ $in: [1, 5] });
        });
    });

    describe('large sets', () => {
        it('collapses a large fully contiguous set into a pure range (no gaps)', () => {
            let uids = [];
            for (let i = 1; i <= 50000; i++) {
                uids.push(i); // no gaps at all
            }
            let query = checkRangeQuery(uids);
            expect(query.$in).to.be.undefined;
            expect(query.$nin).to.be.undefined;
            expect(query).to.deep.equal({ $gte: 1, $lte: 50000 });
        });

        it('collapses a large fully contiguous set when negated', () => {
            let uids = [];
            for (let i = 1; i <= 50000; i++) {
                uids.push(i); // no gaps at all
            }
            expect(checkRangeQuery(uids, true)).to.deep.equal({ $not: { $gte: 1, $lte: 50000 } });
        });

        it('does not enumerate a large dense set into $in', () => {
            let uids = [];
            for (let i = 1; i <= 50000; i++) {
                if (i !== 1234) {
                    uids.push(i); // single gap
                }
            }
            let query = checkRangeQuery(uids);
            expect(query.$in).to.be.undefined;
            expect(query).to.deep.equal({ $gte: 1, $lte: 50000, $nin: [1234] });
        });

        it('bails to $in for a large sparse set', () => {
            let uids = [];
            for (let i = 1; i <= 1000000; i += 3) {
                uids.push(i); // gaps far outnumber the uids
            }
            let query = checkRangeQuery(uids);
            expect(query.$gte).to.be.undefined;
            expect(query.$in).to.deep.equal(uids);
        });
    });

    describe('equivalence with explicit membership (property based)', () => {
        const cases = [
            { label: 'contiguous', count: 20, maxGap: 1 },
            { label: 'dense (small gaps)', count: 40, maxGap: 2 },
            { label: 'medium density', count: 30, maxGap: 4 },
            { label: 'sparse (large gaps)', count: 15, maxGap: 50 }
        ];

        cases.forEach(({ label, count, maxGap }) => {
            [false, true].forEach(ne => {
                it(`matches the same uids as a literal set: ${label}, ne=${ne}`, () => {
                    let rand = makeRand(0x5eed + count + maxGap + (ne ? 1 : 0));
                    for (let iter = 0; iter < 200; iter++) {
                        // build a strictly ascending unique uid list
                        let uids = [];
                        let cur = 1 + Math.floor(rand() * 5);
                        for (let i = 0; i < count; i++) {
                            uids.push(cur);
                            cur += 1 + Math.floor(rand() * maxGap);
                        }

                        let max = uids[uids.length - 1];
                        let expected = ne ? [] : uids.slice();
                        if (ne) {
                            let set = new Set(uids);
                            for (let uid = 1; uid <= max; uid++) {
                                if (!set.has(uid)) {
                                    expected.push(uid);
                                }
                            }
                        }

                        let query = checkRangeQuery(uids, ne);
                        expect(matchedSet(query, max)).to.deep.equal(expected);
                    }
                });
            });
        });
    });
});
