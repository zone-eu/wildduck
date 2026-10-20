/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Autoreply and Authlog tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let username;
    let password = 'secretvalue';
    let authlogEvent;

    before(async () => {
        // ensure that we have an existing user account
        const unique = `${Date.now()}${Math.round(Math.random() * 10000)}`;
        username = `autoreplyuser${unique}`;

        const response = await server
            .post('/users')
            .send({
                username,
                password,
                address: `${username}@example.com`,
                name: 'autoreply user'
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

    it('should PUT /users/{user}/autoreply expect success', async () => {
        const response = await server
            .put(`/users/${user}/autoreply`)
            .send({
                status: true,
                name: 'AR name',
                subject: 'AR subject',
                text: 'Away from office until Dec 19'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
    });

    it('should PUT /users/{user}/autoreply expect failure / invalid status value', async () => {
        const response = await server
            .put(`/users/${user}/autoreply`)
            .send({
                status: 'notabool'
            })
            .expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should PUT /users/{user}/autoreply expect failure / unknown user', async () => {
        const response = await server
            .put(`/users/${'0'.repeat(24)}/autoreply`)
            .send({
                status: true,
                text: 'Away from office'
            })
            .expect(404);

        expect(response.body.code).to.be.equal('UserNotFound');
        expect(response.body.error).to.be.equal('Unknown user');
    });

    it('should GET /users/{user}/autoreply expect success', async () => {
        const response = await server.get(`/users/${user}/autoreply`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.status).to.be.true;
        expect(response.body.name).to.be.equal('AR name');
        expect(response.body.subject).to.be.equal('AR subject');
        expect(response.body.text).to.be.equal('Away from office until Dec 19');
        expect(response.body.html).to.be.equal('');
        expect(response.body.created).to.exist;
    });

    it('should DELETE /users/{user}/autoreply expect success', async () => {
        const response = await server.delete(`/users/${user}/autoreply`).expect(200);

        expect(response.body.success).to.be.true;

        // autoreply should now be disabled and empty
        const checkResponse = await server.get(`/users/${user}/autoreply`).expect(200);

        expect(checkResponse.body.success).to.be.true;
        expect(checkResponse.body.status).to.be.false;
        expect(checkResponse.body.name).to.be.equal('');
        expect(checkResponse.body.subject).to.be.equal('');
        expect(checkResponse.body.text).to.be.equal('');
        expect(checkResponse.body.html).to.be.equal('');
    });

    it('should GET /users/{user}/authlog expect success', async () => {
        // authenticate first so that the authlog would have entries
        const authResponse = await server
            .post('/authenticate')
            .send({
                username,
                password,
                scope: 'master'
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body.id).to.be.equal(user);

        const response = await server.get(`/users/${user}/authlog`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.total).to.be.gte(1);
        expect(response.body.results).to.be.an('array');
        expect(response.body.results).to.not.be.empty;

        const authEntry = response.body.results.find(entry => entry.action === 'authentication' && entry.result === 'success');
        expect(authEntry).to.exist;
        expect(authEntry.id).to.not.be.empty;

        authlogEvent = authEntry.id;
    });

    it('should GET /users/{user}/authlog expect failure / malformed user id', async () => {
        const response = await server.get(`/users/${123}/authlog`).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should GET /users/{user}/authlog/{event} expect success', async () => {
        const response = await server.get(`/users/${user}/authlog/${authlogEvent}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.be.equal(authlogEvent);
        expect(response.body.action).to.be.equal('authentication');
        expect(response.body.result).to.be.equal('success');
    });

    it('should GET /users/{user}/authlog/{event} expect failure / unknown event', async () => {
        const response = await server.get(`/users/${user}/authlog/${'0'.repeat(24)}`).expect(404);

        expect(response.body.code).to.be.equal('EventNotFound');
        expect(response.body.error).to.be.equal('Event was not found');
    });
});
