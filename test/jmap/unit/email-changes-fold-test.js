/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { emailFold } = require('../../../lib/jmap/types/email-changes');
const { threadFold } = require('../../../lib/jmap/types/thread');
const { foldEntries, maxChangesOf, windowEntriesOf, windowLimit, entriesSince } = require('../../../lib/jmap/state');

// a synthetic journal cursor: an async iterable with close(), the server limits and the safety window
function cursor(entries, limits, window = []) {
    const list = entries.map(entry => Object.assign({ _id: new ObjectId() }, entry));
    return {
        limits,
        window: window.map(entry => Object.assign({ _id: new ObjectId() }, entry)),
        closed: false,
        async close() {
            this.closed = true;
        },
        async *[Symbol.asyncIterator]() {
            yield* list;
        }
    };
}

async function fold(entries, maxChanges = Infinity, limits, window) {
    const entriesCursor = cursor(entries, limits, window);
    const { changes, more, last } = await foldEntries(entriesCursor, emailFold, maxChanges);
    const result = {};
    for (const [id, kind] of changes) {
        if (kind !== 'dropped') {
            result[id] = kind;
        }
    }
    return { result, more, last, cursor: entriesCursor };
}

describe('Email/changes journal folding', () => {
    const root = new ObjectId();
    const id = `M${root}`;
    const e = (command, extra = {}) => Object.assign({ command, root, message: root }, extra);

    it('reads a move as one update, whether or not the EXPUNGE names its origin', async () => {
        expect((await fold([e('EXPUNGE', { origin: 'move' }), e('EXISTS', { origin: 'move' })])).result).to.deep.equal({ [id]: 'updated' });
        expect((await fold([e('EXPUNGE'), e('EXISTS', { origin: 'move' })])).result).to.deep.equal({ [id]: 'updated' });
        // the first half alone, as on a page boundary, is an update too
        expect((await fold([e('EXPUNGE', { origin: 'move' })])).result).to.deep.equal({ [id]: 'updated' });
    });

    it('leaves out an Email created and destroyed in the window, however it went', async () => {
        expect((await fold([e('EXISTS'), e('EXPUNGE')])).result).to.deep.equal({});
        expect((await fold([e('EXISTS'), e('FETCH', { flags: ['\\Deleted'] }), e('EXPUNGE')])).result).to.deep.equal({});
        expect((await fold([e('EXISTS', { deleted: true })])).result).to.deep.equal({});
    });

    it('follows the \\Deleted flag', async () => {
        expect((await fold([e('FETCH', { flags: ['\\Deleted'] })])).result).to.deep.equal({ [id]: 'destroyed' });
        expect((await fold([e('FETCH', { flags: [], deletedChangedTo: false })])).result).to.deep.equal({ [id]: 'created' });
        expect((await fold([e('FETCH', { flags: ['\\Deleted'] }), e('FETCH', { flags: [], deletedChangedTo: false })])).result).to.deep.equal({
            [id]: 'updated'
        });
        // a message carrying \Deleted that is moved stays gone
        expect((await fold([e('EXPUNGE', { origin: 'move', deleted: true }), e('EXISTS', { origin: 'move', deleted: true })])).result).to.deep.equal({
            [id]: 'destroyed'
        });
    });

    it('keeps created through later updates and moves', async () => {
        expect(
            (await fold([e('EXISTS'), e('FETCH', { flags: ['\\Seen'] }), e('EXPUNGE', { origin: 'move' }), e('EXISTS', { origin: 'move' })])).result
        ).to.deep.equal({
            [id]: 'created'
        });
    });

    it('stops at the scan limit with an intermediate state', async () => {
        const entries = Array.from({ length: 10 }, () => e('FETCH', { flags: [] }));
        expect((await fold(entries, Infinity, { changes: 100, scan: 4 })).more).to.be.true;
        expect((await fold(entries, Infinity, { changes: 100, scan: 10 })).more).to.be.false;
        // the cursor holds one entry more than the scan limit when there are more
        const { more, result } = await fold(entries.slice(0, 5), Infinity, { changes: 100, scan: 4 });
        expect(more).to.be.true;
        expect(Object.keys(result)).to.have.lengthOf(1);
    });

    it('caps maxChanges with the server limit', async () => {
        const entries = Array.from({ length: 5 }, () => e('EXISTS', { root: new ObjectId() }));
        const { result, more } = await fold(entries, Infinity, { changes: 2, scan: 100 });
        expect(Object.keys(result)).to.have.lengthOf(2);
        expect(more).to.be.true;
    });

    it('reports an Email first seen in the safety window as updated, and a destroy after the state', async () => {
        // the window holds changes at or before the state, which the client may have seen already
        expect((await fold([], Infinity, undefined, [e('EXISTS')])).result).to.deep.equal({ [id]: 'updated' });
        expect((await fold([e('EXPUNGE')], Infinity, undefined, [e('EXISTS')])).result).to.deep.equal({ [id]: 'destroyed' });
        expect((await fold([e('FETCH', { flags: ['\\Deleted'] })], Infinity, undefined, [e('EXISTS')])).result).to.deep.equal({ [id]: 'destroyed' });
        // without the window the same Email is new
        expect((await fold([e('EXISTS'), e('EXPUNGE')])).result).to.deep.equal({});
    });

    it('advances past the state when the safety window holds more Emails than maxChanges', async () => {
        const window = Array.from({ length: 10 }, () => e('FETCH', { flags: ['\\Seen'], root: new ObjectId() }));
        const after = Array.from({ length: 6 }, () => e('FETCH', { flags: ['\\Seen'], root: new ObjectId() }));
        const { result, more, last, cursor: entries } = await fold(after, 5, undefined, window);
        // the two most recent window ids (half of maxChanges) and the first changes after the state
        expect(Object.keys(result)).to.deep.equal([window[8], window[9], after[0], after[1], after[2]].map(entry => `M${entry.root}`));
        expect(more).to.be.true;
        const read = [];
        for await (const entry of entries) {
            read.push(entry._id.toString());
        }
        expect(last.toString()).to.equal(read[2]);

        // maxChanges 1 leaves no room for the window
        const single = await fold(after, 1, undefined, window);
        expect(Object.keys(single.result)).to.deep.equal([`M${after[0].root}`]);
        // the server limit caps the window too
        const capped = await fold(after, Infinity, { changes: 4, scan: 100 }, window);
        expect(Object.keys(capped.result)).to.deep.equal([window[8], window[9], after[0], after[1]].map(entry => `M${entry.root}`));
        expect(windowLimit(500)).to.equal(250);
        expect(windowLimit(3)).to.equal(1);
    });

    it('keeps the window entries of the most recently changed ids', () => {
        const keysOf = entry => entry.keys;
        const window = [{ keys: ['a'] }, { keys: ['b', 'c'] }, { keys: ['a'] }, { keys: [] }, { keys: ['d'] }];
        expect(windowEntriesOf(window, keysOf, 2).map(entry => entry.keys.join())).to.deep.equal(['a', 'a', '', 'd']);
        // an entry whose ids do not all fit ends the selection
        expect(windowEntriesOf(window, keysOf, 3).map(entry => entry.keys.join())).to.deep.equal(['a', 'a', '', 'd']);
        expect(windowEntriesOf(window, keysOf, 4).map(entry => entry.keys.join())).to.deep.equal(['a', 'b,c', 'a', '', 'd']);
        expect(windowEntriesOf(window, keysOf, 0).map(entry => entry.keys.join())).to.deep.equal(['']);
        expect(windowEntriesOf([], keysOf, 5)).to.deep.equal([]);
    });

    it('counts a thread touched in the safety window as visible at the state', () => {
        const thread = new ObjectId();
        const entry = { command: 'EXISTS', thread, root: new ObjectId() };
        const fresh = new Map();
        threadFold.fold(fresh, entry);
        expect(fresh.get(thread.toString())).to.include({ visibleBefore: false, changed: true });
        const known = new Map();
        threadFold.fold(known, entry, true);
        expect(known.get(thread.toString())).to.include({ visibleBefore: true, changed: true });
    });

    it('reads the safety window apart from the entries after the state, both bounded', async () => {
        const user = new ObjectId();
        const since = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 10);
        const anchor = new ObjectId();
        const finds = [];
        const journal = {
            find(filter) {
                const call = { filter, chain: {} };
                finds.push(call);
                const chain = {
                    // newest first, as the window query asks
                    toArray: async () => [{ _id: since }, { _id: ObjectId.createFromTime(since.getTimestamp().getTime() / 1000 - 1) }]
                };
                for (const name of ['sort', 'limit', 'batchSize', 'maxTimeMS']) {
                    chain[name] = value => {
                        call.chain[name] = value;
                        return chain;
                    };
                }
                return chain;
            }
        };
        const context = {
            account: { user, id: user.toString() },
            options: { accessSecret: 'unit', changes: { safetyWindow: 2000, maxChanges: 300, scanLimit: 700 } },
            deps: { database: { collection: () => journal } },
            cache: { anchors: Promise.resolve({ journal: anchor, delivery: anchor, retention: 24 * 3600 * 1000 }) }
        };
        const cursor = await entriesSince(context, since, { message: { $exists: true } });
        expect(cursor.limits).to.deep.equal({ changes: 300, scan: 700 });
        // the window, oldest first
        expect(cursor.window.map(entry => entry._id.toString())).to.deep.equal([
            ObjectId.createFromTime(since.getTimestamp().getTime() / 1000 - 1).toString(),
            since.toString()
        ]);
        const [windowRead, afterRead] = finds;
        expect(windowRead.filter).to.deep.include({ user, message: { $exists: true } });
        expect(windowRead.filter._id.$lte.toString()).to.equal(since.toString());
        expect(windowRead.filter._id.$gt.getTimestamp().getTime()).to.equal(since.getTimestamp().getTime() - 2000);
        expect(windowRead.chain).to.deep.include({ sort: { _id: -1 }, limit: 300 });
        expect(afterRead.filter._id.$gt.toString()).to.equal(since.toString());
        expect(afterRead.filter._id.$lte.toString()).to.equal(anchor.toString());
        expect(afterRead.chain).to.deep.include({ sort: { _id: 1 }, limit: 701, batchSize: 1000 });

        // without a safety window there is nothing to read again
        finds.length = 0;
        context.options.changes.safetyWindow = 0;
        expect((await entriesSince(context, since)).window).to.deep.equal([]);
        expect(finds).to.have.lengthOf(1);

        // the window defaults to two seconds when it is not configured
        finds.length = 0;
        delete context.options.changes.safetyWindow;
        await entriesSince(context, since);
        expect(finds[0].filter._id.$gt.getTimestamp().getTime()).to.equal(since.getTimestamp().getTime() - 2000);

        // the current state has no changes yet; a state newer than the current one is not a state of this account
        finds.length = 0;
        context.options.changes.safetyWindow = 0;
        await entriesSince(context, anchor);
        expect(finds[0].filter._id.$gt.toString()).to.equal(anchor.toString());
        const newer = new ObjectId(anchor.toHexString().slice(0, 8) + 'ffffffffffffffff');
        const err = await entriesSince(context, newer).catch(error => error);
        expect(err.type).to.equal('cannotCalculateChanges');
    });

    it('accepts only safe positive integers as maxChanges', () => {
        expect(maxChangesOf({ maxChanges: Number.MAX_SAFE_INTEGER })).to.equal(Number.MAX_SAFE_INTEGER);
        expect(maxChangesOf({ maxChanges: null })).to.equal(Infinity);
        for (const maxChanges of [0, -1, 1.5, '5', true, 2 ** 53]) {
            expect(() => maxChangesOf({ maxChanges }), String(maxChanges)).to.throw();
        }
    });
});
