/* eslint no-invalid-this: 0 */

'use strict';

const http = require('http');
const https = require('https');
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
            return {
                results: [
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
                ]
            };
        },
        async resolveMailbox() {
            return { _id: id(MAILBOX_ID), path: 'INBOX', specialUse: null };
        },
        async listMessages() {
            return { total: 0, nextCursor: false, results: [] };
        },
        async searchMessages() {
            return { total: 0, nextCursor: false, results: [] };
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
                body: {
                    text: {
                        available: true,
                        content: 'hello',
                        truncated: false,
                        originalLength: 5,
                        returnedLength: 5
                    }
                },
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
    let reader = createReader();
    return {
        calls,
        tokenHandler: {
            async authenticate(token) {
                calls.push(token);
                if (token !== TOKEN) {
                    let err = new Error('Invalid token');
                    err.code = 'InvalidMcpToken';
                    throw err;
                }
                return {
                    tokenId: id(TOKEN_ID),
                    user: { _id: id(USER_ID) }
                };
            }
        },
        mailReadHandler: {
            bind(user) {
                expect(user).to.equal(USER_ID);
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
                'get_message'
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
            expect(message.structuredContent).not.to.have.any.keys(
                'raw',
                'headers',
                'forwardTargets',
                'outbound',
                'files',
                'bimi',
                'metaData'
            );

            let mixedSearch = await client.callTool({
                name: 'search_messages',
                arguments: { q: 'secret term', filters: { from: 'sender@example.com' } }
            });
            expect(mixedSearch.isError).to.equal(true);
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

    it('rejects malformed and oversized request bodies after reloading authentication', async () => {
        let started = await startMcp(false, { maxRequestSize: 16 });
        server = started.server;
        let headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

        let malformed = await request(server, { headers, body: '{' });
        let oversized = await request(server, { headers, body: JSON.stringify({ value: 'x'.repeat(30) }) });

        expect(malformed.statusCode).to.equal(400);
        expect(JSON.parse(malformed.body).error.code).to.equal(-32700);
        expect(oversized.statusCode).to.equal(413);
        expect(started.dependencies.calls).to.deep.equal([TOKEN, TOKEN]);
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
