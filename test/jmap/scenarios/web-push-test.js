/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Catalogue file push.yaml, Web Push delivery (PUSH-060 to PUSH-088): StateChange pushes, RFC 8291
// encryption, the answers of a push service, SSRF protection and VAPID. The test configuration retries
// after 1, 2, 4 and at most 8 seconds, gives a push 3 attempts and removes a subscription after 5
// failed pushes.

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { scenario, api, seed, clock, jmap, fixtures } = require('../harness');
const h = require('./push-subscription-helpers');

const { push } = h;
const VAPID = 'urn:ietf:params:jmap:webpush-vapid';
const RETRY = config.jmap.push.retryDelay * 1000;

/** The Email state of a StateChange request */
const emailState = (box, request, user) => h.changedOf(box, request, user).Email;

/** Makes a change and waits until the box has `count` requests in total */
async function changeAndWait(user, box, count, timeout = 15000) {
    await h.append(user);
    return box.wait(count, timeout);
}

/** The fields of the stored subscription */
async function storedOne(user) {
    const [doc] = await h.storedOf(user);
    return doc;
}

describe('JMAP Web Push delivery', function () {
    this.timeout(60000);

    before(() => push.start());

    describe('StateChange', () => {
        scenario('PUSH-060', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box, { types: null });
            const res = await user.client.method('Email/set', {
                create: {
                    e: {
                        mailboxIds: { ['F' + user.boxes['\\Drafts'].id]: true },
                        subject: 'PUSH-060',
                        textBody: [{ partId: '1' }],
                        bodyValues: { 1: { value: 'Hello' } }
                    }
                }
            });
            expect(res.created, JSON.stringify(res.notCreated)).to.have.property('e');
            const [request] = await h.stateChanges(box, 1);
            expect(request.method).to.equal('POST');
            expect(request.headers['content-type']).to.match(/^application\/json/);
            const body = JSON.parse(request.body.toString('utf8'));
            expect(body['@type']).to.equal('StateChange');
            expect(Object.keys(body.changed)).to.deep.equal([user.accountId]);
            const states = await h.mailStates(user);
            for (const type of ['Email', 'Mailbox', 'Thread']) {
                expect(body.changed[user.accountId][type], type).to.equal(states[type]);
            }
        });

        scenario('PUSH-061', async () => {
            const user = await h.createUser();
            const message = await h.append(user);
            const box = push.endpoint();
            await h.verified(user.client, box);
            await h.flag(user);
            const [first] = await h.stateChanges(box, 1);
            const restId = (await api('GET', `/users/${user.id}/mailboxes/${user.boxes.INBOX.id}/messages`)).results[0].id;
            await api('PUT', `/users/${user.id}/mailboxes/${user.boxes.INBOX.id}/messages/${restId}`, { moveTo: user.boxes['\\Trash'].id });
            const [, second] = await h.stateChanges(box, 2);
            await h.deliver(user);
            const [, , third] = await h.stateChanges(box, 3);
            const states = [first, second, third].map(request => emailState(box, request, user));
            expect(new Set(states).size).to.equal(3);
            expect(states[1] > states[0] && states[2] > states[1], 'newer states').to.be.true;
            expect(h.changedOf(box, first, user)).to.not.have.property('EmailDelivery');
            expect(h.changedOf(box, second, user)).to.not.have.property('EmailDelivery');
            expect(h.changedOf(box, third, user)).to.have.property('EmailDelivery');
            expect(message).to.be.ok;
        });

        scenario('PUSH-062', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box, { types: ['Mailbox'] });
            await h.append(user);
            const [request] = await h.stateChanges(box, 1);
            expect(Object.keys(h.changedOf(box, request, user))).to.deep.equal(['Mailbox']);
        });

        scenario('PUSH-063', async () => {
            const user = await h.createUser();
            await h.append(user);
            await h.append(user);
            const box = push.endpoint();
            await h.verified(user.client, box, { types: ['EmailDelivery'] });
            await h.flag(user);
            const client = await h.imapOf(user);
            const lock = await client.getMailboxLock('INBOX');
            try {
                await client.messageMove('1', 'Trash');
                await client.messageDelete('1');
            } finally {
                lock.release();
            }
            await h.expectRequests(box, 1, 3000);
        });

        scenario('PUSH-064', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box, { types: ['EmailDelivery'] });
            await api('POST', `/users/${user.id}/submit`, { to: [{ address: 'external-recipient@example.org' }], subject: 'PUSH-064', text: 'Sent copy' });
            const [submitted] = await h.stateChanges(box, 1);
            expect(Object.keys(h.changedOf(box, submitted, user))).to.deep.equal(['EmailDelivery']);
            await h.deliver(user);
            const [, delivered] = await h.stateChanges(box, 2);
            expect(Object.keys(h.changedOf(box, delivered, user))).to.deep.equal(['EmailDelivery']);
        });

        scenario('PUSH-065', async () => {
            const user = await h.createUser();
            const asp = await h.aspClient(user);
            const boxes = [push.endpoint(), push.endpoint(), push.endpoint()];
            await h.verified(user.client, boxes[0]);
            await h.verified(user.client, boxes[1]);
            await h.verified(asp, boxes[2]);
            const other = await h.createUser();
            const otherBox = push.endpoint();
            await h.verified(other.client, otherBox);
            await h.append(user);
            for (const box of boxes) {
                await h.stateChanges(box, 1);
            }
            await h.expectRequests(otherBox, 1);
            expect(boxes.map(box => box.stateChanges().length)).to.deep.equal([1, 1, 1]);
        });

        scenario('PUSH-066', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            const client = await h.imapOf(user);
            const raw = await fixtures.buildMessage();
            await Promise.all(Array.from({ length: 50 }, () => client.append('INBOX', raw)));
            const states = await h.mailStates(user);
            await clock.waitFor(() => box.stateChanges().length && emailState(box, box.stateChanges().slice(-1)[0], user) === states.Email, {
                message: 'the final state is pushed'
            });
            await clock.delay(1500);
            const changes = box.stateChanges();
            expect(changes.length).to.be.below(10);
            expect(emailState(box, changes[changes.length - 1], user)).to.equal(states.Email);
        });

        scenario('PUSH-067', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.verified(user.client, box);
            await h.patchStored(id, { expires: new Date(Date.now() - 1000) });
            await h.append(user);
            await h.expectRequests(box, 1);
            expect((await h.pushGet(user.client, { ids: null })).list).to.deep.equal([]);
            expect(await h.storedOf(user)).to.deep.equal([]);
        });

        scenario('PUSH-068', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            await h.append(user);
            await h.stateChanges(box, 1);
            for (const request of [box.verifications()[0], box.stateChanges()[0]]) {
                expect(request.method).to.equal('POST');
                expect(request.headers.ttl).to.match(/^\d+$/);
            }
        });

        scenario('PUSH-069', async () => {
            const user = await h.createUser();
            await h.append(user);
            const box = push.endpoint();
            await h.verified(user.client, box);
            await h.deliver(user);
            await h.stateChanges(box, 1);
            await h.flag(user);
            const changes = await h.stateChanges(box, 2);
            const topics = new Set();
            for (const request of changes) {
                if (request.headers.urgency !== undefined) {
                    expect(['very-low', 'low', 'normal', 'high']).to.include(request.headers.urgency);
                }
                if (request.headers.topic !== undefined) {
                    expect(request.headers.topic).to.match(/^[A-Za-z0-9_-]{1,32}$/);
                    topics.add(request.headers.topic);
                }
            }
            expect(topics.size).to.be.at.most(1);
            expect(box.verifications()[0].headers).to.not.have.property('topic');
        });

        scenario('PUSH-070', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            const subject = `Distinctive ${crypto.randomBytes(6).toString('hex')}`;
            await h.deliver(user, { subject, from: 'Unique Sender <unique.sender@example.net>' });
            const [request] = await h.stateChanges(box, 1);
            expect(request.headers).to.not.have.property('cookie');
            expect(request.headers.authorization || '').to.not.match(/^(basic|bearer)\s/i);
            const text = request.body.toString();
            const body = JSON.parse(text);
            expect(body).to.have.all.keys('@type', 'changed');
            for (const secret of [subject, 'unique.sender', user.username, user.password]) {
                expect(text).to.not.include(secret);
            }
            const emails = await user.client.method('Email/query', {});
            for (const id of emails.ids) {
                expect(text).to.not.include(id);
            }
        });
    });

    describe('encryption', () => {
        scenario('PUSH-071', async () => {
            const user = await h.createUser();
            const box = push.endpoint(true);
            await h.verified(user.client, box);
            await h.append(user);
            const [change] = await h.stateChanges(box, 1);
            const verification = box.verifications()[0];
            for (const request of [verification, change]) {
                expect(request.headers['content-encoding']).to.equal('aes128gcm');
                expect(() => JSON.parse(request.body.toString())).to.throw();
                // salt (16), record size (4), key id length (1), the 65 octet server key
                expect(request.body[20]).to.equal(65);
                expect(request.body[21]).to.equal(4);
            }
            expect(box.json(verification)['@type']).to.equal('PushVerification');
            expect(box.json(change)['@type']).to.equal('StateChange');
        });

        scenario('PUSH-072', async () => {
            const user = await h.createUser();
            const box = push.endpoint(true);
            await h.verified(user.client, box);
            box.respond({ status: 500 });
            await changeAndWait(user, box, 3);
            await h.stateChanges(box, 2);
            await changeAndWait(user, box, 4);
            const bodies = box.stateChanges().map(request => request.body);
            expect(bodies).to.have.length(3);
            const salts = new Set(bodies.map(body => body.subarray(0, 16).toString('hex')));
            const keys = new Set(bodies.map(body => body.subarray(21, 86).toString('hex')));
            expect(salts.size).to.equal(3);
            expect(keys.size).to.equal(3);
        });

        scenario('PUSH-073', async () => {
            const user = await h.createUser();
            const box = push.endpoint(true);
            await h.verified(user.client, box);
            box.respond({ status: 500 }, { status: 500 }, { status: 201 });
            await changeAndWait(user, box, 4);
            await h.expectRequests(box, 4, RETRY * 3);
            for (const request of box.requests.slice(1)) {
                expect(request.headers['content-encoding']).to.equal('aes128gcm');
                expect(() => JSON.parse(request.body.toString())).to.throw();
            }
        });
    });

    describe('push service answers', () => {
        scenario('PUSH-074', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            let count = 1;
            for (const status of [201, 200, 204]) {
                box.respond({ status });
                await changeAndWait(user, box, ++count);
                await h.expectRequests(box, count, RETRY * 2);
            }
        });

        scenario('PUSH-075', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            box.respond({ status: 429, headers: { 'Retry-After': '20' } });
            const [, throttled] = await changeAndWait(user, box, 2);
            for (let i = 0; i < 5; i++) {
                await clock.delay(2000);
                await h.append(user);
            }
            await box.wait(3, 20000);
            const retried = box.requests[2];
            expect(retried.time - throttled.time).to.be.at.least(19500);
            const states = await h.mailStates(user);
            expect(emailState(box, retried, user)).to.equal(states.Email);
            await h.expectRequests(box, 3);
        });

        scenario('PUSH-076', async function () {
            this.timeout(90000);
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            box.fallback = { status: 429 };
            const until = Date.now() + 30000;
            while (Date.now() < until) {
                await h.append(user);
                await clock.delay(1000);
            }
            const times = box.stateChanges().map(request => request.time);
            const gaps = times.slice(1).map((time, i) => time - times[i]);
            const ceiling = config.jmap.push.maxRetryDelay * 1000;
            expect(gaps.length).to.be.at.least(4);
            for (let i = 0; i < gaps.length; i++) {
                expect(gaps[i], `gap ${i}`).to.be.at.least(RETRY - 100);
                expect(gaps[i], `gap ${i}`).to.be.below(ceiling + 1500);
                if (i) {
                    expect(gaps[i], `gap ${i} grows`).to.be.at.least(gaps[i - 1] - 500);
                }
            }
            expect(gaps[gaps.length - 1]).to.be.at.least(ceiling - 500);
        });

        scenario('PUSH-077', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            box.respond({ status: 503 }, { status: 503 }, { status: 201 });
            await changeAndWait(user, box, 4);
            await h.expectRequests(box, 4, RETRY * 4);
            const [first, second, third] = box.stateChanges().map(request => request.time);
            expect(third - second).to.be.above(second - first);
        });

        scenario('PUSH-078', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            box.respond({ status: 500 });
            await changeAndWait(user, box, 2);
            await h.append(user);
            const states = await h.mailStates(user);
            const [, failed, retried] = await box.wait(3);
            expect(emailState(box, retried, user)).to.equal(states.Email);
            expect(emailState(box, failed, user)).to.not.equal(states.Email);
            await h.expectRequests(box, 3);
        });

        scenario('PUSH-079', async () => {
            const user = await h.createUser();
            const slow = push.endpoint();
            const fast = push.endpoint();
            await h.verified(user.client, slow);
            await h.verified(user.client, fast);
            slow.respond({ hang: true });
            const started = Date.now();
            await h.append(user);
            await h.stateChanges(fast, 1, 3000);
            expect(Date.now() - started).to.be.below(3000);
            const [, hung, retried] = await slow.wait(3, 20000);
            expect(retried.time - hung.time).to.be.at.least(config.jmap.push.timeout * 1000);
        });

        scenario('PUSH-080', async () => {
            for (const status of [410, 404]) {
                const user = await h.createUser();
                const box = push.endpoint();
                await h.verified(user.client, box);
                box.fallback = { status };
                await changeAndWait(user, box, 2);
                await clock.delay(500);
                await h.append(user);
                await h.expectRequests(box, 2);
                expect((await h.pushGet(user.client, { ids: null })).list).to.deep.equal([]);
            }
        });

        scenario('PUSH-081', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            let count = 1;
            for (const status of [400, 401, 403, 413]) {
                box.respond({ status });
                await changeAndWait(user, box, ++count);
                await h.expectRequests(box, count, RETRY * 2);
                expect((await storedOne(user)).failures).to.equal(count - 1);
            }
        });

        scenario('PUSH-082', async function () {
            this.timeout(120000);
            const user = await h.createUser();
            const box = push.endpoint();
            await h.verified(user.client, box);
            const attempts = config.jmap.push.attempts;
            // a success in between resets the counter
            box.respond(...Array.from({ length: attempts * 2 }, () => ({ status: 500 })));
            await changeAndWait(user, box, 1 + attempts, 30000);
            await changeAndWait(user, box, 1 + attempts * 2, 30000);
            expect((await storedOne(user)).failures).to.equal(2);
            await changeAndWait(user, box, 2 + attempts * 2, 30000);
            await clock.waitFor(async () => (await storedOne(user)).failures === 0, { message: 'the counter is reset' });
            // five failed pushes in a row
            box.fallback = { status: 500 };
            let count = 2 + attempts * 2;
            for (let i = 1; i <= config.jmap.push.failureLimit; i++) {
                count += attempts;
                await changeAndWait(user, box, count, 30000);
            }
            await clock.waitFor(async () => !(await h.storedOf(user)).length, { message: 'the subscription is removed' });
            await h.append(user);
            await h.expectRequests(box, count);
        });
    });

    describe('SSRF protection', () => {
        scenario('PUSH-083', async () => {
            const user = await h.createUser();
            const hosts = [
                '127.0.0.1',
                'localhost',
                '[::1]',
                '10.0.0.5',
                '172.16.1.1',
                '192.168.1.1',
                '169.254.169.254',
                '0.0.0.0',
                '[fc00::1]',
                '[fe80::1]',
                '[::ffff:127.0.0.1]',
                '100.64.0.1',
                '2130706433'
            ];
            const res = await h.create(
                user.client,
                Object.fromEntries(hosts.map((host, i) => [`h${i}`, { deviceClientId: `device-${i}`, url: `https://${host}/push/x` }]))
            );
            expect(res.created).to.equal(null);
            for (let i = 0; i < hosts.length; i++) {
                h.expectInvalid(res.notCreated[`h${i}`], ['url']);
            }
        });

        scenario('PUSH-084', async () => {
            const user = await h.createUser();
            push.setRecords('private.wildduck.test', ['10.1.2.3']);
            push.setRecords('mixed.wildduck.test', ['93.184.215.14', '10.1.2.3']);
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url: 'https://private.wildduck.test/push/x' },
                b: { deviceClientId: 'device-b', url: 'https://mixed.wildduck.test/push/x' }
            });
            h.expectInvalid(res.notCreated.a, ['url']);
            h.expectInvalid(res.notCreated.b, ['url']);
        });

        scenario('PUSH-085', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const name = `moving-${crypto.randomBytes(4).toString('hex')}.wildduck.test`;
            push.setRecords(name, ['198.51.100.7']);
            const url = box.url.replace(push.HOST, name);
            const id = await h.subscribe(user.client, { url, keys: null });
            // the client got the code (from the database here, the push service is not reachable)
            const [doc] = await h.storedOf(user);
            push.setRecords(name, ['127.0.0.1']);
            expect((await h.setCode(user.client, id, doc.verificationCode)).updated).to.have.property(id);
            await h.append(user);
            await clock.waitFor(async () => (await storedOne(user)).failures === 1, { message: 'a failed delivery' });
            expect(box.requests).to.have.length(0);
        });

        scenario('PUSH-086', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const target = push.endpoint();
            await h.verified(user.client, box);
            let count = 1;
            for (const [status, location] of [
                [302, target.url],
                [301, 'https://127.0.0.1/internal'],
                [307, target.url],
                [308, 'https://169.254.169.254/latest/meta-data']
            ]) {
                box.respond({ status, headers: { Location: location } });
                await changeAndWait(user, box, ++count);
                await h.expectRequests(box, count, RETRY * 2);
            }
            expect(target.requests).to.have.length(0);
            expect((await storedOne(user)).failures).to.equal(4);
        });
    });

    describe('VAPID', () => {
        /** Checks the Authorization header of a push request against the advertised key */
        function checkVapid(request, url, applicationServerKey) {
            const match = /^vapid t=([^,\s]+),\s*k=(\S+)$/.exec(request.headers.authorization || '');
            expect(match, request.headers.authorization).to.be.ok;
            expect(match[2]).to.equal(applicationServerKey);
            const [header, claims, signature] = match[1].split('.');
            expect(JSON.parse(Buffer.from(header, 'base64url'))).to.include({ alg: 'ES256' });
            const payload = JSON.parse(Buffer.from(claims, 'base64url'));
            expect(payload.aud).to.equal(new URL(url).origin);
            expect(payload.exp).to.be.at.most(Math.floor(Date.now() / 1000) + 24 * 3600);
            expect(payload.exp).to.be.above(Math.floor(Date.now() / 1000));
            expect(payload.sub)
                .to.be.a('string')
                .and.match(/^(mailto:|https:)/);
            const raw = Buffer.from(applicationServerKey, 'base64url');
            const key = crypto.createPublicKey({
                key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
                format: 'jwk'
            });
            const valid = crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
            expect(valid, 'the JWT signature').to.be.true;
        }

        scenario('PUSH-088', async () => {
            const user = await h.createUser();
            const { applicationServerKey } = (await user.client.session()).capabilities[VAPID];
            const box = push.endpoint();
            await h.verified(user.client, box);
            await h.append(user);
            const [change] = await h.stateChanges(box, 1);
            checkVapid(box.verifications()[0], box.url, applicationServerKey);
            checkVapid(change, box.url, applicationServerKey);
        });

        // last: rotates the key of the test server
        scenario('PUSH-087', async () => {
            const user = await h.createUser();
            const session = await user.client.session();
            const { applicationServerKey } = session.capabilities[VAPID];
            const raw = Buffer.from(applicationServerKey, 'base64url');
            expect(applicationServerKey).to.match(/^[A-Za-z0-9_-]+$/);
            expect(raw).to.have.length(65);
            expect(raw[0]).to.equal(4);
            const db = await seed.db();
            await db.collection('settings').deleteOne({ key: 'jmap:vapid' });
            const rotated = await clock.waitFor(
                async () => {
                    const next = await user.client.session();
                    return next.capabilities[VAPID].applicationServerKey !== applicationServerKey && next;
                },
                { timeout: 10000, message: 'the key is rotated' }
            );
            expect(rotated.state).to.not.equal(session.state);
            expect(jmap.URN.core in rotated.capabilities).to.be.true;
        });
    });
});
