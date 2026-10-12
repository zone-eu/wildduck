'use strict';

// mulberry32: a small seeded generator, so randomized tests can be replayed from their seed
function prng(seed) {
    let state = seed >>> 0; // eslint-disable-line no-bitwise
    let next = () => {
        /* eslint-disable no-bitwise */
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        /* eslint-enable no-bitwise */
    };
    return {
        next,
        int: (min, max) => min + Math.floor(next() * (max - min + 1)),
        chance: p => next() < p,
        pick: list => list[Math.floor(next() * list.length)],
        bytes: length => Buffer.from(Array.from({ length }, () => Math.floor(next() * 256)))
    };
}

module.exports = { prng };
