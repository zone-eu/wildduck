/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { eventSourceLimits } = require('../../../lib/jmap/routes/eventsource');

describe('JMAP event source limits', () => {
    it('applies the defaults', () => {
        expect(eventSourceLimits()).to.include({ minPing: 5, maxPing: 300, maxDuration: 1800, maxStreams: 15 });
        expect(eventSourceLimits({ minPing: 2, maxStreams: 3 })).to.include({ minPing: 2, maxPing: 300, maxStreams: 3 });
    });

    it('refuses ping bounds outside RFC 8620 7.3', () => {
        for (const configured of [{ minPing: 31 }, { maxPing: 299 }, { minPing: 0 }]) {
            expect(() => eventSourceLimits(configured), JSON.stringify(configured)).to.throw(/minPing/);
        }
    });

    it('refuses a stream limit or lifetime below one', () => {
        expect(() => eventSourceLimits({ maxStreams: 0 })).to.throw(/maxStreams/);
        expect(() => eventSourceLimits({ maxDuration: 0 })).to.throw(/maxDuration/);
    });
});
