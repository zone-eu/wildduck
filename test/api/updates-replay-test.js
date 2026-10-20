/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../../lib/db');
const { connect, readUpdatesStream } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// SSE lines are "data: <json>" blocks, parse them back to objects
const parseEvents = data =>
    data
        .split('\n\n')
        .map(block => {
            let lines = block.split('\n');
            let payload = lines
                .filter(line => line.startsWith('data: '))
                .map(line => line.slice(6))
                .join('\n');
            let id = (lines.find(line => line.startsWith('id: ')) || '').slice(4);
            if (!payload) {
                return null;
            }
            try {
                return { id, payload: JSON.parse(payload) };
            } catch (err) {
                return null;
            }
        })
        .filter(entry => entry);

describe('API Updates stream', function () {
    this.timeout(15000); // eslint-disable-line no-invalid-this

    const runId = Date.now().toString(36);
    const username = `updatesuser-${runId}`;

    let user;
    let inbox;

    const postMessage = subject =>
        server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                unseen: true,
                from: { address: 'updates-sender@example.com' },
                to: [{ address: `${username}@web.zone.test` }],
                subject,
                text: 'Updates stream test'
            })
            .expect(200);

    before(async () => {
        await connect();

        const userResponse = await server
            .post('/users')
            .send({
                username,
                password: 'secretpassword',
                address: `${username}@web.zone.test`,
                name: 'updates user'
            })
            .expect(200);
        expect(userResponse.body.success).to.be.true;
        user = userResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX').id;
        expect(inbox).to.exist;
    });

    after(async () => {
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('should GET /users/{user}/updates expect success / replays journal entries after Last-Event-ID', async () => {
        await postMessage(`Replay message 1 ${runId}`);
        await postMessage(`Replay message 2 ${runId}`);
        await postMessage(`Replay message 3 ${runId}`);

        const journal = await db.database
            .collection('journal')
            .find({ user: new ObjectId(user), command: 'EXISTS' })
            .sort({ _id: 1 })
            .toArray();
        expect(journal.length).to.be.gte(3);

        // replay everything after the first new-message entry
        const lastEventId = journal[0]._id;

        const result = await readUpdatesStream(`/users/${user}/updates`, {
            headers: { 'Last-Event-ID': lastEventId.toString() },
            // the counters are written last, the first idle comment only follows 15 seconds later
            until: data => data.includes('"command": "COUNTERS"')
        });

        expect(result.statusCode).to.equal(200);
        expect(result.headers['content-type']).to.include('text/event-stream');

        const events = parseEvents(result.data);
        const exists = events.filter(event => event.payload.command === 'EXISTS');
        expect(exists.length).to.equal(journal.length - 1);
        for (const event of exists) {
            expect(event.id > lastEventId.toString()).to.be.true;
            expect(event.payload.mailbox).to.equal(inbox);
        }

        // the replay ends with the counters of every touched mailbox
        const counters = events.filter(event => event.payload.command === 'COUNTERS');
        expect(counters.length).to.equal(1);
        expect(counters[0].payload.mailbox).to.equal(inbox);
        expect(counters[0].payload.total).to.equal(3);
        expect(counters[0].payload.unseen).to.equal(3);
        expect(counters[0].id).to.equal(journal[journal.length - 1]._id.toString());

        // counters follow the replayed entries
        expect(result.data.indexOf('"command": "COUNTERS"')).to.be.gt(result.data.lastIndexOf('"command": "EXISTS"'));
    });

    it('should GET /users/{user}/updates expect success / replays nothing for the latest event id', async () => {
        const latest = await db.database.collection('journal').findOne({ user: new ObjectId(user) }, { sort: { _id: -1 } });

        const result = await readUpdatesStream(`/users/${user}/updates?Last-Event-ID=${latest._id.toString()}`);

        expect(result.statusCode).to.equal(200);
        expect(parseEvents(result.data)).to.deep.equal([]);
    });

    it('should GET /users/{user}/updates expect success / streams live changes', async () => {
        const subject = `Live message ${runId}`;

        const result = await readUpdatesStream(`/users/${user}/updates`, {
            afterOpen: async () => {
                await postMessage(subject);
            },
            until: data => data.includes('"command": "EXISTS"'),
            timeout: 10000
        });

        expect(result.statusCode).to.equal(200);

        const events = parseEvents(result.data);
        const exists = events.find(event => event.payload.command === 'EXISTS');
        expect(exists).to.exist;
        expect(exists.payload.mailbox).to.equal(inbox);
        expect(exists.id).to.be.a('string').that.is.not.empty;
    });
});
