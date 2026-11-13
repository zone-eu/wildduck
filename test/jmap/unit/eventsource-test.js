/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { eventSourceLimits, sharedReads } = require('../../../lib/jmap/routes/eventsource');

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

describe('JMAP event source shared state reads', () => {
    // reads that resolve when release() is called, counting the reads made
    function reader() {
        const waiting = [];
        const state = { reads: 0 };
        state.read = arg =>
            new Promise(resolve => {
                const n = ++state.reads;
                waiting.push(() => resolve({ arg, n }));
            });
        state.release = () => waiting.splice(0).forEach(resolve => resolve());
        return state;
    }
    const tick = () => new Promise(resolve => setImmediate(resolve));

    it('lets the streams that heard of a change join one read', async () => {
        const source = reader();
        const states = sharedReads(source.read);
        const heard = process.hrtime.bigint();
        const first = states('u1:Email', heard, 'a');
        const second = states('u1:Email', heard, 'b');
        await tick();
        expect(source.reads).to.equal(1);
        source.release();
        expect(await first).to.deep.equal({ arg: 'a', n: 1 });
        expect(await second).to.equal(await first);
    });

    it('reads again for a change heard after the read started, and per account and types', async () => {
        const source = reader();
        const states = sharedReads(source.read);
        const first = states('u1:Email', process.hrtime.bigint(), 'a');
        await tick();
        // heard while the first read runs: it may not see this change
        const later = states('u1:Email', process.hrtime.bigint(), 'b');
        await tick();
        expect(source.reads).to.equal(2);
        source.release();
        expect((await first).arg).to.equal('a');
        expect((await later).arg).to.equal('b');

        const other = states('u2:Email', 0n, 'c');
        const types = states('u1:Email,Mailbox', 0n, 'd');
        await tick();
        expect(source.reads).to.equal(4);
        source.release();
        expect((await Promise.all([other, types])).map(result => result.arg)).to.deep.equal(['c', 'd']);
    });

    it('forgets a finished read, and passes a failure to every stream that joined', async () => {
        let calls = 0;
        const states = sharedReads(async () => {
            calls++;
            throw new Error('down');
        });
        const heard = process.hrtime.bigint();
        const results = await Promise.all([states('k', heard), states('k', heard)].map(promise => promise.catch(err => err.message)));
        expect(results).to.deep.equal(['down', 'down']);
        expect(calls).to.equal(1);
        await states('k', heard).catch(() => false);
        expect(calls).to.equal(2);
    });
});
