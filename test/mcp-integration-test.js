/* eslint-env mocha */
/* eslint no-unused-expressions: 0 */
/* eslint no-invalid-this: 0 */

'use strict';

// End to end coverage of the MCP service against a live WildDuck instance.
//
// The unit suites stub the API, so this is what proves the real thing: that a token minted
// over REST authenticates, that tools reach the API and come back shaped as declared, that the
// role's field allowlist actually strips what it claims to, and that reading over MCP leaves
// message state alone.

const chai = require('chai');
const config = require('@zone-eu/wild-config');
const { ObjectId } = require('mongodb');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const db = require('../lib/db');
const mcp = require('../mcp');
const userDeleteTask = require('../lib/tasks/user-delete');

const expect = chai.expect;

const API = `http://127.0.0.1:${config.api.port}`;
const MCP_PORT = 8099;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

async function api(method, path, body) {
    let res = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = await res.json();
    if (!json.success) {
        throw new Error(`${method} ${path} -> ${JSON.stringify(json)}`);
    }
    return json;
}

function rpc(token, payload) {
    return fetch(MCP_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(Object.assign({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, payload))
    });
}

describe('MCP service integration', function () {
    this.timeout(30000);

    let server;
    let client;
    let user;
    let inbox;
    let token;
    let uid;

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));

        let username = `mcpint${Date.now()}`;
        user = await api('POST', '/users', {
            username,
            password: 'Secret123Secret',
            address: `${username}@example.com`,
            name: 'MCP Integration'
        });

        inbox = (await api('GET', `/users/${user.id}/mailboxes`)).results.find(mailbox => mailbox.path === 'INBOX');

        await api('POST', `/users/${user.id}/mailboxes/${inbox.id}/messages`, {
            from: { name: 'Sender', address: 'sender@example.com' },
            to: [{ address: `${username}@example.com` }],
            subject: 'Quarterly invoice',
            text: 'Please review the attached invoice. '.repeat(20),
            html: '<p>Please review</p><script>steal()</script><img src="https://tracker.example/pixel.gif">',
            unseen: true
        });

        token = await api('POST', `/users/${user.id}/mcp-tokens`, { description: 'integration' });

        server = await new Promise((resolve, reject) =>
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
                    // deliberately small, so the truncation and continuation paths are exercised
                    maxBodyChars: 200
                },
                (err, started) => (err ? reject(err) : resolve(started))
            )
        );

        client = new Client({ name: 'wildduck-integration', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(MCP_URL), {
                requestInit: { headers: { Authorization: `Bearer ${token.token}` } }
            })
        );
    });

    after(async () => {
        if (client) {
            await client.close().catch(() => false);
        }
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        if (user) {
            await api('DELETE', `/users/${user.id}`).catch(() => false);
        }
    });

    it('mints a token over REST that authenticates over MCP', async () => {
        expect(token.token).to.match(/^wdmcp_\d[a-f0-9]{72}$/);
        expect(token.role).to.equal('mcp:read');

        let listed = await api('GET', `/users/${user.id}/mcp-tokens?sess=integration&ip=127.0.0.1`);
        expect(listed.results).to.have.length(1);
        expect(listed.results[0]).to.not.have.property('hash');
        expect(listed.results[0]).to.not.have.property('token');
    });

    it('records minting and revoking in the user auth log', async () => {
        let minted = await api('POST', `/users/${user.id}/mcp-tokens`, { description: 'audited', sess: 'integration', ip: '127.0.0.1' });
        await api('DELETE', `/users/${user.id}/mcp-tokens/${minted.id}?sess=integration&ip=127.0.0.1`);

        let authlog = await api('GET', `/users/${user.id}/authlog`);
        let actions = authlog.results.map(entry => entry.action);

        // an agent credential appearing on an account is an account event, like an application
        // password is
        expect(actions).to.include('create mcp token');
        expect(actions).to.include('delete mcp token');
    });

    it('advertises exactly the read tools the access level allows', async () => {
        let tools = await client.listTools();

        expect(tools.tools.map(tool => tool.name).sort()).to.deep.equal([
            'get_account',
            'get_message',
            'get_message_text',
            'list_mailboxes',
            'list_messages',
            'search_messages'
        ]);
        for (let tool of tools.tools) {
            expect(tool.annotations.readOnlyHint, tool.name).to.equal(true);
        }
    });

    it('reads the account and its mailboxes', async () => {
        let account = await client.callTool({ name: 'get_account', arguments: {} });
        expect(account.isError).to.not.equal(true);
        expect(account.structuredContent.id).to.equal(user.id);
        expect(account.structuredContent.quota.allowed).to.be.above(0);

        let mailboxes = await client.callTool({ name: 'list_mailboxes', arguments: {} });
        expect(mailboxes.structuredContent.mailboxes.map(mailbox => mailbox.path)).to.include('INBOX');
    });

    it('lists messages without leaking fields the access level excludes', async () => {
        let listed = await client.callTool({ name: 'list_messages', arguments: { mailbox: 'INBOX' } });

        expect(listed.isError).to.not.equal(true);
        expect(listed.structuredContent.total).to.equal(1);

        let message = listed.structuredContent.messages[0];
        expect(message.subject).to.equal('Quarterly invoice');
        expect(message).to.not.have.any.keys('user', 'outbound', 'metaData', 'forwardTargets');

        uid = message.uid;
    });

    it('returns a bounded, sanitized body and reads on from an offset', async () => {
        let message = await client.callTool({ name: 'get_message', arguments: { mailbox: 'INBOX', uid, body_format: 'both' } });
        expect(message.isError).to.not.equal(true);

        let body = message.structuredContent.body;
        expect(body.text.returnedLength).to.equal(200);
        expect(body.text.totalLength).to.be.above(200);
        expect(body.text.hasMore).to.equal(true);

        // scripts and tracking pixels never reach the caller
        expect(body.html.content).to.include('Please review');
        expect(body.html.content).to.not.include('steal');
        expect(body.html.content).to.not.include('tracker.example');

        let rest = await client.callTool({ name: 'get_message_text', arguments: { mailbox: 'INBOX', uid, offset: 200, length: 40 } });
        expect(rest.structuredContent.body.text.offset).to.equal(200);
        expect(rest.structuredContent.body.text.content).to.have.length(40);
    });

    it('searches with typed filters and refuses undeclared arguments', async () => {
        let hit = await client.callTool({ name: 'search_messages', arguments: { query: 'invoice' } });
        expect(hit.isError).to.not.equal(true);
        expect(hit.structuredContent.total).to.equal(1);

        // an ordered search asks MongoPaging to page on idate, which drops the field from every
        // result unless the route asks for it back, and a message with no receive time is not
        // something an agent can reason about
        expect(hit.structuredContent.messages[0].receivedAt).to.be.a('string');
        expect(new Date(hit.structuredContent.messages[0].receivedAt).getTime()).to.be.above(0);

        // a filter the API has no negative form for is declared as a flag, so the value that
        // would silently match everything is refused instead
        let negative = await client.callTool({ name: 'search_messages', arguments: { query: 'invoice', has_attachments: false } });
        expect(negative.isError).to.equal(true);

        // the token is the binding, so naming another user is not something a tool accepts
        let injected = await client.callTool({ name: 'search_messages', arguments: { query: 'invoice', user: '507f191e810c19729de860ea' } });
        expect(injected.isError).to.equal(true);
    });

    it('leaves message state alone', async () => {
        let listed = await api('GET', `/users/${user.id}/mailboxes/${inbox.id}/messages`);
        expect(listed.results[0].seen).to.equal(false);
    });

    it('records the authentication in the user auth log', async () => {
        let authlog = await api('GET', `/users/${user.id}/authlog`);
        let entries = authlog.results.filter(entry => entry.protocol === 'MCP');

        expect(entries.length).to.be.above(0);
        expect(entries[0].result).to.equal('success');
    });

    it('confines the credential to the routes the tools use', async () => {
        // The role alone would admit these: read:own on messages and users also covers the raw
        // RFC822 source, the archive, the address register and PUT /logout, which is a state
        // change. The credential is pinned to the tool routes so none of them is reachable.
        let call = (method, path) =>
            fetch(`${API}/users/${user.id}${path}`, {
                method,
                headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' }
            });

        for (let [method, path] of [
            ['GET', `/mailboxes/${inbox.id}/messages/${uid}/message.eml`],
            ['GET', '/archived/messages'],
            ['GET', '/addressregister?query=a'],
            ['GET', '/updates'],
            ['GET', '/mcp-tokens'],
            ['PUT', '/logout'],
            ['DELETE', `/mailboxes/${inbox.id}/messages/${uid}`]
        ]) {
            let res = await call(method, path);
            expect(res.status, `${method} ${path}`).to.equal(403);
        }

        // and the routes the tools do use still work
        expect((await call('GET', '/mailboxes')).status).to.equal(200);
    });

    it('applies the field allowlist in the API, not only in the MCP service', async () => {
        // config/roles.json is meant to be the declaration of what an agent may see, so it has
        // to bound the credential rather than the client: a token used against the API directly
        // must not read a field its level does not grant.
        let call = path => fetch(`${API}/users/${user.id}${path}`, { headers: { Authorization: `Bearer ${token.token}` } }).then(res => res.json());

        let message = await call(`/mailboxes/${inbox.id}/messages/${uid}`);
        expect(message.success).to.equal(true);
        expect(message.subject).to.equal('Quarterly invoice');
        expect(message).to.not.have.any.keys('user', 'envelope', 'metaData', 'outbound', 'files', 'forwardTargets');

        let listing = await call(`/mailboxes/${inbox.id}/messages?metaData=true&includeHeaders=true`);
        expect(listing.results[0]).to.not.have.any.keys('headers', 'metaData', 'user');
        // the listing envelope is not resource data and survives the filter
        expect(listing.total).to.equal(1);
        expect(listing.results[0].subject).to.equal('Quarterly invoice');

        let mailboxes = await call('/mailboxes');
        expect(mailboxes.results.map(mailbox => mailbox.path)).to.include('INBOX');
        expect(mailboxes.results[0]).to.not.have.any.keys('modifyIndex', 'encryptMessages');

        // and the fields the tools do need are granted, including the content type a client
        // uses to tell an encrypted message from a plain one
        let read = await client.callTool({ name: 'get_message', arguments: { mailbox: 'INBOX', uid } });
        expect(read.structuredContent.contentType).to.be.a('string').and.to.include('/');
    });

    it('refuses a state change that rides on one of the tool routes', async () => {
        // markAsSeen is a write: it updates the message, the journal and the notification
        // stream. The route is one the credential may reach, and the method is GET, so nothing
        // but a write grant stands between a read-only credential and message state.
        let res = await fetch(`${API}/users/${user.id}/mailboxes/${inbox.id}/messages/${uid}?markAsSeen=true`, {
            headers: { Authorization: `Bearer ${token.token}` }
        });

        expect(res.status).to.equal(403);

        let listed = await api('GET', `/users/${user.id}/mailboxes/${inbox.id}/messages`);
        expect(listed.results[0].seen).to.equal(false);
    });

    it('deletes MCP tokens along with the account', async () => {
        let username = `mcpdel${Date.now()}`;
        let victim = await api('POST', '/users', {
            username,
            password: 'Secret123Secret',
            address: `${username}@example.com`
        });

        let created = await api('POST', `/users/${victim.id}/mcp-tokens`, { description: 'first' });
        await api('POST', `/users/${victim.id}/mcp-tokens`, { description: 'second' });

        let victimId = new ObjectId(victim.id);
        expect(await db.users.collection('mcptokens').countDocuments({ user: victimId })).to.equal(2);

        // deleting the account retires the credential immediately, because authentication
        // reloads the user on every request and the row is gone from `users`. Deleted with a
        // recovery window, so the data cleanup is still pending and can be inspected.
        let deleteAfter = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await api('DELETE', `/users/${victim.id}?deleteAfter=${encodeURIComponent(deleteAfter)}`);
        expect((await rpc(created.token)).status).to.equal(401);

        // the records themselves are cleared with the rest of the account data, on the same
        // schedule as application passwords, so a cancelled deletion is still recoverable
        expect(await db.users.collection('mcptokens').countDocuments({ user: victimId })).to.equal(2);

        await new Promise((resolve, reject) => userDeleteTask({ _id: new ObjectId() }, { user: victimId }, {}, err => (err ? reject(err) : resolve())));
        expect(await db.users.collection('mcptokens').countDocuments({ user: victimId })).to.equal(0);
    });

    it('refuses a malformed, unknown or revoked credential', async () => {
        expect((await rpc(`wdmcp_1${'a'.repeat(64)}deadbeef`)).status).to.equal(401);
        expect((await rpc('b'.repeat(40))).status).to.equal(401);

        await api('DELETE', `/users/${user.id}/mcp-tokens/${token.id}`);
        expect((await rpc(token.token)).status).to.equal(401);

        // re-mint so the rest of the suite and teardown still have a working credential
        token = await api('POST', `/users/${user.id}/mcp-tokens`, { description: 'integration' });
    });
});
