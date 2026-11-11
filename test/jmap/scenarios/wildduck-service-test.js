/* eslint no-unused-expressions: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file wildduck.yaml: JMAP service wiring and operations (WDS).

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const forge = require('node-forge');
const promClient = require('prom-client');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { MongoServerError } = require('mongodb');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');
const instance = require('../harness/instance');

const { JmapClient, forUser, URN, JMAP_URL } = jmap;
const REPO = path.join(__dirname, '..', '..', '..');

const echo = (args, callId = 'c1') => ({ using: [URN.core], methodCalls: [['Core/echo', args, callId]] });

// wildduck_service_up of the test server (worker 1, metrics listener) and of this process (worker 2)
async function serverServiceStates() {
    const res = await fetch(`http://127.0.0.1:${config.metrics.port}/metrics`);
    const text = await res.text();
    return Object.fromEntries([...text.matchAll(/^wildduck_service_up\{service="([^"]+)"\} (\d+)$/gm)].map(match => [match[1], Number(match[2])]));
}

async function localServiceState(service) {
    const metric = await promClient.register.getSingleMetric('wildduck_service_up').get();
    const entry = metric.values.find(value => value.labels.service === service);
    return entry && entry.value;
}

const refused = url =>
    fetch(url).then(
        () => false,
        err => err
    );

// a self signed certificate for one server name
function selfSigned(servername) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const attrs = [{ name: 'commonName', value: servername }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: servername }] }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { privateKey: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

// the certificate a TLS server presents for a server name (or the handshake error)
function peerCertificate(port, options) {
    return new Promise(resolve => {
        const socket = tls.connect(Object.assign({ host: '127.0.0.1', port, rejectUnauthorized: false }, options), () => {
            const cert = socket.getPeerX509Certificate();
            socket.end();
            resolve({ cert });
        });
        socket.on('error', err => resolve({ err }));
    });
}

describe('JMAP service (wildduck.yaml)', () => {
    before(() => instance.captureLog());
    after(() => instance.stopAll());

    scenario('WDS-001', async () => {
        // the shipped configuration file, not the test overrides
        const file = fs.readFileSync(path.join(REPO, 'config', 'jmap.toml'), 'utf8');
        const enabled = (/^enabled\s*=\s*(\S+)/m.exec(file) || [])[1];
        expect(enabled).to.equal('false');

        const port = await instance.freePort();
        const { app } = await instance.startInstance({ enabled: enabled === 'true', port });
        expect(app).to.be.false;
        expect(await refused(`http://127.0.0.1:${port}/.well-known/jmap`)).to.be.an('error');
        expect(await localServiceState('jmap')).to.equal(0);

        // the other services of the test server start as before
        const states = await serverServiceStates();
        for (const service of ['imap', 'pop3', 'lmtp', 'api']) {
            expect(states[service], service).to.equal(1);
        }
    });

    scenario('WDS-002', async () => {
        // the test server is one worker, an instance in this process is a second one
        const second = await instance.startInstance();
        expect((await serverServiceStates()).jmap).to.equal(1);
        expect(await localServiceState('jmap')).to.equal(1);

        const user = await accounts.createUser();
        const workers = [forUser(user), forUser(user)];
        const urls = [JMAP_URL, second.url];
        for (let round = 0; round < 3; round++) {
            for (const [index, client] of workers.entries()) {
                const res = await client.raw(`${urls[index]}/jmap/api/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(echo({ round, worker: index }))
                });
                expect(res.status).to.equal(200);
                expect(res.json.methodResponses[0][1]).to.deep.equal({ round, worker: index });
            }
        }

        const stateAt = async url => {
            const res = await workers[0].raw(`${url}/jmap/api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ using: [URN.core, URN.mail], methodCalls: [['Email/get', { accountId: `u${user.id}`, ids: [] }, 'g']] })
            });
            return res.json.methodResponses[0][1].state;
        };
        const before = await stateAt(JMAP_URL);
        expect(await stateAt(second.url)).to.equal(before);

        // a change seen by the first worker is seen by the second one
        await seed.deliver(user.address, await fixtures.buildMessage({ to: user.address }));
        const after = await clock.waitFor(async () => {
            const state = await stateAt(JMAP_URL);
            return state !== before && state;
        });
        expect(await stateAt(second.url)).to.equal(after);

        // and the request counter of one worker limits the other
        const { maxConcurrentRequests } = config.jmap.limits;
        const held = [];
        try {
            for (let i = 0; i < maxConcurrentRequests; i++) {
                const req = http.request(`${JMAP_URL}/jmap/api/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': 100, Authorization: workers[0].authorization }
                });
                req.on('error', () => false);
                req.write('{');
                held.push(req);
            }
            const { redis } = await instance.connect();
            await clock.waitFor(async () => Number(await redis.get(`jmap:conc:${user.id}`)) === maxConcurrentRequests, { message: 'requests were not held' });
            const over = await workers[1].raw(`${second.url}/jmap/api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(echo({}))
            });
            expect(over.status).to.equal(429);
            expect(over.json.limit).to.equal('maxConcurrentRequests');
        } finally {
            held.forEach(req => req.destroy());
        }
    });

    scenario('WDS-003', async () => {
        // a reverse proxy in front of an instance: the public URL is the proxy's
        const proxy = http.createServer();
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const publicUrl = `http://127.0.0.1:${proxy.address().port}`;
        const upstream = await instance.startInstance({ baseUrl: publicUrl });
        proxy.on('request', (req, res) => {
            const forward = http.request(
                {
                    host: '127.0.0.1',
                    port: upstream.port,
                    method: req.method,
                    path: req.url,
                    headers: Object.assign({}, req.headers, { host: `127.0.0.1:${upstream.port}` })
                },
                answer => {
                    res.writeHead(answer.statusCode, answer.headers);
                    answer.pipe(res);
                }
            );
            req.pipe(forward);
        });

        try {
            const user = await accounts.createUser();
            const client = forUser(user);
            const res = await client.raw(`${publicUrl}/.well-known/jmap`);
            expect(res.status).to.equal(200);
            for (const key of ['apiUrl', 'uploadUrl', 'downloadUrl', 'eventSourceUrl']) {
                expect(res.json[key].startsWith(`${publicUrl}/`), key).to.be.true;
                expect(res.json[key], key).to.not.include(`:${upstream.port}`);
            }
            const echoed = await client.raw(res.json.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(echo({ via: 'proxy' }))
            });
            expect(echoed.json.methodResponses[0][1]).to.deep.equal({ via: 'proxy' });
        } finally {
            proxy.close();
        }
    });

    scenario('WDS-004', async () => {
        const servername = `jmap-${crypto.randomBytes(4).toString('hex')}.example.test`;
        const managed = selfSigned(servername);
        const { id } = await api('POST', '/certs', { servername, privateKey: managed.privateKey, cert: managed.cert });
        try {
            const secure = await instance.startInstance({ secure: true });

            const sni = await peerCertificate(secure.port, { servername });
            expect(sni.err).to.not.exist;
            expect(sni.cert.fingerprint256).to.equal(new crypto.X509Certificate(managed.cert).fingerprint256);

            const defaultCert = new crypto.X509Certificate(fs.readFileSync(path.join(REPO, 'certs', 'example.cert')));
            const plain = await peerCertificate(secure.port, { servername: 'localhost' });
            expect(plain.err).to.not.exist;
            expect(plain.cert.fingerprint256).to.equal(defaultCert.fingerprint256);

            const old = await peerCertificate(secure.port, { servername, minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT:@SECLEVEL=0' });
            expect(old.err).to.be.an('error');

            // the service works over TLS
            const user = await accounts.createUser();
            const res = await new Promise((resolve, reject) => {
                const req = https.request(
                    `${secure.url}/.well-known/jmap`,
                    { rejectUnauthorized: false, servername, headers: { Authorization: forUser(user).authorization } },
                    answer => {
                        answer.resume();
                        answer.on('end', () => resolve(answer));
                    }
                );
                req.on('error', reject);
                req.end();
            });
            expect(res.statusCode).to.equal(200);
        } finally {
            await api('DELETE', `/certs/${id}`);
        }
    });

    scenario('WDS-005', async () => {
        const records = instance.captureLog();
        const logged = await instance.startInstance();
        const user = await accounts.createUser();
        const client = forUser(user);
        const secret = `content-${crypto.randomBytes(6).toString('hex')}`;
        const from = records.length;
        const res = await client.raw(`${logged.url}/jmap/api/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                using: [URN.core, URN.mail],
                methodCalls: [
                    ['Core/echo', { secret }, 'a'],
                    ['Mailbox/get', { accountId: `u${user.id}`, ids: [] }, 'b'],
                    ['Fake/nonexistent', {}, 'c']
                ]
            })
        });
        expect(res.status).to.equal(200);

        const access = await clock.waitFor(() => {
            const lines = records.slice(from).filter(record => record.prefix === 'JMAP' && / \/jmap\/api\/ /.test(record.message));
            return lines.length && lines;
        });
        expect(access).to.have.length(1);
        const line = access[0].message;
        expect(line).to.include(`user=${user.id}`);
        expect(line).to.include('methods=Core/echo,Mailbox/get,Fake/nonexistent');
        expect(line).to.include('errors=unknownMethod');
        expect(line).to.match(/ \d+ms$/);
        const sess = (/ sess=(\S+)/.exec(line) || [])[1];
        expect(sess).to.match(/^[0-9a-f]{16}$/);

        // the session id is the one of the authentication log entry
        const db = await seed.db();
        const authEntry = await db.collection('authlog').findOne({ user: new seed.ObjectId(user.id), sess });
        expect(authEntry).to.exist;

        for (const record of records.slice(from)) {
            expect(record.message).to.not.include(user.password);
            expect(record.message).to.not.include(client.authorization.split(' ')[1]);
            expect(record.message).to.not.include(secret);
        }
        await instance.stopInstance(logged.app);
    });

    scenario('WDS-006', async () => {
        instance.captureLog();
        const fault = { on: false };
        const timeLimit = () => {
            const err = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
            return Promise.reject(err);
        };
        const failingCursor = () => {
            const cursor = { toArray: timeLimit, next: timeLimit, hasNext: timeLimit, close: async () => false };
            cursor[Symbol.asyncIterator] = () => ({ next: timeLimit, return: async () => ({ done: true }) });
            for (const name of ['project', 'sort', 'limit', 'skip', 'maxTimeMS', 'batchSize', 'hint', 'allowDiskUse']) {
                cursor[name] = () => cursor;
            }
            return cursor;
        };
        // the messages collection of the instance runs into the database time limit while the fault is on
        const wrap = database =>
            new Proxy(database, {
                get(target, property) {
                    const value = Reflect.get(target, property, target);
                    if (property !== 'collection') {
                        return typeof value === 'function' ? value.bind(target) : value;
                    }
                    return (name, ...rest) => {
                        const collection = target.collection(name, ...rest);
                        if (name !== 'messages') {
                            return collection;
                        }
                        return new Proxy(collection, {
                            get(inner, key) {
                                if (fault.on && ['aggregate', 'find'].includes(key)) {
                                    return failingCursor;
                                }
                                if (fault.on && ['countDocuments', 'distinct', 'findOne', 'estimatedDocumentCount'].includes(key)) {
                                    return timeLimit;
                                }
                                const member = Reflect.get(inner, key, inner);
                                return typeof member === 'function' ? member.bind(inner) : member;
                            }
                        });
                    };
                }
            });
        const slow = await instance.startInstance({}, { database: wrap });
        const user = await accounts.createUser();
        await seed.deliver(user.address, await fixtures.buildMessage({ to: user.address }));
        const client = new JmapClient(forUser(user).authorization);
        const send = () =>
            client.raw(`${slow.url}/jmap/api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    using: [URN.core, URN.mail],
                    methodCalls: [
                        ['Core/echo', { before: true }, 'a'],
                        ['Email/query', { accountId: `u${user.id}` }, 'q'],
                        ['Mailbox/get', { accountId: `u${user.id}`, ids: null, properties: ['name'] }, 'm']
                    ]
                })
            });

        fault.on = true;
        const res = await send();
        fault.on = false;
        expect(res.status).to.equal(200);
        const [first, query, mailboxes] = res.json.methodResponses;
        expect(first).to.deep.equal(['Core/echo', { before: true }, 'a']);
        expect(query[0]).to.equal('error');
        expect(query[1].type).to.be.oneOf(['serverUnavailable', 'serverFail']);
        expect(mailboxes[0]).to.equal('Mailbox/get');
        expect(mailboxes[1].list).to.not.be.empty;

        // the worker keeps serving
        const later = await clock.waitFor(async () => {
            const answer = await send();
            return answer.json.methodResponses[1][0] === 'Email/query' && answer;
        });
        expect(later.json.methodResponses[1][1].ids).to.have.length(1);
        await instance.stopInstance(slow.app);
    });
});
