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

const getLatestJournalId = async (userId, db) => {
    const latest = await db.database.collection('journal').findOne({ user: new ObjectId(userId) }, { sort: { _id: -1 } });
    // no entries yet: replay from the very beginning
    return latest ? latest._id : new ObjectId('000000000000000000000000');
};

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

describe('API Updates stream system flag counters', function () {
    this.timeout(15000); // eslint-disable-line no-invalid-this

    const runId = Date.now().toString(36);
    const username = `flagstream-${runId}`;

    let user;
    let inbox;

    const postMessage = async subject => {
        const response = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                unseen: true,
                from: { address: 'flag-sender@example.com' },
                to: [{ address: `${username}@web.zone.test` }],
                subject,
                text: 'Flag counter stream test'
            })
            .expect(200);
        return response.body.message.id;
    };

    const updateMessage = (uid, changes) => server.put(`/users/${user}/mailboxes/${inbox}/messages/${uid}`).send(changes).expect(200);

    before(async () => {
        const userResponse = await server
            .post('/users')
            .send({
                username,
                password: 'secretpassword',
                address: `${username}@web.zone.test`,
                name: 'flag stream user'
            })
            .expect(200);
        user = userResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX').id;
    });

    after(async () => {
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('replays FLAG_COUNTERS for flag and unseen changes', async () => {
        const anchor = await getLatestJournalId(user, db);
        const uidSeen = await postMessage(`Flag stream seen ${runId}`);
        const uidFlagged = await postMessage(`Flag stream flagged ${runId}`);
        await updateMessage(uidSeen, { seen: true });
        await updateMessage(uidFlagged, { flagged: true });

        const result = await readUpdatesStream(`/users/${user}/updates`, {
            headers: { 'Last-Event-ID': anchor.toString() },
            until: data => data.includes('"flag": "flagged"') && data.includes('"flag": "unread"'),
            timeout: 10000
        });
        expect(result.statusCode).to.equal(200);

        const events = parseEvents(result.data);
        const flagged = events.filter(event => event.payload.command === 'FLAG_COUNTERS' && event.payload.flag === 'flagged');
        const unread = events.filter(event => event.payload.command === 'FLAG_COUNTERS' && event.payload.flag === 'unread');

        expect(flagged.length).to.equal(1);
        expect(flagged[0].payload).to.include({ total: 1, unseen: 1 });
        expect(unread.length).to.equal(1);
        expect(unread[0].payload).to.include({ total: 1, unseen: 1 });

        const counters = events.filter(event => event.payload.command === 'COUNTERS');
        expect(counters.length).to.equal(1);
        expect(counters[0].payload).to.include({ mailbox: inbox, total: 2, unseen: 1 });
    });

    it('replays the unread FLAG_COUNTERS when unseen mail is expunged or its mailbox is deleted', async () => {
        const anchor = await getLatestJournalId(user, db);
        const uid = await postMessage(`Flag stream expunge ${runId}`);

        const tmpResponse = await server
            .post(`/users/${user}/mailboxes`)
            .send({ path: `Tmp ${runId}` })
            .expect(200);
        const tmpMailbox = tmpResponse.body.id;
        await server
            .post(`/users/${user}/mailboxes/${tmpMailbox}/messages`)
            .send({
                unseen: true,
                from: { address: 'flag-sender@example.com' },
                to: [{ address: `${username}@web.zone.test` }],
                subject: `Flag stream mailbox delete ${runId}`,
                text: 'Flag counter stream test'
            })
            .expect(200);

        await server.delete(`/users/${user}/mailboxes/${inbox}/messages/${uid}`).expect(200);
        await server.delete(`/users/${user}/mailboxes/${tmpMailbox}`).expect(200);

        const result = await readUpdatesStream(`/users/${user}/updates`, {
            headers: { 'Last-Event-ID': anchor.toString() },
            until: data => data.includes('"flag": "unread"'),
            timeout: 10000
        });
        expect(result.statusCode).to.equal(200);

        const events = parseEvents(result.data);
        const unread = events.filter(event => event.payload.command === 'FLAG_COUNTERS' && event.payload.flag === 'unread');
        expect(unread.length).to.equal(1);
        // the flagged-unseen message from the previous test is still in the account
        expect(unread[0].payload).to.include({ total: 1, unseen: 1 });
    });
});

describe('API Updates stream label counters', function () {
    this.timeout(15000); // eslint-disable-line no-invalid-this

    const runId = Date.now().toString(36);
    const username = `labelstream-${runId}`;
    const labelName = `Stream Label ${runId}`;

    let user;
    let inbox;
    let labelId;

    const postMessage = async subject => {
        const response = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                unseen: true,
                from: { address: 'label-sender@example.com' },
                to: [{ address: `${username}@web.zone.test` }],
                subject,
                text: 'Label counter stream test'
            })
            .expect(200);
        return response.body.message.id;
    };

    before(async () => {
        const userResponse = await server
            .post('/users')
            .send({
                username,
                password: 'secretpassword',
                address: `${username}@web.zone.test`,
                name: 'label stream user'
            })
            .expect(200);
        user = userResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX').id;

        const labelResponse = await server.post(`/users/${user}/labels`).send({ name: labelName }).expect(200);
        labelId = labelResponse.body.id;
    });

    after(async () => {
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('replays LABEL_COUNTERS with the labelId alongside the label name', async () => {
        const anchor = await getLatestJournalId(user, db);
        const uid = await postMessage(`Label stream ${runId}`);
        await server
            .put(`/users/${user}/mailboxes/${inbox}/messages/${uid}`)
            .send({ labels: [labelName] })
            .expect(200);

        const result = await readUpdatesStream(`/users/${user}/updates`, {
            headers: { 'Last-Event-ID': anchor.toString() },
            until: data => data.includes('"command": "LABEL_COUNTERS"'),
            timeout: 10000
        });
        expect(result.statusCode).to.equal(200);

        const events = parseEvents(result.data);
        const labelEvents = events.filter(event => event.payload.command === 'LABEL_COUNTERS');
        expect(labelEvents.length).to.equal(1);
        expect(labelEvents[0].payload).to.include({ label: labelName, labelId, total: 1, unseen: 1 });
        expect(labelEvents[0].payload.labelId).to.be.a('string');
    });

    it('replays LABEL_COUNTERS with the same labelId after a label rename', async () => {
        const renamedName = `${labelName} (renamed)`;
        await server.put(`/users/${user}/labels/${labelId}`).send({ name: renamedName }).expect(200);
        // the renamed name is tracked once its counters are read
        await server.get(`/users/${user}/label-counters/${encodeURIComponent(renamedName)}`).expect(200);

        const anchor = await getLatestJournalId(user, db);
        const uid = await postMessage(`Label stream renamed ${runId}`);
        await server
            .put(`/users/${user}/mailboxes/${inbox}/messages/${uid}`)
            .send({ labels: [renamedName] })
            .expect(200);

        const result = await readUpdatesStream(`/users/${user}/updates`, {
            headers: { 'Last-Event-ID': anchor.toString() },
            until: data => data.includes('"command": "LABEL_COUNTERS"'),
            timeout: 10000
        });
        expect(result.statusCode).to.equal(200);

        const events = parseEvents(result.data);
        const labelEvents = events.filter(event => event.payload.command === 'LABEL_COUNTERS');
        expect(labelEvents.length).to.equal(1);
        expect(labelEvents[0].payload).to.include({ label: renamedName, labelId, total: 2, unseen: 2 });
        expect(labelEvents[0].payload.labelId).to.be.a('string');
    });

    it('counts only searchable mailboxes and resolves active label ids in one replay batch', async () => {
        const activeLabel = `${labelName} active`;
        const deletingLabel = `${labelName} deleting`;
        const activeResponse = await server.post(`/users/${user}/labels`).send({ name: activeLabel }).expect(200);
        const deletingResponse = await server.post(`/users/${user}/labels`).send({ name: deletingLabel }).expect(200);
        const activeId = new ObjectId(activeResponse.body.id);
        const deletingId = new ObjectId(deletingResponse.body.id);
        const mailboxes = (await server.get(`/users/${user}/mailboxes`).expect(200)).body.results;
        const junk = new ObjectId(mailboxes.find(entry => entry.specialUse === '\\Junk').id);
        const trash = new ObjectId(mailboxes.find(entry => entry.specialUse === '\\Trash').id);
        const inboxId = new ObjectId(inbox);
        const inserted = [
            {
                _id: new ObjectId(),
                user: new ObjectId(user),
                uid: 1001,
                mailbox: inboxId,
                labels: [activeId],
                unseen: true,
                searchable: true
            },
            {
                _id: new ObjectId(),
                user: new ObjectId(user),
                uid: 1002,
                mailbox: junk,
                labels: [activeId],
                unseen: true,
                searchable: true
            },
            {
                _id: new ObjectId(),
                user: new ObjectId(user),
                uid: 1003,
                mailbox: trash,
                labels: [activeId],
                unseen: true,
                searchable: true
            },
            {
                _id: new ObjectId(),
                user: new ObjectId(user),
                uid: 1004,
                mailbox: inboxId,
                labels: [activeId],
                unseen: true,
                searchable: false
            },
            {
                _id: new ObjectId(),
                user: new ObjectId(user),
                uid: 1005,
                mailbox: inboxId,
                labels: [deletingId],
                unseen: true,
                searchable: true
            }
        ].map(message => ({
            flagged: false,
            undeleted: true,
            draft: false,
            flags: [],
            ...message
        }));
        const journal = db.database.collection('journal');
        const messages = db.database.collection('messages');
        let journalId;

        try {
            await messages.insertMany(inserted);
            await db.database.collection('labels').updateOne({ _id: deletingId, user: new ObjectId(user) }, { $set: { deleting: true } });
            await db.redis.sadd(`account-counters:{${user}}:labels`, activeLabel, deletingLabel);

            const anchor = await getLatestJournalId(user, db);
            // ObjectIds generated by separate processes are not ordered within a second.
            journalId = ObjectId.createFromTime(Math.floor(anchor.getTimestamp().getTime() / 1000) + 1);
            await journal.insertOne({
                _id: journalId,
                user: new ObjectId(user),
                command: 'FETCH',
                mailbox: inboxId,
                labels: [activeLabel, deletingLabel],
                unseenChange: true
            });

            const result = await readUpdatesStream(`/users/${user}/updates`, {
                headers: { 'Last-Event-ID': anchor.toString() },
                until: data => parseEvents(data).filter(event => event.payload.command === 'LABEL_COUNTERS').length === 2,
                timeout: 10000
            });
            expect(result.statusCode).to.equal(200);

            const events = parseEvents(result.data).filter(event => event.payload.command === 'LABEL_COUNTERS');
            const activeEvent = events.find(event => event.payload.label === activeLabel);
            const deletingEvent = events.find(event => event.payload.label === deletingLabel);
            expect(activeEvent).to.exist;
            expect(activeEvent.payload).to.include({ labelId: activeId.toString(), total: 1, unseen: 1 });
            expect(deletingEvent).to.exist;
            expect(deletingEvent.payload).to.include({ total: 0, unseen: 0 });
            expect(deletingEvent.payload).to.not.have.property('labelId');
            expect(events).to.have.length(2);
        } finally {
            await messages.deleteMany({ _id: { $in: inserted.map(message => message._id) } });
            if (journalId) {
                await journal.deleteOne({ _id: journalId });
            }
            await db.database.collection('labels').updateOne({ _id: deletingId }, { $unset: { deleting: '' } });
            await db.redis.srem(`account-counters:{${user}}:labels`, activeLabel, deletingLabel);
        }
    });
});
