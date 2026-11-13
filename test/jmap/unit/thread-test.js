/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const thread = require('../../../lib/jmap/types/thread');
const { formatId } = require('../../../lib/jmap/ids');

const threadGet = thread.methods['Thread/get'];

// A database whose messages collection holds `count` messages of one thread, and that records the limit of the read
function fakeDatabase(threadId, count) {
    const reads = [];
    const cursor = docs => ({
        limit(value) {
            reads.push(value);
            return cursor(docs.slice(0, value));
        },
        toArray: async () => docs
    });
    const messages = Array.from({ length: count }, (value, i) => ({ _id: new ObjectId(), thread: threadId, idate: new Date(1000 + i) }));
    return {
        reads,
        collection: name => ({ find: () => cursor(name === 'messages' ? messages : []) })
    };
}

const contextOf = database => ({
    account: { id: 'a1', user: new ObjectId() },
    limits: { maxObjectsInGet: 500 },
    deps: { database },
    cache: {}
});

describe('Thread/get message cap (NV-19)', () => {
    const saved = thread.LIMITS.maxThreadEmails;
    afterEach(() => {
        thread.LIMITS.maxThreadEmails = saved;
    });

    it('reads at most the cap plus one message and answers requestTooLarge above it', async () => {
        thread.LIMITS.maxThreadEmails = 5;
        const threadId = new ObjectId();
        const database = fakeDatabase(threadId, 8);
        let failed = null;
        await threadGet({ accountId: 'a1', ids: [formatId('thread', threadId)] }, contextOf(database)).catch(err => (failed = err));
        expect(database.reads).to.deep.equal([6]);
        expect(failed).to.be.an('error');
        expect(failed.type).to.equal('requestTooLarge');
    });

    it('a thread at the cap is not refused', async () => {
        thread.LIMITS.maxThreadEmails = 5;
        const threadId = new ObjectId();
        const database = fakeDatabase(threadId, 5);
        let failed = null;
        // the fake database has no state to read after the Emails, so the call fails later, but not on the cap
        await threadGet({ accountId: 'a1', ids: [formatId('thread', threadId)] }, contextOf(database)).catch(err => (failed = err));
        expect(database.reads).to.deep.equal([6]);
        expect(failed && failed.type).to.not.equal('requestTooLarge');
    });
});
