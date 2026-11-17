/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Maildropper#cancelQueued and #queueState against the local test MongoDB (the database of
// config/test.toml, in a database of its own); skipped when it is not reachable.

const { expect } = require('chai');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const Maildropper = require('../lib/maildropper');

describe('Maildropper cancelQueued', function () {
    this.timeout(10000);
    let client;
    let senderDb;
    let maildropper;
    let user;
    const queue = () => senderDb.collection('zone-queue');

    before(async function () {
        try {
            client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
            senderDb = client.db(`${config.dbs.dbname}-maildropper-cancel`);
            await senderDb.command({ ping: 1 });
        } catch {
            this.skip();
        }
        maildropper = new Maildropper({ db: { senderDb, database: senderDb }, collection: 'zone-queue', gfs: 'mail' });
    });

    after(async () => {
        if (senderDb) {
            await senderDb.dropDatabase();
        }
        if (client) {
            await client.close();
        }
    });

    beforeEach(() => {
        user = new ObjectId();
    });

    // a stored message with one queue entry per recipient, as Maildropper#push leaves it
    async function queued(recipients, queuedAt = new Date()) {
        const id = new ObjectId().toHexString();
        const upload = new GridFSBucket(senderDb, { bucketName: 'mail' }).openUploadStream(`message ${id}`, {
            metadata: { data: { userId: user.toString(), reason: 'submit' } }
        });
        await new Promise((resolve, reject) => upload.once('finish', resolve).once('error', reject).end('Subject: test\r\n\r\nbody'));
        await queue().insertMany(
            recipients.map((recipient, i) => ({ id, seq: String(i + 1).padStart(3, '0'), recipient, locked: false, lockTime: 0, queued: queuedAt }))
        );
        return id;
    }

    const stored = async id => !!(await senderDb.collection('mail.files').findOne({ filename: `message ${id}` }));

    it('removes every entry and the stored message', async () => {
        const id = await queued(['a@example.com', 'b@example.com']);
        const result = await maildropper.cancelQueued(id, { user, expected: 2 });
        expect(result).to.deep.equal({ success: true, queueId: id, deleted: 2 });
        expect(await queue().countDocuments({ id })).to.equal(0);
        expect(await stored(id)).to.be.false;
    });

    it('removes nothing when the MTA locked one entry', async () => {
        const later = new Date(Date.now() + 3600 * 1000);
        const id = await queued(['a@example.com', 'b@example.com'], later);
        await queue().updateOne({ id, seq: '002' }, { $set: { locked: true, lockTime: Date.now() } });
        const result = await maildropper.cancelQueued(id, { user, expected: 2 });
        expect(result).to.deep.equal({ success: false, code: 'QueueEntryLocked' });
        const entries = await queue().find({ id }).sort({ seq: 1 }).toArray();
        expect(entries).to.have.length(2);
        // the claim was rolled back: delivery times as before, no claim left
        expect(entries.map(entry => entry.queued.getTime())).to.deep.equal([later.getTime(), later.getTime()]);
        expect(entries.some(entry => 'cancelClaim' in entry)).to.be.false;
        expect(await stored(id)).to.be.true;
    });

    it('removes nothing when a recipient got the message already', async () => {
        const id = await queued(['a@example.com', 'b@example.com']);
        await queue().deleteOne({ id, seq: '001' });
        expect(await maildropper.cancelQueued(id, { user, expected: 2 })).to.deep.equal({ success: false, code: 'QueueEntryLocked' });
        expect(await queue().countDocuments({ id })).to.equal(1);
    });

    it('refuses a message of another user', async () => {
        const id = await queued(['a@example.com']);
        expect(await maildropper.cancelQueued(id, { user: new ObjectId(), expected: 1 })).to.deep.equal({ success: false, code: 'NotEnoughPrivileges' });
        expect(await queue().countDocuments({ id })).to.equal(1);
        expect(await maildropper.cancelQueued('nosuchid', { user })).to.deep.equal({ success: false, code: 'NoSuchQueueEntry' });
    });

    it('keeps a message the MTA can not take while a claim holds it', async () => {
        const now = new Date();
        const id = await queued(['a@example.com'], now);
        // a claim left behind by a process that died before its rollback
        const token = new ObjectId();
        const until = new Date(Date.now() + 60 * 1000);
        await queue().updateMany({ id }, { $set: { queued: until, cancelClaim: { token, until, queued: now } } });
        // the MTA takes due entries only, the claimed one is not due
        expect(await queue().countDocuments({ id, locked: false, queued: { $lte: new Date() } })).to.equal(0);
        // a live claim of another canceler is not taken over
        expect(await maildropper.cancelQueued(id, { user, expected: 1 })).to.deep.equal({ success: false, code: 'QueueEntryLocked' });
        const entry = await queue().findOne({ id });
        expect(entry.cancelClaim.token.equals(token)).to.be.true;
        expect(entry.queued.getTime()).to.equal(until.getTime());
    });

    it('takes over an expired claim and restores its original delivery time on a rollback', async () => {
        const original = new Date(Date.now() - 3600 * 1000);
        const id = await queued(['a@example.com', 'b@example.com'], original);
        const expired = new Date(Date.now() - 1000);
        await queue().updateMany({ id }, { $set: { queued: expired, cancelClaim: { token: new ObjectId(), until: expired, queued: original } } });
        // a recipient is gone, so the cancel rolls back to the time before the first claim
        await queue().deleteOne({ id, seq: '002' });
        expect(await maildropper.cancelQueued(id, { user, expected: 2 })).to.deep.equal({ success: false, code: 'QueueEntryLocked' });
        const entry = await queue().findOne({ id });
        expect(entry.queued.getTime()).to.equal(original.getTime());
        expect(entry).to.not.have.property('cancelClaim');
        // and a cancel without an expected count takes the rest
        expect(await maildropper.cancelQueued(id, { user })).to.deep.equal({ success: true, queueId: id, deleted: 1 });
    });

    it('counts entries per message on the server', async () => {
        const a = await queued(['a@example.com', 'b@example.com', 'c@example.com']);
        const b = await queued(['d@example.com']);
        await queue().updateOne({ id: b }, { $set: { locked: true } });
        const state = await maildropper.queueState([a, b, 'missing']);
        expect([...state.entries()]).to.have.deep.members([
            [a, { count: 3, locked: false }],
            [b, { count: 1, locked: true }]
        ]);
        expect((await maildropper.queueState([])).size).to.equal(0);
    });
});
