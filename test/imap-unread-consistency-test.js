/* eslint no-invalid-this: 0 */
/* global before, after */
'use strict';

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const db = require('../lib/db');
const MessageHandler = require('../lib/message-handler');
const onStatus = require('../lib/handlers/on-status');
const onSearch = require('../lib/handlers/on-search');
const onFetch = require('../lib/handlers/on-fetch');
const onStore = require('../lib/handlers/on-store');

// Real MongoDB evaluates the STORE pipelines. Only uniquely named collections in
// wildduck-test are used; no application fixtures, Redis or live API are needed.
describe('IMAP unread consistency', function () {
    this.timeout(10000);
    let client;
    let database;
    let databaseSnapshot;
    let messages;
    let mailboxes;
    let labels;
    let server;
    let session;
    let fetchedFlags;
    let mailbox;
    let notifications;
    let beforeBulkWrite;

    const invoke = (handler, ...args) => new Promise((resolve, reject) => handler(...args, (err, result) => (err ? reject(err) : resolve(result))));

    before(async () => {
        client = new MongoClient('mongodb://127.0.0.1:27017/wildduck-test', { serverSelectionTimeoutMS: 3000 });
        await client.connect();
        database = client.db();
        const prefix = `unread-consistency-${new ObjectId()}`;
        messages = database.collection(`${prefix}-messages`);
        mailboxes = database.collection(`${prefix}-mailboxes`);
        labels = database.collection(`${prefix}-labels`);
    });

    after(async () => {
        try {
            for (const collection of [messages, mailboxes, labels]) {
                if (collection) {
                    await collection.drop();
                }
            }
        } finally {
            await client.close();
        }
    });

    beforeEach(async () => {
        databaseSnapshot = db.database;
        const user = new ObjectId();
        mailbox = { _id: new ObjectId(), user, path: 'INBOX', uidNext: 43, uidValidity: 1, modifyIndex: 1, flags: ['\\Seen'] };
        await mailboxes.insertOne(mailbox);
        await messages.insertMany(
            Array.from({ length: 42 }, (_, index) => ({
                _id: new ObjectId(),
                mailbox: mailbox._id,
                user,
                uid: index + 1,
                modseq: 1,
                flags: ['\\Seen'],
                unseen: false,
                labels: []
            }))
        );
        fetchedFlags = [];
        notifications = [];
        beforeBulkWrite = null;
        db.database = {
            collection(name) {
                if (name === 'mailboxes') {
                    return mailboxes;
                }
                if (name === 'labels') {
                    return labels;
                }
                expect(name).to.equal('messages');
                return new Proxy(messages, {
                    get(target, key) {
                        if (key === 'bulkWrite') {
                            return async (...args) => {
                                if (beforeBulkWrite) {
                                    const hook = beforeBulkWrite;
                                    beforeBulkWrite = null;
                                    await hook();
                                }
                                return target.bulkWrite(...args);
                            };
                        }
                        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
                    }
                });
            }
        };
        server = {
            logger: { debug() {}, info() {}, error() {} },
            notifier: {
                fire() {},
                async addEntriesAsync(mailboxData, entries) {
                    notifications.push(...[].concat(entries));
                }
            }
        };
        session = {
            id: 'unread-consistency',
            user: { id: user },
            selected: { uidList: Array.from({ length: 42 }, (_, index) => index + 1), condstoreEnabled: false },
            socket: { readyState: 'open', destroyed: false },
            isUTF8Enabled: () => false,
            getQueryResponse(query, message) {
                fetchedFlags.push({ uid: message.uid, flags: [...message.flags] });
                return [];
            },
            formatResponse: () => ({ tag: '*', command: 'FETCH', attributes: [] }),
            writeStream: {
                write(data, callback) {
                    if (data && typeof data.resume === 'function') {
                        data.once('end', callback);
                        data.resume();
                    } else if (callback) {
                        return callback();
                    }
                }
            }
        };
    });

    afterEach(async () => {
        db.database = databaseSnapshot;
        await Promise.all([messages.deleteMany({}), mailboxes.deleteMany({}), labels.deleteMany({})]);
    });

    async function fetchFlags(markAsSeen = false) {
        const messageHandler = { counters: { asyncTTLCounter: async () => ({ success: true }) } };
        const userCache = { getAsync: async () => 0 };
        await invoke(
            onFetch(server, messageHandler, userCache),
            mailbox._id,
            { messages: session.selected.uidList, metadataOnly: !markAsSeen, flagsExist: true, markAsSeen, query: [] },
            session
        );
    }

    async function inspectUnread() {
        const status = await invoke(onStatus(server), 'INBOX', session);
        const search = await invoke(
            onSearch(server),
            mailbox._id,
            { query: [{ key: 'flag', value: '\\Seen', exists: false }] },
            session
        );
        fetchedFlags = [];
        await fetchFlags();
        return { unseen: status.unseen, unreadUids: search.uidList.sort((a, b) => a - b), flags: fetchedFlags };
    }

    async function store(action, value) {
        await invoke(
            onStore(server),
            mailbox._id,
            { messages: session.selected.uidList, action, value, silent: true, unchangedSince: false },
            session
        );
    }

    async function expectConsistent(seen) {
        const result = await inspectUnread();
        expect(result.unseen).to.equal(seen ? 0 : 42);
        expect(result.unreadUids).to.deep.equal(seen ? [] : session.selected.uidList);
        expect(result.flags).to.have.lengthOf(42);
        expect(result.flags.every(message => message.flags.includes('\\Seen') === seen)).to.equal(true);
        const stored = await messages.find({}).toArray();
        expect(stored.every(message => message.unseen === !message.flags.includes('\\Seen'))).to.equal(true);
    }

    it('agrees across STATUS, SEARCH and FETCH for read messages', async () => {
        await expectConsistent(true);
    });

    it('agrees across STATUS, SEARCH and FETCH for unread messages', async () => {
        await messages.updateMany({}, { $set: { flags: [], unseen: true } });
        await expectConsistent(false);
    });

    it('reproduces the reported 42-message mismatch before repair', async () => {
        await messages.updateMany({}, { $set: { unseen: true } });
        const result = await inspectUnread();
        expect(result.unseen).to.equal(42);
        expect(result.unreadUids).to.deep.equal(session.selected.uidList);
        expect(result.flags).to.have.lengthOf(42);
        expect(result.flags.every(message => message.flags.includes('\\Seen'))).to.equal(true);
    });

    for (const action of ['add', 'set']) {
        it(`repairs stale unseen values with idempotent STORE ${action} Seen`, async () => {
            await messages.updateMany({}, { $set: { unseen: true } });
            await store(action, ['\\Seen']);
            await expectConsistent(true);
            expect(notifications).to.have.lengthOf(42);
            expect(notifications.every(entry => entry.unseenChange)).to.equal(true);
        });
    }

    for (const action of ['remove', 'set']) {
        it(`repairs stale read values with idempotent STORE ${action}`, async () => {
            await messages.updateMany({}, { $set: { flags: [], unseen: false } });
            await store(action, action === 'remove' ? ['\\Seen'] : []);
            await expectConsistent(false);
            expect(notifications).to.have.lengthOf(42);
            expect(notifications.every(entry => entry.unseenChange)).to.equal(true);
        });
    }

    it('preserves a concurrent Seen addition while adding another flag', async () => {
        await messages.updateMany({}, { $set: { flags: [], unseen: true } });
        beforeBulkWrite = () => messages.updateMany({}, { $addToSet: { flags: '\\Seen' }, $set: { unseen: false } });
        await store('add', ['\\Answered']);
        await expectConsistent(true);
        expect(await messages.countDocuments({ flags: '\\Answered' })).to.equal(42);
    });

    it('preserves a concurrent Seen removal while removing another flag', async () => {
        await messages.updateMany({}, { $addToSet: { flags: '\\Answered' } });
        beforeBulkWrite = () => messages.updateMany({}, { $pull: { flags: '\\Seen' }, $set: { unseen: true } });
        await store('remove', ['\\Answered']);
        await expectConsistent(false);
        expect(await messages.countDocuments({ flags: '\\Answered' })).to.equal(0);
    });

    it('repairs stale unseen after a complete non-PEEK FETCH without duplicating Seen', async () => {
        await messages.updateMany({}, { $set: { unseen: true } });
        await fetchFlags(true);
        await expectConsistent(true);
        expect(notifications).to.have.lengthOf(42);
        const stored = await messages.find({}).toArray();
        expect(stored.every(message => message.flags.filter(flag => flag === '\\Seen').length === 1)).to.equal(true);
    });

    it('leaves mismatched records untouched during a read-only FLAGS fetch', async () => {
        await messages.updateMany({}, { $set: { unseen: true } });
        await fetchFlags();
        expect(await messages.countDocuments({ unseen: true })).to.equal(42);
        expect(notifications).to.have.lengthOf(0);
    });

    for (const seen of [true, false]) {
        it(`repairs stale indexed state through API updates with seen=${seen}`, async () => {
            await messages.updateMany({}, { $set: { flags: seen ? ['\\Seen'] : [], unseen: seen } });
            const handler = Object.create(MessageHandler.prototype);
            handler.database = db.database;
            handler.notifier = server.notifier;
            handler.settingsHandler = { get: async () => 100 };
            const count = await handler._updateAsync(mailbox.user, mailbox._id, { $in: session.selected.uidList }, { seen });
            expect(count).to.equal(42);
            await expectConsistent(seen);
            expect(notifications).to.have.lengthOf(42);
            expect(notifications.every(entry => entry.unseenChange)).to.equal(true);
        });
    }

    for (const seen of [true, false]) {
        it(`normalizes moved messages with Seen=${seen} and preserves source counter accounting`, async () => {
            const sourceMessage = await messages.findOne({ uid: 1 });
            const destination = { ...sourceMessage, _id: new ObjectId(), mailbox: new ObjectId(), flags: seen ? ['\\Seen'] : [], unseen: seen };
            const handler = Object.create(MessageHandler.prototype);
            handler.database = db.database;
            const existsEntries = [];
            const removeEntries = [];
            await handler.updateMessage(
                {
                    message: destination,
                    targetData: { _id: destination.mailbox },
                    sourceUid: [],
                    destinationUid: [],
                    mailboxData: mailbox,
                    existsEntries,
                    removeEntries,
                    messageId: sourceMessage._id,
                    messageUid: sourceMessage.uid,
                    unseen: sourceMessage.unseen,
                    flagged: false,
                    labels: [],
                    destinationLabels: [],
                    uidNext: 1,
                    bulk_batch_size: 100
                },
                { close: async () => {} },
                {}
            );
            const stored = await messages.findOne({ _id: destination._id });
            expect(stored.unseen).to.equal(!seen);
            expect(existsEntries[0].unseen).to.equal(!seen);
            expect(removeEntries[0].unseen).to.equal(sourceMessage.unseen);
        });
    }

    for (const seen of [true, false]) {
        it(`normalizes restored messages with Seen=${seen} before insertion`, async () => {
            const handler = Object.create(MessageHandler.prototype);
            handler.database = db.database;
            handler.notifier = server.notifier;
            handler.getMailboxAsync = async () => mailbox;
            const message = { _id: new ObjectId(), mailbox: mailbox._id, user: mailbox.user, flags: seen ? ['\\Seen'] : [], unseen: seen };
            await handler._putAsync(message);
            const stored = await messages.findOne({ _id: message._id });
            expect(stored.unseen).to.equal(!seen);
            expect(notifications[0].unseen).to.equal(!seen);
        });
    }
});
