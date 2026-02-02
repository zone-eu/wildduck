/* globals before: false, after: false */
'use strict';

const supertest = require('supertest');
const chai = require('chai');
const expect = chai.expect;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// Test credentials - centralized
const TEST_CREDS = { username: 'jmapuser', password: 'secretvalue', email: 'jmapuser@example.com', name: 'JMAP User' };

describe('JMAP tests', function () {
    this.timeout(10000);

    let user;

    before(async () => {
        const response = await server
            .post('/users')
            .send({ username: TEST_CREDS.username, password: TEST_CREDS.password, address: TEST_CREDS.email, name: TEST_CREDS.name })
            .expect(200);
        expect(response.body.success).to.be.true;
        user = response.body.id;
    });

    after(async () => {
        if (!user) return;
        try {
            const response = await server.delete(`/users/${user}`).expect(200);
            expect(response.body.success).to.be.true;
        } catch (e) {
            console.warn('Cleanup failed:', e.message);
        }
        user = false;
    });

    it('GET /.well-known/jmap returns discovery info', async () => {
        const response = await server.get('/.well-known/jmap').expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.apiUrl).to.be.a('string');
        expect(response.body.capabilities).to.be.an('object');
    });

    it('POST /jmap with Basic auth should return Mailbox/get results', async () => {
        // Basic auth header
        const token = Buffer.from(`${TEST_CREDS.username}:${TEST_CREDS.password}`).toString('base64');
        const body = { methodCalls: [['Mailbox/get', {}, 'R1']] };

        const response = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(body).expect(200);
        expect(response.body.methodResponses).to.be.an('array');
        const resp = response.body.methodResponses[0];
        expect(resp[0]).to.equal('Mailbox/get');
        expect(resp[1].list).to.be.an('array');
    });

    it('POST /jmap Email/send, Email/query, Email/get and Email/set flows', async () => {
        const token = Buffer.from(`${TEST_CREDS.username}:${TEST_CREDS.password}`).toString('base64');

        // find user's inbox
        const mailboxesResp = await server.get(`/users/${user}/mailboxes`).expect(200);
        const inbox = mailboxesResp.body.results.find(m => m.path === 'INBOX');
        expect(inbox).to.exist;

        // send a message via submit API
        const submitResp = await server.post(`/users/${user}/submit`).send({
            to: [{ address: TEST_CREDS.email }],
            subject: 'JMAP Test Message',
            text: 'Hello JMAP'
        }).expect(200);
        expect(submitResp.body.success).to.be.true;
        const submitted = submitResp.body.message;
        expect(submitted).to.have.property('mailbox');
        expect(submitted).to.have.property('id');

        // allow slight delay for indexing / notifier
        await new Promise(r => setTimeout(r, 50));

        // query for emails in mailbox
        const queryBody = { methodCalls: [['Email/query', { filter: { inMailbox: submitted.mailbox } }, 'R1']] };
        const queryResp = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(queryBody).expect(200);
        const qResp = queryResp.body.methodResponses.find(r => r[0] === 'Email/query');
        expect(qResp).to.exist;
        const ids = qResp[1].ids;
        expect(ids).to.be.an('array').that.is.not.empty;

        const messageId = ids[0];

        // get the message via Email/get
        const getBody = { methodCalls: [['Email/get', { ids: [messageId] }, 'R1']] };
        const getResp = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(getBody).expect(200);
        const gResp = getResp.body.methodResponses.find(r => r[0] === 'Email/get');
        expect(gResp).to.exist;
        expect(gResp[1].list).to.be.an('array');
        const got = gResp[1].list[0];
        expect(got.subject).to.equal('JMAP Test Message');

        // set a flag via Email/set (add \\Seen)
        const setBody = { methodCalls: [['Email/set', { update: { [messageId]: { addFlags: ['\\\\Seen'] } } }, 'R1']] };
        const setResp = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(setBody).expect(200);
        const sResp = setResp.body.methodResponses.find(r => r[0] === 'Email/set');
        expect(sResp).to.exist;
        expect(sResp[1].updated).to.include(messageId);

        // verify message now has flag via Email/get
        const getResp2 = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(getBody).expect(200);
        const gResp2 = getResp2.body.methodResponses.find(r => r[0] === 'Email/get');
        const got2 = gResp2[1].list[0];
        expect(got2.keywords).to.include('\\Seen');
    });

    it('GET /jmap session, Email/changes created and destroyed detection', async () => {
        const token = Buffer.from(`${TEST_CREDS.username}:${TEST_CREDS.password}`).toString('base64');

        // get initial state
        const sessionResp = await server.get('/jmap').set('Authorization', 'Basic ' + token).expect(200);
        const state1 = sessionResp.body.state;
        expect(state1).to.exist;

        // submit a message
        const submitResp = await server.post(`/users/${user}/submit`).send({
            to: [{ address: TEST_CREDS.email }],
            subject: 'JMAP Changes Test',
            text: 'Hello changes'
        }).expect(200);
        expect(submitResp.body.success).to.be.true;
        const submitted = submitResp.body.message;

        // allow slight delay
        await new Promise(r => setTimeout(r, 50));

        // changes since state1 should include created id
        const changesBody = { methodCalls: [['Email/changes', { sinceState: state1 }, 'R1']] };
        const changesResp = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(changesBody).expect(200);
        const chResp = changesResp.body.methodResponses.find(r => r[0] === 'Email/changes');
        expect(chResp).to.exist;
        expect(chResp[1].created).to.be.an('array').that.includes(String(submitted.id));

        // mark the message as deleted (add \Deleted flag)
        const messageId = chResp[1].created[0];
        const setDelBody = { methodCalls: [['Email/set', { update: { [messageId]: { addFlags: ['\\Deleted'] } } }, 'R1']] };
        await server.post('/jmap').set('Authorization', 'Basic ' + token).send(setDelBody).expect(200);

        // allow slight delay
        await new Promise(r => setTimeout(r, 50));

        // changes again since previous state should now show destroyed
        const state2Resp = await server.get('/jmap').set('Authorization', 'Basic ' + token).expect(200);
        const state2 = state2Resp.body.state;

        const changesBody2 = { methodCalls: [['Email/changes', { sinceState: state1 }, 'R1']] };
        const changesResp2 = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(changesBody2).expect(200);
        const chResp2 = changesResp2.body.methodResponses.find(r => r[0] === 'Email/changes');
        expect(chResp2).to.exist;
        // destroyed should contain the message id after \\Deleted flag
        expect(chResp2[1].destroyed).to.be.an('array').that.includes(messageId);
    });

    it('GET /jmap session and upload/download + send with blob', async () => {
        const token = Buffer.from(`${TEST_CREDS.username}:${TEST_CREDS.password}`).toString('base64');

        // session
        const sessionResp2 = await server.get('/jmap').set('Authorization', 'Basic ' + token).expect(200);
        expect(sessionResp2.body.apiUrl).to.be.a('string');
        expect(sessionResp2.body.uploadUrl).to.be.a('string');
        expect(sessionResp2.body.downloadUrl).to.be.a('string');
        expect(sessionResp2.body.state).to.exist;

        // upload a file via /jmap/upload
        const fileBuf = Buffer.from('Hello JMAP attachment');
        const uploadResp = await server.post('/jmap/upload').set('Authorization', 'Basic ' + token).set('x-filename', 'hello.txt').set('content-type', 'text/plain').send(fileBuf).expect(200);
        expect(uploadResp.body.success).to.be.true;
        const blobId = uploadResp.body.id;
        expect(blobId).to.be.a('string');

        // send message referencing the blob
        const sendBody = { methodCalls: [['Email/send', { create: { c1: { email: { to: [{ address: TEST_CREDS.email }], subject: 'JMAP with attachment', text: 'See attachment', attachments: [{ blobId } ] } } } }, 'R1']] };
        const sendResp = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(sendBody).expect(200);
        const sendRespEntry = sendResp.body.methodResponses.find(r => r[0] === 'Email/send');
        expect(sendRespEntry).to.exist;
        expect(Object.keys(sendRespEntry[1].created)).to.not.be.empty;
    });

    it('POST /jmap without auth should return 401', async () => {
        const body = { methodCalls: [['Mailbox/get', {}, 'R1']] };
        const response = await server.post('/jmap').send(body).expect(401);
        expect(response.body.code).to.equal('AuthRequired');
    });
});
