/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const supertest = require('supertest');
const config = require('@zone-eu/wild-config');
const { MAX_KEYWORDS } = require('../../lib/consts');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Keyword limit API errors', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    let client;
    let database;
    let user;
    let inbox;
    let filter;

    before(async () => {
        const response = await server
            .post('/users')
            .send({
                username: `keyword-limit-${Date.now()}`,
                password: 'secretvalue',
                address: `keyword-limit-${Date.now()}@example.com`,
                name: 'Keyword Limit User'
            })
            .expect(200);
        user = response.body.id;

        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxes.body.results.find(mailbox => mailbox.path === 'INBOX').id;

        const filterResponse = await server
            .post(`/users/${user}/filters`)
            .send({ name: 'Existing filter', query: { from: 'sender@example.com' }, action: { seen: true } })
            .expect(200);
        filter = filterResponse.body.id;

        client = await MongoClient.connect(config.dbs.mongo);
        database = client.db(config.dbs.dbname);
        const userId = new ObjectId(user);
        await database
            .collection('keywords')
            .insertMany(Array.from({ length: MAX_KEYWORDS }, (_, slot) => ({ user: userId, slot, path: `limit-${slot}` })));
    });

    after(async () => {
        if (database && user) {
            await database.collection('keywords').deleteMany({ user: new ObjectId(user) });
        }
        if (client) {
            await client.close();
        }
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('returns KeywordLimitExceeded when creating a filter', async () => {
        const response = await server
            .post(`/users/${user}/filters`)
            .send({ name: 'Overflow filter', query: { from: 'overflow@example.com' }, action: { keywords: ['overflow-create'] } })
            .expect(400);

        expect(response.body.code).to.equal('KeywordLimitExceeded');
    });

    it('returns KeywordLimitExceeded when updating a filter', async () => {
        const response = await server
            .put(`/users/${user}/filters/${filter}`)
            .send({ action: { keywords: ['overflow-update'] } })
            .expect(400);

        expect(response.body.code).to.equal('KeywordLimitExceeded');
    });

    it('returns KeywordLimitExceeded when uploading a message', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                from: { name: 'Keyword Tester', address: 'keyword@example.com' },
                subject: 'Keyword limit upload',
                text: 'Keyword limit upload',
                keywords: ['overflow-upload']
            })
            .expect(400);

        expect(response.body.code).to.equal('KeywordLimitExceeded');
    });
});
