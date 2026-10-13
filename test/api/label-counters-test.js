/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const db = require('../../lib/db');
const ImapNotifier = require('../../lib/imap-notifier');
const { buildApp } = require('./_inprocess');
const { createRoleToken, deleteRoleToken } = require('./_helpers');

describe('API label counters', function () {
    this.timeout(120000); // eslint-disable-line no-invalid-this

    let app;
    let rootToken;
    let ownToken;
    let user;
    let inbox;
    const labelA = `Label A ${crypto.randomBytes(4).toString('hex')}`;
    const labelB = `Label B ${crypto.randomBytes(4).toString('hex')}`;
    let labelAId;
    let labelBId;
    const insertedMessageIds = [];
    const messageIds = {};

    const request = (method, url, token = rootToken.accessToken, payload) =>
        app.inject({
            method,
            url,
            headers: { 'x-access-token': token, ...(payload ? { 'content-type': 'application/json' } : {}) },
            ...(payload ? { payload: JSON.stringify(payload) } : {})
        });

    before(async () => {
        ({ app } = await buildApp());
        rootToken = await createRoleToken('root');

        const username = `labelcount-${crypto.randomBytes(5).toString('hex')}`;
        const created = await request('POST', '/users', rootToken.accessToken, {
            username,
            password: `test-${crypto.randomBytes(12).toString('hex')}`,
            address: `${username}@example.org`,
            name: 'Label counter test'
        }).then(res => {
            expect(res.statusCode).to.equal(200);
            return res.json();
        });
        user = created.id;
        ownToken = await createRoleToken('user', user);

        const labelAResponse = await request('POST', `/users/${user}/labels`, rootToken.accessToken, { name: labelA });
        expect(labelAResponse.statusCode).to.equal(200);
        labelAId = new ObjectId(labelAResponse.json().id);
        const labelBResponse = await request('POST', `/users/${user}/labels`, rootToken.accessToken, { name: labelB });
        expect(labelBResponse.statusCode).to.equal(200);
        labelBId = new ObjectId(labelBResponse.json().id);

        const mailboxResponse = await request('GET', `/users/${user}/mailboxes`);
        expect(mailboxResponse.statusCode).to.equal(200);
        const mailboxes = mailboxResponse.json().results;
        inbox = new ObjectId(mailboxes.find(entry => entry.path === 'INBOX').id);
        const junkMailbox = new ObjectId(mailboxes.find(entry => entry.specialUse === '\\Junk').id);
        const trashMailbox = new ObjectId(mailboxes.find(entry => entry.specialUse === '\\Trash').id);
        const archiveResponse = await request('POST', `/users/${user}/mailboxes`, rootToken.accessToken, { path: 'Archive' });
        expect(archiveResponse.statusCode).to.equal(200);
        const archiveMailbox = new ObjectId(archiveResponse.json().id);

        const records = [
            { name: 'inbox-a-unseen', mailbox: inbox, labels: [labelAId], unseen: true, flags: [], searchable: true },
            { name: 'inbox-a-unseen-2', mailbox: inbox, labels: [labelAId], unseen: true, flags: [], searchable: true },
            { name: 'inbox-plain', mailbox: inbox, labels: [], unseen: true, flags: [], searchable: true },
            { name: 'junk-a', mailbox: junkMailbox, labels: [labelAId], unseen: true, flags: [], searchable: true },
            { name: 'trash-a', mailbox: trashMailbox, labels: [labelAId], unseen: true, flags: [] },
            { name: 'archive-b', mailbox: archiveMailbox, labels: [labelBId], unseen: true, flags: [], searchable: true }
        ].map((record, index) => {
            const message = {
                _id: new ObjectId(),
                user: new ObjectId(user),
                uid: index + 1,
                mailbox: record.mailbox,
                labels: record.labels,
                unseen: record.unseen,
                flags: record.flags,
                flagged: false,
                undeleted: true,
                draft: false,
                searchable: record.searchable !== false
            };
            messageIds[record.name] = message._id;
            return message;
        });
        insertedMessageIds.push(...records.map(record => record._id));
        await db.database.collection('messages').insertMany(records);
    });

    after(async () => {
        if (user && insertedMessageIds.length) {
            await db.database.collection('messages').deleteMany({ _id: { $in: insertedMessageIds } });
        }
        if (user) {
            const counterKeyPattern = `account-counters:{${user}}:*`;
            let cursor = '0';
            do {
                const [nextCursor, keys] = await db.redis.scan(cursor, 'MATCH', counterKeyPattern, 'COUNT', 100);
                if (keys.length) {
                    await db.redis.del(...keys);
                }
                cursor = nextCursor;
            } while (cursor !== '0');
            await request('DELETE', `/users/${user}`).catch(() => false);
        }
        await deleteRoleToken(ownToken && ownToken.tokenHash);
        await deleteRoleToken(rootToken && rootToken.tokenHash);
        if (app) {
            await app.close();
        }
    });

    const invalidateAccountCounters = async () => {
        const notifier = Object.create(ImapNotifier.prototype);
        notifier.redis = db.redis;
        await notifier.updateAccountCounters([{ command: 'FETCH', user: new ObjectId(user), flags: [] }]);
    };

    it('returns label counters in the searchable scope by default and supports the all-mailbox override', async () => {
        const searchable = await request('GET', `/users/${user}/label-counters/${encodeURIComponent(labelA)}`);
        expect(searchable.statusCode).to.equal(200);
        expect(searchable.json()).to.deep.equal({ success: true, label: labelA, total: 2, unseen: 2 });

        const all = await request('GET', `/users/${user}/label-counters/${encodeURIComponent(labelA)}?searchable=false`);
        expect(all.statusCode).to.equal(200);
        expect(all.json()).to.deep.equal({ success: true, label: labelA, total: 4, unseen: 4 });

        const labelBResponse = await request('GET', `/users/${user}/label-counters/${encodeURIComponent(labelB)}`);
        expect(labelBResponse.statusCode).to.equal(200);
        expect(labelBResponse.json()).to.deep.equal({ success: true, label: labelB, total: 1, unseen: 1 });
    });

    it('returns the all-labels aggregate counters in the searchable scope by default', async () => {
        const searchable = await request('GET', `/users/${user}/labels?counters=true`);
        expect(searchable.statusCode).to.equal(200);
        expect(searchable.json().success).to.be.true;
        const searchableLabels = Object.fromEntries(searchable.json().labels.map(label => [label.name, label]));
        expect(searchableLabels[labelA]).to.include({ id: labelAId.toString(), total: 2, unseen: 2 });
        expect(searchableLabels[labelB]).to.include({ id: labelBId.toString(), total: 1, unseen: 1 });

        const all = await request('GET', `/users/${user}/labels?counters=true&searchable=false`);
        expect(all.statusCode).to.equal(200);
        const allLabels = Object.fromEntries(all.json().labels.map(label => [label.name, label]));
        expect(allLabels[labelA]).to.include({ total: 4, unseen: 4 });
        expect(allLabels[labelB]).to.include({ total: 1, unseen: 1 });

        const plain = await request('GET', `/users/${user}/labels`);
        expect(plain.statusCode).to.equal(200);
        for (const label of plain.json().labels) {
            expect(label.total).to.be.undefined;
            expect(label.unseen).to.be.undefined;
        }
    });

    it('never serves the other scope cached value when switching searchable', async () => {
        const read = async (url) => {
            const response = await request('GET', url);
            expect(response.statusCode).to.equal(200);
            return response.json();
        };
        const url = `/users/${user}/label-counters/${encodeURIComponent(labelA)}`;

        expect(await read(url)).to.include({ total: 2, unseen: 2 });
        expect(await read(`${url}?searchable=false`)).to.include({ total: 4, unseen: 4 });
        expect(await read(url)).to.include({ total: 2, unseen: 2 });

        await db.database
            .collection('messages')
            .updateOne({ _id: messageIds['inbox-a-unseen'] }, { $set: { unseen: false, flags: ['\\Seen'] } });
        await db.database.collection('messages').updateOne({ _id: messageIds['junk-a'] }, { $set: { unseen: false, flags: ['\\Seen'] } });
        await invalidateAccountCounters();

        expect(await read(`${url}?searchable=false`)).to.include({ total: 4, unseen: 2 });
        expect(await read(url)).to.include({ total: 2, unseen: 1 });
        expect(await read(`${url}?searchable=false`)).to.include({ total: 4, unseen: 2 });
    });

    it('validates searchable and reports missing users', async () => {
        const invalidLabelCounter = await request(
            'GET',
            `/users/${user}/label-counters/${encodeURIComponent(labelA)}?searchable=maybe`
        );
        expect(invalidLabelCounter.statusCode).to.equal(400);
        expect(invalidLabelCounter.json()).to.include({ code: 'InputValidationError' });

        const invalidList = await request('GET', `/users/${user}/labels?counters=true&searchable=maybe`);
        expect(invalidList.statusCode).to.equal(400);
        expect(invalidList.json()).to.include({ code: 'InputValidationError' });

        const missing = await request('GET', `/users/${new ObjectId()}/label-counters/${encodeURIComponent(labelA)}`);
        expect(missing.statusCode).to.equal(404);
        expect(missing.json()).to.include({ code: 'UserNotFound' });
    });

    it('allows own access and denies a user token access to another account', async () => {
        const own = await request('GET', `/users/${user}/label-counters/${encodeURIComponent(labelA)}`, ownToken.accessToken);
        expect(own.statusCode).to.equal(200);

        const other = await request('GET', `/users/${new ObjectId()}/label-counters/${encodeURIComponent(labelA)}`, ownToken.accessToken);
        expect(other.statusCode).to.equal(403);
    });
});
