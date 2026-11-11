/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// The submission poller and the lazy refresh (lib/jmap/submission-queue.js) against the local test
// MongoDB, with a stand in for the queue; skipped when MongoDB is not reachable.

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const queue = require('../../../lib/jmap/submission-queue');

describe('JMAP submission queue', function () {
    this.timeout(10000);
    let client;
    let database;
    let deps;
    // queue id -> {count, locked}, what Maildropper#queueState would answer
    let entries;
    let fired;
    const submissions = () => database.collection(queue.COLLECTION);

    before(async function () {
        try {
            client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
            database = client.db(`${config.dbs.dbname}-submission-queue-unit`);
            await database.command({ ping: 1 });
        } catch {
            this.skip();
        }
    });

    after(async () => {
        if (database) {
            await database.dropDatabase();
        }
        if (client) {
            await client.close();
        }
    });

    beforeEach(async () => {
        await submissions().deleteMany({});
        entries = new Map();
        fired = [];
        deps = {
            database,
            redis: { set: async () => 'OK' },
            notifier: { fire: user => fired.push(user.toString()) },
            maildropper: {
                queueState: async ids => new Map(ids.filter(id => entries.has(id)).map(id => [id, entries.get(id)]))
            }
        };
    });

    async function pending(fields = {}) {
        const now = new Date();
        const doc = Object.assign(
            {
                _id: new ObjectId(),
                user: new ObjectId(),
                undoStatus: 'pending',
                queueId: new ObjectId().toHexString(),
                deliveries: 2,
                sendAt: now,
                checkAt: now
            },
            fields
        );
        entries.set(doc.queueId, { count: doc.deliveries, locked: false });
        await submissions().insertOne(doc);
        return doc;
    }

    const read = doc => submissions().findOne({ _id: doc._id });

    it('checks a waiting message again later and later, up to an hour', async () => {
        const doc = await pending();
        const delays = [];
        for (let i = 0; i < 10; i++) {
            // make it due again without waiting
            await submissions().updateOne({ _id: doc._id }, { $set: { checkAt: new Date(Date.now() - 1000) } });
            const started = Date.now();
            expect(await queue.pollOnce(deps, 15)).to.equal(0);
            delays.push(Math.round(((await read(doc)).checkAt.getTime() - started) / 1000));
        }
        expect(delays).to.deep.equal([15, 30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);
        expect((await read(doc)).undoStatus).to.equal('pending');
    });

    it('takes due submissions only, earliest check first, and finalizes the started ones', async () => {
        const notDue = await pending({ checkAt: new Date(Date.now() + 60 * 1000) });
        const locked = await pending();
        const delivered = await pending();
        const partly = await pending();
        entries.set(locked.queueId, { count: 2, locked: true });
        entries.delete(delivered.queueId);
        entries.set(partly.queueId, { count: 1, locked: false });
        expect(await queue.pollOnce(deps, 15)).to.equal(3);
        for (const doc of [locked, delivered, partly]) {
            const after = await read(doc);
            expect(after.undoStatus).to.equal('final');
            expect(after.modSeq).to.be.a('number');
        }
        expect((await read(notDue)).undoStatus).to.equal('pending');
        expect(fired).to.have.members([locked, delivered, partly].map(doc => doc.user.toString()));
    });

    it('skips the poll when another worker holds the lock', async () => {
        await pending();
        deps.redis.set = async () => null;
        entries.clear();
        expect(await queue.pollOnce(deps, 15)).to.equal(0);
    });

    it('refreshes the due submissions of a user on read, not the held ones', async () => {
        const user = new ObjectId();
        const due = await pending({ user });
        const held = await pending({ user, sendAt: new Date(Date.now() + 3600 * 1000) });
        // a message held for later can not have started; if it were looked at, it would turn final
        entries.delete(due.queueId);
        entries.delete(held.queueId);
        expect(await queue.refreshUser(deps, user)).to.be.true;
        expect((await read(due)).undoStatus).to.equal('final');
        expect((await read(held)).undoStatus).to.equal('pending');
    });

    it('restarts the checks when the REST API sets a new delivery time', async () => {
        const doc = await pending({ checkDelay: 960 });
        // the user has used JMAP
        await database.collection('jmapstate').insertOne({ _id: doc.user });
        const sendTime = new Date(Date.now() + 120 * 1000);
        await queue.syncQueueChange(deps, doc.user, doc.queueId, { sendTime });
        const after = await read(doc);
        expect(after.checkAt.getTime()).to.equal(sendTime.getTime());
        expect(after).to.not.have.property('checkDelay');
        expect(after.sendAt.getTime()).to.equal(Math.floor(sendTime.getTime() / 1000) * 1000);
    });
});
