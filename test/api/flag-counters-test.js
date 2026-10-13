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

describe('API flag counters', function () {
    this.timeout(120000); // eslint-disable-line no-invalid-this

    let app;
    let rootToken;
    let ownToken;
    let user;
    let mailbox;
    const insertedMessageIds = [];

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

        const username = `flagcount-${crypto.randomBytes(5).toString('hex')}`;
        const created = await request('POST', '/users', rootToken.accessToken, {
            username,
            password: `test-${crypto.randomBytes(12).toString('hex')}`,
            address: `${username}@example.org`,
            name: 'Flag counter test'
        }).then(res => {
            expect(res.statusCode).to.equal(200);
            return res.json();
        });
        user = created.id;
        ownToken = await createRoleToken('user', user);

        const mailboxResponse = await request('GET', `/users/${user}/mailboxes`);
        expect(mailboxResponse.statusCode).to.equal(200);
        mailbox = new ObjectId(mailboxResponse.json().results.find(entry => entry.path === 'INBOX').id);

        const records = [
            { unseen: false, flags: ['\\Seen'], flagged: false, undeleted: true, draft: false },
            { unseen: true, flags: ['\\Answered'], flagged: false, undeleted: true, draft: false },
            { unseen: true, flags: ['\\Flagged'], flagged: true, undeleted: true, draft: false },
            { unseen: true, flags: ['\\Deleted'], flagged: false, undeleted: false, draft: false },
            { unseen: true, flags: ['\\Draft'], flagged: false, undeleted: true, draft: true }
        ].map((record, index) => ({
            _id: new ObjectId(),
            user: new ObjectId(user),
            mailbox,
            uid: index + 1,
            ...record
        }));
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

    it('returns total and unseen counts for every supported system flag', async () => {
        for (const flag of ['seen', 'answered', 'flagged', 'deleted', 'draft']) {
            const response = await request('GET', `/users/${user}/flag-counters/${flag}`);
            expect(response.statusCode).to.equal(200);
            expect(response.json()).to.deep.equal({ success: true, flag, total: 1, unseen: flag === 'seen' ? 0 : 1 });
        }
    });

    it('preserves the legacy flagged counter response shape', async () => {
        const response = await request('GET', `/users/${user}/flagged-counter`);
        expect(response.statusCode).to.equal(200);
        expect(response.json()).to.deep.equal({ success: true, total: 1, unseen: 1 });
    });

    it('reloads cached answered and draft counters after FETCH flag changes', async () => {
        const read = async flag => {
            const response = await request('GET', `/users/${user}/flag-counters/${flag}`);
            expect(response.statusCode).to.equal(200);
            return response.json();
        };
        const notifyFetch = async () => {
            const notifier = Object.create(ImapNotifier.prototype);
            notifier.redis = db.redis;
            await notifier.updateAccountCounters([{ command: 'FETCH', user: new ObjectId(user), flags: [] }]);
        };

        expect(await read('answered')).to.include({ total: 1, unseen: 1 });
        expect(await read('draft')).to.include({ total: 1, unseen: 1 });

        await db.database.collection('messages').updateOne({ _id: insertedMessageIds[1] }, { $set: { flags: [] } });
        await db.database.collection('messages').updateOne({ _id: insertedMessageIds[4] }, { $set: { draft: false, flags: [] } });
        await notifyFetch();
        expect(await read('answered')).to.include({ total: 0, unseen: 0 });
        expect(await read('draft')).to.include({ total: 0, unseen: 0 });

        await db.database.collection('messages').updateOne({ _id: insertedMessageIds[1] }, { $set: { flags: ['\\Answered'] } });
        await db.database.collection('messages').updateOne({ _id: insertedMessageIds[4] }, { $set: { draft: true, flags: ['\\Draft'] } });
        await notifyFetch();
        expect(await read('answered')).to.include({ total: 1, unseen: 1 });
        expect(await read('draft')).to.include({ total: 1, unseen: 1 });
    });

    it('validates the flag and reports missing users', async () => {
        const invalid = await request('GET', `/users/${user}/flag-counters/other`);
        expect(invalid.statusCode).to.equal(400);
        expect(invalid.json()).to.include({ code: 'InputValidationError' });

        const missing = await request('GET', `/users/${new ObjectId()}/flag-counters/flagged`);
        expect(missing.statusCode).to.equal(404);
        expect(missing.json()).to.include({ code: 'UserNotFound' });
    });

    it('allows own access and denies a user token access to another account', async () => {
        const own = await request('GET', `/users/${user}/flag-counters/answered`, ownToken.accessToken);
        expect(own.statusCode).to.equal(200);

        const other = await request('GET', `/users/${new ObjectId()}/flag-counters/answered`, ownToken.accessToken);
        expect(other.statusCode).to.equal(403);
    });
});
