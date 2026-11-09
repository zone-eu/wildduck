/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { buildApp } = require('./_inprocess');
const { createRoleToken, deleteRoleToken } = require('./_helpers');
const db = require('../../lib/db');
const consts = require('../../lib/consts');
const { USER_LIMIT_FIELDS } = require('../../lib/user-limits');

const call = async (app, method, url, payload, token) => {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: token ? { 'x-access-token': token } : {} });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).to.equal(200);
    return response.json();
};

const overrides = {
    maxMailboxes: 10,
    maxLabels: 2,
    maxRecipientsPerMessage: 3,
    maxApplicationPasswords: 1,
    maxMcpTokens: 2,
    autoreplyInterval: 60000
};

describe('Per-user limits API', function () {
    this.timeout(30000); // eslint-disable-line no-invalid-this

    let app, user, ownToken;

    before(async () => {
        ({ app } = await buildApp());
        const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        user = (
            await call(app, 'POST', '/users', {
                username: `limits-${run}`,
                address: `limits-${run}@example.com`,
                password: 'test-password',
                ...overrides
            })
        ).id;
        ownToken = await createRoleToken('user', user);
    });

    after(async () => {
        if (ownToken) {
            await deleteRoleToken(ownToken.tokenHash);
        }
        if (user) {
            await call(app, 'DELETE', `/users/${user}`);
        }
        if (app) {
            await app.close();
        }
    });

    it('persists overrides and exposes configured values and effective allowances', async () => {
        const result = await call(app, 'GET', `/users/${user}`);
        const stored = await db.users.collection('users').findOne({ _id: new ObjectId(user) });
        for (const field of USER_LIMIT_FIELDS) {
            expect(stored[field], field).to.equal(overrides[field]);
            expect(result[field], field).to.equal(overrides[field]);
            expect(result.limits[field].allowed, field).to.equal(overrides[field]);
        }
        expect(result.limits.maxMailboxes.used).to.be.greaterThan(0);
        expect(result.limits.maxLabels.used).to.equal(0);
    });

    it('does not allow an account to change its own allowances', async () => {
        await call(app, 'PUT', `/users/${user}`, Object.fromEntries(USER_LIMIT_FIELDS.map(field => [field, 999999])), ownToken.accessToken);
        const stored = await db.users.collection('users').findOne({ _id: new ObjectId(user) });
        for (const field of USER_LIMIT_FIELDS) {
            expect(stored[field], field).to.equal(overrides[field]);
        }
    });

    it('rejects negative, fractional and unsafe integer allowances', async () => {
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            for (const field of USER_LIMIT_FIELDS) {
                const response = await app.inject({ method: 'PUT', url: `/users/${user}`, payload: { [field]: value } });
                expect(response.statusCode, `${field}: ${value}`).to.equal(400);
                expect(response.json().code).to.equal('InputValidationError');
                expect(JSON.stringify(response.json().details)).to.include(field);
            }
        }
    });

    it('enforces mailbox and label allowances while preserving existing resources after lowering', async () => {
        const mailboxes = (await call(app, 'GET', `/users/${user}/mailboxes`)).results;
        await call(app, 'PUT', `/users/${user}`, { maxMailboxes: mailboxes.length - 1 });
        const mailboxResponse = await app.inject({ method: 'POST', url: `/users/${user}/mailboxes`, payload: { path: 'Over limit' } });
        expect(mailboxResponse.statusCode).to.equal(400);
        expect(mailboxResponse.json().code).to.equal('DisallowedMailboxMethod');
        expect((await call(app, 'GET', `/users/${user}/mailboxes`)).results).to.have.length(mailboxes.length);
        await call(app, 'PUT', `/users/${user}`, { maxMailboxes: overrides.maxMailboxes });

        await call(app, 'POST', `/users/${user}/labels`, { name: 'First' });
        await call(app, 'POST', `/users/${user}/labels`, { name: 'Second' });
        const labelResponse = await app.inject({ method: 'POST', url: `/users/${user}/labels`, payload: { name: 'Third' } });
        expect(labelResponse.statusCode).to.equal(400);
        expect(labelResponse.json().code).to.equal('LabelLimitExceeded');
        await call(app, 'PUT', `/users/${user}`, { maxLabels: 1 });
        await call(app, 'POST', `/users/${user}/labels`, { name: 'First' });
        expect((await call(app, 'GET', `/users/${user}/labels`)).labels).to.have.length(2);
        await call(app, 'PUT', `/users/${user}`, { maxLabels: overrides.maxLabels });
    });

    it('does not expose or accept removed per-user size fields', async () => {
        const userData = await call(app, 'GET', `/users/${user}`);
        for (const field of ['maxMessageSize', 'maxAttachmentSize']) {
            expect(userData).not.to.have.property(field);
            expect(userData.limits).not.to.have.property(field);
            for (const [method, url] of [['PUT', `/users/${user}`], ['POST', '/users']]) {
                const response = await app.inject({ method, url, payload: method === 'POST' ? { username: 'unused-size-field', password: 'test-password', [field]: 128 } : { [field]: 128 } });
                expect(response.statusCode).to.equal(400);
                expect(response.json().code).to.equal('InputValidationError');
                expect(JSON.stringify(response.json().details)).to.include(field);
            }
        }
    });

    it('enforces the per-user persistent MCP token allowance', async () => {
        const tokens = [];
        try {
            tokens.push((await call(app, 'POST', `/users/${user}/mcp-tokens`, { description: 'First' })).id);
            tokens.push((await call(app, 'POST', `/users/${user}/mcp-tokens`, { description: 'Second' })).id);
            const response = await app.inject({ method: 'POST', url: `/users/${user}/mcp-tokens`, payload: { description: 'Third' } });
            expect(response.statusCode).to.equal(403);
            expect(response.json().code).to.equal('TooMany');
        } finally {
            for (const token of tokens) {
                await call(app, 'DELETE', `/users/${user}/mcp-tokens/${token}`);
            }
        }
    });

    it('enforces the per-user application password allowance and permits inheritance again', async () => {
        await call(app, 'POST', `/users/${user}/asps`, { description: 'First', scopes: ['imap'] });
        const rejected = await app.inject({ method: 'POST', url: `/users/${user}/asps`, payload: { description: 'Second', scopes: ['imap'] } });
        expect(rejected.statusCode).to.equal(403);
        expect(rejected.json().code).to.equal('TooMany');
        await call(app, 'PUT', `/users/${user}`, { maxApplicationPasswords: 0 });
        await call(app, 'POST', `/users/${user}/asps`, { description: 'Second', scopes: ['imap'] });
    });

    it('updates all allowances and resets them to deployment defaults with zero', async () => {
        const updated = Object.fromEntries(USER_LIMIT_FIELDS.map(field => [field, overrides[field] * 2]));
        await call(app, 'PUT', `/users/${user}`, updated);
        const result = await call(app, 'GET', `/users/${user}`);
        for (const field of USER_LIMIT_FIELDS) {
            expect(result[field], field).to.equal(updated[field]);
            expect(result.limits[field].allowed, field).to.equal(updated[field]);
        }
        await call(app, 'PUT', `/users/${user}`, Object.fromEntries(USER_LIMIT_FIELDS.map(field => [field, 0])));
        const inherited = await call(app, 'GET', `/users/${user}`);
        for (const field of USER_LIMIT_FIELDS) {
            expect(inherited[field], field).to.equal(0);
            expect(inherited.limits[field].allowed, field).to.be.greaterThan(0);
        }
        expect(inherited.limits.maxLabels.allowed).to.equal(consts.MAX_LABELS);
    });

});
