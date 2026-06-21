/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* global before, after */

'use strict';

const http2 = require('node:http2');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const forge = require('node-forge');
const { expect } = require('chai');
const ApnClient = require('../lib/apn-client');

// 64-char hex device tokens accepted by the client
const VALID_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const VALID_TOKEN_2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Self-signed cert/key for the mock APNs server, via node-forge
function generateSelfSignedCert() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const key = Buffer.from(forge.pki.privateKeyToPem(keys.privateKey));
    const certPem = Buffer.from(forge.pki.certificateToPem(cert));

    const tmpDir = os.tmpdir();
    const keyPath = path.join(tmpDir, 'apn-test-key.pem');
    const certPath = path.join(tmpDir, 'apn-test-cert.pem');

    // ApnClient reads the cert/key from disk via certPath/keyPath, so persist them
    fs.writeFileSync(keyPath, key);
    fs.writeFileSync(certPath, certPem);

    return { key, cert: certPem, keyPath, certPath };
}

// In-memory pushsubscriptions collection: supports the find/deleteMany shapes the client uses.
// `subscriptions` is mutated in place so tests can assert stale-token cleanup.
function mockDatabase(subscriptions) {
    return {
        collection() {
            return {
                find(query) {
                    let matched = subscriptions;
                    if (query.mailboxIds) {
                        let paths = query.mailboxIds.$in || [query.mailboxIds];
                        matched = subscriptions.filter(sub => sub.mailboxIds.some(m => paths.includes(m)));
                    }
                    return {
                        toArray() {
                            return Promise.resolve(matched);
                        }
                    };
                },
                deleteMany(query) {
                    let ids = query._id.$in || [];
                    let count = 0;
                    for (let id of ids) {
                        let idx = subscriptions.findIndex(s => s._id === id);
                        if (idx >= 0) {
                            subscriptions.splice(idx, 1);
                            count++;
                        }
                    }
                    return Promise.resolve({ deletedCount: count });
                }
            };
        }
    };
}

// respond to every APNs request with a fixed status/body
function respondWith(status, body) {
    return stream => {
        stream.respond({ ':status': status });
        stream.end(body || undefined);
    };
}

describe('ApnClient', function () {
    this.timeout(15000); // eslint-disable-line

    let tls;
    let mockServer;
    let mockPort;
    let requestHandler;
    let prevTlsReject;
    let clients;
    let mockSessions;

    before(function () {
        // generated in-process, throws (not skips) on failure
        tls = generateSelfSignedCert();

        // trust the mock server's self-signed cert for this suite (restored in after())
        prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    });

    after(function () {
        if (prevTlsReject === undefined) {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsReject;
        }
    });

    beforeEach(function (done) {
        requestHandler = null;
        clients = [];
        mockSessions = [];

        mockServer = http2.createSecureServer({
            key: tls.key,
            cert: tls.cert
        });

        // track every server-side session so teardown can force-close them; a session
        // that received a server-initiated GOAWAY can otherwise linger and stall close()
        mockServer.on('session', session => mockSessions.push(session));

        mockServer.on('stream', (stream, headers) => {
            // default: 200 OK, unless the test installs its own handler
            (requestHandler || respondWith(200))(stream, headers);
        });

        mockServer.listen(0, '127.0.0.1', () => {
            mockPort = mockServer.address().port;
            done();
        });
    });

    afterEach(function (done) {
        // close every client a test created so no HTTP/2 session or timer leaks
        for (let client of clients) {
            client.close();
        }
        // force-destroy any lingering server-side session so mockServer.close() can complete
        for (let session of mockSessions) {
            if (!session.destroyed) {
                session.destroy();
            }
        }
        if (mockServer) {
            mockServer.close(() => done());
        } else {
            return done();
        }
    });

    // Instantiate the class directly (bypassing the singleton) and point it at the mock server.
    // Created clients are tracked and closed in afterEach.
    function createClient(overrides) {
        let client = new ApnClient({
            topic: 'com.apple.mail.XServer.test',
            certPath: tls.certPath,
            keyPath: tls.keyPath,
            database: overrides && overrides.database,
            loggelf: (overrides && overrides.loggelf) || (() => false)
        });
        client.host = `127.0.0.1:${mockPort}`;
        clients.push(client);
        return client;
    }

    describe('device token validation', function () {
        // every invalid token must reject the same way, before any network activity
        for (let [label, token] of [
            ['non-hex characters', 'Z'.repeat(64)],
            ['tokens shorter than 64 chars', 'abcd1234'],
            ['tokens longer than 64 chars', 'a'.repeat(65)],
            ['empty token', '']
        ]) {
            it(`should reject ${label}`, async function () {
                let client = createClient();
                try {
                    await client._push(token, 'account-1');
                    expect.fail('should have thrown');
                } catch (err) {
                    expect(err.message).to.equal('Invalid device token format');
                }
            });
        }

        it('should accept a valid 64-char hex token', async function () {
            let client = createClient();
            let result = await client._push(VALID_TOKEN, 'account-1');
            expect(result.status).to.equal(200);
        });

        it('should not create an HTTP/2 session for invalid tokens', function () {
            let client = createClient();
            expect(client._session).to.be.null;

            client._push('invalid', 'account-1').catch(() => {});

            // validation rejects before _getSession(), so no session is opened
            expect(client._session).to.be.null;
        });
    });

    describe('_push() request/response handling', function () {
        it('should send correct headers and payload', function (done) {
            let client = createClient();

            requestHandler = (stream, headers) => {
                expect(headers[':method']).to.equal('POST');
                expect(headers[':path']).to.equal(`/3/device/${VALID_TOKEN}`);
                expect(headers['content-type']).to.equal('application/json');
                expect(headers['apns-topic']).to.equal('com.apple.mail.XServer.test');
                expect(headers['apns-push-type']).to.equal('background');
                expect(headers['apns-priority']).to.equal('5');
                expect(headers['apns-expiration']).to.be.a('string');
                expect(headers['apns-collapse-id']).to.equal('test-account');

                let body = '';
                stream.on('data', chunk => {
                    body += chunk;
                });
                stream.on('end', () => {
                    expect(JSON.parse(body)).to.deep.equal({ aps: { 'account-id': 'test-account' } });
                    stream.respond({ ':status': 200 });
                    stream.end();
                });
            };

            client
                ._push(VALID_TOKEN, 'test-account')
                .then(result => {
                    expect(result.status).to.equal(200);
                    expect(result.reason).to.be.null;
                    done();
                })
                .catch(done);
        });

        it('should handle 200 success', async function () {
            let client = createClient();
            let result = await client._push(VALID_TOKEN, 'account-1');
            expect(result.status).to.equal(200);
            expect(result.reason).to.be.null;
        });

        it('should handle 410 Gone with reason', async function () {
            requestHandler = respondWith(410, JSON.stringify({ reason: 'Unregistered' }));
            let result = await createClient()._push(VALID_TOKEN, 'account-1');
            expect(result.status).to.equal(410);
            expect(result.reason).to.equal('Unregistered');
        });

        it('should handle 400 Bad Request with reason', async function () {
            requestHandler = respondWith(400, JSON.stringify({ reason: 'BadDeviceToken' }));
            let result = await createClient()._push(VALID_TOKEN, 'account-1');
            expect(result.status).to.equal(400);
            expect(result.reason).to.equal('BadDeviceToken');
        });

        it('should handle non-JSON error body gracefully', async function () {
            requestHandler = respondWith(500, 'Internal Server Error');
            let result = await createClient()._push(VALID_TOKEN, 'account-1');
            expect(result.status).to.equal(500);
            expect(result.reason).to.equal('Internal Server Error');
        });

        it('should handle empty response body', async function () {
            requestHandler = respondWith(200);
            let result = await createClient()._push(VALID_TOKEN, 'account-1');
            expect(result.status).to.equal(200);
            expect(result.reason).to.be.null;
        });

        it('should reuse the HTTP/2 session across multiple pushes', async function () {
            let requestCount = 0;
            requestHandler = stream => {
                requestCount++;
                stream.respond({ ':status': 200 });
                stream.end();
            };

            let client = createClient();
            await client._push(VALID_TOKEN, 'account-1');
            let session1 = client._session;
            await client._push(VALID_TOKEN, 'account-2');
            let session2 = client._session;

            expect(session1).to.equal(session2);
            expect(requestCount).to.equal(2);
        });
    });

    describe('_flushNotifications()', function () {
        const subsFor = (...mailboxIdsPerSub) =>
            mailboxIdsPerSub.map((mailboxIds, i) => ({
                _id: String(i + 1),
                deviceToken: i === 0 ? VALID_TOKEN : VALID_TOKEN_2,
                accountId: `acc-${i + 1}`,
                mailboxIds
            }));

        it('should send a push to every matching subscription', async function () {
            let pushCount = 0;
            requestHandler = stream => {
                pushCount++;
                stream.respond({ ':status': 200 });
                stream.end();
            };

            let subs = subsFor(['INBOX'], ['INBOX']);
            await createClient({ database: mockDatabase(subs) })._flushNotifications('user-1', ['INBOX']);
            expect(pushCount).to.equal(2);
        });

        it('should query with $in for multiple mailbox paths', async function () {
            let pushCount = 0;
            requestHandler = stream => {
                pushCount++;
                stream.respond({ ':status': 200 });
                stream.end();
            };

            let subs = subsFor(['INBOX'], ['Notes']);
            await createClient({ database: mockDatabase(subs) })._flushNotifications('user-1', ['INBOX', 'Notes']);
            expect(pushCount).to.equal(2);
        });

        it('should not push when no subscription matches the mailbox', async function () {
            let pushCount = 0;
            requestHandler = stream => {
                pushCount++;
                stream.respond({ ':status': 200 });
                stream.end();
            };

            let subs = subsFor(['Sent']);
            await createClient({ database: mockDatabase(subs) })._flushNotifications('user-1', ['INBOX']);
            expect(pushCount).to.equal(0);
        });

        // tokens APNs reports as permanently invalid are removed; systemic/transient errors are not
        for (let [label, status, reason, removed] of [
            ['410 Unregistered', 410, 'Unregistered', true],
            ['400 BadDeviceToken', 400, 'BadDeviceToken', true],
            ['400 BadTopic (systemic)', 400, 'BadTopic', false],
            ['500 InternalServerError (transient)', 500, 'InternalServerError', false]
        ]) {
            it(`should ${removed ? 'remove' : 'keep'} a subscription on ${label}`, async function () {
                let pushCount = 0;
                requestHandler = (stream, headers) => {
                    pushCount++;
                    // only the first token gets the error; the second always succeeds
                    if (headers[':path'].includes(VALID_TOKEN)) {
                        stream.respond({ ':status': status });
                        stream.end(JSON.stringify({ reason }));
                    } else {
                        stream.respond({ ':status': 200 });
                        stream.end();
                    }
                };

                let subs = subsFor(['INBOX'], ['INBOX']);
                await createClient({ database: mockDatabase(subs) })._flushNotifications('user-1', ['INBOX']);

                // both devices are always attempted in parallel
                expect(pushCount).to.equal(2);
                if (removed) {
                    expect(subs.map(s => s._id)).to.deep.equal(['2']);
                } else {
                    expect(subs).to.have.length(2);
                }
            });
        }

        it('should not throw when the subscription query fails', async function () {
            let pushCount = 0;
            requestHandler = stream => {
                pushCount++;
                stream.respond({ ':status': 200 });
                stream.end();
            };

            let db = {
                collection() {
                    return {
                        find() {
                            return {
                                toArray() {
                                    return Promise.reject(new Error('DB connection lost'));
                                }
                            };
                        }
                    };
                }
            };

            // must resolve, not reject
            await createClient({ database: db })._flushNotifications('user-1', ['INBOX']);
            expect(pushCount).to.equal(0);
        });
    });

    describe('notify() debouncing', function () {
        // replace the network-touching flush with a recorder
        function recordingClient() {
            let flushCalls = [];
            let client = createClient({ database: { collection: () => ({}) } });
            client._flushNotifications = async (user, mailboxIds) => {
                flushCalls.push({ user: user.toString(), mailboxIds });
            };
            return { client, flushCalls };
        }

        it('should coalesce repeated calls for the same user into one flush', function (done) {
            let { client, flushCalls } = recordingClient();

            client.notify('user-1', 'INBOX');
            client.notify('user-1', 'INBOX');
            client.notify('user-1', 'Notes');

            expect(flushCalls).to.have.length(0); // nothing fires synchronously

            setTimeout(() => {
                expect(flushCalls).to.have.length(1);
                // INBOX + Notes, deduplicated
                expect(flushCalls[0].mailboxIds).to.have.members(['INBOX', 'Notes']);
                expect(flushCalls[0].mailboxIds).to.have.length(2);
                done();
            }, 2500);
        });

        it('should debounce each user independently', function (done) {
            let { client, flushCalls } = recordingClient();

            client.notify('user-1', 'INBOX');
            client.notify('user-2', 'INBOX');

            setTimeout(() => {
                expect(flushCalls).to.have.length(2);
                expect(flushCalls.map(c => c.user)).to.have.members(['user-1', 'user-2']);
                done();
            }, 2500);
        });

        it('should reset the debounce timer on each new call', function (done) {
            let { client, flushCalls } = recordingClient();

            client.notify('user-1', 'INBOX');

            // a second call before the first window elapses pushes the flush out
            setTimeout(() => {
                client.notify('user-1', 'Sent');
                expect(flushCalls).to.have.length(0);
            }, 1000);

            // original window would have fired here, but it was reset
            setTimeout(() => expect(flushCalls).to.have.length(0), 2500);

            // reset window fires here, with both mailboxes coalesced
            setTimeout(() => {
                expect(flushCalls).to.have.length(1);
                expect(flushCalls[0].mailboxIds).to.have.members(['INBOX', 'Sent']);
                done();
            }, 3500);
        });
    });

    describe('reconnect cooldown', function () {
        // point a client at a port with nothing listening so the connect fails immediately
        function failingClient(overrides) {
            let client = createClient(overrides);
            client.host = '127.0.0.1:1'; // ECONNREFUSED before 'connect'
            return client;
        }

        it('should arm a single hold after a failed connect', async function () {
            let gelf = [];
            let client = failingClient({ loggelf: m => gelf.push(m) });

            // first attempt dials (and is doomed); the failure arms the cooldown asynchronously
            expect(client._getSession()).to.not.be.null;
            await new Promise(resolve => setTimeout(resolve, 300));

            expect(client._reconnectAfter).to.be.greaterThan(Date.now());
            // 'error' + 'close' both fire, but only the first arms/logs the hold
            let holds = gelf.filter(m => m._mail_action === 'apn_reconnect_hold');
            expect(holds).to.have.length(1);
        });

        it('should return null from _getSession() while cooling down', function () {
            let client = createClient();
            client._reconnectAfter = Date.now() + 10000;
            expect(client._getSession()).to.be.null;
        });

        it('should reject _push() while cooling down without dialing', async function () {
            let client = createClient();
            client._reconnectAfter = Date.now() + 10000;
            try {
                await client._push(VALID_TOKEN, 'account-1');
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.message).to.equal('APNs reconnect on cooldown');
            }
            expect(client._session).to.be.null;
        });

        it('should skip _flushNotifications() entirely while cooling down', async function () {
            let queried = false;
            let db = {
                collection() {
                    return {
                        find() {
                            queried = true;
                            return { toArray: () => Promise.resolve([]) };
                        }
                    };
                }
            };

            let client = createClient({ database: db });
            client._reconnectAfter = Date.now() + 10000;
            await client._flushNotifications('user-1', ['INBOX']);

            // early return: no DB query, no push
            expect(queried).to.be.false;
        });

        it('should reconnect and clear the hold once the cooldown elapses', async function () {
            requestHandler = respondWith(200);
            let client = createClient();

            // simulate an elapsed cooldown
            client._reconnectAfter = Date.now() - 1;

            let result = await client._push(VALID_TOKEN, 'account-1');
            expect(result.status).to.equal(200);
            // a successful connect clears the hold
            expect(client._reconnectAfter).to.equal(0);
        });
    });

    describe('GOAWAY handling', function () {
        it('should destroy the session on a GOAWAY frame and reconnect on the next push', async function () {
            requestHandler = respondWith(200);

            let serverSessions = [];
            mockServer.on('session', s => serverSessions.push(s));

            let client = createClient();
            await client._push(VALID_TOKEN, 'account-1');
            let session = client._session;
            expect(session).to.not.be.null;
            expect(serverSessions.length).to.be.greaterThan(0);

            serverSessions[serverSessions.length - 1].goaway();
            await new Promise(resolve => setTimeout(resolve, 500));

            // GOAWAY of a live session destroys it but does not arm the cooldown
            expect(client._session).to.be.null;
            expect(client._reconnectAfter).to.equal(0);

            // next push opens a fresh session
            await client._push(VALID_TOKEN, 'account-1');
            expect(client._session).to.not.be.null;
            expect(client._session).to.not.equal(session);
        });
    });

    describe('close()', function () {
        it('should clear pending debounce timers', function (done) {
            let flushCalls = [];
            let client = createClient({ database: { collection: () => ({}) } });
            client._flushNotifications = async () => {
                flushCalls.push(true);
            };

            client.notify('user-1', 'INBOX');
            client.close();

            setTimeout(() => {
                expect(flushCalls).to.have.length(0);
                done();
            }, 3000);
        });

        it('should tear down the HTTP/2 session', async function () {
            requestHandler = respondWith(200);
            let client = createClient();

            await client._push(VALID_TOKEN, 'account-1');
            expect(client._session).to.not.be.null;

            client.close();
            expect(client._session).to.be.null;
        });
    });

    describe('GELF logging', function () {
        // collect GELF events and run a flush against a single seeded subscription
        async function flushAndCollect(status, body) {
            let gelf = [];
            requestHandler = respondWith(status, body);
            let subs = [{ _id: '1', deviceToken: VALID_TOKEN, accountId: 'acc-1', mailboxIds: ['INBOX'] }];
            let client = createClient({ database: mockDatabase(subs), loggelf: m => gelf.push(m) });
            await client._flushNotifications('user-1', ['INBOX']);
            return gelf;
        }

        it('should log a successful connection', async function () {
            let gelf = await flushAndCollect(200);
            let msg = gelf.find(m => m._mail_action === 'apn_connected');
            expect(msg).to.exist;
            expect(msg.short_message).to.equal('[APN] HTTP/2 session established');
        });

        it('should log an invalid device token', async function () {
            let gelf = [];
            let client = createClient({ loggelf: m => gelf.push(m) });
            await client._push('bad', 'account-1').catch(() => {});
            expect(gelf.find(m => m._mail_action === 'apn_invalid_token')).to.exist;
        });

        it('should log a successful push', async function () {
            let gelf = await flushAndCollect(200);
            expect(gelf.find(m => m._mail_action === 'apn_sent')).to.exist;
        });

        it('should log an expired token', async function () {
            let gelf = await flushAndCollect(410, JSON.stringify({ reason: 'Unregistered' }));
            expect(gelf.find(m => m._mail_action === 'apn_token_expired')).to.exist;
        });

        it('should log a push failure with status and reason', async function () {
            let gelf = await flushAndCollect(403, JSON.stringify({ reason: 'InvalidProviderToken' }));
            let msg = gelf.find(m => m._mail_action === 'apn_fail');
            expect(msg).to.exist;
            expect(msg._status).to.equal(403);
            expect(msg._reason).to.equal('InvalidProviderToken');
        });

        it('should never include the full device token in any GELF event', async function () {
            let gelf = await flushAndCollect(200);
            for (let msg of gelf) {
                expect(JSON.stringify(msg)).to.not.include(VALID_TOKEN);
            }
        });
    });
});
