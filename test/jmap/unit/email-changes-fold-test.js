/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { emailFold } = require('../../../lib/jmap/types/email-changes');
const { foldEntries, maxChangesOf } = require('../../../lib/jmap/state');

// a synthetic journal cursor: an async iterable with close() and the server limits
function cursor(entries, limits) {
    const list = entries.map(entry => Object.assign({ _id: new ObjectId() }, entry));
    return {
        limits,
        closed: false,
        async close() {
            this.closed = true;
        },
        async *[Symbol.asyncIterator]() {
            yield* list;
        }
    };
}

async function fold(entries, maxChanges = Infinity, limits) {
    const { changes, more } = await foldEntries(cursor(entries, limits), emailFold, maxChanges);
    const result = {};
    for (const [id, kind] of changes) {
        if (kind !== 'dropped') {
            result[id] = kind;
        }
    }
    return { result, more };
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
        expect((await fold([e('FETCH', { flags: ['\\Deleted'] }), e('FETCH', { flags: [], deletedChangedTo: false })])).result).to.deep.equal({ [id]: 'updated' });
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
    });

    it('caps maxChanges with the server limit', async () => {
        const entries = Array.from({ length: 5 }, () => e('EXISTS', { root: new ObjectId() }));
        const { result, more } = await fold(entries, Infinity, { changes: 2, scan: 100 });
        expect(Object.keys(result)).to.have.lengthOf(2);
        expect(more).to.be.true;
    });

    it('accepts only safe positive integers as maxChanges', () => {
        expect(maxChangesOf({ maxChanges: Number.MAX_SAFE_INTEGER })).to.equal(Number.MAX_SAFE_INTEGER);
        expect(maxChangesOf({ maxChanges: null })).to.equal(Infinity);
        for (const maxChanges of [0, -1, 1.5, '5', true, 2 ** 53]) {
            expect(() => maxChangesOf({ maxChanges }), String(maxChanges)).to.throw();
        }
    });
});
