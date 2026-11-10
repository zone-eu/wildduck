/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const { buildApp } = require('./_inprocess');
const { createRoleToken, deleteRoleToken } = require('./_helpers');
const db = require('../../lib/db');
const { ObjectId } = require('mongodb');
const McpTokenHandler = require('../../lib/mcp-token-handler');

describe('API user role and permission policies', function () {
    this.timeout(120000); // eslint-disable-line no-invalid-this

    let app;
    let rootToken;
    let user;
    let username;
    let ownToken;
    let otherToken;
    const tokenHashes = [];
    const users = [];
    let mcpTokenId;

    const request = (method, url, token = rootToken.accessToken, payload) =>
        app.inject({
            method,
            url,
            headers: { 'x-access-token': token, ...(payload ? { 'content-type': 'application/json' } : {}) },
            ...(payload ? { payload: JSON.stringify(payload) } : {})
        });
    const makeToken = async (role, id) => {
        const token = await createRoleToken(role, id);
        tokenHashes.push(token.tokenHash);
        return token;
    };
    const setPolicy = async policy => {
        const response = await request('PUT', `/users/${user}`, rootToken.accessToken, policy);
        expect(response.statusCode).to.equal(200);
    };

    before(async () => {
        ({ app } = await buildApp());
        rootToken = await makeToken('root');
        username = `policy-${crypto.randomBytes(6).toString('hex')}`;
        const created = await request('POST', '/users', rootToken.accessToken, {
            username,
            password: false,
            role: 'user',
            permissions: { labels: { create: true } },
            name: 'Policy test',
            address: `${username}@example.org`
        });
        expect(created.statusCode).to.equal(200);
        user = created.json().id;
        users.push(user);
        const details = await request('GET', `/users/${user}`);
        expect(details.json()).to.include({ role: 'user' });
        expect(details.json().permissions).to.deep.equal({ labels: { create: true } });
        ownToken = await makeToken('user', user);
        otherToken = await makeToken('user', user);
    });

    beforeEach(async () => {
        await setPolicy({ role: null, permissions: null });
    });

    after(async () => {
        if (mcpTokenId) {
            await db.users.collection('mcptokens').deleteOne({ _id: new ObjectId(mcpTokenId) });
        }
        for (const id of users) {
            await request('DELETE', `/users/${id}`, rootToken.accessToken);
        }
        for (const hash of tokenHashes) {
            await deleteRoleToken(hash);
        }
        if (app) {
            await app.close();
        }
    });

    it('applies updated resource restrictions to already issued user tokens', async () => {
        let response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Denied label' });
        expect(response.statusCode).to.equal(200);
        const labelId = response.json().id;

        await setPolicy({ permissions: { labels: { create: false, read: false, update: false, delete: false }, filters: { create: false } } });
        response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Denied label' });
        expect(response.statusCode).to.equal(403);
        response = await request('POST', `/users/${user}/filters`, ownToken.accessToken, { name: 'Denied filter', query: {}, action: {} });
        expect(response.statusCode).to.equal(403);
        for (const [method, url, payload] of [
            ['GET', `/users/${user}/labels`],
            ['PUT', `/users/${user}/labels/${labelId}`, { name: 'Renamed label' }],
            ['DELETE', `/users/${user}/labels/${labelId}`]
        ]) {
            response = await request(method, url, ownToken.accessToken, payload);
            expect(response.statusCode).to.equal(403);
            expect(response.json().code).to.equal('MissingPrivileges');
        }

        await setPolicy({ permissions: null });
        response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Restored label' });
        expect(response.statusCode).to.equal(200);
    });

    it('allows root to assign configured roles, clears them with null, and preserves explicit token roles', async () => {
        await setPolicy({ role: 'api:read', permissions: { labels: { read: true } } });
        const details = await request('GET', `/users/${user}`, rootToken.accessToken);
        expect(details.statusCode).to.equal(200);
        expect(details.json().role).to.equal('api:read');
        expect(details.json()).to.have.property('permissions');
        const ownDetails = await request('GET', `/users/${user}`, ownToken.accessToken);
        expect(ownDetails.statusCode).to.equal(200);
        expect(ownDetails.json().role).to.equal('api:read');
        expect(ownDetails.json().permissions).to.deep.equal({ labels: { read: true } });
        const explicitRootToken = await makeToken('root', user);
        let response = await request('GET', `/users/${user}/labels`, explicitRootToken.accessToken);
        expect(response.statusCode).to.equal(200);
        response = await request('POST', '/authenticate/mcp', explicitRootToken.accessToken, {});
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('MasterTokenRequired');
        response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Role denied label' });
        expect(response.statusCode).to.equal(403);

        await setPolicy({ role: 'manager' });
        response = await request('POST', '/authenticate/mcp', ownToken.accessToken, {});
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('MasterTokenNotEligible');
        await setPolicy({ permissions: { authentication: { create: false } } });
        response = await request('POST', '/authenticate/mcp', ownToken.accessToken, {});
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('MissingPrivileges');
        await setPolicy({ role: null, permissions: {} });
        response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Empty map restored label' });
        expect(response.statusCode).to.equal(200);
        await setPolicy({ permissions: { labels: { create: false } } });
        await setPolicy({ name: 'Omitted permissions remain unchanged' });
        response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Still denied' });
        expect(response.statusCode).to.equal(403);
        await setPolicy({ permissions: { filters: { create: false } } });
        response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Replacement map restored label' });
        expect(response.statusCode).to.equal(200);
        await setPolicy({ role: null, permissions: null });
        response = await request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Null role restored label' });
        expect(response.statusCode).to.equal(200);
        response = await request('POST', `/users/${user}/labels`, rootToken.accessToken, { name: 'Root label' });
        expect(response.statusCode).to.equal(200);
    });

    it('exposes stored policies through user readOwn and readAny grants in details and listings', async () => {
        const policy = { role: 'user', permissions: { labels: { create: false } } };
        await setPolicy(policy);
        const readerToken = await makeToken('api:read');
        const boundReaderToken = await makeToken('api:read', user);

        for (const token of [rootToken, ownToken, readerToken, boundReaderToken]) {
            const details = await request('GET', `/users/${token === ownToken || token === boundReaderToken ? 'me' : user}`, token.accessToken);
            expect(details.statusCode).to.equal(200);
            expect(details.json()).to.deep.include(policy);
            const listing = await request('GET', `/users?query=${username}`, token.accessToken);
            expect(listing.statusCode).to.equal(200);
            expect(listing.json().results).to.have.length(1);
            expect(listing.json().results[0]).to.deep.include(policy);
        }

        // A user-bound role with read:any can also read other users' policies.
        const other = await request('POST', '/users', rootToken.accessToken, {
            username: `${username}-visible`,
            password: false,
            ...policy
        });
        expect(other.statusCode).to.equal(200);
        users.push(other.json().id);
        const mixed = await request('GET', `/users?query=${username}`, boundReaderToken.accessToken);
        expect(mixed.statusCode).to.equal(200);
        expect(mixed.json().results).to.have.length(2);
        expect(mixed.json().results.find(entry => entry.id === user)).to.deep.include(policy);
        expect(mixed.json().results.find(entry => entry.id === other.json().id)).to.deep.include(policy);
        const denied = await request('GET', `/users/${other.json().id}`, ownToken.accessToken);
        expect(denied.statusCode).to.equal(403);
        const ownListing = await request('GET', `/users?query=${username}`, ownToken.accessToken);
        expect(ownListing.statusCode).to.equal(200);
        expect(ownListing.json().results.map(entry => entry.id)).to.deep.equal([user]);

        await setPolicy({ role: null, permissions: null });
        const cleared = await request('GET', `/users/${user}`, ownToken.accessToken);
        expect(cleared.statusCode).to.equal(200);
        expect(cleared.json()).not.to.have.any.keys('role', 'permissions');
    });

    it('uses the same policy visibility in authentication identity responses', async () => {
        const policy = { role: 'user', permissions: { labels: { create: false } } };
        const password = 'Policy-test-password-123';
        const authUsername = `policy-auth-${crypto.randomBytes(6).toString('hex')}`;
        const created = await request('POST', '/users', rootToken.accessToken, { username: authUsername, ...policy, password, allowUnsafe: true });
        expect(created.statusCode).to.equal(200);
        users.push(created.json().id);
        const ownManagerToken = await makeToken('manager', created.json().id);
        const managerToken = await makeToken('manager');
        const authOnlyToken = await makeToken('tokenAuth');
        const asp = await request('POST', `/users/${created.json().id}/asps`, rootToken.accessToken, {
            description: 'Policy authentication test',
            scopes: ['imap']
        });
        expect(asp.statusCode).to.equal(200);
        for (const path of ['/preauth', '/authenticate']) {
            for (const token of [rootToken, ownManagerToken, managerToken, authOnlyToken]) {
                const response = await request('POST', path, token.accessToken, {
                    username: authUsername,
                    ...(path === '/authenticate' ? { password } : {})
                });
                expect(response.statusCode).to.equal(200);
                if (token === authOnlyToken) {
                    expect(response.json()).not.to.have.any.keys('role', 'permissions');
                } else {
                    expect(response.json()).to.deep.include(policy);
                }
            }
        }
        for (const token of [managerToken, authOnlyToken]) {
            const response = await request('POST', '/authenticate', token.accessToken, {
                username: authUsername,
                password: asp.json().password,
                scope: 'imap'
            });
            expect(response.statusCode).to.equal(200);
            if (token === authOnlyToken) {
                expect(response.json()).not.to.have.any.keys('role', 'permissions');
            } else {
                expect(response.json()).to.deep.include(policy);
            }
        }
    });

    it('allows policy writes through normal user create and update grants', async () => {
        const managerToken = await makeToken('manager');
        const policy = { role: 'api:read', permissions: { labels: { create: false } } };
        const created = await request('POST', '/users', managerToken.accessToken, {
            username: `policy-created-${crypto.randomBytes(6).toString('hex')}`,
            password: false,
            ...policy
        });
        expect(created.statusCode).to.equal(200);
        const id = created.json().id;
        users.push(id);
        expect((await request('GET', `/users/${id}`)).json()).to.deep.include(policy);

        for (const update of [policy, { role: null, permissions: null }]) {
            const response = await request('PUT', `/users/${user}`, managerToken.accessToken, update);
            expect(response.statusCode).to.equal(200);
            const details = (await request('GET', `/users/${user}`)).json();
            if (update.role === null) {
                expect(details).not.to.have.any.keys('role', 'permissions');
            } else {
                expect(details).to.deep.include(update);
            }
        }
    });

    it('preserves user write denial and attribute filtering for policy fields', async () => {
        const readerToken = await makeToken('api:read');
        for (const payload of [{ role: 'user' }, { role: null }, { permissions: {} }]) {
            const response = await request('PUT', `/users/${user}`, readerToken.accessToken, payload);
            expect(response.statusCode).to.equal(403);
            expect(response.json().code).to.equal('MissingPrivileges');
        }

        const policy = { role: 'user', permissions: { labels: { create: false } } };
        await setPolicy(policy);
        const filtered = await request('PUT', '/users/me', ownToken.accessToken, { role: 'root', permissions: null, name: 'Allowed name update' });
        expect(filtered.statusCode).to.equal(200);
        expect((await request('GET', `/users/${user}`)).json()).to.deep.include({ ...policy, name: 'Allowed name update' });

        await setPolicy({ permissions: { users: { update: false } } });
        const boundManagerToken = await makeToken('manager', user);
        const denied = await request('PUT', `/users/${user}`, boundManagerToken.accessToken, { permissions: null });
        expect(denied.statusCode).to.equal(403);
        expect(denied.json().code).to.equal('MissingPrivileges');
    });

    it('rejects malformed policy values', async () => {
        for (const payload of [
            { role: 'unknown-role' },
            { permissions: { unknownResource: { read: false } } },
            { permissions: { labels: { publish: false } } },
            { permissions: { labels: { create: 'false' } } }
        ]) {
            const response = await request('PUT', `/users/${user}`, rootToken.accessToken, payload);
            expect(response.statusCode).to.equal(400);
            expect(response.json().code).to.equal('InputValidationError');
        }
    });

    it('keeps permission updates isolated to the targeted user', async () => {
        const username = `policy-other-${crypto.randomBytes(6).toString('hex')}`;
        const created = await request('POST', '/users', rootToken.accessToken, {
            username,
            password: false,
            name: 'Other policy test',
            address: `${username}@example.org`
        });
        expect(created.statusCode).to.equal(200);
        const secondUser = created.json().id;
        users.push(secondUser);
        const secondToken = await makeToken('user', secondUser);

        await setPolicy({ permissions: { labels: { create: false } } });
        const responses = await Promise.all([
            request('POST', `/users/${user}/labels`, ownToken.accessToken, { name: 'Isolated denied label' }),
            request('POST', `/users/${secondUser}/labels`, secondToken.accessToken, { name: 'Isolated allowed label' }),
            request('POST', `/users/${user}/labels`, otherToken.accessToken, { name: 'Concurrent denied label' })
        ]);
        expect(responses.map(response => response.statusCode)).to.deep.equal([403, 200, 403]);
    });

    it('fails closed for invalid stored policies on an existing API token', async () => {
        await db.users.collection('users').updateOne({ _id: new ObjectId(user) }, { $set: { role: 'missing-role' } });
        let response = await request('GET', `/users/${user}`, ownToken.accessToken);
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('InvalidToken');
        await setPolicy({ role: null });
        await db.users.collection('users').updateOne({ _id: new ObjectId(user) }, { $set: { permissions: { labels: { read: 'false' } } } });
        response = await request('GET', `/users/${user}`, ownToken.accessToken);
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('InvalidToken');
    });

    it('applies updated policies to existing MCP tokens on their next API request', async () => {
        const handler = new McpTokenHandler({ users: db.users, redis: db.redis });
        const token = await handler.create(user, { description: 'permissions integration test' });
        mcpTokenId = token.id;
        const call = () => app.inject({ method: 'GET', url: `/users/${user}/labels`, headers: { authorization: `Bearer ${token.token}` } });
        expect((await call()).statusCode).to.equal(200);
        await setPolicy({ role: 'user', permissions: { labels: { read: true } } });
        const details = await app.inject({ method: 'GET', url: `/users/${user}`, headers: { authorization: `Bearer ${token.token}` } });
        expect(details.statusCode).to.equal(200);
        expect(details.json()).not.to.have.any.keys('role', 'permissions');
        await setPolicy({ permissions: { labels: { read: false } } });
        const denied = await call();
        expect(denied.statusCode).to.equal(403);
        expect(denied.json().code).to.equal('InvalidToken');
        await setPolicy({ permissions: null });
        expect((await call()).statusCode).to.equal(200);
    });
});
