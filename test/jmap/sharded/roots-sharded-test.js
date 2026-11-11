/* eslint no-unused-expressions: 0 */
/* globals before, after */
'use strict';

// Message roots on a sharded cluster laid out like production: messages sharded by {mailbox, uid},
// with the two mailboxes of the test user on different shards, so a move relocates the document to
// another shard. Run with npm run test:jmap:sharded (starts the cluster with setup.sh).

const { expect } = require('chai');
const { MongoClient, ObjectId, MinKey } = require('mongodb');
const { resolveRoots, repairUserRoots } = require('../../../lib/message-roots');

const URL = process.env.JMAP_SHARDED_MONGO || 'mongodb://127.0.0.1:27117';
const DB_NAME = 'wildduck-sharded';
const NS = `${DB_NAME}.messages`;

describe('message roots on a sharded cluster', function () {
    this.timeout(60000); // eslint-disable-line no-invalid-this

    let client;
    let db;
    let messages;
    const user = new ObjectId();
    // mailbox ids ordered so that the split point sends `second` to its own chunk
    const first = new ObjectId();
    const second = new ObjectId();

    // the shard that holds documents of a mailbox, from the explain of a targeted query
    const shardOf = async mailbox => {
        const explain = await messages.find({ mailbox, uid: 1 }).explain();
        return explain.queryPlanner.winningPlan.shards.map(shard => shard.shardName);
    };

    before(async () => {
        client = await MongoClient.connect(URL, { serverSelectionTimeoutMS: 5000 });
        db = client.db(DB_NAME);
        messages = db.collection('messages');
        await messages.createIndex({ root: 1 }, { name: 'by_root', partialFilterExpression: { root: { $exists: true } } });
        await messages.createIndex({ user: 1, thread: 1 }, { name: 'user_messages_by_thread' });

        const admin = client.db('admin');
        await admin.command({ split: NS, middle: { mailbox: second, uid: new MinKey() } }).catch(() => false);
        const chunkOwner = async mailbox => (await shardOf(mailbox))[0];
        const target = (await chunkOwner(first)) === 'shard1' ? 'shard2' : 'shard1';
        if ((await chunkOwner(second)) !== target) {
            await admin.command({ moveChunk: NS, find: { mailbox: second, uid: 1 }, to: target, _waitForDelete: true });
        }
    });

    after(async () => {
        if (messages) {
            await messages.deleteMany({ user });
        }
        if (client) {
            await client.close();
        }
    });

    it('keeps the mailboxes of the user on different shards', async () => {
        expect(await shardOf(first)).to.not.deep.equal(await shardOf(second));
    });

    it('finds a message by root after a move to another shard, preferring the new document while both exist', async () => {
        const root = new ObjectId();
        const original = { _id: root, root, user, mailbox: first, uid: 1 };
        const moved = { _id: new ObjectId(), root, user, mailbox: second, uid: 1 };
        await messages.insertOne(original);

        // a move inserts first and deletes second, the lookup sees both for a moment
        await messages.insertOne(moved);
        let found = await resolveRoots(messages, user, [root], { legacy: false });
        expect(found.get(root.toString())._id.toString()).to.equal(moved._id.toString());

        await messages.deleteOne({ _id: original._id, mailbox: first, uid: 1 });
        found = await resolveRoots(messages, user, [root], { legacy: false });
        expect(found.get(root.toString()).mailbox.toString()).to.equal(second.toString());
    });

    it('asks every shard through the by_root index', async () => {
        const explain = await messages.find({ user, root: { $in: [new ObjectId()], $exists: true } }).explain();
        const plans = explain.queryPlanner.winningPlan.shards;
        expect(plans).to.have.length(2);
        for (const plan of plans) {
            expect(JSON.stringify(plan.winningPlan)).to.include('"indexName":"by_root"');
        }
    });

    it('separates a shared root across shards and fills missing roots', async () => {
        const root = new ObjectId();
        const legacy = { _id: new ObjectId(), user, mailbox: first, uid: 2 };
        await messages.insertMany([
            { _id: root, root, user, mailbox: first, uid: 3 },
            { _id: new ObjectId(), root, user, mailbox: second, uid: 3 },
            legacy
        ]);

        const result = await repairUserRoots(db, user, { settleMs: 10 });
        expect(result.separated).to.equal(1);
        expect(result.filled).to.equal(1);

        const docs = await messages.find({ user }).toArray();
        const roots = docs.map(doc => doc.root.toString());
        expect(new Set(roots).size).to.equal(docs.length);
        expect(docs.find(doc => doc._id.equals(legacy._id)).root.toString()).to.equal(legacy._id.toString());
    });
});
