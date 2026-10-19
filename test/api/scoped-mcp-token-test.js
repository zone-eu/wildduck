/* eslint-env mocha */
/* eslint no-invalid-this: 0 */
/* eslint no-unused-expressions: 0 */

'use strict';

// Integration coverage for the scoped token exchange the OAuth backend relies on:
// minting MCP login sessions from a master API token (POST /authenticate/mcp), how the
// MCP service treats those sessions (sliding idle TTL, absolute lifetime, clean 401s),
// and revocation through the symmetric shape DELETE /authenticate/:scope/:token,
// reachable with any current master token of the same user.
//
// It also pins the two pre-deployment compatibility edges: a master token issued by the
// current flow for a user without 2FA must mint without any challenge, and a master token
// issued before the assurance metadata existed must be refused with a documented 403
// rather than a 500, so the backend can map it to "log in again".

const crypto = require('crypto');
const supertest = require('supertest');
const chai = require('chai');
const { ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);
const db = require('../../lib/db');
const mcp = require('../../mcp');
const McpTokenHandler = require('../../lib/mcp-token-handler');
const consts = require('../../lib/consts');

const API = `http://127.0.0.1:${config.api.port}`;
const MCP_PORT = 8101;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function createAccount(username, password) {
    const response = await server
        .post('/users')
        .send({ username, password, address: `${username}@example.com`, name: username })
        .expect(200);
    return { id: response.body.id, username, password };
}

async function loginMaster(account) {
    const response = await server.post('/authenticate').send({ username: account.username, password: account.password, token: true }).expect(200);
    expect(response.body.success).to.be.true;
    return response.body;
}

async function mintMcpSession(masterToken) {
    const response = await server.post('/authenticate/mcp').set('Authorization', `Bearer ${masterToken}`).expect(200);
    expect(response.body.success).to.be.true;
    return response.body;
}

async function mcpCall(token, method, params) {
    return fetch(MCP_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} })
    });
}

// A master token in the exact shape the pre-deployment code wrote: no assurance fields at
// all, so the API middleware cannot tell whether any 2FA ever happened.
function legacyMasterToken(userId, authVersion) {
    const token = crypto.randomBytes(20).toString('hex');
    const signature = crypto
        .createHmac('sha256', config.api.accessControl.secret)
        .update(JSON.stringify({ token, user: userId, authVersion, role: 'user' }))
        .digest('hex');
    return {
        token,
        data: {
            user: userId,
            role: 'user',
            token,
            created: Date.now(),
            ttl: 1209600,
            authVersion,
            s: signature
        }
    };
}

describe('Scoped MCP token exchange', function () {
    this.timeout(30000);

    let mcpServer;
    let account;
    let otherAccount;

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));

        account = await createAccount(`scopedmint${Date.now()}`, 'Secret123Secret');
        otherAccount = await createAccount(`scopedother${Date.now()}`, 'Secret123Secret');

        mcpServer = await new Promise((resolve, reject) =>
            mcp.start(
                {
                    enabled: true,
                    host: '127.0.0.1',
                    port: MCP_PORT,
                    path: '/mcp',
                    secure: false,
                    apiUrl: API,
                    allowedHosts: ['127.0.0.1'],
                    allowedOrigins: [],
                    maxRequestSize: 1048576,
                    maxResults: 50,
                    maxBodyChars: 20000
                },
                (err, started) => (err ? reject(err) : resolve(started))
            )
        );
    });

    after(async () => {
        if (mcpServer) {
            await new Promise(resolve => mcpServer.close(resolve));
        }
        for (const entry of [account, otherAccount]) {
            if (entry) {
                await server.delete(`/users/${entry.id}`).catch(() => false);
            }
        }
    });

    it('should POST /authenticate/mcp expect success for a user without 2FA', async () => {
        const master = await loginMaster(account);
        expect(master.require2fa).to.equal(false);
        expect(master.token).to.be.a('string');

        const session = await mintMcpSession(master.token);
        expect(session.scope).to.equal('mcp');
        expect(session.id).to.match(/^[0-9a-f]{64}$/);
        expect(session.token).to.match(/^wdmcp_\d[a-f0-9]{72}$/);
    });

    it('should POST /authenticate/:scope expect failure for an unsupported scope', async () => {
        const master = await loginMaster(account);
        const response = await server.post('/authenticate/imap').set('Authorization', `Bearer ${master.token}`);
        expect(response.status).to.equal(400);
        expect(response.body.code).to.equal('UnsupportedAuthScope');
    });

    it('should POST /authenticate/mcp expect failure with a pre-deployment master token', async () => {
        const profile = await db.users.collection('users').findOne({ _id: new ObjectId(account.id) });
        const legacy = legacyMasterToken(account.id, Number(profile.authVersion) || 0);
        await db.redis
            .multi()
            .hmset('tn:token:' + crypto.createHash('sha256').update(legacy.token).digest('hex'), legacy.data)
            .exec();

        // the old token still works for ordinary API calls...
        await server.get('/users/me').set('Authorization', `Bearer ${legacy.token}`).expect(200);

        // ...but the exchange refuses it with a documented error, not a 500
        const response = await server.post('/authenticate/mcp').set('Authorization', `Bearer ${legacy.token}`);
        expect(response.status).to.equal(403);
        expect(response.body.code).to.equal('MasterTokenNotEligible');
    });

    it('should accept a session token minted via POST /authenticate/mcp over MCP', async () => {
        const master = await loginMaster(account);
        const session = await mintMcpSession(master.token);

        expect((await mcpCall(session.token, 'initialize')).status).to.equal(200);

        // a full tool call, so the API hop behind the MCP service runs with the session
        const client = new Client({ name: 'scoped-mint-test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(MCP_URL), {
                requestInit: { headers: { Authorization: `Bearer ${session.token}` } }
            })
        );
        const result = await client.callTool({ name: 'get_account', arguments: {} });
        await client.close();
        expect(result.content[0].text).to.include(account.username);
    });

    it('should slide the idle TTL on use and 401 after it lapses', async () => {
        const master = await loginMaster(account);
        const session = await mintMcpSession(master.token);
        const sessionKey = McpTokenHandler.sessionKey(session.token);

        expect(await db.redis.ttl(sessionKey)).to.be.greaterThan(100000);

        // a nearly idle session lapses on its own and the service answers a clean 401
        await db.redis.expire(sessionKey, 1);
        await sleep(1500);
        expect(await db.redis.ttl(sessionKey)).to.be.at.most(0);
        expect((await mcpCall(session.token, 'initialize')).status).to.equal(401);

        // a session used before it lapses gets its idle TTL refreshed back to full
        const second = await mintMcpSession(master.token);
        const secondKey = McpTokenHandler.sessionKey(second.token);
        await db.redis.expire(secondKey, 5);
        expect((await mcpCall(second.token, 'initialize')).status).to.equal(200);
        expect(await db.redis.ttl(secondKey)).to.be.greaterThan(100000);
    });

    it('should 401 a session that outlived the absolute lifetime', async () => {
        const master = await loginMaster(account);
        const session = await mintMcpSession(master.token);
        const sessionKey = McpTokenHandler.sessionKey(session.token);

        // age the session past api.accessControl.tokenLifetime and re-sign, since the
        // signature covers the creation time
        const lifetime = config.api.accessControl.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME;
        const data = await db.redis.hgetall(sessionKey);
        data.created = Date.now() - (lifetime + 60) * 1000;
        data.s = McpTokenHandler.sessionSignature(session.token, data);
        await db.redis.hset(sessionKey, 'created', data.created, 's', data.s);

        const response = await mcpCall(session.token, 'initialize');
        expect(response.status).to.equal(401);
        expect(response.headers.get('www-authenticate')).to.include('Bearer');
        const body = await response.json();
        expect(body.error.code).to.equal(-32001);
        expect(await db.redis.ttl(sessionKey)).to.be.at.most(0);
    });

    it('should DELETE /authenticate/mcp/:token expect success with any current master token of the same user', async () => {
        const first = await loginMaster(account);
        const session = await mintMcpSession(first.token);

        const second = await loginMaster(account);
        const response = await server.delete(`/authenticate/mcp/${session.id}`).set('Authorization', `Bearer ${second.token}`).expect(200);
        expect(response.body.success).to.be.true;

        // the session is actually gone, not just its management record
        expect((await mcpCall(session.token, 'initialize')).status).to.equal(401);
    });

    it('should DELETE /authenticate/mcp/:token expect failure for an unknown or already revoked id', async () => {
        const master = await loginMaster(account);
        const session = await mintMcpSession(master.token);

        await server.delete(`/authenticate/mcp/${session.id}`).set('Authorization', `Bearer ${master.token}`).expect(200);

        const again = await server.delete(`/authenticate/mcp/${session.id}`).set('Authorization', `Bearer ${master.token}`);
        expect(again.status).to.equal(404);
        expect(again.body.code).to.equal('ScopedTokenNotFound');

        const unknown = await server.delete(`/authenticate/mcp/${'f'.repeat(64)}`).set('Authorization', `Bearer ${master.token}`);
        expect(unknown.status).to.equal(404);
        expect(unknown.body.code).to.equal('ScopedTokenNotFound');

        const malformed = await server.delete('/authenticate/mcp/not-a-hash').set('Authorization', `Bearer ${master.token}`);
        expect(malformed.status).to.equal(400);
        expect(malformed.body.code).to.equal('InputValidationError');
    });

    it("should DELETE /authenticate/mcp/:token expect failure with another user's master token", async () => {
        const master = await loginMaster(account);
        const session = await mintMcpSession(master.token);

        const other = await loginMaster(otherAccount);
        const response = await server.delete(`/authenticate/mcp/${session.id}`).set('Authorization', `Bearer ${other.token}`);
        expect(response.status).to.equal(404);
        expect(response.body.code).to.equal('ScopedTokenNotFound');

        // the session belongs to its own user and survives the stranger's attempt
        expect((await mcpCall(session.token, 'initialize')).status).to.equal(200);
    });

    it('should DELETE /authenticate/:scope/:token expect failure for an unsupported scope', async () => {
        const master = await loginMaster(account);

        // a known authentication scope without a token handler still answers 400
        const response = await server.delete(`/authenticate/imap/${'f'.repeat(64)}`).set('Authorization', `Bearer ${master.token}`);
        expect(response.status).to.equal(400);
        expect(response.body.code).to.equal('UnsupportedAuthScope');

        const unknown = await server.delete(`/authenticate/bogus/${'f'.repeat(64)}`).set('Authorization', `Bearer ${master.token}`);
        expect(unknown.status).to.equal(400);
        expect(unknown.body.code).to.equal('UnsupportedAuthScope');
    });

    it('should POST /authenticate/mcp expect failure when an MCP credential tries to mint', async () => {
        const master = await loginMaster(account);
        const session = await mintMcpSession(master.token);

        const response = await server.post('/authenticate/mcp').set('Authorization', `Bearer ${session.token}`);
        expect(response.status).to.equal(403);
        expect(response.body.code).to.equal('InvalidToken');
    });

    it('should accept sess and ip in the request body of both scoped token routes', async () => {
        const master = await loginMaster(account);

        const session = await server
            .post('/authenticate/mcp')
            .set('Authorization', `Bearer ${master.token}`)
            .send({ sess: 'scoped-mint-audit', ip: '203.0.113.7' })
            .expect(200);
        expect(session.body.success).to.be.true;
        expect(session.body.id).to.match(/^[0-9a-f]{64}$/);

        const response = await server
            .delete(`/authenticate/mcp/${session.body.id}`)
            .set('Authorization', `Bearer ${master.token}`)
            .send({ sess: 'scoped-mint-audit', ip: '203.0.113.7' })
            .expect(200);
        expect(response.body.success).to.be.true;

        // the body-carrying revoke really went through
        expect((await mcpCall(session.body.token, 'initialize')).status).to.equal(401);
    });

    it('should reject an invalid ip in the scoped token request body', async () => {
        const master = await loginMaster(account);

        const response = await server
            .post('/authenticate/mcp')
            .set('Authorization', `Bearer ${master.token}`)
            .send({ sess: 'scoped-mint-audit', ip: 'not-an-ip' });
        expect(response.status).to.equal(400);
        expect(response.body.code).to.equal('InputValidationError');
    });
});
