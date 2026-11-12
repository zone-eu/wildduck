/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { anchorIndex, firstCollapsedRoots, ANCHOR_BATCH_SIZE, COLLAPSE_SCAN_LIMIT } = require('../../../lib/jmap/types/email-query');

// a messages collection with `count` results in sort order, where the lookup by root finds `anchor`;
// records the aggregation options and how far the anchor search read
function collection(count, anchor, threadOf = () => undefined) {
    const docs = Array.from({ length: count }, (value, i) => {
        const _id = new ObjectId();
        return { _id, root: _id, thread: threadOf(i) };
    });
    const seen = { options: null, read: 0, closed: false };
    return {
        docs,
        seen,
        find: () => ({
            async *[Symbol.asyncIterator]() {
                yield anchor || docs[Math.floor(count / 2)];
            }
        }),
        aggregate(pipeline, options) {
            seen.options = options;
            seen.pipeline = pipeline;
            return {
                async close() {
                    seen.closed = true;
                },
                async *[Symbol.asyncIterator]() {
                    for (const doc of docs) {
                        seen.read++;
                        yield doc;
                    }
                }
            };
        }
    };
}

describe('Email/query anchor search', () => {
    const user = new ObjectId();
    const context = { account: { user }, cache: { rootsReady: Promise.resolve(true) }, options: {} };

    it('streams the ids in batches and stops at the anchor', async () => {
        const messages = collection(2000);
        const anchor = messages.docs[1000];
        const index = await anchorIndex(context, messages, [{ $match: { user } }], `M${anchor._id}`);
        expect(index).to.equal(1000);
        expect(messages.seen.options.batchSize).to.equal(ANCHOR_BATCH_SIZE);
        expect(ANCHOR_BATCH_SIZE).to.be.within(1, 1000);
        expect(messages.seen.read).to.equal(1001);
        expect(messages.seen.closed).to.be.true;
        expect(messages.seen.pipeline.slice(-2)).to.deep.equal([{ $limit: 100000 }, { $project: { _id: 1, root: 1 } }]);
    });

    it('answers anchorNotFound for an id that is not in the list', async () => {
        // the Email exists but the filter leaves it out
        const outside = new ObjectId();
        const messages = collection(10, { _id: outside, root: outside });
        const err = await anchorIndex(context, messages, [], `M${outside}`).catch(error => error);
        expect(err.type).to.equal('anchorNotFound');
        expect(messages.seen.read).to.equal(10);
        // an Email that does not exist at all is not searched for
        const other = new ObjectId();
        const missing = collection(10, { _id: other, root: other });
        const unknown = await anchorIndex(context, missing, [], `M${new ObjectId()}`).catch(error => error);
        expect(unknown.type).to.equal('anchorNotFound');
        expect(missing.seen.read).to.equal(0);
    });
});

describe('Email/query collapsed pages', () => {
    const threads = Array.from({ length: 10 }, () => new ObjectId());

    it('keeps the first message of every thread in sort order and reads only as far as the page', async () => {
        // three consecutive messages per thread
        const messages = collection(30, null, i => threads[Math.floor(i / 3)]);
        const roots = await firstCollapsedRoots(messages, [{ $match: {} }], 4, 1000);
        expect(roots).to.deep.equal([0, 3, 6, 9].map(i => messages.docs[i]._id.toString()));
        expect(messages.seen.read).to.equal(10);
        expect(messages.seen.closed).to.be.true;
        expect(messages.seen.options).to.include({ batchSize: 500, maxTimeMS: 1000 });
        expect(messages.seen.pipeline.slice(-2)).to.deep.equal([{ $limit: COLLAPSE_SCAN_LIMIT + 1 }, { $project: { _id: 1, root: 1, thread: 1 } }]);
    });

    it('answers every thread of a short list, and nothing for a count of 0', async () => {
        // interleaved threads and messages without a thread, which form one group
        const messages = collection(8, null, i => (i % 4 === 3 ? undefined : threads[i % 2]));
        expect(await firstCollapsedRoots(messages, [], 100, 1000)).to.deep.equal([0, 1, 3].map(i => messages.docs[i]._id.toString()));
        expect(messages.seen.read).to.equal(8);
        expect(await firstCollapsedRoots(collection(5), [], 0, 1000)).to.deep.equal([]);
    });

    it('gives up after the scan limit, for the caller to group in the database', async () => {
        const messages = collection(COLLAPSE_SCAN_LIMIT + 1, null, () => threads[0]);
        expect(await firstCollapsedRoots(messages, [], 2, 1000)).to.be.null;
        expect(messages.seen.closed).to.be.true;
    });
});
