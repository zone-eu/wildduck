/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// Pins the defects found by route-fuzz-test.js, authorization-matrix-test.js and
// the response contract check, one case each, so a regression shows up by name.

const chai = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../../lib/db');
const plugins = require('../../lib/plugins');
const { buildApp } = require('./_inprocess');
const { createFixtures } = require('./_fixtures');
const { createRoleToken, deleteRoleToken } = require('./_helpers');
const { PassThrough } = require('stream');

const expect = chai.expect;

describe('API defects found by fuzzing and the authorization matrix', function () {
    this.timeout(60 * 1000); // eslint-disable-line no-invalid-this

    let app;
    let violations;
    let fixtures;
    let other;

    const send = (method, url, body, token) =>
        app.inject({
            method,
            url,
            headers: { ...(token ? { 'x-access-token': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {})
        });

    const unknownMailbox = new ObjectId().toString();

    before(async () => {
        ({ app, violations } = await buildApp());
        fixtures = await createFixtures(app, 'ff');
        other = await createFixtures(app, 'fo');
        violations.clear();
    });

    after(async () => {
        for (const entry of [fixtures, other]) {
            if (entry) {
                await entry.cleanup();
            }
        }
        if (app) {
            await app.close();
        }
    });

    it('answers a message update in an unknown mailbox with 404 NoSuchMailbox', async () => {
        const single = await send('PUT', `/users/${fixtures.ids.user}/mailboxes/${unknownMailbox}/messages/1`, { seen: true });
        expect(single.statusCode).to.equal(404);
        expect(single.json().code).to.equal('NoSuchMailbox');

        const range = await send('PUT', `/users/${fixtures.ids.user}/mailboxes/${unknownMailbox}/messages`, { message: '1:*', seen: true });
        expect(range.statusCode).to.equal(404);
        expect(range.json().code).to.equal('NoSuchMailbox');
    });

    it('answers a move to an unknown mailbox with 404 NoSuchMailbox', async () => {
        const res = await send('PUT', `/users/${fixtures.ids.user}/mailboxes/${fixtures.ids.mailbox}/messages/${fixtures.path.message}`, {
            moveTo: unknownMailbox
        });
        expect(res.statusCode).to.equal(404);
        expect(res.json().code).to.equal('NoSuchMailbox');
    });

    it('answers a message update without changes with 400 NothingChanged', async () => {
        const res = await send('PUT', `/users/${fixtures.ids.user}/mailboxes/${fixtures.ids.mailbox}/messages`, { message: '1:*' });
        expect(res.statusCode).to.equal(400);
        expect(res.json().code).to.equal('NothingChanged');

        const mailbox = await send('PUT', `/users/${fixtures.ids.user}/mailboxes/${fixtures.ids.mailbox}`, {});
        expect(mailbox.statusCode).to.equal(400);
        expect(mailbox.json()).to.deep.equal({ error: 'Nothing was changed', code: 'NothingChanged' });
    });

    it('answers a JSON array body on a route with path params with 400 InvalidContent', async () => {
        const res = await send('POST', `/users/${fixtures.ids.user}/mailboxes`, '[1,2]');
        expect(res.statusCode).to.equal(400);
        expect(res.json().code).to.equal('InvalidContent');
    });

    it('accepts a submission whose envelope has no recipients', async () => {
        const res = await send('POST', `/users/${fixtures.ids.user}/submit`, {
            uploadOnly: true,
            envelope: { from: { address: fixtures.email } },
            to: [{ address: `rcpt@${fixtures.domain}` }],
            subject: 'envelope without recipients',
            text: 'body'
        });
        expect(res.statusCode).to.equal(200);
        expect(res.json().success).to.be.true;
    });

    it('refuses an attachment encoding that Buffer does not know with 400', async () => {
        const res = await send('POST', `/users/${fixtures.ids.user}/submit`, {
            uploadOnly: true,
            to: [{ address: `rcpt@${fixtures.domain}` }],
            subject: 'unknown encoding',
            text: 'body',
            attachments: [{ filename: 'x.txt', content: 'eA==', encoding: 'fuzz' }]
        });
        expect(res.statusCode).to.equal(400);
        expect(res.json().code).to.equal('InputValidationError');

        // the encodings Buffer knows keep working, in any letter case
        const ok = await send('POST', `/users/${fixtures.ids.user}/submit`, {
            uploadOnly: true,
            to: [{ address: `rcpt@${fixtures.domain}` }],
            subject: 'hex encoding',
            text: 'body',
            attachments: [{ filename: 'x.txt', content: '78', encoding: 'HEX' }]
        });
        expect(ok.statusCode).to.equal(200);
    });

    it('searches with a null byte in the query instead of failing in MongoDB', async () => {
        const res = await send('GET', `/users/${fixtures.ids.user}/addressregister?query=${encodeURIComponent('a\u0000b')}`);
        expect(res.statusCode).to.equal(200);
        expect(res.json().results).to.deep.equal([]);
    });

    it('answers a pre-hashed password the hashing library does not know with 400 HashError', async () => {
        const res = await send('PUT', `/users/${fixtures.ids.user}`, { password: 'not a hash', hashedPassword: true });
        expect(res.statusCode).to.equal(400);
        expect(res.json().code).to.equal('HashError');
    });

    it('lists authentication events with null and object fields as stored', async () => {
        const user = new ObjectId(fixtures.ids.user);
        const credential = { id: 'credential-id', description: 'Security key' };
        await db.users.collection('authlog').insertMany([
            { user, action: 'authentication', result: 'success', asp: null, aname: null, created: new Date(), expires: new Date(Date.now() + 3600 * 1000) },
            { user, action: 'register webauthn', result: 'success', credential, created: new Date(), expires: new Date(Date.now() + 3600 * 1000) }
        ]);

        const res = await send('GET', `/users/${fixtures.ids.user}/authlog?limit=250`);
        expect(res.statusCode).to.equal(200);
        const results = res.json().results;

        const plain = results.find(entry => entry.action === 'authentication' && 'asp' in entry);
        expect(plain.asp).to.equal(null);
        expect(plain.aname).to.equal(null);

        const registration = results.find(entry => entry.action === 'register webauthn');
        expect(registration.credential).to.deep.equal(credential);
    });

    it('gives unknown ACME challenges an error code', async () => {
        const res = await send('GET', '/.well-known/acme-challenge/unknown-token');
        expect(res.statusCode).to.equal(404);
        expect(res.json().code).to.equal('UnknownChallenge');
    });

    it('keeps the role of a token that changed the password of another account', async () => {
        // webmail holds users:update:any, its token belongs to an account
        const { accessToken, tokenHash } = await createRoleToken('webmail', fixtures.ids.user);
        try {
            const change = await send('PUT', `/users/${other.ids.user}`, { password: `other-${other.runId}-new` }, accessToken);
            expect(change.statusCode).to.equal(200);

            const stored = await db.redis.hgetall(`tn:token:${tokenHash}`);
            expect(stored.role).to.equal('webmail');

            // still a webmail token: reads another account
            const read = await send('GET', `/users/${other.ids.user}`, undefined, accessToken);
            expect(read.statusCode).to.equal(200);
        } finally {
            await deleteRoleToken(tokenHash);
        }
    });

    it('keeps the session of a token that changed its own password', async () => {
        const { accessToken, tokenHash } = await createRoleToken('user', fixtures.ids.user);
        try {
            const change = await send('PUT', `/users/${fixtures.ids.user}`, { password: `own-${fixtures.runId}-new` }, accessToken);
            expect(change.statusCode).to.equal(200);

            // the password change bumped authVersion, the refreshed token carries the new one
            const read = await send('GET', `/users/${fixtures.ids.user}`, undefined, accessToken);
            expect(read.statusCode).to.equal(200);
            expect((await db.redis.hgetall(`tn:token:${tokenHash}`)).role).to.equal('user');
        } finally {
            await deleteRoleToken(tokenHash);
        }
    });

    it('passes messages through the placeholder plugin handler before plugins are loaded', done => {
        const source = new PassThrough();
        const output = new PassThrough();
        const chunks = [];
        output.on('data', chunk => chunks.push(chunk));
        output.on('end', () => {
            expect(Buffer.concat(chunks).toString()).to.equal('message');
            done();
        });
        plugins.handler.runAnalyzerHooks({}, source, output);
        source.end('message');
    });

    it('answers in line with the response models', () => {
        const found = violations.list().map(f => `${f.method} ${f.route} ${f.statusCode} ${f.path}: ${f.kind}`);
        expect(found, found.join('\n')).to.deep.equal([]);
    });
});
