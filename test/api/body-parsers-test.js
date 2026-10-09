/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// The request body parsers registered in api.js
describe('API body parsers', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const runId = Date.now().toString(36);
    const username = `parseruser-${runId}`;

    let user;

    before(async () => {
        const userResponse = await server
            .post('/users')
            .send({
                username,
                password: 'secretpassword',
                address: `${username}@web.zone.test`,
                name: 'parser user'
            })
            .expect(200);
        expect(userResponse.body.success).to.be.true;
        user = userResponse.body.id;
    });

    after(async () => {
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('should POST /users/{user}/mailboxes expect failure / malformed JSON body', async () => {
        const response = await server.post(`/users/${user}/mailboxes`).set('Content-Type', 'application/json').send('{"path": "broken"').expect(400);

        // parser errors are raised before validation, so the body uses the plain {code, message} shape
        expect(response.body.code).to.equal('InvalidContent');
        expect(response.body.message).to.include('Invalid JSON');
    });

    it('should POST /users/{user}/mailboxes expect success / empty JSON body is treated as no body', async () => {
        // an empty body fails validation for the missing path, not JSON parsing
        const response = await server.post(`/users/${user}/mailboxes`).set('Content-Type', 'application/json').send('').expect(400);

        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should POST /users/{user}/mailboxes expect success / form encoded body', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes`)
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send(`path=form-folder-${runId}&retention=1000`)
            .expect(200);

        expect(response.body.success).to.be.true;

        const mailboxResponse = await server.get(`/users/${user}/mailboxes/${response.body.id}`).expect(200);
        expect(mailboxResponse.body.path).to.equal(`form-folder-${runId}`);
        expect(mailboxResponse.body.retention).to.equal(1000);
    });

    it('should POST /users/{user}/mailboxes expect success / suffixed JSON content type', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes`)
            .set('Content-Type', 'application/vnd.api+json; charset=utf-8')
            .send(JSON.stringify({ path: `suffixed-folder-${runId}` }))
            .expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should POST /users/{user}/mailboxes/{mailbox}/messages expect success / text body is parsed as a string', async () => {
        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        const inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX').id;

        const raw = ['From: sender@example.com', `To: ${username}@web.zone.test`, `Subject: raw upload ${runId}`, '', 'Raw message body'].join('\r\n');

        const response = await server.post(`/users/${user}/mailboxes/${inbox}/messages`).set('Content-Type', 'message/rfc822').send(raw).expect(200);

        expect(response.body.success).to.be.true;

        const messageResponse = await server.get(`/users/${user}/mailboxes/${inbox}/messages/${response.body.message.id}`).expect(200);
        expect(messageResponse.body.subject).to.equal(`raw upload ${runId}`);
        expect(messageResponse.body.text).to.equal('Raw message body');
    });
});
