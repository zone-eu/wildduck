/* globals before: false, after: false */
'use strict';

const supertest = require('supertest');
const chai = require('chai');
const expect = chai.expect;
const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// Test credentials - centralized
const TEST_CREDS = { username: 'jmapcc', password: 'secretvalue', email: 'jmapcc@example.com', name: 'JMAP CC' };

describe('JMAP changelog concurrency tests', function () {
    this.timeout(60000);

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

    it('concurrent sends and deletes result in changelog entries', async () => {
        const token = Buffer.from(`${TEST_CREDS.username}:${TEST_CREDS.password}`).toString('base64');

        // do multiple concurrent submits
        const submits = [];
        for (let i = 0; i < 10; i++) {
            submits.push(
                server
                    .post(`/users/${user}/submit`)
                    .send({ to: [{ address: TEST_CREDS.email }], subject: `C${i}`, text: 'Hello' })
                    .expect(200)
            );
        }

        const results = await Promise.all(submits);
        const msgs = results.map(r => r.body.message);

        // concurrently delete half of them via EXPUNGE by adding Deleted flag then expunge
        const deletes = [];
        for (let i = 0; i < Math.floor(msgs.length / 2); i++) {
            const msg = msgs[i];
            // set Deleted flag (find by mailbox and uid via messages API is complex; use test-friendly approach: query and get id)
            deletes.push(
                (async () => {
                    // Query mailbox
                    const queryBody = { methodCalls: [['Email/query', { filter: { inMailbox: msg.mailbox } }, 'R1']] };
                    await server.post('/jmap').set('Authorization', 'Basic ' + token).send(queryBody).expect(200);
                    // Use messages API to delete message directly
                    await server.del(`/users/${user}/mailboxes/${msg.mailbox}/messages/${msg.id}`).expect(200);
                })()
            );
        }

        await Promise.all(deletes);

        // allow time for GC and changelog updates
        await new Promise(r => setTimeout(r, 200));

        // fetch changes since 0
        const changesBody = { methodCalls: [['Email/changes', { sinceState: '0' }, 'R1']] };
        const changesResp = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(changesBody).expect(200);
        const chResp = changesResp.body.methodResponses.find(r => r[0] === 'Email/changes');
        expect(chResp).to.exist;
        expect(chResp[1].created.length).to.be.at.least(msgs.length);
        // destroyed should include deletes
        expect(chResp[1].destroyed.length).to.be.at.least(Math.floor(msgs.length / 2));
    });
});
