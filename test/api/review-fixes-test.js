/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// Regression tests for the defects found in the post-migration review.
//
// Unlike test/api/regression-parity-test.js these are NOT runnable against a
// master checkout: some of them pin behavior master got wrong too (the custom
// special-use mailbox names), and others pin fastify specific machinery that
// has no restify counterpart (response model serialization).

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const { connect, createRoleToken, deleteRoleToken, binaryParser } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// a well formed id that resolves to nothing: validation runs before the
// handler looks the resource up, so a 404 proves the request passed validation
// while a 400 InputValidationError proves it did not
const MISSING_ID = '0'.repeat(24);

describe('API post-migration review fixes', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    const suffix = crypto.randomBytes(6).toString('hex');
    let user;
    let userToken;
    let rootUserToken;

    before(async () => {
        await connect();

        const response = await server
            .post('/users')
            .send({
                username: `fixes-${suffix}`,
                password: 'fixessecretvalue',
                address: `fixes-${suffix}@example.com`
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        user = response.body.id;

        userToken = await createRoleToken('user', user);
        // the user role may only READ webhooks, so exercising a body param
        // needs a token that can create one while still being bound to a user
        // id for "me" to resolve to
        rootUserToken = await createRoleToken('root', user);
    });

    after(async () => {
        await deleteRoleToken(userToken && userToken.tokenHash);
        await deleteRoleToken(rootUserToken && rootUserToken.tokenHash);

        if (user) {
            await server.delete(`/users/${user}`).expect(200);
            user = false;
        }
    });

    describe('"me" resolves outside path params', () => {
        // the access token hook runs in onRequest, where only path params exist
        // and the body is still unparsed, so the alias has to be applied to the
        // merged params instead

        it('should GET /webhooks expect success / user=me in the query string', async () => {
            const response = await server.get(`/webhooks?user=me&accessToken=${userToken.accessToken}`).expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should POST /webhooks expect success / user=me in the request body', async () => {
            const response = await server
                .post(`/webhooks?accessToken=${rootUserToken.accessToken}`)
                .send({
                    user: 'me',
                    type: ['test.*'],
                    url: 'https://example.com/webhook'
                })
                .expect(200);

            expect(response.body.success).to.be.true;

            const webhookData = await db.database.collection('webhooks').findOne({ _id: new ObjectId(response.body.id) });
            expect(webhookData).to.exist;
            // stored against the token's user id, not the literal string
            expect(webhookData.user.toString()).to.equal(user);

            await server.delete(`/webhooks/${response.body.id}?accessToken=${rootUserToken.accessToken}`).expect(200);
        });
    });

    describe('response models tolerate documents written outside the API', () => {
        // fast-json-stringify THROWS on a missing required key, so a single
        // incomplete document used to take down a whole listing

        it('should GET /users/{user}/filters expect success / filter without a created date', async () => {
            const created = await server
                .post(`/users/${user}/filters`)
                .send({
                    name: 'legacy filter',
                    query: { from: 'sender@example.com' },
                    action: { seen: true }
                })
                .expect(200);

            const filterId = new ObjectId(created.body.id);
            await db.database.collection('filters').updateOne({ _id: filterId }, { $unset: { created: '' } });

            try {
                const response = await server.get(`/users/${user}/filters`).expect(200);
                expect(response.body.success).to.be.true;

                const filterData = response.body.results.find(entry => entry.id === created.body.id);
                expect(filterData).to.exist;
                expect(filterData).to.not.have.property('created');

                // the single filter route serializes through its own model
                const singleResponse = await server.get(`/users/${user}/filters/${created.body.id}`).expect(200);
                expect(singleResponse.body.success).to.be.true;
                expect(singleResponse.body).to.not.have.property('created');
            } finally {
                await server.delete(`/users/${user}/filters/${created.body.id}`).expect(200);
            }
        });

        it('should GET /users/{user}/mailboxes expect success / mailbox without a subscribed flag', async () => {
            const listing = await server.get(`/users/${user}/mailboxes`).expect(200);
            const mailboxId = listing.body.results[0].id;

            await db.database.collection('mailboxes').updateOne({ _id: new ObjectId(mailboxId) }, { $unset: { subscribed: '', modifyIndex: '' } });

            const response = await server.get(`/users/${user}/mailboxes`).expect(200);
            expect(response.body.success).to.be.true;
            // the whole listing survives, not just the intact documents
            expect(response.body.results.length).to.equal(listing.body.results.length);

            const mailboxData = response.body.results.find(entry => entry.id === mailboxId);
            expect(mailboxData).to.exist;
            expect(mailboxData).to.not.have.property('subscribed');

            await db.database.collection('mailboxes').updateOne({ _id: new ObjectId(mailboxId) }, { $set: { subscribed: true, modifyIndex: 0 } });
        });
    });

    describe('Joi conversion semantics preserved', () => {
        it('should PUT /users/{user}/mailboxes/{mailbox}/messages/{message} expect failure / empty expires is ignored', async () => {
            // reaching the missing mailbox proves the empty value was dropped
            // the way Joi .empty('') did, instead of failing the anyOf branch;
            // a regression answers 400 InputValidationError and never gets
            // far enough to look the mailbox up
            const response = await server.put(`/users/${user}/mailboxes/${MISSING_ID}/messages/1`).send({ seen: true, expires: '' });

            expect(response.body.code).to.not.equal('InputValidationError');
            expect(response.body.error).to.match(/Mailbox is missing/);
        });

        it('should POST /users/{user}/mailboxes/{mailbox}/messages expect failure / empty reference attachments is ignored', async () => {
            const response = await server
                .post(`/users/${user}/mailboxes/${MISSING_ID}/messages`)
                .send({
                    reference: { mailbox: MISSING_ID, id: 5, action: 'reply', attachments: '' },
                    subject: 'empty reference attachments',
                    text: 'message body'
                })
                .expect(404);

            expect(response.body.code).to.not.equal('InputValidationError');
        });

        it('should POST /users/{user}/mailboxes/{mailbox}/messages expect failure / null address falls over to an empty string', async () => {
            // Joi email().failover('') turned any invalid value, including
            // null, into '' which the handler then filtered out
            const response = await server
                .post(`/users/${user}/mailboxes/${MISSING_ID}/messages`)
                .send({
                    from: { address: `fixes-${suffix}@example.com` },
                    to: [{ name: 'Bob', address: null }],
                    subject: 'null address',
                    text: 'message body'
                })
                .expect(404);

            expect(response.body.code).to.not.equal('InputValidationError');
        });

        it('should POST /users/{user}/storage expect success / empty content is stored as a zero length file', async () => {
            // Joi.binary() coerced '' into an empty Buffer before .empty('')
            // could match it, so an empty upload was stored, not rejected
            const response = await server
                .post(`/users/${user}/storage`)
                .send({ filename: `empty-${suffix}.txt`, content: '' })
                .expect(200);
            expect(response.body.success).to.be.true;

            const fileResponse = await server.get(`/users/${user}/storage/${response.body.id}`).buffer(true).parse(binaryParser).expect(200);
            expect(fileResponse.body.length).to.equal(0);

            await server.delete(`/users/${user}/storage/${response.body.id}`).expect(200);
        });
    });

    describe('validation contract', () => {
        it('should POST /users/{user}/asps expect failure / empty scope list is rejected', async () => {
            // an ASP with no scopes can never authenticate, so storing one
            // hands the caller a password that silently fails everywhere
            const response = await server.post(`/users/${user}/asps`).send({ description: 'no scopes', scopes: [] }).expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should POST /users/{user}/filters expect failure / invalid target names the expected type', async () => {
            const response = await server
                .post(`/users/${user}/filters`)
                .send({
                    query: { from: 'sender@example.com' },
                    action: { targets: ['not-an-email'] }
                })
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            // the internal keyword vocabulary must not reach API consumers
            expect(response.body.error).to.not.match(/wdAssert/);
            expect(response.body.error).to.match(/must be a valid email/);
        });
    });

    describe('user creation', () => {
        it('should POST /users expect success / custom special-use mailbox names are applied', async () => {
            const response = await server
                .post('/users')
                .send({
                    username: `mailboxnames-${suffix}`,
                    password: 'mailboxnamessecret',
                    address: `mailboxnames-${suffix}@example.com`,
                    mailboxes: { sent: 'Saadetud', trash: 'Prügikast' }
                })
                .expect(200);

            expect(response.body.success).to.be.true;
            const createdUser = response.body.id;

            try {
                const listing = await server.get(`/users/${createdUser}/mailboxes`).expect(200);

                const sent = listing.body.results.find(entry => entry.specialUse === '\\Sent');
                const trash = listing.body.results.find(entry => entry.specialUse === '\\Trash');

                expect(sent).to.exist;
                expect(sent.name).to.equal('Saadetud');
                expect(trash).to.exist;
                expect(trash.name).to.equal('Prügikast');
            } finally {
                await server.delete(`/users/${createdUser}`).expect(200);
            }
        });
    });

    describe('CORS', () => {
        it('should OPTIONS /authenticate expect success / preflight echoes the origin for credentialed requests', async () => {
            const origin = 'https://webmail.example.com';
            const response = await server.options('/authenticate').set('Origin', origin).set('Access-Control-Request-Method', 'POST');

            expect(response.status).to.be.below(300);
            // browsers reject "*" together with credentials, so the concrete
            // origin has to be echoed back
            expect(response.headers['access-control-allow-origin']).to.equal(origin);
            expect(response.headers['access-control-allow-credentials']).to.equal('true');
        });

        it('should OPTIONS /authenticate expect success / preflight allows the headers the old middleware merged in', async () => {
            const response = await server
                .options('/authenticate')
                .set('Origin', 'https://webmail.example.com')
                .set('Access-Control-Request-Method', 'POST')
                .set('Access-Control-Request-Headers', 'x-request-id');

            expect(response.status).to.be.below(300);
            expect(response.headers['access-control-allow-headers'] || '').to.match(/x-request-id/i);
        });
    });
});
