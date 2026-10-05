/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* globals before: false, after: false */

'use strict';

const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');
const { MongoClient, ObjectId } = require('mongodb');

const db = require('../lib/db');
const onXapplepushserviceFactory = require('../lib/handlers/on-xapplepushservice');

// 64-char hex token
const VALID_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

// aps-account-id is a UUID
const ACCOUNT_1 = '0715A26B-CA09-4730-A419-793000CA982E';
const ACCOUNT_2 = '1826B37C-DB1A-5841-B52A-8A4111DB093F';

describe('on-xapplepushservice handler', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    let mongoClient;
    let database;
    let user;
    let inboxId;
    let notesId;

    // minimal fake imap-core server object
    const buildServer = aps => ({
        logger: {
            debug: () => false,
            info: () => false,
            error: () => false
        },
        loggelf: () => false,
        options: { aps }
    });

    const buildSession = () => ({
        id: 'sess-test',
        user: { id: user }
    });

    // promisified invocation of the callback-style handler
    const invoke = (server, accountID, deviceToken, subTopic, mailboxes) =>
        new Promise((resolve, reject) => {
            const handler = onXapplepushserviceFactory(server);
            handler(accountID, deviceToken, subTopic, mailboxes, buildSession(), (err, topic) => {
                if (err) {
                    return reject(err);
                }
                resolve(topic);
            });
        });

    before(async () => {
        mongoClient = await MongoClient.connect(config.dbs.mongo, { useNewUrlParser: true, useUnifiedTopology: true });
        database = mongoClient.db();
        // share the connection with the handler's db singleton (same module instance)
        db.database = database;
    });

    after(async () => {
        if (user) {
            await database.collection('pushsubscriptions').deleteMany({ user });
            await database.collection('mailboxes').deleteMany({ user });
        }
        if (mongoClient) {
            await mongoClient.close();
        }
    });

    beforeEach(async () => {
        // fresh user + mailboxes per test
        user = new ObjectId();
        await database.collection('pushsubscriptions').deleteMany({ user });
        await database.collection('mailboxes').deleteMany({ user });

        inboxId = new ObjectId();
        notesId = new ObjectId();
        await database.collection('mailboxes').insertMany([
            { _id: inboxId, user, path: 'INBOX' },
            { _id: notesId, user, path: 'Notes' }
        ]);
    });

    it('should resolve mailbox paths to ids and store a new registration', async () => {
        const topic = await invoke(buildServer({ topic: 'com.apple.mail.test' }), ACCOUNT_1, VALID_TOKEN, 'com.apple.mobilemail', ['INBOX', 'Notes']);

        expect(topic).to.equal('com.apple.mail.test');

        const doc = await database.collection('pushsubscriptions').findOne({ user, deviceToken: VALID_TOKEN });
        expect(doc).to.exist;
        expect(doc.accountId).to.equal(ACCOUNT_1);
        expect(doc.subTopic).to.equal('com.apple.mobilemail');
        // only stable mailbox ids are persisted; paths are not stored
        expect(doc.mailboxes).to.be.undefined;

        const storedIds = doc.mailboxIds.map(id => id.toString()).sort();
        expect(storedIds).to.deep.equal([inboxId.toString(), notesId.toString()].sort());

        expect(doc.created).to.be.instanceof(Date);
        expect(doc.updated).to.be.instanceof(Date);
    });

    it('should update an existing registration without creating a duplicate', async () => {
        const server = buildServer({ topic: 'com.apple.mail.test' });

        await invoke(server, ACCOUNT_1, VALID_TOKEN, 'com.apple.mobilemail', ['INBOX', 'Notes']);
        const before = await database.collection('pushsubscriptions').findOne({ user, deviceToken: VALID_TOKEN });

        // second registration for the same device, narrowed to INBOX and a new account id
        const topic = await invoke(server, ACCOUNT_2, VALID_TOKEN, 'com.apple.mobilemail', ['INBOX']);
        expect(topic).to.equal('com.apple.mail.test');

        const docs = await database.collection('pushsubscriptions').find({ user, deviceToken: VALID_TOKEN }).toArray();
        expect(docs).to.have.length(1);

        const after = docs[0];
        expect(after._id.toString()).to.equal(before._id.toString());
        expect(after.accountId).to.equal(ACCOUNT_2);
        expect(after.mailboxes).to.be.undefined;
        expect(after.mailboxIds.map(id => id.toString())).to.deep.equal([inboxId.toString()]);
        // created is preserved, updated moves forward (or stays equal on a fast run)
        expect(after.created.getTime()).to.equal(before.created.getTime());
        expect(after.updated.getTime()).to.be.at.least(before.updated.getTime());
    });

    it('should store an empty mailboxIds set when no paths resolve', async () => {
        const topic = await invoke(buildServer({ topic: 'com.apple.mail.test' }), ACCOUNT_1, VALID_TOKEN, 'com.apple.mobilemail', ['NoSuchMailbox']);

        expect(topic).to.equal('com.apple.mail.test');

        const doc = await database.collection('pushsubscriptions').findOne({ user, deviceToken: VALID_TOKEN });
        expect(doc).to.exist;
        expect(doc.mailboxIds).to.deep.equal([]);
    });

    it('should reject an invalid device token and not write anything', async () => {
        let error;
        try {
            await invoke(buildServer({ topic: 'com.apple.mail.test' }), ACCOUNT_1, 'not-a-valid-token', 'com.apple.mobilemail', ['INBOX']);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.message).to.equal('Invalid device token format');

        const count = await database.collection('pushsubscriptions').countDocuments({ user });
        expect(count).to.equal(0);
    });

    it('should reject an invalid account id and not write anything', async () => {
        let error;
        try {
            await invoke(buildServer({ topic: 'com.apple.mail.test' }), 'not-a-uuid', VALID_TOKEN, 'com.apple.mobilemail', ['INBOX']);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.message).to.equal('Invalid account id format');

        const count = await database.collection('pushsubscriptions').countDocuments({ user });
        expect(count).to.equal(0);
    });

    it('should fail when aps.topic is not configured and not write anything', async () => {
        let error;
        try {
            await invoke(buildServer({}), ACCOUNT_1, VALID_TOKEN, 'com.apple.mobilemail', ['INBOX']);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.message).to.equal('APS topic not configured');

        const count = await database.collection('pushsubscriptions').countDocuments({ user });
        expect(count).to.equal(0);
    });
});
