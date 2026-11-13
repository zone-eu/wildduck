/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// Hidden settings (not enumerable rows such as ACME account keys, and the jmap: keys such as the VAPID
// key pair) hold secrets: GET /settings/:key answers them only to a role that may write settings.
// In-process with app.inject().

const chai = require('chai');
const db = require('../../lib/db');
const { SettingsHandler } = require('../../lib/settings-handler');
const { buildApp } = require('./_inprocess');
const { createRoleToken, deleteRoleToken } = require('./_helpers');

const expect = chai.expect;

const SUFFIX = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const JMAP_KEY = `jmap:hidden-test-${SUFFIX}`;
const HIDDEN_KEY = `hidden-test-${SUFFIX}`;

describe('Hidden settings', function () {
    this.timeout(30000); // eslint-disable-line no-invalid-this

    let app;
    const tokens = [];

    const tokenFor = async role => {
        const token = await createRoleToken(role);
        tokens.push(token.tokenHash);
        return token.accessToken;
    };

    const getSetting = async (key, role) =>
        app.inject({ method: 'GET', url: `/settings/${encodeURIComponent(key)}`, headers: { 'x-access-token': await tokenFor(role) } });

    before(async () => {
        ({ app } = await buildApp());
        const settings = db.database.collection('settings');
        await settings.insertMany([
            { key: JMAP_KEY, value: JSON.stringify({ privateKey: 'secret' }), enumerable: false, encrypted: false, created: new Date() },
            { key: HIDDEN_KEY, value: JSON.stringify({ accountKey: 'secret' }), enumerable: false, encrypted: false, created: new Date() }
        ]);
    });

    after(async () => {
        await db.database.collection('settings').deleteMany({ key: { $in: [JMAP_KEY, HIDDEN_KEY, `${HIDDEN_KEY}-enc`] } });
        for (const tokenHash of tokens) {
            await deleteRoleToken(tokenHash);
        }
        if (app) {
            await app.close();
        }
    });

    it('should GET /settings/{key} expect failure / hidden settings for a read only role', async () => {
        for (const key of [JMAP_KEY, HIDDEN_KEY]) {
            const res = await getSetting(key, 'api:read');
            expect(res.statusCode, key).to.equal(404);
            expect(res.json().code).to.equal('SettingNotFound');
            expect(res.body).to.not.include('secret');
        }
    });

    it('should GET /settings/{key} expect success / hidden settings for a role that writes settings', async () => {
        const res = await getSetting(JMAP_KEY, 'settings');
        expect(res.statusCode).to.equal(200);
        expect(res.json().value).to.deep.equal({ privateKey: 'secret' });
    });

    it('should GET /settings/{key} expect success / a known setting for a read only role', async () => {
        const res = await getSetting('const:max:mailboxes', 'api:read');
        expect(res.statusCode).to.equal(200);
        expect(res.json().value).to.be.a('number');
    });

    it('stores an encrypted setting as encrypted and reads it back', async () => {
        const handler = new SettingsHandler({ db: db.database });
        await handler.set(`${HIDDEN_KEY}-enc`, { a: 1 }, { encrypt: true, secret: 'test secret', enumerable: false });
        const row = await db.database.collection('settings').findOne({ key: `${HIDDEN_KEY}-enc` });
        expect(row.encrypted).to.be.true;
        expect(row.value).to.not.include('"a"');
        expect(await handler.get(`${HIDDEN_KEY}-enc`, { secret: 'test secret' })).to.deep.equal({ a: 1 });
        expect(await handler.isHidden(`${HIDDEN_KEY}-enc`)).to.be.true;
    });
});
