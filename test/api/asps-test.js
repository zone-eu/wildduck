/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('ASPs tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let asp;

    before(async () => {
        // ensure that we have an existing user account
        const unique = `${Date.now()}${Math.round(Math.random() * 10000)}`;
        const response = await server
            .post('/users')
            .send({
                username: `aspsuser${unique}`,
                password: 'secretvalue',
                address: `aspsuser${unique}@example.com`,
                name: 'asps user'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        user = response.body.id;
    });

    after(async () => {
        if (!user) {
            return;
        }

        const response = await server.delete(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;

        user = false;
    });

    it('should POST /users/{user}/asps expect success', async () => {
        const response = await server
            .post(`/users/${user}/asps`)
            .send({
                description: 'test asp',
                scopes: ['imap']
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
        expect(response.body.password).to.match(/^[a-z]{16}$/);

        asp = response.body.id;
    });

    it('should POST /users/{user}/asps expect failure / missing description', async () => {
        const response = await server
            .post(`/users/${user}/asps`)
            .send({
                scopes: ['imap']
            })
            .expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/asps expect failure / unknown user', async () => {
        const response = await server
            .post(`/users/${'0'.repeat(24)}/asps`)
            .send({
                description: 'test asp',
                scopes: ['imap']
            })
            .expect(404);

        expect(response.body.code).to.be.equal('UserNotFound');
        expect(response.body.error).to.be.equal('This user does not exist');
    });

    it('should GET /users/{user}/asps expect success', async () => {
        const response = await server.get(`/users/${user}/asps`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results).to.be.an('array');
        expect(response.body.results.length).to.be.equal(1);

        const entry = response.body.results[0];
        expect(entry.id).to.be.equal(asp);
        expect(entry.description).to.be.equal('test asp');
        expect(entry.scopes).to.deep.equal(['imap']);
        expect(entry.lastUse).to.be.an('object');
    });

    it('should GET /users/{user}/asps/{asp} expect success', async () => {
        const response = await server.get(`/users/${user}/asps/${asp}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.be.equal(asp);
        expect(response.body.description).to.be.equal('test asp');
        expect(response.body.scopes).to.deep.equal(['imap']);
        expect(response.body.lastUse).to.be.an('object');
    });

    it('should GET /users/{user}/asps/{asp} expect failure / unknown asp', async () => {
        const response = await server.get(`/users/${user}/asps/${'0'.repeat(24)}`).expect(404);

        expect(response.body.code).to.be.equal('AspNotFound');
        expect(response.body.error).to.be.equal('Invalid or unknown ASP key');
    });

    it('should GET /users/{user}/asps/{asp} expect failure / malformed asp id', async () => {
        const response = await server.get(`/users/${user}/asps/${123}`).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should DELETE /users/{user}/asps/{asp} expect success', async () => {
        const response = await server.delete(`/users/${user}/asps/${asp}`).expect(200);

        expect(response.body.success).to.be.true;

        // deleted ASP should not resolve any more
        const checkResponse = await server.get(`/users/${user}/asps/${asp}`).expect(404);
        expect(checkResponse.body.code).to.be.equal('AspNotFound');

        // listing should be empty again
        const listResponse = await server.get(`/users/${user}/asps`).expect(200);
        expect(listResponse.body.success).to.be.true;
        expect(listResponse.body.results.length).to.be.equal(0);
    });

    it('should DELETE /users/{user}/asps/{asp} expect failure / unknown asp', async () => {
        // the same ASP was already deleted in the previous test
        const response = await server.delete(`/users/${user}/asps/${asp}`).expect(404);

        expect(response.body.code).to.be.equal('AspNotFound');
        expect(response.body.error).to.not.be.empty;
    });

    it('should DELETE /users/{user}/asps/{asp} expect failure / malformed asp id', async () => {
        const response = await server.delete(`/users/${user}/asps/${'-'.repeat(24)}`).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });
});
