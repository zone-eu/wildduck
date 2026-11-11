'use strict';

// A local Web Push service for the PushSubscription scenarios: an HTTPS server on push.wildduck.test
// (certificate in test/jmap/fixtures, trusted by the test configuration) that records every request
// and answers as a test tells it, a DNS server for the *.wildduck.test names the server resolves
// (jmap.push.testDns), and the user agent side of RFC 8291 (key pairs, decryption).

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const https = require('https');
const path = require('path');
const config = require('@zone-eu/wild-config');
const { decrypt, ipv6Bytes } = require('../../../lib/jmap/push/webpush');
const { waitFor, delay } = require('./clock');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const HOST = 'push.wildduck.test';

// ---------------------------------------------------------------- DNS

const records = new Map();
let dnsServer = null;

/** Sets the A and AAAA answers of a name (an empty list answers NXDOMAIN) */
function setRecords(name, addresses) {
    records.set(name.toLowerCase(), [].concat(addresses));
}

function readName(message, offset) {
    const labels = [];
    while (message[offset]) {
        labels.push(message.subarray(offset + 1, offset + 1 + message[offset]).toString());
        offset += message[offset] + 1;
    }
    return { name: labels.join('.').toLowerCase(), end: offset + 1 };
}

function answer(query) {
    const { name, end } = readName(query, 12);
    const type = query.readUInt16BE(end);
    const question = query.subarray(12, end + 4);
    const addresses = records.get(name) || [];
    const family = type === 1 ? 4 : type === 28 ? 6 : 0;
    const matching = addresses.filter(address => (family === 4 ? !address.includes(':') : family === 6 && address.includes(':')));
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    // a response, recursion desired and available, NXDOMAIN for unknown names
    header.writeUInt16BE(addresses.length ? 0x8180 : 0x8183, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(matching.length, 6);
    const answers = matching.map(address => {
        const rdata = family === 4 ? Buffer.from(address.split('.').map(Number)) : ipv6Bytes(address);
        const record = Buffer.alloc(12);
        record.writeUInt16BE(0xc00c, 0);
        record.writeUInt16BE(type, 2);
        record.writeUInt16BE(1, 4);
        record.writeUInt32BE(1, 6);
        record.writeUInt16BE(rdata.length, 10);
        return Buffer.concat([record, rdata]);
    });
    return Buffer.concat([header, question, ...answers]);
}

async function startDns() {
    if (dnsServer) {
        return;
    }
    const [host, port] = config.jmap.push.testDns.server.split(':');
    dnsServer = dgram.createSocket('udp4');
    dnsServer.on('message', (message, remote) => {
        try {
            dnsServer.send(answer(message), remote.port, remote.address);
        } catch {
            // ignore malformed queries
        }
    });
    await new Promise((resolve, reject) => {
        dnsServer.once('error', reject);
        dnsServer.bind(Number(port), host, resolve);
    });
    dnsServer.unref();
}

// ---------------------------------------------------------------- push service

let server = null;
let port = null;
const boxes = new Map();

/**
 * A push endpoint: a URL on the local push service and the requests it received.
 * `answers` is a list of responses used in order ({status, headers, hang}); afterwards `fallback` answers.
 */
class Box {
    constructor(id) {
        this.id = id;
        this.url = `https://${HOST}:${port}/push/${id}`;
        this.requests = [];
        this.answers = [];
        this.fallback = { status: 201 };
        this.keys = null;
    }

    /** Answers the next requests with these responses */
    respond(...answers) {
        this.answers.push(...answers);
        return this;
    }

    /** Waits for at least `count` requests and answers them */
    async wait(count = 1, timeout = 10000) {
        await waitFor(() => this.requests.length >= count, { timeout, message: `${count} push requests to ${this.id}, got ${this.requests.length}` });
        return this.requests.slice(0, count);
    }

    /** The decoded JSON body of a request (decrypted with the box keys when it is encrypted) */
    json(request) {
        const body = request.headers['content-encoding'] === 'aes128gcm' ? decrypt(request.body, this.keys.privateKey, this.keys.auth) : request.body;
        return JSON.parse(body.toString());
    }

    /** Requests whose body is a StateChange */
    stateChanges() {
        return this.requests.filter(request => this.json(request)['@type'] === 'StateChange');
    }

    verifications() {
        return this.requests.filter(request => this.json(request)['@type'] === 'PushVerification');
    }
}

async function startServer() {
    if (server) {
        return;
    }
    server = https.createServer(
        { key: fs.readFileSync(path.join(FIXTURES, 'push-receiver.key')), cert: fs.readFileSync(path.join(FIXTURES, 'push-receiver.cert')) },
        (req, res) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const box = boxes.get(req.url.split('/')[2]);
                if (!box) {
                    res.writeHead(404).end();
                    return;
                }
                box.requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks), time: Date.now() });
                const reply = box.answers.length ? box.answers.shift() : box.fallback;
                if (reply.hang) {
                    // never answers; the socket stays open until the client gives up
                    return;
                }
                res.writeHead(reply.status, reply.headers || {}).end();
            });
        }
    );
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    server.unref();
    port = server.address().port;
}

/** Starts the push service and the DNS server (once per run) */
async function start() {
    await startDns();
    await startServer();
    setRecords(HOST, ['127.0.0.1']);
}

/** A new push endpoint; `withKeys` adds RFC 8291 user agent keys (box.keys, box.subscriptionKeys) */
function endpoint(withKeys = false) {
    const box = new Box(crypto.randomBytes(12).toString('hex'));
    boxes.set(box.id, box);
    if (withKeys) {
        box.keys = userAgentKeys();
    }
    return box;
}

/** A P-256 key pair and auth secret of a user agent: {p256dh, auth, privateKey} */
function userAgentKeys() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url'), privateKey: ecdh.getPrivateKey() };
}

function close() {
    if (server) {
        server.closeAllConnections();
        server.close();
    }
    if (dnsServer) {
        dnsServer.close();
    }
    server = null;
    dnsServer = null;
}

module.exports = { start, endpoint, userAgentKeys, setRecords, close, delay, HOST };
