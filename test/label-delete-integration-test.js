/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before, after */
'use strict';

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { run } = require('../lib/tasks/label-delete');
const ImapNotifier = require('../lib/imap-notifier');

describe('Label deletion synchronization in MongoDB', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this
    const user = new ObjectId();
    const label = new ObjectId();
    const remainingLabel = new ObjectId();
    const mailboxes = [new ObjectId(), new ObjectId()];
    const messages = [new ObjectId(), new ObjectId()];
    let client;
    let database;

    before(async () => {
        client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
        database = client.db(config.dbs.dbname);
    });

    beforeEach(async () => {
        await database.collection('mailboxes').insertMany(
            mailboxes.map((_id, index) => ({ _id, user, path: `LabelDeleteTest-${index}`, modifyIndex: 6 }))
        );
        await database.collection('labels').insertMany([
            { _id: label, user, name: 'Projects', slot: 0, deleting: true },
            { _id: remainingLabel, user, name: 'Keep', slot: 1 }
        ]);
        await database.collection('messages').insertMany(
            messages.map((_id, index) => ({
                _id,
                user,
                mailbox: mailboxes[index],
                uid: 1,
                flags: ['\\Seen', 'ordinary'],
                labels: [label, remainingLabel],
                modseq: 6
            }))
        );
        await database.collection('filters').insertOne({ user, action: { labels: [label, remainingLabel] } });
    });

    afterEach(async () => {
        if (database) {
            for (const name of ['journal', 'messages', 'filters', 'labels', 'mailboxes']) {
                await database.collection(name).deleteMany({ user });
            }
        }
    });

    after(async () => {
        if (client) {
            await client.close();
        }
    });

    async function runWithConcurrentWriter(afterAllocation) {
        let injected = false;
        let concurrentModseq;
        const fires = [];
        const wrappedDatabase = {
            collection(name) {
                const collection = database.collection(name);
                if (name !== 'messages') {
                    return collection;
                }
                const writeConcurrently = async mailbox => {
                    const state = await database.collection('mailboxes').findOneAndUpdate(
                        { _id: mailbox, user },
                        { $inc: { modifyIndex: 1 } },
                        { returnDocument: 'after' }
                    );
                    concurrentModseq = state.value.modifyIndex;
                    await collection.updateOne(
                        { mailbox, uid: 1 },
                        { $set: { flags: ['\\Flagged', 'concurrent'], modseq: concurrentModseq } }
                    );
                };
                return {
                    find: (...args) => collection.find(...args),
                    async findOneAndUpdate(query, update, options) {
                        if (!afterAllocation && !injected && query.mailbox.equals(mailboxes[0])) {
                            injected = true;
                            await writeConcurrently(query.mailbox);
                        }
                        return collection.findOneAndUpdate(query, update, options);
                    },
                    updateMany(query, update, callback) {
                        const apply = async () => {
                            if (afterAllocation && !injected && query.mailbox.equals(mailboxes[0])) {
                                injected = true;
                                await writeConcurrently(query.mailbox);
                            }
                            return collection.updateMany(query, update);
                        };
                        apply().then(result => callback(null, result), callback);
                    }
                };
            }
        };

        const notifier = Object.create(ImapNotifier.prototype);
        notifier.database = wrappedDatabase;
        notifier.logger = { debug() {}, error() {} };
        notifier.prepareAccountCounterInvalidations = async () => {};
        notifier.updateCounters = async () => {};
        notifier.updateAccountCounters = async () => {};
        notifier.fire = notifiedUser => fires.push(notifiedUser);

        const result = await run(
            { _id: new ObjectId() },
            { user, label, name: 'Projects' },
            { messageHandler: { notifier }, loggelf() {} },
            wrappedDatabase
        );
        const stored = await database.collection('messages').findOne({ _id: messages[0], mailbox: mailboxes[0], uid: 1 });
        const entries = await database.collection('journal').find({ user, command: 'FETCH' }).toArray();
        expect(result).to.deep.equal({ updated: 2, filters: 1, deleted: 1 });
        expect(entries).to.have.length(2);
        expect(entries.map(entry => entry.mailbox.toString())).to.have.members(mailboxes.map(id => id.toString()));
        expect(entries.every(entry => entry.removedLabels.length === 1 && entry.removedLabels[0] === 'Projects')).to.be.true;
        expect(stored.labels).to.deep.equal([remainingLabel]);
        expect(stored.flags).to.deep.equal(['\\Flagged', 'concurrent']);
        expect(stored.modseq).to.be.at.least(concurrentModseq);
        expect(fires).to.have.length(3);
        expect(await database.collection('labels').countDocuments({ user, _id: label })).to.equal(0);
        expect((await database.collection('filters').findOne({ user })).action.labels).to.deep.equal([remainingLabel]);
        return { stored, concurrentModseq, entry: entries.find(entry => entry.mailbox.equals(mailboxes[0])) };
    }

    it('journals current flags and a sequence beyond a writer that runs before label removal', async () => {
        const { stored, concurrentModseq, entry } = await runWithConcurrentWriter(false);
        expect(stored.modseq).to.be.greaterThan(concurrentModseq);
        expect(entry.modseq).to.equal(stored.modseq);
        expect(entry.flags).to.deep.equal(['\\Flagged', 'concurrent', `$wdlabel$${remainingLabel}`]);
    });

    it('never lowers a message sequence when a writer runs after journal allocation', async () => {
        const { stored, concurrentModseq } = await runWithConcurrentWriter(true);
        expect(stored.modseq).to.equal(concurrentModseq);
    });
});
