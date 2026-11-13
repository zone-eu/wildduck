/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file push.yaml, PushSubscription/get and /set, verification and the binding to credentials
// (PUSH-002 to PUSH-059, RFC 8620 7.2). Delivery is in web-push-test.js. The test configuration lowers
// the limits: 3 subscriptions per user, 5 creations per hour, 60 seconds to verify.

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const { expect } = require('chai');
const { scenario, api, accounts, clock, jmap } = require('../harness');
const { startInstance, stopInstance } = require('../harness/instance');
const { pushSettings } = require('../../../lib/jmap/push/settings');
const h = require('./push-subscription-helpers');

const { push } = h;
const DAY = 24 * 3600 * 1000;
const MAX_LIFETIME = config.jmap.push.maxLifetime * 1000;

/** Asserts a UTCDate about `ms` from now (within a minute) */
function expectAbout(value, ms) {
    expect(value).to.match(h.UTC_DATE);
    expect(Math.abs(Date.parse(value) - (Date.now() + ms))).to.be.below(60 * 1000);
}

const unknownId = () => 'P' + crypto.randomBytes(12).toString('hex');

describe('JMAP PushSubscription', function () {
    this.timeout(60000);
    let redis;

    before(async () => {
        await push.start();
        redis = new Redis(config.dbs.redis);
    });

    after(async () => {
        await redis.quit();
    });

    describe('get', () => {
        scenario('PUSH-002', async () => {
            const user = await h.createUser();
            const res = await h.pushGet(user.client, { ids: null });
            expect(res).to.deep.equal({ list: [], notFound: [] });
            expect(res).to.not.have.any.keys('accountId', 'state');
        });

        scenario('PUSH-003', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const ids = [await h.subscribe(user.client, box), await h.subscribe(user.client, box)];
            const res = await h.pushGet(user.client, { ids: null });
            expect(res.list.map(entry => entry.id).sort()).to.deep.equal(ids.sort());
            for (const entry of res.list) {
                expect(entry).to.have.all.keys('id', 'deviceClientId', 'verificationCode', 'expires', 'types');
            }
        });

        scenario('PUSH-004', async () => {
            const user = await h.createUser();
            const id = await h.subscribe(user.client, push.endpoint());
            const unknown = unknownId();
            const res = await h.pushGet(user.client, { ids: [id, unknown, 'not an id!'] });
            expect(res.list.map(entry => entry.id)).to.deep.equal([id]);
            expect(res.notFound).to.deep.equal([unknown, 'not an id!']);
            const empty = await h.pushGet(user.client, { ids: [] });
            expect(empty.list).to.deep.equal([]);
        });

        scenario('PUSH-005', async () => {
            const user = await h.createUser();
            await h.subscribe(user.client, push.endpoint(true));
            for (const args of [{}, { properties: null }]) {
                const res = await h.pushGet(user.client, args);
                expect(res.list).to.have.length(1);
                expect(res.list[0]).to.not.have.any.keys('url', 'keys');
            }
        });

        scenario('PUSH-006', async () => {
            const user = await h.createUser();
            await h.subscribe(user.client, push.endpoint(true));
            for (const properties of [['url'], ['id', 'keys']]) {
                const err = await h.methodError(user.client, 'PushSubscription/get', { properties });
                expect(err.type).to.equal('forbidden');
            }
        });

        scenario('PUSH-007', async () => {
            const user = await h.createUser();
            await h.subscribe(user.client, push.endpoint());
            const res = await h.pushGet(user.client, { properties: ['deviceClientId', 'expires'] });
            expect(res.list[0]).to.have.all.keys('id', 'deviceClientId', 'expires');
            const err = await h.methodError(user.client, 'PushSubscription/get', { properties: ['deviceClientId', 'colour'] });
            expect(err.type).to.equal('invalidArguments');
        });

        scenario('PUSH-008', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.subscribe(user.client, box);
            const { verificationCode } = await h.verificationOf(box, id);
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].verificationCode).to.equal(null);
            await h.setCode(user.client, id, verificationCode);
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].verificationCode).to.equal(verificationCode);
        });
    });

    describe('create', () => {
        scenario('PUSH-009', async () => {
            const user = await h.createUser();
            const res = await h.create(user.client, { a: { deviceClientId: 'device-1', url: push.endpoint().url } });
            const created = res.created.a;
            expect(created.id).to.match(/^[A-Za-z][A-Za-z0-9_-]*$/);
            expect(created.keys).to.equal(null);
            expect(created.expires).to.match(h.UTC_DATE);
            expect(Date.parse(created.expires)).to.be.above(Date.now());
            expect(res).to.not.have.any.keys('accountId', 'oldState', 'newState');
        });

        scenario('PUSH-010', async () => {
            const user = await h.createUser();
            const args = { create: { a: { deviceClientId: 'device-1', url: push.endpoint().url } } };
            const [[name, res]] = await user.client.call([['PushSubscription/set', args, 'p']], h.CORE);
            expect(name).to.equal('PushSubscription/set');
            expect(res.created).to.have.property('a');
            const [[errorName, error]] = await user.client.call([['PushSubscription/set', args, 'p']], [jmap.URN.mail]);
            expect(errorName).to.equal('error');
            expect(error.type).to.equal('unknownMethod');
        });

        scenario('PUSH-011', async () => {
            const user = await h.createUser();
            const boxes = [push.endpoint(), push.endpoint()];
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url: boxes[0].url },
                b: { deviceClientId: 'device-b', url: boxes[1].url },
                c: { deviceClientId: 'device-c', url: 'http://push.example.com/abc' }
            });
            expect(Object.keys(res.created).sort()).to.deep.equal(['a', 'b']);
            expect(res.created.a.id).to.not.equal(res.created.b.id);
            expect(res.notCreated.c.type).to.equal('invalidProperties');
            await Promise.all(boxes.map(box => box.wait(1)));
            await clock.delay(500);
            expect(boxes.map(box => box.verifications().length)).to.deep.equal([1, 1]);
        });

        scenario('PUSH-012', async () => {
            const user = await h.createUser();
            const res = await h.create(user.client, { a: { deviceClientId: 'device-1', url: 'http://push.example.com/abc' } });
            h.expectInvalid(res.notCreated.a, ['url']);
            expect(res.created).to.equal(null);
            expect(await h.storedOf(user)).to.deep.equal([]);
        });

        scenario('PUSH-013', async () => {
            const user = await h.createUser();
            const urls = [
                'not a url',
                '/relative/path',
                'ftp://host/x',
                'https://',
                'https://user:pass@push.example.com/x',
                42,
                'https://push.example.com/' + 'a'.repeat(10000)
            ];
            const res = await h.create(user.client, Object.fromEntries(urls.map((url, i) => [`c${i}`, { deviceClientId: `device-${i}`, url }])));
            expect(res.created).to.equal(null);
            for (let i = 0; i < urls.length; i++) {
                h.expectInvalid(res.notCreated[`c${i}`], ['url']);
            }
        });

        scenario('PUSH-014', async () => {
            const user = await h.createUser();
            const url = push.endpoint().url;
            const res = await h.create(user.client, { a: { url }, b: { deviceClientId: '', url }, c: { deviceClientId: 7, url } });
            for (const id of ['a', 'b', 'c']) {
                h.expectInvalid(res.notCreated[id], ['deviceClientId']);
            }
        });

        scenario('PUSH-015', async () => {
            const user = await h.createUser();
            const url = push.endpoint().url;
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url, verificationCode: 'guess' },
                b: { deviceClientId: 'device-b', url, verificationCode: null }
            });
            h.expectInvalid(res.notCreated.a, ['verificationCode']);
            expect(res.created).to.have.property('b');
        });

        scenario('PUSH-016', async () => {
            const user = await h.createUser();
            const url = push.endpoint().url;
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url, id: unknownId() },
                b: { deviceClientId: 'device-b', url, foo: 'bar' }
            });
            h.expectInvalid(res.notCreated.a, ['id']);
            h.expectInvalid(res.notCreated.b, ['foo']);
        });

        scenario('PUSH-017', async () => {
            const user = await h.createUser();
            await h.append(user);
            const boxes = [push.endpoint(), push.endpoint()];
            const ids = [await h.verified(user.client, boxes[0], { types: null }), await h.verified(user.client, boxes[1])];
            const res = await h.pushGet(user.client, { ids });
            expect(res.list.map(entry => entry.types)).to.deep.equal([null, null]);
            await h.flag(user);
            for (const box of boxes) {
                const [change] = await h.stateChanges(box, 1);
                expect(Object.keys(h.changedOf(box, change, user)).sort()).to.deep.equal(['Email', 'Mailbox', 'Thread']);
            }
        });

        scenario('PUSH-018', async () => {
            const user = await h.createUser();
            const id = await h.subscribe(user.client, push.endpoint(), { types: ['Mailbox', 'Email', 'EmailDelivery'] });
            const res = await h.pushGet(user.client, { ids: [id] });
            expect(res.list[0].types).to.have.members(['Mailbox', 'Email', 'EmailDelivery']).and.have.length(3);
        });

        scenario('PUSH-019', async () => {
            const user = await h.createUser();
            const res = await h.create(user.client, { a: { deviceClientId: 'device-a', url: push.endpoint().url, types: [] } });
            h.expectInvalid(res.notCreated.a, ['types']);
        });

        scenario('PUSH-020', async () => {
            const user = await h.createUser();
            const url = push.endpoint().url;
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url, types: ['Email', 'Nonsense'] },
                b: { deviceClientId: 'device-b', url, types: 'Email' },
                c: { deviceClientId: 'device-c', url, types: [1] }
            });
            for (const id of ['a', 'b', 'c']) {
                h.expectInvalid(res.notCreated[id], ['types']);
            }
        });

        scenario('PUSH-021', async () => {
            const user = await h.createUser();
            const keys = push.userAgentKeys();
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url: push.endpoint().url, keys: { p256dh: keys.p256dh, auth: keys.auth } }
            });
            const created = res.created.a;
            if (created.keys !== undefined) {
                expect(created.keys).to.deep.equal({ p256dh: keys.p256dh, auth: keys.auth });
            }
            const got = await h.pushGet(user.client, { ids: [created.id] });
            expect(got.list[0]).to.not.have.property('keys');
        });

        scenario('PUSH-022', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const good = push.userAgentKeys();
            const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(63, 0), Buffer.from([1])]).toString('base64url');
            const variants = [
                { p256dh: good.p256dh },
                { auth: good.auth },
                { p256dh: '!!not*base64!!', auth: good.auth },
                { p256dh: crypto.randomBytes(64).toString('base64url'), auth: good.auth },
                { p256dh: offCurve, auth: good.auth },
                { p256dh: good.p256dh, auth: crypto.randomBytes(8).toString('base64url') },
                'p256dh=abc'
            ];
            const res = await h.create(
                user.client,
                Object.fromEntries(variants.map((keys, i) => [`k${i}`, { deviceClientId: `device-${i}`, url: box.url, keys }]))
            );
            expect(res.created).to.equal(null);
            for (let i = 0; i < variants.length; i++) {
                h.expectInvalid(res.notCreated[`k${i}`], ['keys']);
            }
            await h.expectRequests(box, 0);
        });

        scenario('PUSH-023', async () => {
            const user = await h.createUser();
            const ahead = new Date(Date.now() + 3 * DAY);
            const plain = ahead.toISOString().replace(/\.\d{3}Z$/, 'Z');
            const precise = new Date(ahead.getTime() + 123).toISOString();
            const url = push.endpoint().url;
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url, expires: plain },
                b: { deviceClientId: 'device-b', url, expires: precise }
            });
            const got = await h.pushGet(user.client, { ids: [res.created.a.id, res.created.b.id] });
            expect(got.list.map(entry => entry.expires)).to.deep.equal([plain, precise]);
        });

        scenario('PUSH-024', async () => {
            const user = await h.createUser();
            const res = await h.create(user.client, { a: { deviceClientId: 'device-a', url: push.endpoint().url } });
            expectAbout(res.created.a.expires, MAX_LIFETIME);
            const got = await h.pushGet(user.client, { ids: [res.created.a.id] });
            expect(got.list[0].expires).to.equal(res.created.a.expires);
        });

        scenario('PUSH-025', async () => {
            const user = await h.createUser();
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url: push.endpoint().url, expires: new Date(Date.now() + 365 * DAY).toISOString() }
            });
            expectAbout(res.created.a.expires, MAX_LIFETIME);
        });

        scenario('PUSH-026', async () => {
            const user = await h.createUser();
            const url = push.endpoint().url;
            const values = [new Date(Date.now() + 47 * 3600 * 1000).toISOString(), new Date(Date.now() + 7 * DAY - 60 * 1000).toISOString()];
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url, expires: values[0] },
                b: { deviceClientId: 'device-b', url, expires: values[1] }
            });
            const got = await h.pushGet(user.client, { ids: [res.created.a.id, res.created.b.id] });
            expect(got.list.map(entry => entry.expires)).to.deep.equal(values);
            // a configured maximum below 48 hours is refused at start up
            const push47 = Object.assign({}, config.jmap.push, { maxLifetime: 47 * 3600 });
            expect(() => pushSettings({ push: push47 })).to.throw(/48 hours/);
            let failed = null;
            try {
                const instance = await startInstance({ push: push47 });
                await stopInstance(instance.app);
            } catch (err) {
                failed = err;
            }
            expect(failed, 'the service refuses to start').to.be.an('error');
        });

        scenario('PUSH-027', async () => {
            const user = await h.createUser();
            const res = await h.create(user.client, {
                a: { deviceClientId: 'device-a', url: push.endpoint().url, expires: new Date(Date.now() - 3600 * 1000).toISOString() }
            });
            h.expectInvalid(res.notCreated.a, ['expires']);
        });

        scenario('PUSH-028', async () => {
            const user = await h.createUser();
            const url = push.endpoint().url;
            const values = ['tomorrow', '2027-01-31T12:00:00+01:00', '2027-02-31T12:00:00Z', 1800000000];
            const res = await h.create(user.client, Object.fromEntries(values.map((expires, i) => [`e${i}`, { deviceClientId: `device-${i}`, url, expires }])));
            for (let i = 0; i < values.length; i++) {
                h.expectInvalid(res.notCreated[`e${i}`], ['expires']);
            }
        });

        scenario('PUSH-029', async () => {
            const user = await h.createUser();
            const url = push.endpoint().url;
            await h.subscribe(user.client, push.endpoint(), { deviceClientId: 'D' });
            const res = await h.create(user.client, { a: { deviceClientId: 'D', url } });
            h.expectInvalid(res.notCreated.a, ['deviceClientId']);
            const asp = await h.aspClient(user);
            expect((await h.create(asp, { a: { deviceClientId: 'D', url } })).created).to.have.property('a');
            const other = await h.createUser();
            expect((await h.create(other.client, { a: { deviceClientId: 'D', url } })).created).to.have.property('a');
        });

        scenario('PUSH-030', async () => {
            const user = await h.createUser();
            const asp = await h.aspClient(user);
            const first = await h.subscribe(user.client, push.endpoint());
            await h.subscribe(user.client, push.endpoint());
            await h.subscribe(asp, push.endpoint());
            const box = push.endpoint();
            const res = await h.create(user.client, { a: { deviceClientId: 'device-4', url: box.url } });
            expect(res.notCreated.a.type).to.equal('overQuota');
            expect(await h.storedOf(user)).to.have.length(3);
            await h.expectRequests(box, 0);
            await h.pushSet(user.client, { destroy: [first] });
            expect((await h.create(user.client, { a: { deviceClientId: 'device-4', url: box.url } })).created).to.have.property('a');
        });

        scenario('PUSH-031', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            for (let i = 1; i <= 5; i++) {
                const id = await h.subscribe(user.client, box, { deviceClientId: 'device' });
                await h.verificationOf(box, id);
                expect(box.requests).to.have.length(i);
                await h.pushSet(user.client, { destroy: [id] });
            }
            const res = await h.create(user.client, { a: { deviceClientId: 'device', url: box.url } });
            expect(res.notCreated.a.type).to.equal('rateLimit');
            await h.expectRequests(box, 5);
        });

        scenario('PUSH-032', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.subscribe(user.client, box);
            const [request] = await box.wait(1, 5000);
            expect(request.method).to.equal('POST');
            expect(request.headers['content-type']).to.match(/^application\/json/);
            expect(request.headers.ttl).to.match(/^\d+$/);
            const body = JSON.parse(request.body.toString());
            expect(body).to.have.all.keys('@type', 'pushSubscriptionId', 'verificationCode');
            expect(body['@type']).to.equal('PushVerification');
            expect(body.pushSubscriptionId).to.equal(id);
            expect(body.verificationCode).to.be.a('string');
        });

        describe('with higher limits', () => {
            let instance;
            before(async () => {
                instance = await startInstance({ push: Object.assign({}, config.jmap.push, { maxPerUser: 25, createRate: 25 }) });
            });
            after(() => stopInstance(instance.app));

            scenario('PUSH-033', async () => {
                const user = await h.createUser();
                const box = push.endpoint();
                const client = new jmap.JmapClient(jmap.basic(user.username, user.password));
                const create = Object.fromEntries(Array.from({ length: 20 }, (v, i) => [`c${i}`, { deviceClientId: `device-${i}`, url: box.url }]));
                const res = await client.raw(`${instance.url}/jmap/api/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ using: h.CORE, methodCalls: [['PushSubscription/set', { create }, 'p']] })
                });
                const created = res.json.methodResponses[0][1].created;
                expect(Object.keys(created)).to.have.length(20);
                await box.wait(20, 20000);
                const codes = box.requests.map(request => box.json(request));
                expect(new Set(codes.map(body => body.verificationCode)).size).to.equal(20);
                for (const { pushSubscriptionId, verificationCode } of codes) {
                    expect(verificationCode).to.match(/^[A-Za-z0-9_-]{22,}$/);
                    expect(verificationCode).to.not.include(pushSubscriptionId.slice(1));
                }
            });
        });
    });

    describe('verification', () => {
        scenario('PUSH-034', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            await h.subscribe(user.client, box);
            await box.wait(1);
            await h.append(user);
            await h.flag(user);
            await h.expectRequests(box, 1, 3000);
            expect(box.verifications()).to.have.length(1);
        });

        scenario('PUSH-035', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.subscribe(user.client, box);
            const { verificationCode } = await h.verificationOf(box, id);
            const res = await h.setCode(user.client, id, verificationCode);
            expect(res.updated).to.deep.equal({ [id]: null });
            await h.append(user);
            await h.stateChanges(box, 1);
        });

        scenario('PUSH-036', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.subscribe(user.client, box);
            await h.verificationOf(box, id);
            const res = await h.setCode(user.client, id, 'wrong');
            h.expectInvalid(res.notUpdated[id], ['verificationCode']);
            await h.append(user);
            await h.expectRequests(box, 1);
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].verificationCode).to.equal(null);
        });

        scenario('PUSH-037', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.subscribe(user.client, box);
            const { verificationCode } = await h.verificationOf(box, id);
            for (let i = 1; i <= 6; i++) {
                const res = await h.setCode(user.client, id, `wrong-${i}`);
                expect(res.notUpdated[id].type, `attempt ${i}`).to.equal(i <= 5 ? 'invalidProperties' : 'notFound');
            }
            const res = await h.setCode(user.client, id, verificationCode);
            expect(res.notUpdated[id].type).to.equal('notFound');
        });

        scenario('PUSH-038', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            box.fallback = { status: 500 };
            const started = Date.now();
            const id = await h.subscribe(user.client, box);
            expect(Date.now() - started).to.be.below(2000);
            expect(id).to.be.a('string');
            const attempts = config.jmap.push.verifyAttempts || 5;
            await box.wait(attempts, 40000);
            await h.expectRequests(box, attempts, 4000);
            const gaps = box.requests.slice(1).map((request, i) => request.time - box.requests[i].time);
            for (let i = 1; i < gaps.length; i++) {
                expect(gaps[i], 'growing delays').to.be.above(gaps[i - 1]);
            }
        });

        scenario('PUSH-039', async () => {
            const user = await h.createUser();
            const id = await h.subscribe(user.client, push.endpoint(true));
            // two minutes later, with a one minute grace period
            await h.patchStored(id, { verifyBy: new Date(Date.now() - 60 * 1000), created: new Date(Date.now() - 120 * 1000) });
            const res = await h.pushGet(user.client, { ids: null });
            expect(res.list).to.deep.equal([]);
            expect(await h.storedOf(user)).to.deep.equal([]);
        });

        scenario('PUSH-040', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.verified(user.client, box);
            for (const patch of [
                { expires: new Date(Date.now() + 2 * DAY).toISOString() },
                { types: ['Email'] },
                { expires: new Date(Date.now() + 3 * DAY).toISOString(), types: null }
            ]) {
                const res = await h.pushSet(user.client, { update: { [id]: patch } });
                expect(res.updated).to.have.property(id);
            }
            await h.append(user);
            await h.stateChanges(box, 1);
            expect(box.verifications()).to.have.length(1);
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].verificationCode).to.be.a('string');
        });

        scenario('PUSH-041', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.verified(user.client, box);
            const { verificationCode } = await h.verificationOf(box, id);
            expect((await h.setCode(user.client, id, verificationCode)).updated).to.deep.equal({ [id]: null });
            const res = await h.setCode(user.client, id, verificationCode + 'x');
            h.expectInvalid(res.notUpdated[id], ['verificationCode']);
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].verificationCode).to.equal(verificationCode);
        });
    });

    describe('update', () => {
        scenario('PUSH-042', async () => {
            const user = await h.createUser();
            await h.append(user);
            const box = push.endpoint();
            const id = await h.verified(user.client, box, { types: ['Mailbox'] });
            expect((await h.pushSet(user.client, { update: { [id]: { types: ['EmailDelivery'] } } })).updated).to.have.property(id);
            await h.flag(user);
            await h.expectRequests(box, 1);
            await h.deliver(user);
            const [change] = await h.stateChanges(box, 1);
            expect(Object.keys(h.changedOf(box, change, user))).to.deep.equal(['EmailDelivery']);
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].types).to.deep.equal(['EmailDelivery']);
        });

        scenario('PUSH-043', async () => {
            const user = await h.createUser();
            const id = await h.verified(user.client, push.endpoint(), { types: ['Email'] });
            await h.pushSet(user.client, { update: { [id]: { expires: new Date(Date.now() + 2 * DAY).toISOString() } } });
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].types).to.deep.equal(['Email']);
            await h.pushSet(user.client, { update: { [id]: { types: null } } });
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].types).to.equal(null);
        });

        scenario('PUSH-044', async () => {
            const user = await h.createUser();
            const id = await h.verified(user.client, push.endpoint(), { types: ['Email'] });
            for (const types of [['Unknown'], 'Email', []]) {
                const res = await h.pushSet(user.client, { update: { [id]: { types } } });
                h.expectInvalid(res.notUpdated[id], ['types']);
            }
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].types).to.deep.equal(['Email']);
        });

        scenario('PUSH-045', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.verified(user.client, box);
            // created two days ago
            await h.patchStored(id, { created: new Date(Date.now() - 2 * DAY) });
            const res = await h.pushSet(user.client, { update: { [id]: { expires: new Date(Date.now() + 30 * DAY).toISOString() } } });
            expectAbout(res.updated[id].expires, MAX_LIFETIME);
            await h.append(user);
            await h.stateChanges(box, 1);
            expect(box.verifications()).to.have.length(1);
        });

        scenario('PUSH-046', async () => {
            const user = await h.createUser();
            const id = await h.verified(user.client, push.endpoint());
            for (const ahead of [5 * DAY, 3600 * 1000]) {
                const expires = new Date(Date.now() + ahead).toISOString();
                const res = await h.pushSet(user.client, { update: { [id]: { expires } } });
                expect(res.updated).to.deep.equal({ [id]: null });
                expect((await h.pushGet(user.client, { ids: [id] })).list[0].expires).to.equal(expires);
            }
        });

        scenario('PUSH-047', async () => {
            const user = await h.createUser();
            const id = await h.verified(user.client, push.endpoint());
            const before = (await h.pushGet(user.client, { ids: [id] })).list[0].expires;
            for (const expires of [new Date(Date.now() - 3600 * 1000).toISOString(), 'soon']) {
                const res = await h.pushSet(user.client, { update: { [id]: { expires } } });
                h.expectInvalid(res.notUpdated[id], ['expires']);
            }
            expect((await h.pushGet(user.client, { ids: [id] })).list[0].expires).to.equal(before);
        });

        scenario('PUSH-048', async () => {
            const user = await h.createUser();
            const id = await h.subscribe(user.client, push.endpoint());
            const keys = push.userAgentKeys();
            const patches = {
                url: push.endpoint().url,
                keys: { p256dh: keys.p256dh, auth: keys.auth },
                deviceClientId: 'another',
                id: unknownId(),
                foo: 'bar'
            };
            for (const [property, value] of Object.entries(patches)) {
                const res = await h.pushSet(user.client, { update: { [id]: { [property]: value } } });
                h.expectInvalid(res.notUpdated[id], [property]);
            }
        });

        scenario('PUSH-049', async () => {
            const user = await h.createUser();
            const unknown = unknownId();
            const expires = new Date(Date.now() + DAY).toISOString();
            const res = await h.pushSet(user.client, { update: { [unknown]: { expires }, 'bad id!': { expires } } });
            expect(res.notUpdated[unknown].type).to.equal('notFound');
            expect(res.notUpdated['bad id!'].type).to.equal('notFound');
        });

        scenario('PUSH-050', async () => {
            const user = await h.createUser();
            const p1 = await h.verified(user.client, push.endpoint());
            const p2 = await h.verified(user.client, push.endpoint());
            const unknown = unknownId();
            const res = await h.pushSet(user.client, {
                update: {
                    [p1]: { types: ['Email'] },
                    [p2]: { expires: new Date(Date.now() - 3600 * 1000).toISOString() },
                    [unknown]: { expires: new Date(Date.now() + DAY).toISOString() }
                }
            });
            expect(res.updated).to.have.all.keys(p1);
            expect(res.notUpdated[p2].type).to.equal('invalidProperties');
            expect(res.notUpdated[unknown].type).to.equal('notFound');
        });
    });

    describe('destroy', () => {
        scenario('PUSH-051', async () => {
            const user = await h.createUser();
            const box = push.endpoint();
            const id = await h.verified(user.client, box);
            await h.append(user);
            await h.stateChanges(box, 1);
            const count = box.requests.length;
            const res = await h.pushSet(user.client, { destroy: [id] });
            expect(res.destroyed).to.deep.equal([id]);
            expect((await h.pushGet(user.client, { ids: [id] })).notFound).to.deep.equal([id]);
            await h.append(user);
            await h.expectRequests(box, count);
        });

        scenario('PUSH-052', async () => {
            const user = await h.createUser();
            const id = await h.subscribe(user.client, push.endpoint());
            const unknown = unknownId();
            const res = await h.pushSet(user.client, { destroy: [id, unknown, 'bad id!'] });
            expect(res.destroyed).to.deep.equal([id]);
            expect(res.notDestroyed[unknown].type).to.equal('notFound');
            expect(res.notDestroyed['bad id!'].type).to.equal('notFound');
        });

        scenario('PUSH-053', async () => {
            const user = await h.createUser();
            const box = push.endpoint(true);
            const id = await h.verified(user.client, box);
            await h.append(user);
            await h.stateChanges(box, 1);
            await h.pushSet(user.client, { destroy: [id] });
            const marker = box.url.split('/').pop();
            const stored = await h.storedOf(user);
            expect(JSON.stringify(stored)).to.not.include(marker);
            // queued, delayed, finished and failed delivery jobs
            const keys = await redis.keys(`wd:bull:jmap_push:*`);
            for (const key of keys) {
                const type = await redis.type(key);
                const content =
                    type === 'hash'
                        ? JSON.stringify(await redis.hgetall(key))
                        : type === 'string'
                          ? await redis.get(key)
                          : type === 'list'
                            ? JSON.stringify(await redis.lrange(key, 0, -1))
                            : type === 'zset'
                              ? JSON.stringify(await redis.zrange(key, 0, -1))
                              : '';
                for (const secret of [marker, box.keys.p256dh, box.keys.auth]) {
                    expect(content, key).to.not.include(secret);
                }
            }
        });
    });

    describe('credentials', () => {
        scenario('PUSH-054', async () => {
            const user = await h.createUser();
            const a = await h.aspClient(user);
            const b = await h.aspClient(user);
            const token = await h.tokenClient(user);
            const id = await h.subscribe(a, push.endpoint());
            for (const client of [b, token]) {
                expect((await h.pushGet(client, { ids: null })).list).to.deep.equal([]);
                expect((await h.pushGet(client, { ids: [id] })).notFound).to.deep.equal([id]);
            }
            expect((await h.pushGet(a, { ids: null })).list.map(entry => entry.id)).to.deep.equal([id]);
        });

        scenario('PUSH-055', async () => {
            const user = await h.createUser();
            const a = await h.aspClient(user);
            const b = await h.aspClient(user);
            const other = await h.createUser();
            const id = await h.subscribe(a, push.endpoint(), { types: ['Email'] });
            for (const client of [b, other.client]) {
                const updated = await h.pushSet(client, { update: { [id]: { types: ['Mailbox'] } } });
                expect(updated.notUpdated[id].type).to.equal('notFound');
                const destroyed = await h.pushSet(client, { destroy: [id] });
                expect(destroyed.notDestroyed[id].type).to.equal('notFound');
            }
            expect((await h.pushGet(a, { ids: [id] })).list[0].types).to.deep.equal(['Email']);
        });

        scenario('PUSH-056', async () => {
            const user = await h.createUser();
            const a = await h.aspClient(user);
            const box = push.endpoint(true);
            await h.verified(a, box);
            await api('DELETE', `/users/${user.id}/asps/${a.aspId}`);
            await clock.waitFor(async () => !(await h.storedOf(user)).length, { message: 'the subscription is removed' });
            await h.append(user);
            await h.expectRequests(box, 1);
        });

        scenario('PUSH-057', async () => {
            const user = await h.createUser();
            const token = await h.tokenClient(user);
            const asp = await h.aspClient(user);
            const boxes = { password: push.endpoint(), token: push.endpoint(), asp: push.endpoint() };
            await h.verified(user.client, boxes.password);
            await h.verified(token, boxes.token);
            await h.verified(asp, boxes.asp);
            await api('PUT', `/users/${user.id}`, { password: 'Another-Secret-123' });
            await clock.waitFor(async () => (await h.storedOf(user)).length === 1, { message: 'two subscriptions are removed' });
            await h.deliver(user);
            await h.stateChanges(boxes.asp, 1);
            await h.expectRequests(boxes.password, 1);
            expect(boxes.token.requests).to.have.length(1);
        });

        scenario('PUSH-058', async () => {
            const user = await h.createUser();
            const token = await h.tokenClient(user);
            const box = push.endpoint();
            await h.verified(token, box, { expires: new Date(Date.now() + 3 * DAY).toISOString() });
            // the token runs out
            await redis.pexpire(token.tokenKey, 1);
            await clock.delay(50);
            await h.append(user);
            await h.expectRequests(box, 1);
            await clock.waitFor(async () => !(await h.storedOf(user)).length, { message: 'the subscription is removed' });
        });

        scenario('PUSH-089', async () => {
            const user = await h.createUser();
            const token = await h.tokenClient(user);
            const box = push.endpoint();
            const id = await h.verified(token, box);
            // a rotated api.accessControl.secret: the token record was signed, and the subscription bound to
            // it, under the previous secret (in the field order of UserHandler.setAuthToken)
            const previous = `previous ${crypto.randomBytes(8).toString('hex')}`;
            const hmac = data => crypto.createHmac('sha256', previous).update(data).digest('hex');
            const record = await redis.hgetall(token.tokenKey);
            const signature = hmac(
                JSON.stringify({
                    token: token.token,
                    user: record.user,
                    authVersion: Number(record.authVersion) || 0,
                    role: record.role,
                    mfaRequired: record.mfaRequired,
                    mfaVerified: record.mfaVerified,
                    passwordChangeRequired: record.passwordChangeRequired
                })
            );
            await redis.hset(token.tokenKey, 's', signature);
            await h.patchStored(id, { tokenProof: hmac(`${token.tokenKey.slice('tn:token:'.length)}\0${signature}`) });
            expect((await token.request({ using: h.CORE, methodCalls: [['Core/echo', {}, 'e']] })).status).to.equal(401);

            await h.append(user);
            // the PushVerification only
            await h.expectRequests(box, 1);
            await clock.waitFor(async () => !(await h.storedOf(user)).length, { message: 'the subscription is removed' });
        });

        scenario('PUSH-059', async () => {
            const changes = {
                disabled: user => api('PUT', `/users/${user.id}`, { disabled: true }),
                suspended: user => api('PUT', `/users/${user.id}`, { suspended: true }),
                scope: user => api('PUT', `/users/${user.id}`, { disabledScopes: ['jmap'] }),
                deleted: user => accounts.deleteUser(user.id)
            };
            for (const [name, change] of Object.entries(changes)) {
                const user = await h.createUser();
                const box = push.endpoint();
                await h.verified(user.client, box);
                await change(user);
                await h.deliver(user).catch(() => false);
                await h.expectRequests(box, 1);
                if (name === 'deleted') {
                    await clock.waitFor(async () => !(await h.storedOf(user)).length, { message: 'subscriptions of a deleted user are removed' });
                }
            }
        });
    });
});
