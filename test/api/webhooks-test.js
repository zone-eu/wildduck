/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

/* globals after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API Webhooks', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    // webhooks are global resources, other test files may create entries as well,
    // so all assertions target entries created by this run only
    const runId = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const webhookType = `test.webhook${runId}`;
    const webhookUrl = `https://example.com/wildduck-webhook-test/${runId}`;

    let webhookId;
    let createdWebhooks = [];

    after(async () => {
        // remove any webhook this run created that a test did not already delete,
        // ignore response status as the entry might be gone already
        for (let id of createdWebhooks) {
            await server.del(`/webhooks/${id}`);
        }
        createdWebhooks = [];
    });

    it('should POST /webhooks expect success', async () => {
        const response = await server
            .post('/webhooks')
            .send({
                type: ['user.created', webhookType],
                url: webhookUrl
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.match(/^[0-9a-f]{24}$/);

        webhookId = response.body.id;
        createdWebhooks.push(webhookId);
    });

    it('should POST /webhooks expect failure / invalid url', async () => {
        const response = await server
            .post('/webhooks')
            .send({
                type: [webhookType],
                url: 'not a valid url'
            })
            .expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /webhooks expect failure / missing type', async () => {
        const response = await server
            .post('/webhooks')
            .send({
                url: webhookUrl
            })
            .expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should GET /webhooks expect success / created webhook is listed', async () => {
        // page through the listing in case other tests have filled the collection
        let entry;
        let next;
        for (let page = 0; page < 20; page++) {
            const response = await server.get(`/webhooks?limit=250${next ? `&next=${encodeURIComponent(next)}` : ''}`).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.results).to.be.an('array');

            entry = response.body.results.find(webhookData => webhookData.id === webhookId);
            if (entry || !response.body.nextCursor) {
                break;
            }
            next = response.body.nextCursor;
        }

        expect(entry).to.exist;
        expect(entry.type).to.deep.equal(['user.created', webhookType]);
        expect(entry.user).to.be.null;
        expect(entry.url).to.equal(webhookUrl);
    });

    it('should GET /webhooks expect success / type filter', async () => {
        const response = await server.get(`/webhooks?type=${encodeURIComponent(webhookType)}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.type).to.equal(webhookType);
        expect(response.body.results.length).to.equal(1);
        expect(response.body.results[0].id).to.equal(webhookId);
        expect(response.body.results[0].url).to.equal(webhookUrl);

        // a type value that no webhook uses must not match anything
        const emptyResponse = await server.get(`/webhooks?type=${encodeURIComponent(`test.none${runId}`)}`).expect(200);

        expect(emptyResponse.body.success).to.be.true;
        expect(emptyResponse.body.results.length).to.equal(0);
    });

    it('should DELETE /webhooks/{webhook} expect failure / malformed id', async () => {
        const response = await server.del(`/webhooks/${123}`).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should DELETE /webhooks/{webhook} expect failure / unknown id', async () => {
        const response = await server.del(`/webhooks/${'0'.repeat(24)}`).expect(404);

        expect(response.body.code).to.equal('WebhookNotFound');
        expect(response.body.error).to.equal('Invalid or unknown webhook identifier');
    });

    it('should DELETE /webhooks/{webhook} expect success', async () => {
        const response = await server.del(`/webhooks/${webhookId}`).expect(200);

        expect(response.body.success).to.be.true;

        // the deleted webhook must not be listed anymore
        const listResponse = await server.get(`/webhooks?type=${encodeURIComponent(webhookType)}`).expect(200);

        expect(listResponse.body.success).to.be.true;
        expect(listResponse.body.results.length).to.equal(0);

        createdWebhooks = createdWebhooks.filter(id => id !== webhookId);
    });
});
