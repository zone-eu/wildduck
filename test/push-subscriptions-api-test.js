/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');
const { MongoClient, ObjectId } = require('mongodb');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Push subscriptions API', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    let mongoClient;
    let database;
    let userId;
    let inboxId;

    const VALID_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    // aps-account-id is a UUID
    const ACCOUNT_1 = '0715A26B-CA09-4730-A419-793000CA982E';
    const ACCOUNT_OTHER = '1826B37C-DB1A-5841-B52A-8A4111DB093F';

    // there is no API to create a subscription (registration happens over IMAP),
    // so seed the document directly into the collection
    const seedSubscription = overrides => {
        const now = new Date();
        const doc = Object.assign(
            {
                user: new ObjectId(userId),
                deviceToken: VALID_TOKEN,
                accountId: ACCOUNT_1,
                subTopic: 'com.apple.mobilemail',
                mailboxIds: [new ObjectId(inboxId)],
                created: now,
                updated: now
            },
            overrides || {}
        );
        return database
            .collection('pushsubscriptions')
            .insertOne(doc)
            .then(r => r.insertedId);
    };

    before(async () => {
        mongoClient = await MongoClient.connect(config.dbs.mongo, { useNewUrlParser: true, useUnifiedTopology: true });
        database = mongoClient.db();

        const response = await server
            .post('/users')
            .send({
                username: 'pushsubuser',
                password: 'secretpass',
                address: 'pushsubuser@example.com',
                name: 'push sub user'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        userId = response.body.id;

        const mailboxes = await server.get(`/users/${userId}/mailboxes`).expect(200);
        const inbox = mailboxes.body.results.find(result => result.path === 'INBOX');
        expect(inbox).to.exist;
        inboxId = inbox.id;
    });

    after(async () => {
        if (userId) {
            await database.collection('pushsubscriptions').deleteMany({ user: new ObjectId(userId) });
            await server.delete(`/users/${userId}`).expect(200);
        }
        if (mongoClient) {
            await mongoClient.close();
        }
    });

    afterEach(async () => {
        await database.collection('pushsubscriptions').deleteMany({ user: new ObjectId(userId) });
    });

    it('should GET /users/:user/pushsubscriptions expect success with empty list', async () => {
        const response = await server.get(`/users/${userId}/pushsubscriptions`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.results).to.deep.equal([]);
    });

    it('should GET /users/:user/pushsubscriptions expect success and resolve mailbox paths', async () => {
        const subscriptionId = await seedSubscription();

        const response = await server.get(`/users/${userId}/pushsubscriptions`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.results).to.have.length(1);

        const result = response.body.results[0];
        expect(result.id).to.equal(subscriptionId.toString());
        expect(result.deviceToken).to.equal(VALID_TOKEN);
        expect(result.accountId).to.equal(ACCOUNT_1);
        expect(result.subTopic).to.equal('com.apple.mobilemail');
        // mailboxes are resolved from mailboxIds to current paths
        expect(result.mailboxes).to.deep.equal(['INBOX']);
    });

    it('should GET /users/:user/pushsubscriptions expect deleted mailboxes to be omitted', async () => {
        // mailboxId that does not resolve to any existing mailbox
        await seedSubscription({ mailboxIds: [new ObjectId()] });

        const response = await server.get(`/users/${userId}/pushsubscriptions`).expect(200);
        expect(response.body.results).to.have.length(1);
        expect(response.body.results[0].mailboxes).to.deep.equal([]);
    });

    it('should DELETE /users/:user/pushsubscriptions/:subscription expect success', async () => {
        const subscriptionId = await seedSubscription();

        const response = await server.delete(`/users/${userId}/pushsubscriptions/${subscriptionId.toString()}`).expect(200);
        expect(response.body.success).to.be.true;

        const remaining = await database.collection('pushsubscriptions').countDocuments({ user: new ObjectId(userId) });
        expect(remaining).to.equal(0);
    });

    it('should DELETE /users/:user/pushsubscriptions/:subscription expect failure for unknown id', async () => {
        const response = await server.delete(`/users/${userId}/pushsubscriptions/${new ObjectId().toString()}`).expect(404);
        expect(response.body.error).to.exist;
        expect(response.body.code).to.equal('SubscriptionNotFound');
    });

    it('should DELETE /users/:user/pushsubscriptions/:subscription expect failure for another user subscription', async () => {
        // subscription that belongs to a different user must not be deletable through this user
        const otherUser = new ObjectId();
        const r = await database.collection('pushsubscriptions').insertOne({
            user: otherUser,
            deviceToken: VALID_TOKEN,
            accountId: ACCOUNT_OTHER,
            subTopic: 'com.apple.mobilemail',
            mailboxIds: [new ObjectId(inboxId)],
            created: new Date(),
            updated: new Date()
        });

        const response = await server.delete(`/users/${userId}/pushsubscriptions/${r.insertedId.toString()}`).expect(404);
        expect(response.body.code).to.equal('SubscriptionNotFound');

        // the other user's subscription is untouched
        const stillThere = await database.collection('pushsubscriptions').countDocuments({ _id: r.insertedId });
        expect(stillThere).to.equal(1);

        await database.collection('pushsubscriptions').deleteMany({ user: otherUser });
    });

    it('should POST /users/:user/pushsubscriptions/notify expect failure when APS is disabled', async () => {
        // APS is not configured in the test environment, so the endpoint reports the service as disabled
        await seedSubscription();

        const response = await server.post(`/users/${userId}/pushsubscriptions/notify`).send({}).expect(404);
        expect(response.body.error).to.exist;
        expect(response.body.code).to.equal('PushServiceDisabled');
    });
});
