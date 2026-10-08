/* eslint no-invalid-this: 0 */

'use strict';

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { X509Certificate } = require('crypto');
const chai = require('chai');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const log = require('npmlog');
const mcp = require('../mcp');
const certs = require('../lib/certs');
const metrics = require('../lib/metrics');

const expect = chai.expect;
const TOKEN = `wdmcp_${'a'.repeat(64)}`;
const TOKEN_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f191e810c19729de860ea';
const MAILBOX_ID = '507f1f77bcf86cd799439012';
const THREAD_ID = '507f1f77bcf86cd799439013';

function id(value) {
    return { toString: () => value };
}

function createReader() {
    return {
        role: 'mcp:read',
        async getAccount() {
            return {
                id: USER_ID,
                username: 'alice',
                name: 'Alice',
                primaryAddress: 'alice@example.com',
                aliases: [{ address: 'alias@example.com' }],
                quota: { allowed: 1000, used: 100 }
            };
        },
        async listMailboxes() {
            return [
                {
                    id: MAILBOX_ID,
                    name: 'INBOX',
                    path: 'INBOX',
                    specialUse: null,
                    subscribed: true,
                    hidden: false,
                    total: 1,
                    unseen: 1
                }
            ];
        },
        async resolveMailbox() {
            return { id: MAILBOX_ID, path: 'INBOX', specialUse: null };
        },
        async mailboxId() {
            return MAILBOX_ID;
        },
        async listMessages() {
            return { total: 0, nextCursor: null, messages: [] };
        },
        async searchMessages() {
            return { total: 0, nextCursor: null, messages: [] };
        },
        async getMessage() {
            return {
                id: 1,
                mailbox: MAILBOX_ID,
                thread: THREAD_ID,
                from: { address: 'sender@example.com' },
                replyTo: [],
                to: [{ address: 'alice@example.com' }],
                cc: [],
                bcc: [],
                messageId: '<message@example.com>',
                subject: 'Hello',
                date: null,
                idate: null,
                size: 5,
                attachments: [],
                seen: false,
                deleted: false,
                flagged: false,
                draft: false,
                answered: false,
                forwarded: false,
                encrypted: false,
                text: 'hello',
                html: ['<p>hello</p><script>alert(1)</script>'],
                raw: 'raw message secret',
                headers: { authorization: 'header secret' },
                forwardTargets: ['forward@example.com'],
                outbound: ['queue-id'],
                files: ['draft-file'],
                bimi: { image: 'embedded image' },
                metaData: { secret: true }
            };
        }
    };
}

function createDependencies() {
    let calls = [];
    let addresses = [];
    let reader = createReader();
    return {
        calls,
        addresses,
        tokenHandler: {
            async authenticate(token, meta) {
                calls.push(token);
                addresses.push((meta && meta.ip) || false);
                if (token !== TOKEN) {
                    let err = new Error('Invalid token');
                    err.code = 'InvalidMcpToken';
                    throw err;
                }
                return {
                    tokenId: id(TOKEN_ID),
                    user: { _id: id(USER_ID) },
                    role: 'mcp:read'
                };
            }
        },
        apiClient: {
            bind(auth, token) {
                expect(auth.user._id.toString()).to.equal(USER_ID);
                expect(token).to.equal(TOKEN);
                return reader;
            }
        }
    };
}

function startServer(options, dependencies) {
    return new Promise((resolve, reject) => {
        mcp.start(options, (err, server) => (err ? reject(err) : resolve(server)), dependencies);
    });
}

function startMcp(secure, overrides) {
    let options = {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        path: '/mcp',
        secure: secure === true,
        allowedHosts: ['127.0.0.1', 'localhost'],
        allowedOrigins: ['https://client.example'],
        maxRequestSize: 1024,
        maxResults: 50,
        maxBodyChars: 50000,
        ...overrides
    };
    let dependencies = createDependencies();
    return startServer(options, dependencies).then(server => ({ server, dependencies }));
}

function closeServer(server) {
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}

function request(server, options) {
    options = options || {};
    let client = options.secure ? https : http;
    let body = options.body;
    if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
        body = JSON.stringify(body);
    }
    let headers = { ...(options.headers || {}) };
    if (body !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
        headers['Content-Length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
        let req = client.request(
            {
                host: '127.0.0.1',
                port: server.address().port,
                path: options.path || '/mcp',
                method: options.method || 'POST',
                headers,
                rejectUnauthorized: false,
                servername: options.servername
            },
            res => {
                let chunks = [];
                let peerCertificate = res.socket.encrypted ? res.socket.getPeerCertificate() : false;
                res.on('data', chunk => chunks.push(chunk));
                res.once('error', reject);
                res.once('end', () =>
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        peerCertificate,
                        body: Buffer.concat(chunks).toString()
                    })
                );
            }
        );
        req.once('error', reject);
        req.end(body);
    });
}

async function connectClient(server, mode) {
    let transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
        authProvider: { token: async () => TOKEN }
    });
    let client = new Client(
        { name: 'wildduck-mcp-test', version: '1.0.0' },
        {
            versionNegotiation: { mode }
        }
    );
    await client.connect(transport);
    return client;
}

describe('Read-only MCP service', function () {
    this.timeout(10000);

    let server;
    let client;

    afterEach(async () => {
        if (client) {
            await client.close();
            client = false;
        }
        await closeServer(server);
        server = false;
    });

    it('does not start when disabled', async () => {
        expect(await startServer({ enabled: false })).to.equal(false);
    });

    for (let mode of ['legacy', 'auto']) {
        it(`serves ${mode === 'legacy' ? 'legacy' : 'modern'} stateless requests through the official client`, async () => {
            ({ server } = await startMcp(false, { maxResults: 500 }));
            client = await connectClient(server, mode);

            expect(client.getProtocolEra()).to.equal(mode === 'legacy' ? 'legacy' : 'modern');
            expect(client.getInstructions()).to.include('untrusted data');

            let result = await client.listTools();
            expect(result.tools.map(tool => tool.name)).to.deep.equal([
                'get_account',
                'list_mailboxes',
                'list_messages',
                'search_messages',
                'get_message',
                'get_message_text'
            ]);
            for (let tool of result.tools) {
                expect(tool.inputSchema.type).to.equal('object');
                expect(tool.outputSchema.type).to.equal('object');
                expect(tool.annotations).to.include({
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false
                });
            }
            expect(result.tools.find(tool => tool.name === 'list_messages').inputSchema.properties.limit.maximum).to.equal(50);
            expect(result.tools.find(tool => tool.name === 'search_messages').inputSchema.properties.limit.maximum).to.equal(50);

            let account = await client.callTool({ name: 'get_account', arguments: {} });
            expect(account.isError).not.to.equal(true);
            expect(account.structuredContent).to.deep.equal({
                id: USER_ID,
                username: 'alice',
                name: 'Alice',
                primaryAddress: 'alice@example.com',
                aliases: [{ address: 'alias@example.com' }],
                quota: { allowed: 1000, used: 100 }
            });

            let mailboxes = await client.callTool({ name: 'list_mailboxes', arguments: {} });
            expect(mailboxes.isError).not.to.equal(true);
            expect(mailboxes.structuredContent.mailboxes[0]).not.to.have.property('specialUse');

            let messages = await client.callTool({ name: 'list_messages', arguments: { mailbox: 'INBOX' } });
            expect(messages.isError).not.to.equal(true);
            expect(messages.structuredContent.mailbox).not.to.have.property('specialUse');

            let message = await client.callTool({
                name: 'get_message',
                arguments: { mailbox: 'INBOX', uid: 1 }
            });
            expect(message.isError).not.to.equal(true);
            expect(message.structuredContent.body.text.content).to.equal('hello');
            expect(message.structuredContent.body).not.to.have.property('html');
            expect(message.structuredContent).not.to.have.any.keys('raw', 'headers', 'forwardTargets', 'outbound', 'files', 'bimi', 'metaData');

            // The search tool takes typed fields only: the REST `q` grammar is not exposed, and
            // an argument the schema does not declare is refused rather than quietly dropped
            let unknownArgument = await client.callTool({
                name: 'search_messages',
                arguments: { query: 'invoice', user: '507f191e810c19729de860ea' }
            });
            expect(unknownArgument.isError).to.equal(true);

            // The advertised page size is a ceiling, not a suggestion
            let overLimit = await client.callTool({
                name: 'search_messages',
                arguments: { query: 'invoice', limit: 5000 }
            });
            expect(overLimit.isError).to.equal(true);
        });
    }

    it('rejects missing and non-MCP credentials', async () => {
        let started = await startMcp();
        server = started.server;

        let missing = await request(server, {
            headers: { 'Content-Type': 'application/json' },
            body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
        });
        let apiToken = await request(server, {
            headers: { Authorization: `Bearer ${'b'.repeat(40)}`, 'Content-Type': 'application/json' },
            body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
        });
        let xAccessToken = await request(server, {
            headers: { 'X-Access-Token': TOKEN, 'Content-Type': 'application/json' },
            body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
        });
        let queryToken = await request(server, {
            path: `/mcp?accessToken=${TOKEN}`,
            headers: { 'Content-Type': 'application/json' },
            body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
        });
        let lowercaseBearer = await request(server, {
            headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'lowercase-bearer-test', version: '1.0.0' }
                }
            }
        });

        expect(missing.statusCode).to.equal(401);
        expect(missing.headers['www-authenticate']).to.equal('Bearer realm="WildDuck MCP"');
        expect(apiToken.statusCode).to.equal(401);
        expect(xAccessToken.statusCode).to.equal(401);
        expect(queryToken.statusCode).to.equal(401);
        expect(lowercaseBearer.statusCode).not.to.equal(401);
        expect(started.dependencies.calls).to.deep.equal([false, 'b'.repeat(40), false, false, TOKEN]);
    });

    it('returns a generic 503 when token storage is unavailable', async () => {
        let dependencies = createDependencies();
        dependencies.tokenHandler.authenticate = async () => {
            throw new Error('mongodb://user:secret@database.internal/private');
        };
        server = await startServer(
            {
                enabled: true,
                host: '127.0.0.1',
                port: 0,
                path: '/mcp',
                secure: false,
                allowedHosts: ['127.0.0.1'],
                allowedOrigins: [],
                maxRequestSize: 1024,
                maxResults: 50,
                maxBodyChars: 50000
            },
            dependencies
        );

        let response = await request(server, {
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: {}
        });

        expect(response.statusCode).to.equal(503);
        expect(response.body).not.to.include('database.internal');
        expect(response.body).not.to.include('secret');
    });

    it('keeps tool logs and metric labels free of secrets and unbounded input', async () => {
        ({ server } = await startMcp());
        client = await connectClient(server, 'auto');

        let entries = [];
        let originalInfo = log.info;
        log.info = (...args) => entries.push(args);
        try {
            await client.callTool({ name: 'get_message', arguments: { mailbox: 'INBOX', uid: 1 } });
        } finally {
            log.info = originalInfo;
        }

        let logged = JSON.stringify(entries);
        expect(logged).to.include(TOKEN_ID);
        expect(logged).to.include(USER_ID);
        expect(logged).to.include('get_message');
        expect(logged).not.to.include(TOKEN);
        expect(logged).not.to.include('INBOX');
        expect(logged).not.to.include('raw message secret');
        expect(logged).not.to.include('hello');

        metrics.recordMcpTool('secret-unbounded-tool-name', 'unexpected-result', 0.01, 12);
        metrics.recordMcpRequest('SECRET-METHOD', 418, 0.01);
        let exposition = await metrics.getMetrics();
        expect(exposition).to.include('wildduck_mcp_tool_calls_total{tool="other",result="error"}');
        expect(exposition).to.include('wildduck_mcp_requests_total{method="other",status_class="4xx"}');
        expect(exposition).not.to.include('secret-unbounded-tool-name');
        expect(exposition).not.to.include('SECRET-METHOD');
    });

    it('validates the path, method, Host, and Origin before dispatch', async () => {
        let started = await startMcp();
        server = started.server;

        let unknown = await request(server, { path: '/health', method: 'GET' });
        let method = await request(server, { method: 'PUT' });
        let host = await request(server, { headers: { Host: 'attacker.example' } });
        let userInfoHost = await request(server, { headers: { Host: 'attacker@127.0.0.1' } });
        let origin = await request(server, { headers: { Origin: 'https://attacker.example' } });
        let preflight = await request(server, { method: 'OPTIONS', headers: { Origin: 'https://client.example' } });

        expect(unknown.statusCode).to.equal(404);
        expect(method.statusCode).to.equal(405);
        expect(host.statusCode).to.equal(403);
        expect(userInfoHost.statusCode).to.equal(403);
        expect(origin.statusCode).to.equal(403);
        expect(preflight.statusCode).to.equal(204);
        expect(preflight.headers['access-control-allow-origin']).to.equal('https://client.example');
        expect(started.dependencies.calls).to.deep.equal([]);
    });

    it('delivers a refusal for a malformed or oversized body, and drains the oversized one', async () => {
        let started = await startMcp(false, { maxRequestSize: 16 });
        server = started.server;
        let headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

        let malformed = await request(server, { headers, body: '{' });
        let oversized = await request(server, { headers, body: JSON.stringify({ value: 'x'.repeat(30) }) });

        expect(malformed.statusCode).to.equal(400);
        expect(JSON.parse(malformed.body).error.code).to.equal(-32700);
        expect(oversized.statusCode).to.equal(413);
        expect(started.dependencies.calls).to.deep.equal([TOKEN, TOKEN]);

        // Both answers reach the client on a reusable connection: the malformed body was read
        // in full, and the oversized one is taken off the wire before the refusal is sent, so
        // neither has to tear the socket down.
        expect(oversized.headers.connection).to.not.equal('close');
        expect(malformed.headers.connection).to.not.equal('close');

        let encoded = await request(server, {
            headers: { ...headers, 'Content-Encoding': 'gzip' },
            body: '{}'
        });
        expect(encoded.statusCode).to.equal(415);
        // its body is within the cap, so draining it is bounded and the connection lives
        expect(encoded.headers.connection).to.not.equal('close');
    });

    it('delivers the refusal for an oversized body larger than the socket buffer', async () => {
        let started = await startMcp(false, { maxRequestSize: 1024 });
        server = started.server;
        let headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

        // The body is far larger than the socket receive buffer and is refused unread. Answering
        // it with a close before it was off the wire reached the client as a reset rather than
        // the 413; draining it first delivers the status. 512 KB is well past the buffer and
        // well within the drain bound.
        let oversized = await request(server, { headers, body: 'x'.repeat(512 * 1024) });
        expect(oversized.statusCode).to.equal(413);
    });

    it('delivers each early refusal to the client after draining a bounded body', async () => {
        let started = await startMcp(false, { maxRequestSize: 16 });
        server = started.server;

        // None of these reach readBody, and all but the last run before the caller has
        // authenticated. Each is answered after its body is drained, so the client reads the
        // status on a connection it can reuse rather than a reset. The bodies are larger than
        // the socket buffer, which is where an undrained refusal would have reset instead.
        let body = 'x'.repeat(64 * 1024);
        let refusals = [
            await request(server, { path: '/elsewhere', body }),
            await request(server, { headers: { Host: 'evil.example' }, body }),
            await request(server, { headers: { Origin: 'https://evil.example' }, body }),
            await request(server, { method: 'PUT', body }),
            await request(server, { headers: { Authorization: `Bearer ${'c'.repeat(40)}` }, body })
        ];

        expect(refusals.map(refusal => refusal.statusCode)).to.deep.equal([404, 403, 403, 405, 401]);
        refusals.forEach(refusal => expect(refusal.headers.connection).to.not.equal('close'));

        let small = await request(server, { path: '/elsewhere', body: 'xx' });
        expect(small.statusCode).to.equal(404);
        expect(small.headers.connection).to.not.equal('close');
    });

    it('drains and answers an oversized body on every method that carries one', async () => {
        let started = await startMcp(false, { maxRequestSize: 16 });
        server = started.server;
        let headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

        // A DELETE body is read too, so an oversized one is refused and drained just like a POST
        let oversizedDelete = await request(server, { method: 'DELETE', headers, body: 'x'.repeat(64 * 1024) });
        expect(oversizedDelete.statusCode).to.equal(413);
        expect(oversizedDelete.headers.connection).to.not.equal('close');

        // a body within the cap is still handed to the protocol handler
        let smallDelete = await request(server, { method: 'DELETE', headers });
        expect(smallDelete.statusCode).to.not.equal(413);
    });

    it('takes the proxied address from the last forwarded entry, and only when trusted', async () => {
        let started = await startMcp(false, { trustProxy: true });
        server = started.server;
        let bearer = { Authorization: `Bearer ${'c'.repeat(40)}`, 'Content-Type': 'application/json' };

        // A proxy appends the address it saw, so everything before the final entry is text the
        // client sent. Reading the first entry would hand a caller a fresh failure budget per
        // request just by prepending an address.
        await request(server, { headers: { ...bearer, 'X-Forwarded-For': '9.9.9.9, 198.51.100.7' }, body: {} });
        await request(server, { headers: { ...bearer, 'X-Forwarded-For': '198.51.100.8' }, body: {} });
        expect(started.dependencies.addresses).to.deep.equal(['198.51.100.7', '198.51.100.8']);

        await closeServer(server);
        let untrusted = await startMcp(false, { trustProxy: false });
        server = untrusted.server;

        await request(server, { headers: { ...bearer, 'X-Forwarded-For': '9.9.9.9' }, body: {} });
        expect(untrusted.dependencies.addresses[0]).to.not.equal('9.9.9.9');
    });

    it('serves HTTPS and registers MCP certificate reload and SNI lookup', async () => {
        let registrations = [];
        let sniCalls = [];
        let registerReload = certs.registerReload;
        let getContextForServername = certs.getContextForServername;
        certs.registerReload = (registeredServer, name, serverOptions) => registrations.push({ registeredServer, name, serverOptions });
        certs.getContextForServername = async (servername, serverOptions, meta) => {
            sniCalls.push({ servername, serverOptions, meta });
            return false;
        };

        try {
            ({ server } = await startMcp(true));
            let response = await request(server, { secure: true, method: 'GET', servername: 'mail.example.com' });
            let expectedCert = new X509Certificate(certs.get('mcp').cert);

            expect(response.statusCode).to.equal(401);
            expect(response.peerCertificate.raw.equals(expectedCert.raw)).to.equal(true);
            expect(registrations).to.have.length(1);
            expect(registrations[0].name).to.equal('mcp');
            expect(registrations[0].registeredServer).to.equal(server);
            expect(registrations[0].serverOptions).to.have.property('cert');
            expect(sniCalls).to.have.length(1);
            expect(sniCalls[0].servername).to.equal('mail.example.com');
            expect(sniCalls[0].meta).to.deep.equal({ source: 'MCP' });
        } finally {
            certs.registerReload = registerReload;
            certs.getContextForServername = getContextForServername;
        }
    });
});

describe('MCP request draining', () => {
    // A fake request stream: an EventEmitter with the few flags and the resume() the drain reads.
    function fakeRequest(props) {
        let req = new EventEmitter();
        req.complete = false;
        req.destroyed = false;
        req.readable = true;
        req.resume = () => false;
        return Object.assign(req, props);
    }

    it('resolves true when the body ends within the bound', async () => {
        let req = fakeRequest();
        let result = mcp.drainUnusedBody(req, 1024, 1000);
        req.emit('data', Buffer.alloc(100));
        req.emit('end');
        expect(await result).to.equal(true);
        // its listeners are removed once it settles, so a later event cannot resolve it twice
        expect(req.listenerCount('data')).to.equal(0);
        expect(req.listenerCount('end')).to.equal(0);
    });

    it('resolves false when the body overruns the byte bound', async () => {
        let req = fakeRequest();
        let result = mcp.drainUnusedBody(req, 128, 1000);
        req.emit('data', Buffer.alloc(64));
        req.emit('data', Buffer.alloc(128));
        expect(await result).to.equal(false);
        expect(req.listenerCount('data')).to.equal(0);
    });

    it('resolves false when the body overruns the time bound', async () => {
        let req = fakeRequest();
        // never ends and stays under the byte bound, so only the timeout can settle it
        let result = mcp.drainUnusedBody(req, 1024, 20);
        req.emit('data', Buffer.alloc(8));
        expect(await result).to.equal(false);
    });

    it('resolves true immediately for a request whose body is already read', async () => {
        let req = fakeRequest({ complete: true });
        expect(await mcp.drainUnusedBody(req, 1024, 1000)).to.equal(true);
        // it never has to touch the stream
        expect(req.listenerCount('data')).to.equal(0);
    });

    it('resolves false immediately for a stream that is already gone', async () => {
        expect(await mcp.drainUnusedBody(fakeRequest({ destroyed: true }), 1024, 1000)).to.equal(false);
        expect(await mcp.drainUnusedBody(fakeRequest({ readable: false }), 1024, 1000)).to.equal(false);
    });
});
