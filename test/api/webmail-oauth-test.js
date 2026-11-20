/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

/* globals before: false */

'use strict';

const crypto = require('crypto');
const supertest = require('supertest');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const { uniqueName } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function createUser(prefix) {
    const username = uniqueName(prefix);
    const response = await server
        .post('/users')
        .send({ username, password: 'secretvalue', address: `${username}@example.com` })
        .expect(200);
    return { id: response.body.id, username };
}

async function mcpToken(user) {
    const response = await server.post(`/users/${user.id}/mcp-tokens`).send({ description: 'OAuth: Test client' }).expect(200);
    return { id: response.body.id, token: response.body.token };
}

describe('Webmail OAuth clients and grants', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let client;

    before(async () => {
        user = await createUser('wmoauth');
        const response = await server
            .post('/webmail/oauth/clients')
            .send({ name: 'Test client', redirectUris: ['https://client.example/callback', 'http://127.0.0.1:33418/cb'] })
            .expect(200);
        client = response.body;
    });

    it('registers clients with https or loopback redirect URIs only', async () => {
        expect(client).to.include({ success: true, name: 'Test client' });
        expect(client.redirectUris).to.deep.equal(['https://client.example/callback', 'http://127.0.0.1:33418/cb']);
        const read = await server.get(`/webmail/oauth/clients/${client.id}`).expect(200);
        expect(read.body.name).to.equal('Test client');

        for (const redirectUris of [['http://client.example/cb'], ['https://client.example/cb#x'], ['javascript:alert(1)'], []]) {
            const response = await server.post('/webmail/oauth/clients').send({ name: 'Bad', redirectUris });
            expect(response.status, JSON.stringify(redirectUris)).to.equal(400);
        }
    });

    it('keeps clients away from user tokens', async () => {
        const auth = await server.post('/authenticate').send({ username: user.username, password: 'secretvalue', token: true }).expect(200);
        await server.get(`/webmail/oauth/clients/${client.id}?accessToken=${auth.body.token}`).expect(403);
        await server
            .post(`/webmail/oauth/clients?accessToken=${auth.body.token}`)
            .send({ name: 'Mine', redirectUris: ['https://mine.example/cb'] })
            .expect(403);
    });

    it('stores, finds, rotates and removes a grant, revoking its MCP tokens', async () => {
        const first = await mcpToken(user);
        const created = await server
            .post(`/users/${user.id}/webmail/oauth/grants`)
            .send({
                client: client.id,
                scope: 'mcp:read',
                mcpToken: first.id,
                refreshHash: hash('refresh-1'),
                accessHash: hash(first.token),
                expires: new Date(Date.now() + 86400000).toISOString()
            })
            .expect(200);
        const grant = created.body.id;
        expect(created.body).to.include({ clientName: 'Test client', scope: 'mcp:read', mcpToken: first.id });
        expect(created.body).to.not.have.property('refreshHash');

        const found = await server.get(`/users/${user.id}/webmail/oauth/grants?refreshHash=${hash('refresh-1')}`).expect(200);
        expect(found.body.results.map(entry => entry.id)).to.deep.equal([grant]);
        const missing = await server.get(`/users/${user.id}/webmail/oauth/grants?refreshHash=${hash('other')}`).expect(200);
        expect(missing.body.results).to.deep.equal([]);

        const second = await mcpToken(user);
        const rotated = await server
            .put(`/users/${user.id}/webmail/oauth/grants/${grant}`)
            .send({ previousRefreshHash: hash('refresh-1'), mcpToken: second.id, refreshHash: hash('refresh-2'), accessHash: hash(second.token) })
            .expect(200);
        // the same refresh token again finds nothing
        const third = await mcpToken(user);
        await server
            .put(`/users/${user.id}/webmail/oauth/grants/${grant}`)
            .send({ previousRefreshHash: hash('refresh-1'), mcpToken: third.id, refreshHash: hash('refresh-3'), accessHash: hash(third.token) })
            .expect(404);
        await server.delete(`/users/${user.id}/mcp-tokens/${third.id}`).expect(200);
        expect(rotated.body.mcpToken).to.equal(second.id);
        let tokens = (await server.get(`/users/${user.id}/mcp-tokens`).expect(200)).body.results.map(entry => entry.id);
        expect(tokens).to.deep.equal([second.id]);
        const byAccess = await server.get(`/users/${user.id}/webmail/oauth/grants?accessHash=${hash(second.token)}`).expect(200);
        expect(byAccess.body.results).to.have.length(1);

        const removed = await server.delete(`/users/${user.id}/webmail/oauth/grants/${grant}`).expect(200);
        expect(removed.body.deleted).to.be.true;
        tokens = (await server.get(`/users/${user.id}/mcp-tokens`).expect(200)).body.results;
        expect(tokens).to.deep.equal([]);
        expect((await server.get(`/users/${user.id}/webmail/oauth/grants`).expect(200)).body.results).to.deep.equal([]);
    });

    it('refuses grants for unknown clients and malformed hashes', async () => {
        const token = await mcpToken(user);
        const base = {
            client: client.id,
            scope: 'mcp:read',
            mcpToken: token.id,
            refreshHash: hash('a'),
            accessHash: hash('b'),
            expires: new Date(Date.now() + 86400000).toISOString()
        };
        await server
            .post(`/users/${user.id}/webmail/oauth/grants`)
            .send({ ...base, client: '0123456789abcdef01234567' })
            .expect(400);
        await server
            .post(`/users/${user.id}/webmail/oauth/grants`)
            .send({ ...base, refreshHash: 'plain-token' })
            .expect(400);
    });
});
