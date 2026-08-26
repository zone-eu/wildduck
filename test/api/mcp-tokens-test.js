/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const crypto = require('crypto');
const supertest = require('supertest');
const chai = require('chai');
const { ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');

const expect = chai.expect;
const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('MCP access token API', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let userId;
    let otherUserId;
    let apiToken;
    let mcpToken;
    let mcpTokenId;
    const suffix = `${process.pid}-${Date.now()}`;
    const username = `mcp-token-user-${suffix}`;
    const otherUsername = `mcp-token-other-${suffix}`;

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));

        let userResponse = await server
            .post('/users')
            .send({ username, address: `${username}@example.com`, password: 'secretpass' })
            .expect(200);
        userId = userResponse.body.id;

        let otherResponse = await server
            .post('/users')
            .send({ username: otherUsername, address: `${otherUsername}@example.com`, password: 'secretpass' })
            .expect(200);
        otherUserId = otherResponse.body.id;

        let authResponse = await server
            .post('/authenticate')
            .send({ username: `${username}@example.com`, password: 'secretpass', scope: 'master', token: true })
            .expect(200);
        apiToken = authResponse.body.token;
        expect(apiToken).to.match(/^[a-f0-9]{40}$/);
    });

    after(async () => {
        if (userId) await db.users.collection('mcptokens').deleteMany({ user: new ObjectId(userId) });
        if (otherUserId) await db.users.collection('mcptokens').deleteMany({ user: new ObjectId(otherUserId) });
        if (userId) await server.delete(`/users/${userId}`).expect(200);
        if (otherUserId) await server.delete(`/users/${otherUserId}`).expect(200);
    });

    it('should POST /users/{user}/mcp-tokens expect failure / without a description', async () => {
        let response = await server.post(`/users/${userId}/mcp-tokens`).send({}).expect(400);
        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should POST /users/{user}/mcp-tokens expect success / return the plaintext token once', async () => {
        let response = await server.post(`/users/${userId}/mcp-tokens`).send({ description: 'Codex' }).expect(200);

        expect(response.body.success).to.equal(true);
        expect(response.body.token).to.match(/^wdmcp_[a-f0-9]{64}$/);
        expect(response.body.role).to.equal('mcp:read');
        expect(response.body.audience).to.equal('mcp');
        expect(response.body.expires).not.to.exist;
        mcpToken = response.body.token;
        mcpTokenId = response.body.id;

        let stored = await db.users.collection('mcptokens').findOne({ _id: new ObjectId(mcpTokenId) });
        expect(stored).to.exist;
        expect(stored).not.to.have.property('token');
        expect(stored.hash).to.equal(crypto.createHash('sha256').update(mcpToken).digest('hex'));
        expect(JSON.stringify(stored)).not.to.include(mcpToken);
    });

    it('should POST /users/{user}/mcp-tokens expect success / with a future expiration', async () => {
        let expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        let response = await server
            .post(`/users/${userId}/mcp-tokens`)
            .send({ description: 'Temporary client', expires })
            .expect(200);

        expect(new Date(response.body.expires).getTime()).to.equal(new Date(expires).getTime());
    });

    it('should GET /users/{user}/mcp-tokens expect success / never return secrets or hashes', async () => {
        let response = await server.get(`/users/${userId}/mcp-tokens`).expect(200);

        expect(response.body.success).to.equal(true);
        expect(response.body.results).to.have.length(2);
        expect(response.body.results.find(entry => entry.id === mcpTokenId)).to.include({
            description: 'Codex',
            role: 'mcp:read',
            audience: 'mcp'
        });
        expect(JSON.stringify(response.body)).not.to.include(mcpToken);
        for (let entry of response.body.results) {
            expect(entry).not.to.have.any.keys('token', 'hash', 'authVersion', 'user');
        }
    });

    it('should GET /users/{user} expect failure / when an MCP token is replayed against REST', async () => {
        let response = await server.get(`/users/${userId}`).set('Authorization', `Bearer ${mcpToken}`).expect(403);
        expect(response.body.code).to.equal('InvalidToken');
    });

    it('should POST /users/{user}/mcp-tokens expect success / for a user managing their own token', async () => {
        let response = await server
            .post(`/users/${userId}/mcp-tokens`)
            .set('Authorization', `Bearer ${apiToken}`)
            .send({ description: 'Self-managed' })
            .expect(200);
        expect(response.body.token).to.match(/^wdmcp_[a-f0-9]{64}$/);
    });

    it('should POST /users/{user}/mcp-tokens expect failure / for another user', async () => {
        let response = await server
            .post(`/users/${otherUserId}/mcp-tokens`)
            .set('Authorization', `Bearer ${apiToken}`)
            .send({ description: 'Cross-user attempt' })
            .expect(403);
        expect(response.body.code).to.equal('MissingPrivileges');
    });

    it('should DELETE /users/{user}/mcp-tokens/{token} expect success / revoke by record ID', async () => {
        await server.delete(`/users/${userId}/mcp-tokens/${mcpTokenId}`).expect(200);
        expect(await db.users.collection('mcptokens').findOne({ _id: new ObjectId(mcpTokenId) })).to.equal(null);

        let response = await server.get(`/users/${userId}/mcp-tokens`).expect(200);
        expect(response.body.results.some(entry => entry.id === mcpTokenId)).to.equal(false);
    });
});
