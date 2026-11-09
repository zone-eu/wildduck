/* globals before, after */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { buildApp } = require('./_inprocess');
const db = require('../../lib/db');
const counters = require('../../lib/counters');
const { SettingsHandler } = require('../../lib/settings-handler');
const { createRoleToken, deleteRoleToken } = require('./_helpers');

async function call(app, method, url, payload) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(response.statusCode, `${method} ${url}`).to.equal(200);
    return response.json();
}

describe('API attachment download allowance', function () {
    this.timeout(30000); // eslint-disable-line no-invalid-this
    let app, user, attachmentUrl, storageUrl, token, key;

    before(async () => {
        ({ app } = await buildApp());
        const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        user = (await call(app, 'POST', '/users', { username: `download-${run}`, password: 'test-password', apiMaxDownload: 6 })).id;
        key = `adw:${user}`;
        token = await createRoleToken('user', user);
        const inbox = (await call(app, 'GET', `/users/${user}/mailboxes`)).results.find(mailbox => mailbox.path === 'INBOX').id;
        const message = await call(app, 'POST', `/users/${user}/mailboxes/${inbox}/messages`, {
            text: 'body',
            attachments: [{ filename: 'quota.txt', content: Buffer.from('abc').toString('base64'), contentType: 'text/plain' }]
        });
        attachmentUrl = `/users/${user}/mailboxes/${inbox}/messages/${message.message.id}/attachments/ATT00001`;
        const file = await call(app, 'POST', `/users/${user}/storage`, { filename: 'stored.txt', content: 'abc' });
        storageUrl = `/users/${user}/storage/${file.id}`;
    });

    after(async () => {
        if (token) {
            await deleteRoleToken(token.tokenHash);
        }
        if (user) {
            await call(app, 'DELETE', `/users/${user}`);
            await db.redis.del(key);
        }
        if (app) {
            await app.close();
        }
    });

    it('meters decoded attachment bytes and uploaded files into one owner allowance', async () => {
        const attachment = await app.inject({ method: 'GET', url: attachmentUrl, headers: { 'x-access-token': token.accessToken } });
        expect(attachment.statusCode).to.equal(200);
        expect(attachment.rawPayload.toString()).to.equal('abc');
        let data = await call(app, 'GET', `/users/${user}`);
        expect(data.apiMaxDownload).to.equal(6);
        expect(data.limits.apiDownload).to.include({ allowed: 6, used: 3 });
        expect(data.limits.apiDownload.ttl).to.be.within(1, 86400);
        const file = await app.inject({ method: 'GET', url: storageUrl });
        expect(file.statusCode).to.equal(200);
        expect(file.rawPayload.toString()).to.equal('abc');
        data = await call(app, 'GET', `/users/${user}`);
        expect(data.limits.apiDownload.used).to.equal(6);
        const rejected = await app.inject({ method: 'GET', url: attachmentUrl });
        expect(rejected.statusCode).to.equal(429);
        expect(rejected.json().code).to.equal('ApiDownloadLimitExceeded');
    });

    it('preserves used traffic when an administrator increases the allowance', async () => {
        await call(app, 'PUT', `/users/${user}`, { apiMaxDownload: 9 });
        const file = await app.inject({ method: 'GET', url: storageUrl });
        expect(file.statusCode).to.equal(200);
        expect((await call(app, 'GET', `/users/${user}`)).limits.apiDownload).to.include({ allowed: 9, used: 9 });
    });

    it('does not spend traffic or open a transfer for a known file that cannot fit', async () => {
        await db.redis.del(key);
        await call(app, 'PUT', `/users/${user}`, { apiMaxDownload: 2 });
        const response = await app.inject({ method: 'GET', url: storageUrl });
        expect(response.statusCode).to.equal(429);
        expect(await db.redis.get(key)).to.equal(null);
    });

    it('arbitrates concurrent attachment and storage downloads using atomic Redis accounting', async () => {
        await call(app, 'PUT', `/users/${user}`, { apiMaxDownload: 3 });
        for (const url of [storageUrl, attachmentUrl]) {
            await db.redis.del(key);
            const responses = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'GET', url })));
            expect(responses.filter(response => response.statusCode === 200)).to.have.length(1);
            expect(responses.filter(response => response.statusCode === 429)).to.have.length(5);
            expect(Number(await db.redis.get(key))).to.equal(3);
        }
    });

    it('expires the counter and starts a fresh window on the next download', async () => {
        await db.redis.pexpire(key, 1);
        await new Promise(resolve => setTimeout(resolve, 20));
        const response = await app.inject({ method: 'GET', url: storageUrl });
        expect(response.statusCode).to.equal(200);
        expect(Number(await db.redis.get(key))).to.equal(3);
        expect(await db.redis.ttl(key)).to.be.within(86390, 86400);
    });

    it('inherits the deployment setting for a zero per-user allowance', async () => {
        const handler = new SettingsHandler({ db: db.database });
        const previous = await db.database.collection('settings').findOne({ key: 'const:max:api:download' });
        try {
            await handler.set('const:max:api:download', 3);
            await db.redis.del(key);
            await call(app, 'PUT', `/users/${user}`, { apiMaxDownload: 0 });
            expect((await call(app, 'GET', `/users/${user}`)).limits.apiDownload.allowed).to.equal(3);
            expect((await app.inject({ method: 'GET', url: storageUrl })).statusCode).to.equal(200);
            expect((await app.inject({ method: 'GET', url: storageUrl })).statusCode).to.equal(429);
        } finally {
            if (previous) {
                await db.database.collection('settings').replaceOne({ _id: previous._id }, previous);
            } else {
                await db.database.collection('settings').deleteOne({ key: 'const:max:api:download' });
            }
        }
    });

    it('rejects user attempts to change their own allowance', async () => {
        await app.inject({ method: 'PUT', url: `/users/${user}`, payload: { apiMaxDownload: 1000 }, headers: { 'x-access-token': token.accessToken } });
        expect((await db.users.collection('users').findOne({ _id: new ObjectId(user) })).apiMaxDownload).to.equal(0);
    });

    it('does not overspend a Redis counter under concurrent reservations', async () => {
        const name = `test-api-spend:${new ObjectId()}`;
        const { asyncSpendCounter } = counters(db.redis);
        try {
            const results = await Promise.all(Array.from({ length: 8 }, () => asyncSpendCounter(name, 7, 10)));
            expect(results.filter(result => result.success)).to.have.length(1);
            expect(Number(await db.redis.get(name))).to.equal(7);
        } finally {
            await db.redis.del(name);
        }
    });
});
