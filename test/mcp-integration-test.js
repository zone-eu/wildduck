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
    let writeToken;
    let uid;

    // Every request that presents the MCP credential goes through here, so the account it is
    // scoped to and how the token is carried are each stated once. `init` is open because what
    // carries the credential is itself something the API has an opinion about.
    let authed = (path, init) => fetch(`${API}/users/${user.id}${path}`, { headers: { Authorization: `Bearer ${token.token}` }, ...init });
    let authedWith = (accessToken, path, init = {}) =>
        fetch(`${API}/users/${user.id}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) }
        });

    let connectClient = async accessToken => {
        let writeClient = new Client({ name: 'wildduck-write-integration', version: '1.0.0' });
        await writeClient.connect(
            new StreamableHTTPClientTransport(new URL(MCP_URL), {
                requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
            })
        );
        return writeClient;
    };

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
        writeToken = await api('POST', `/users/${user.id}/mcp-tokens`, { description: 'write integration', role: 'mcp:write_partial' });

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
        expect(listed.results).to.have.length(2);
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
            'get_autoreply',
            'get_message',
            'get_message_text',
            'list_filters',
            'list_labels',
            'list_mailboxes',
            'list_messages',
            'search_messages'
        ]);
        for (let tool of tools.tools) {
            expect(tool.annotations.readOnlyHint, tool.name).to.equal(true);
        }
    });

    it('grants only the partial write tools to the opt-in role and preserves read annotations', async () => {
        let readTools = await client.listTools();
        expect(readTools.tools.map(tool => tool.name)).to.not.include.members(['create_filter', 'create_mailbox', 'set_autoreply']);
        expect(readTools.tools.every(tool => tool.annotations.readOnlyHint === true)).to.equal(true);

        let writeClient = await connectClient(writeToken.token);
        try {
            let tools = await writeClient.listTools();
            let byName = new Map(tools.tools.map(tool => [tool.name, tool]));
            for (let name of ['create_filter', 'create_mailbox', 'set_autoreply']) {
                expect(byName.has(name), name).to.equal(true);
            }
            for (let name of ['delete_mailbox', 'update_filter', 'delete_filter', 'send_message']) {
                expect(byName.has(name), name).to.equal(false);
            }
            expect(byName.get('list_mailboxes').annotations.readOnlyHint).to.equal(true);
        } finally {
            await writeClient.close();
        }
    });

    it('reads empty filters and an unconfigured autoreply without creating settings', async () => {
        let filters = await client.callTool({ name: 'list_filters', arguments: {} });
        expect(filters.isError).to.not.equal(true);
        expect(filters.structuredContent.filters).to.deep.equal([]);
        expect(filters.structuredContent.limits.used).to.equal(0);
        let autoreply = await client.callTool({ name: 'get_autoreply', arguments: {} });
        expect(autoreply.isError).to.not.equal(true);
        expect(autoreply.structuredContent.status).to.equal(false);
        expect(await db.database.collection('autoreplies').countDocuments({ user: new ObjectId(user.id) })).to.equal(0);
    });

    it('creates mailboxes, filters and autoreplies through MCP, with writes visible through REST', async () => {
        let writeClient = await connectClient(writeToken.token);
        try {
            let mailbox = await writeClient.callTool({ name: 'create_mailbox', arguments: { path: 'Agents/Research' } });
            expect(mailbox.isError).to.not.equal(true);
            expect(mailbox.structuredContent.success).to.equal(true);

            let duplicate = await writeClient.callTool({ name: 'create_mailbox', arguments: { path: 'Agents/Research' } });
            expect(duplicate.isError).to.equal(true);

            let malformedAction = await writeClient.callTool({
                name: 'create_filter',
                arguments: { name: 'Malformed MCP action', query: {}, action: { unexpected: true } }
            });
            expect(malformedAction.isError).to.equal(true);

            let malformedReference = await writeClient.callTool({
                name: 'create_filter',
                arguments: { name: 'Malformed MCP reference', query: {}, action: { mailbox: 'not-an-id' } }
            });
            expect(malformedReference.isError).to.equal(true);

            let mailboxes = await api('GET', `/users/${user.id}/mailboxes`);
            expect(mailboxes.results.some(entry => entry.id === mailbox.structuredContent.id && entry.path === 'Agents/Research')).to.equal(true);

            let label = await api('POST', `/users/${user.id}/labels`, { name: 'Agent rule label' });
            let filter = await writeClient.callTool({
                name: 'create_filter',
                arguments: {
                    name: 'Agent invoice rule',
                    query: { subject: 'invoice' },
                    action: {
                        seen: true,
                        flag: true,
                        delete: true,
                        spam: false,
                        mailbox: mailbox.structuredContent.id,
                        labels: [label.id],
                        targets: ['forward@example.com', 'smtp://mx.example.com:25', 'https://example.com/incoming']
                    }
                }
            });
            expect(filter.isError).to.not.equal(true);
            expect(filter.structuredContent.success).to.equal(true);

            let filters = await api('GET', `/users/${user.id}/filters`);
            expect(filters.results.some(entry => entry.id === filter.structuredContent.id && entry.name === 'Agent invoice rule')).to.equal(true);

            let autoreply = await writeClient.callTool({ name: 'set_autoreply', arguments: { status: true, subject: 'Away', text: 'Back soon' } });
            expect(autoreply.isError).to.not.equal(true);
            expect(autoreply.structuredContent.success).to.equal(true);
            let settings = await api('GET', `/users/${user.id}/autoreply`);
            expect(settings.status).to.equal(true);
            expect(settings.subject).to.equal('Away');
            expect(settings.text).to.equal('Back soon');
            let updated = await writeClient.callTool({ name: 'set_autoreply', arguments: { status: false, subject: 'Returned' } });
            expect(updated.structuredContent.id).to.equal(autoreply.structuredContent.id);
            settings = await api('GET', `/users/${user.id}/autoreply`);
            expect(settings.status).to.equal(false);
            expect(settings.subject).to.equal('Returned');
            expect(settings.text).to.equal('Back soon');
            for (let reader of [client, writeClient]) {
                let filterResult = await reader.callTool({ name: 'list_filters', arguments: {} });
                expect(filterResult.isError).to.not.equal(true);
                let entry = filterResult.structuredContent.filters.find(item => item.id === filter.structuredContent.id);
                expect(entry.originalQuery.subject).to.equal('invoice');
                expect(entry.originalAction.targets).to.include('forward@example.com');
                expect(entry.originalAction.labels).to.deep.equal([label.id]);
                expect(entry.originalAction.delete).to.equal(true);
                expect(entry).to.not.have.any.keys('user', 'metaData', 'internalData');
                let autoreplyResult = await reader.callTool({ name: 'get_autoreply', arguments: {} });
                expect(autoreplyResult.isError).to.not.equal(true);
                expect(autoreplyResult.structuredContent).to.include({ status: false, subject: 'Returned', text: 'Back soon' });
            }
            let messages = await api('GET', `/users/${user.id}/mailboxes/${inbox.id}/messages`);
            let read = await writeClient.callTool({ name: 'get_message', arguments: { mailbox: 'INBOX', uid: messages.results[0].id } });
            expect(read.isError).to.not.equal(true);
            expect(read.structuredContent.flags.seen).to.equal(false);
        } finally {
            await writeClient.close();
        }
    });

    it('filters metadata from direct filter reads for both roles', async () => {
        let created = await api('POST', `/users/${user.id}/filters`, {
            name: 'Private metadata', query: {}, action: {}, metaData: { private: 'hidden' }
        });
        for (let credential of [token.token, writeToken.token]) {
            let response = await authedWith(credential, '/filters?metaData=true');
            expect(response.status).to.equal(200);
            let body = await response.json();
            expect(body.results.find(entry => entry.id === created.id)).to.not.have.property('metaData');
            let autoreply = await authedWith(credential, '/autoreply');
            expect(autoreply.status).to.equal(200);
            expect((await autoreply.json()).subject).to.equal('Returned');
        }
    });

    it('allows the partial role through direct REST only for its own supported writes', async () => {
        let mailboxResponse = await authedWith(writeToken.token, '/mailboxes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'Direct/REST' })
        });
        expect(mailboxResponse.status).to.equal(200);
        let mailbox = await mailboxResponse.json();

        let filterResponse = await authedWith(writeToken.token, '/filters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Direct REST rule', query: { from: 'sender@example.com' }, action: { flag: true } })
        });
        expect(filterResponse.status).to.equal(200);
        let filter = await filterResponse.json();
        expect(filter.success).to.equal(true);

        let autoreplyResponse = await authedWith(writeToken.token, '/autoreply', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: true, subject: 'REST away' })
        });
        expect(autoreplyResponse.status).to.equal(200);

        // These routes are outside the bounded role even though some are state changes.
        for (let [method, path] of [
            ['DELETE', `/mailboxes/${mailbox.id}`],
            ['PUT', `/filters/${filter.id}`],
            ['DELETE', `/filters/${filter.id}`],
            ['POST', '/mcp-tokens'],
            ['POST', '/labels']
        ]) {
            let response = await authedWith(writeToken.token, path, { method });
            expect(response.status, `${method} ${path}`).to.equal(403);
        }
    });

    it('rejects collisions, invalid filter references, and malformed filter actions without partial writes', async () => {
        let duplicateMailbox = await authedWith(writeToken.token, '/mailboxes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'INBOX' })
        });
        expect([400, 409]).to.include(duplicateMailbox.status);

        let foreignMailboxId = '507f191e810c19729de860ea';
        let invalidReference = await authedWith(writeToken.token, '/filters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Invalid target', query: {}, action: { mailbox: foreignMailboxId } })
        });
        expect([400, 404]).to.include(invalidReference.status);

        let invalidAction = await authedWith(writeToken.token, '/filters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Invalid action', query: {}, action: { unknown: true } })
        });
        expect(invalidAction.status).to.equal(400);
        expect((await api('GET', `/users/${user.id}/filters`)).results.some(entry => entry.name === 'Invalid action')).to.equal(false);
    });

    it('preserves filter limits and validates label references through MCP', async () => {
        let writeClient = await connectClient(writeToken.token);
        try {
            let invalidLabel = await writeClient.callTool({ name: 'create_filter', arguments: {
                query: {}, action: { labels: [new ObjectId().toString()] }
            } });
            expect(invalidLabel.isError).to.equal(true);
            expect(invalidLabel.content[0].text).to.include('LabelNotFound');
            let userId = new ObjectId(user.id);
            let original = await db.users.collection('users').findOne({ _id: userId }, { projection: { filters: true } });
            let count = await db.database.collection('filters').countDocuments({ user: userId });
            try {
                await db.users.collection('users').updateOne({ _id: userId }, { $set: { filters: count } });
                let limited = await writeClient.callTool({ name: 'create_filter', arguments: { query: {}, action: {} } });
                expect(limited.isError).to.equal(true);
                expect(limited.content[0].text).to.include('TooMany');
                expect(await db.database.collection('filters').countDocuments({ user: userId })).to.equal(count);
            } finally {
                await db.users.collection('users').updateOne({ _id: userId }, original.filters === undefined ? { $unset: { filters: '' } } : { $set: { filters: original.filters } });
            }
        } finally {
            await writeClient.close();
        }
    });

    it('keeps the read role denied on writes and confines partial writes to the token owner', async () => {
        for (let [method, path, body] of [
            ['POST', '/mailboxes', { path: 'Read/Denied' }],
            ['POST', '/filters', { name: 'Read denied', query: {}, action: {} }],
            ['PUT', '/autoreply', { status: true }]
        ]) {
            let response = await authedWith(token.token, path, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            expect(response.status, `${method} ${path}`).to.equal(403);
        }

        for (let credential of [token.token, writeToken.token]) {
            for (let [method, path, body] of [
                ['GET', '/mailboxes'],
                ['GET', '/filters'],
                ['GET', '/autoreply'],
                ['POST', '/mailboxes', { path: 'Cross/User' }],
                ['POST', '/filters', { query: {}, action: {} }],
                ['PUT', '/autoreply', { status: false }]
            ]) {
                let response = await fetch(`${API}/users/507f191e810c19729de860ea${path}`, {
                    method,
                    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
                    body: body ? JSON.stringify(body) : undefined
                });
                expect(response.status, `${method} ${path}`).to.equal(403);
            }
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

    it('lists persistent labels with optional counters through the API', async () => {
        let label = await api('POST', `/users/${user.id}/labels`, { name: 'Empty MCP label', metaData: { private: true } });
        let listed = await client.callTool({ name: 'list_labels', arguments: {} });
        expect(listed.isError, JSON.stringify(listed.content)).to.not.equal(true);
        expect(listed.structuredContent.labels).to.deep.include({ id: label.id, name: 'Empty MCP label' });

        let counted = await client.callTool({ name: 'list_labels', arguments: { include_counters: true } });
        expect(counted.isError, JSON.stringify(counted.content)).to.not.equal(true);
        expect(counted.structuredContent.labels).to.deep.include({ id: label.id, name: 'Empty MCP label', total: 0, unseen: 0 });

        // The API applies the same field allowlist even when the bearer is used directly.
        for (let counters of [false, true]) {
            let response = await authed(`/labels?counters=${counters}`);
            expect(response.status).to.equal(200);
            expect((await response.json()).labels.find(entry => entry.id === label.id)).to.deep.equal(
                { id: label.id, name: 'Empty MCP label', ...(counters ? { total: 0, unseen: 0 } : {}) }
            );
        }
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
        for (let [method, path] of [
            ['GET', `/mailboxes/${inbox.id}/messages/${uid}/message.eml`],
            ['GET', '/archived/messages'],
            ['GET', '/addressregister?query=a'],
            ['GET', '/updates'],
            ['GET', '/mcp-tokens'],
            ['GET', '/labels/507f191e810c19729de860ea'],
            ['POST', '/labels'],
            ['PUT', '/labels/507f191e810c19729de860ea'],
            ['DELETE', '/labels/507f191e810c19729de860ea'],
            ['PUT', '/logout'],
            ['DELETE', `/mailboxes/${inbox.id}/messages/${uid}`]
        ]) {
            for (let credential of [token.token, writeToken.token]) {
                let res = await authedWith(credential, path, { method });
                expect(res.status, `${method} ${path}`).to.equal(403);
            }
        }

        // and the routes the tools do use still work
        expect((await authed('/mailboxes')).status).to.equal(200);
    });

    it('accepts the credential only as a bearer token', async () => {
        // The API takes an access token from a query string and an X-Access-Token header as
        // readily as from Authorization, and strips `Bearer` as an optional prefix. An MCP
        // token is a bearer credential, because a credential in a URL is copied into proxy
        // logs, browser history and referrer headers.
        let carriers = [
            { headers: {}, path: `/mailboxes?accessToken=${encodeURIComponent(token.token)}` },
            { headers: { 'X-Access-Token': token.token } },
            { headers: { Authorization: token.token } },
            // refused even alongside a correct presentation, so that nothing learns the
            // unsafe carrier works
            { path: `/mailboxes?accessToken=${encodeURIComponent(token.token)}` }
        ];

        for (let { headers, path } of carriers) {
            let res = await authed(path || '/mailboxes', headers ? { headers } : {});
            expect(res.status, JSON.stringify(headers || path)).to.equal(403);
        }

        expect((await authed('/mailboxes')).status).to.equal(200);
    });

    it('does not record a second success for the API hop behind a tool call', async () => {
        let mcpEvents = async () =>
            (await api('GET', `/users/${user.id}/authlog`)).results
                .filter(entry => entry.protocol === 'MCP')
                .reduce((sum, entry) => sum + (entry.events || 1), 0);

        let before = await mcpEvents();

        // one tool call is one MCP authentication plus the API requests it makes on the
        // caller's behalf. Only the listener that saw the client records a success; the API
        // re-check would otherwise add an entry naming the internal address, and two awaited
        // round trips to every one of those requests.
        await client.callTool({ name: 'get_account', arguments: {} });

        expect(await mcpEvents()).to.equal(before + 1);

        let entries = (await api('GET', `/users/${user.id}/authlog`)).results.filter(entry => entry.protocol === 'MCP');
        expect(entries.every(entry => entry.ip)).to.equal(true);
    });

    it('applies the field allowlist in the API, not only in the MCP service', async () => {
        // config/roles.json is meant to be the declaration of what an agent may see, so it has
        // to bound the credential rather than the client: a token used against the API directly
        // must not read a field its level does not grant.
        let call = path => authed(path).then(res => res.json());

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
        let res = await authed(`/mailboxes/${inbox.id}/messages/${uid}?markAsSeen=true`);

        expect(res.status).to.equal(403);
        let writeRes = await authedWith(writeToken.token, `/mailboxes/${inbox.id}/messages/${uid}?markAsSeen=true`);
        expect(writeRes.status).to.equal(403);

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
