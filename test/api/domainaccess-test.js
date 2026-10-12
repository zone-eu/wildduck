/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */

/* globals after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Domainaccess tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    // unique tag per run so listings never see leftovers from earlier runs
    const tag = `domainaccess-tag-${Date.now()}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;

    const allowedDomain = 'allowed-domain.example.com';
    const blockedDomain = 'blocked-domain.example.com';

    let allowedId;
    let blockedId;

    after(async () => {
        // remove any entries still registered for the tag
        for (let action of ['allow', 'block']) {
            const response = await server.get(`/domainaccess/${tag}/${action}`).expect(200);
            for (let entry of response.body.results || []) {
                await server.delete(`/domainaccess/${entry.id}`);
            }
        }
    });

    it('should POST /domainaccess/{tag}/allow expect success', async () => {
        const response = await server.post(`/domainaccess/${tag}/allow`).send({ domain: allowedDomain }).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.match(/^[0-9a-f]{24}$/);

        allowedId = response.body.id;
    });

    it('should POST /domainaccess/{tag}/allow expect failure / empty domain', async () => {
        const response = await server.post(`/domainaccess/${tag}/allow`).send({ domain: '' }).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /domainaccess/{tag}/allow expect failure / missing domain', async () => {
        const response = await server.post(`/domainaccess/${tag}/allow`).send({}).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /domainaccess/{tag}/block expect success', async () => {
        const response = await server.post(`/domainaccess/${tag}/block`).send({ domain: blockedDomain }).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.match(/^[0-9a-f]{24}$/);

        blockedId = response.body.id;
    });

    it('should GET /domainaccess/{tag}/allow expect success', async () => {
        const response = await server.get(`/domainaccess/${tag}/allow`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results).to.be.an('array');
        expect(response.body.results.length).to.be.equal(1);

        const entry = response.body.results[0];
        expect(entry.id).to.be.equal(allowedId);
        expect(entry.domain).to.be.equal(allowedDomain);
        expect(entry.action).to.be.equal('allow');
    });

    it('should GET /domainaccess/{tag}/block expect success', async () => {
        const response = await server.get(`/domainaccess/${tag}/block`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results).to.be.an('array');
        expect(response.body.results.length).to.be.equal(1);

        const entry = response.body.results[0];
        expect(entry.id).to.be.equal(blockedId);
        expect(entry.domain).to.be.equal(blockedDomain);
        expect(entry.action).to.be.equal('block');
    });

    it('should DELETE /domainaccess/{domain} expect success', async () => {
        const response = await server.delete(`/domainaccess/${allowedId}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.deleted).to.be.equal(allowedId);

        // the deleted entry must not show up in the listing anymore
        const listResponse = await server.get(`/domainaccess/${tag}/allow`).expect(200);
        expect(listResponse.body.success).to.be.true;
        expect(listResponse.body.results).to.be.an('array').that.is.empty;
    });

    it('should DELETE /domainaccess/{domain} expect failure / unknown id', async () => {
        const response = await server.delete(`/domainaccess/${'0'.repeat(24)}`).expect(404);

        expect(response.body.code).to.be.equal('DomainNotFound');
        expect(response.body.error).to.be.equal('Domain was not found');
    });

    it('should DELETE /domainaccess/{domain} expect failure / malformed id', async () => {
        const response = await server.delete(`/domainaccess/${'not-a-valid-object-id'}`).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });
});
