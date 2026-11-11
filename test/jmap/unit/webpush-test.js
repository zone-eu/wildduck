/* eslint no-unused-expressions: 0 */
/* globals before: false, after: false */
'use strict';

// Web Push primitives (lib/jmap/push/webpush.js): RFC 8291 encryption against the RFC's own example,
// VAPID tokens, the address checks and the pinned connection of a push request. Also the delivery
// rules of lib/jmap/push/delivery.js and the settings checks.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { expect } = require('chai');
const webpush = require('../../../lib/jmap/push/webpush');
const { outcomeOf, retryAfterOf, changedTypes, wantedTypes, backoff } = require('../../../lib/jmap/push/delivery');
const { readStates } = require('../../../lib/jmap/push/states');
const { pushSettings } = require('../../../lib/jmap/push/settings');
const { generate, load } = require('../../../lib/jmap/push/vapid');

// RFC 8291 5 and Appendix A
const VECTOR = {
    plaintext: 'When I grow up, I want to be a watermelon',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    body:
        'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};

describe('JMAP Web Push', () => {
    describe('RFC 8291 encryption', () => {
        it('produces the body of the RFC 8291 example', () => {
            const body = webpush.encrypt(
                Buffer.from(VECTOR.plaintext),
                { p256dh: VECTOR.uaPublic, auth: VECTOR.auth },
                { salt: Buffer.from(VECTOR.salt, 'base64url'), privateKey: Buffer.from(VECTOR.asPrivate, 'base64url') }
            );
            expect(body.toString('base64url')).to.equal(VECTOR.body);
        });

        it('decrypts the RFC 8291 example with the user agent keys', () => {
            const plaintext = webpush.decrypt(Buffer.from(VECTOR.body, 'base64url'), Buffer.from(VECTOR.uaPrivate, 'base64url'), VECTOR.auth);
            expect(plaintext.toString()).to.equal(VECTOR.plaintext);
        });

        it('uses a fresh salt and server key for every message', () => {
            const keys = { p256dh: VECTOR.uaPublic, auth: VECTOR.auth };
            const first = webpush.encrypt('{}', keys);
            const second = webpush.encrypt('{}', keys);
            expect(first.subarray(0, 16).equals(second.subarray(0, 16))).to.be.false;
            expect(first.subarray(21, 86).equals(second.subarray(21, 86))).to.be.false;
            expect(webpush.decrypt(second, Buffer.from(VECTOR.uaPrivate, 'base64url'), VECTOR.auth).toString()).to.equal('{}');
        });

        it('refuses a message larger than one record', () => {
            expect(() => webpush.encrypt(Buffer.alloc(webpush.RECORD_SIZE), { p256dh: VECTOR.uaPublic, auth: VECTOR.auth })).to.throw(/too large/);
        });
    });

    describe('subscription keys', () => {
        it('accepts a P-256 point and a 16 octet secret', () => {
            expect(webpush.parseKeys({ p256dh: VECTOR.uaPublic, auth: VECTOR.auth })).to.deep.equal({ p256dh: VECTOR.uaPublic, auth: VECTOR.auth });
            // padding is tolerated and removed
            expect(webpush.parseKeys({ p256dh: VECTOR.uaPublic, auth: VECTOR.auth + '==' })).to.deep.equal({ p256dh: VECTOR.uaPublic, auth: VECTOR.auth });
        });

        it('rejects anything else', () => {
            const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(63), Buffer.from([1])]).toString('base64url');
            for (const keys of [
                null,
                'x',
                [],
                { p256dh: VECTOR.uaPublic },
                { auth: VECTOR.auth },
                { p256dh: VECTOR.uaPublic, auth: VECTOR.auth, extra: 1 },
                { p256dh: 'a+b/', auth: VECTOR.auth },
                { p256dh: offCurve, auth: VECTOR.auth },
                { p256dh: crypto.randomBytes(64).toString('base64url'), auth: VECTOR.auth },
                { p256dh: VECTOR.uaPublic, auth: crypto.randomBytes(8).toString('base64url') }
            ]) {
                expect(webpush.parseKeys(keys), JSON.stringify(keys)).to.equal(null);
            }
        });
    });

    describe('VAPID', () => {
        it('signs an ES256 JWT for the origin of the push URL', () => {
            const vapid = load(generate());
            const now = Date.UTC(2026, 10, 11);
            const header = webpush.vapidAuthorization(vapid, 'https://push.example.net:8443/a/b?c', 'mailto:postmaster@example.com', now);
            const [, token, key] = /^vapid t=(\S+), k=(\S+)$/.exec(header);
            expect(key).to.equal(vapid.publicKey);
            const [head, claims, signature] = token.split('.');
            expect(JSON.parse(Buffer.from(head, 'base64url'))).to.deep.equal({ typ: 'JWT', alg: 'ES256' });
            expect(JSON.parse(Buffer.from(claims, 'base64url'))).to.deep.equal({
                aud: 'https://push.example.net:8443',
                exp: now / 1000 + 12 * 3600,
                sub: 'mailto:postmaster@example.com'
            });
            const raw = Buffer.from(key, 'base64url');
            const publicKey = crypto.createPublicKey({
                key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
                format: 'jwk'
            });
            expect(
                crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
            ).to.be.true;
        });

        it('never issues a token valid for more than 24 hours', () => {
            const vapid = load(generate());
            const header = webpush.vapidAuthorization(vapid, 'https://push.example.net/', 'mailto:a@example.com', 0, 7 * 24 * 3600);
            const claims = JSON.parse(Buffer.from(/t=[^.]+\.([^.]+)\./.exec(header)[1], 'base64url'));
            expect(claims.exp).to.equal(24 * 3600);
        });
    });

    describe('push URLs and addresses', () => {
        it('accepts absolute https URLs only', () => {
            expect(webpush.parsePushUrl('https://push.example.net/x?y=1').hostname).to.equal('push.example.net');
            for (const url of [
                'http://push.example.net/',
                'https://',
                '/x',
                'ftp://a/b',
                'https://u:p@push.example.net/',
                'https://a/' + 'x'.repeat(3000),
                'https://a/\nb',
                7
            ]) {
                expect(webpush.parsePushUrl(url), String(url)).to.equal(null);
            }
        });

        it('tells public addresses from local, private and reserved ones', () => {
            for (const address of ['8.8.8.8', '93.184.215.14', '2606:4700::1111', '::ffff:8.8.8.8']) {
                expect(webpush.isPublicAddress(address), address).to.be.true;
            }
            for (const address of [
                '127.0.0.1',
                '10.0.0.5',
                '172.16.1.1',
                '192.168.1.1',
                '169.254.169.254',
                '0.0.0.0',
                '100.64.0.1',
                '224.0.0.1',
                '255.255.255.255',
                '::',
                '::1',
                'fc00::1',
                'fe80::1',
                '::ffff:127.0.0.1',
                '::ffff:10.1.2.3',
                '::127.0.0.1',
                '64:ff9b::a01:203',
                '2002:7f00:1::1',
                'ff02::1',
                'not an address'
            ]) {
                expect(webpush.isPublicAddress(address), address).to.be.false;
            }
        });

        it('resolves a host once and checks every address', async () => {
            const resolve = async name =>
                name === 'mixed.example'
                    ? [
                          { address: '93.184.215.14', family: 4 },
                          { address: '10.1.2.3', family: 4 }
                      ]
                    : [{ address: '93.184.215.14', family: 4 }];
            expect(await webpush.resolveTarget(new URL('https://ok.example/'), { resolve })).to.deep.equal({ address: '93.184.215.14', family: 4 });
            for (const url of ['https://mixed.example/', 'https://localhost/', 'https://a.localhost/', 'https://2130706433/', 'https://[::1]/']) {
                let failed = null;
                await webpush.resolveTarget(new URL(url), { resolve }).catch(err => (failed = err));
                expect(failed, url).to.be.instanceOf(webpush.TargetError);
            }
            const exempt = await webpush.resolveTarget(new URL('https://push.test/'), {
                allowHosts: new Set(['push.test']),
                resolve: async () => [{ address: '127.0.0.1', family: 4 }]
            });
            expect(exempt.address).to.equal('127.0.0.1');
        });
    });

    describe('push requests', () => {
        let server;
        let port;
        const received = [];
        const fixtures = path.join(__dirname, '..', 'fixtures');

        before(done => {
            server = https.createServer(
                { key: fs.readFileSync(path.join(fixtures, 'push-receiver.key')), cert: fs.readFileSync(path.join(fixtures, 'push-receiver.cert')) },
                (req, res) => {
                    received.push({ headers: req.headers, url: req.url });
                    req.resume();
                    req.on('end', () => (req.url === '/redirect' ? res.writeHead(302, { Location: 'https://example.com/' }).end() : res.writeHead(201).end()));
                }
            );
            server.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                done();
            });
        });

        after(done => server.close(done));

        const ca = [fs.readFileSync(path.join(fixtures, 'push-receiver.cert'), 'utf8')];

        it('connects to the checked address, not to a new lookup of the name', async () => {
            // push.wildduck.test does not resolve anywhere: the request can only reach the server through the given address
            const url = new URL(`https://push.wildduck.test:${port}/push/abc`);
            const result = await webpush.post(url, { address: '127.0.0.1', family: 4 }, Buffer.from('{}'), { 'Content-Type': 'application/json' }, { ca });
            expect(result.status).to.equal(201);
            expect(received[received.length - 1].headers.host).to.equal(`push.wildduck.test:${port}`);
        });

        it('checks the certificate against the host name of the URL', async () => {
            const url = new URL(`https://other.example:${port}/push/abc`);
            let failed = null;
            await webpush.post(url, { address: '127.0.0.1', family: 4 }, Buffer.from('{}'), {}, { ca }).catch(err => (failed = err));
            expect(failed).to.be.an('error');
        });

        it('does not follow redirects', async () => {
            const count = received.length;
            const url = new URL(`https://push.wildduck.test:${port}/redirect`);
            const result = await webpush.post(url, { address: '127.0.0.1', family: 4 }, Buffer.from('{}'), {}, { ca });
            expect(result.status).to.equal(302);
            expect(received.length).to.equal(count + 1);
            expect(outcomeOf(result).kind).to.equal('failed');
        });

        it('gives up at the timeout', async () => {
            const silent = net.createServer(() => false);
            await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
            const url = new URL(`https://push.wildduck.test:${silent.address().port}/x`);
            const started = Date.now();
            let failed = null;
            await webpush.post(url, { address: '127.0.0.1', family: 4 }, Buffer.from('{}'), {}, { ca, timeout: 300 }).catch(err => (failed = err));
            silent.close();
            expect(failed.code).to.equal('ETIMEDOUT');
            expect(Date.now() - started).to.be.below(2000);
            expect(outcomeOf({ error: failed }).kind).to.equal('retry');
        });
    });

    describe('delivery rules', () => {
        it('classifies the answers of a push service', () => {
            expect(outcomeOf({ status: 201, headers: {} }).kind).to.equal('ok');
            expect(outcomeOf({ status: 204, headers: {} }).kind).to.equal('ok');
            expect(outcomeOf({ status: 410, headers: {} }).kind).to.equal('gone');
            expect(outcomeOf({ status: 404, headers: {} }).kind).to.equal('gone');
            expect(outcomeOf({ status: 429, headers: { 'retry-after': '20' } })).to.deep.equal({ kind: 'throttled', retryAfter: 20 });
            expect(outcomeOf({ status: 503, headers: {} }).kind).to.equal('retry');
            for (const status of [301, 302, 307, 308, 400, 401, 403, 413]) {
                expect(outcomeOf({ status, headers: {} }).kind, String(status)).to.equal('failed');
            }
            expect(outcomeOf({ error: new webpush.TargetError('private') }).kind).to.equal('failed');
        });

        it('reads Retry-After as seconds or a date, capped at an hour', () => {
            expect(retryAfterOf('20')).to.equal(20);
            expect(retryAfterOf(new Date(Date.now() + 30000).toUTCString())).to.be.within(29, 31);
            expect(retryAfterOf('999999')).to.equal(3600);
            expect(retryAfterOf('soon')).to.equal(0);
            expect(retryAfterOf(undefined)).to.equal(0);
        });

        it('doubles the retry delay up to the ceiling', () => {
            const settings = { retryDelay: 10, maxRetryDelay: 60 };
            expect([1, 2, 3, 4, 5].map(attempt => backoff(settings, attempt))).to.deep.equal([10, 20, 40, 60, 60]);
        });

        it('pushes only subscribed types whose state moved', () => {
            const states = { Email: 's2', Mailbox: 's2', Thread: 's2', EmailDelivery: 's1' };
            expect(changedTypes(states, { pushed: { Email: 's1', Mailbox: 's1', Thread: 's1', EmailDelivery: 's1' } })).to.deep.equal([
                'Email',
                'Mailbox',
                'Thread'
            ]);
            expect(changedTypes(states, { types: ['EmailDelivery'], pushed: { EmailDelivery: 's1' } })).to.deep.equal([]);
            expect(changedTypes(states, { types: ['Mailbox'], pushed: {} })).to.deep.equal(['Mailbox']);
        });

        it('reads the states of the subscribed types only', async () => {
            expect(wantedTypes([{ types: ['Email'] }, { types: ['Quota', 'Email'] }])).to.deep.equal(['Email', 'Quota']);
            expect(wantedTypes([{ types: ['Email'] }, { types: null }])).to.equal(null);
            const asked = [];
            const module = (types, states) => ({
                pushTypes: types,
                pushStates: async context => {
                    asked.push(types[0]);
                    expect(context.cache).to.deep.equal({ seed: 1 });
                    return states;
                }
            });
            const modules = [module(['Email', 'Mailbox'], { Email: 'e', Mailbox: 'e' }), module(['Quota'], { Quota: 'q' }), { methods: {} }];
            expect(await readStates(modules, { cache: { other: 1 } }, { types: ['Quota'], cache: { seed: 1 } })).to.deep.equal({ Quota: 'q' });
            expect(asked).to.deep.equal(['Quota']);
            expect(await readStates(modules, {}, { cache: { seed: 1 } })).to.deep.equal({ Email: 'e', Mailbox: 'e', Quota: 'q' });
        });
    });

    describe('settings', () => {
        it('refuses a maximum lifetime below 48 hours', () => {
            expect(() => pushSettings({ push: { maxLifetime: 47 * 3600 } })).to.throw(/48 hours/);
            expect(pushSettings({ push: { maxLifetime: 48 * 3600 } }).maxLifetime).to.equal(48 * 3600);
        });

        it('takes the VAPID subject from an https base URL', () => {
            expect(pushSettings({ baseUrl: 'https://jmap.example.com/x' }).vapidSubject).to.equal('https://jmap.example.com');
            expect(pushSettings({ push: { vapidSubject: 'mailto:a@example.com' } }).vapidSubject).to.equal('mailto:a@example.com');
            expect(pushSettings({}).vapidSubject).to.match(/^mailto:postmaster@/);
        });
    });
});
