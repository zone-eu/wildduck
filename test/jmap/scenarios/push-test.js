/* eslint no-unused-expressions: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file push.yaml: the event source stream (ESRC), the EmailDelivery state (EDLV) and the
// withdrawn PushSubscription interim scenario. Web Push (PUSH, phase 4) is in push-subscription-test.js
// and web-push-test.js.

const crypto = require('crypto');
const net = require('net');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const { expect } = require('chai');
const { scenario, api, API_URL, accounts, seed, fixtures, clock, jmap } = require('../harness');
const sse = require('../harness/sse');
const db = require('../../../lib/db');
const jmapService = require('../../../jmap');
const { createApp } = require('../../../lib/jmap/server');
const FilterHandler = require('../../../lib/filter-handler');
const { SoftwareWebAuthnAuthenticator } = require('../../api/_webauthn');

const MAIL_TYPES = ['Email', 'Mailbox', 'Thread'];
const ALL_TYPES = ['Email', 'Mailbox', 'Thread', 'EmailDelivery'];
// every type a types=* stream carries, mail or not
const STAR_TYPES = [
    ...ALL_TYPES,
    'Identity',
    'EmailSubmission',
    'VacationResponse',
    'Quota',
    'AddressBook',
    'ContactCard',
    'Calendar',
    'ParticipantIdentity',
    'CalendarEvent'
];
// how long "no event arrives" is observed when the scenario does not name a time
const QUIET = 2000;

const basicOf = user => jmap.basic(user.username, user.password);

/** Path of the event source with the given parameters; a parameter set to null is left out */
function esPath(params = {}) {
    const values = Object.assign({ types: '*', closeafter: 'no', ping: '0' }, params);
    const query = Object.entries(values)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}=${encodeURIComponent(value).replace('%2A', '*')}`)
        .join('&');
    return `/jmap/eventsource/?${query}`;
}

/** Opens a stream for a user (Basic with the account password unless `authorization` is given) */
function stream(user, params, options = {}) {
    return sse.open(esPath(params), Object.assign({ authorization: user ? basicOf(user) : null }, options));
}

/** Opens a stream and checks that it was accepted */
async function openStream(user, params, options) {
    const es = await stream(user, params, options);
    expect(es.status, es.body && es.body.toString()).to.equal(200);
    return es;
}

/** Asserts that a non 200 answer carried no event stream */
function expectRefused(es, status) {
    expect(es.status).to.equal(status);
    expect(es.headers.get('content-type') || '').to.not.match(/event-stream/);
}

const changedOf = (event, user) => event.json.changed[user.accountId];

// A user with its account id and mailboxes
async function createUser(options) {
    const user = await accounts.createUser(options);
    user.accountId = 'u' + user.id;
    user.client = jmap.forUser(user);
    user.boxes = await accounts.mailboxes(user);
    return user;
}

// One IMAP session per user, kept open for the run (closed by the root after hook)
async function imapOf(user) {
    if (!user.imap || !user.imap.usable) {
        user.imap = await seed.imap(user);
    }
    return user.imap;
}

async function append(user, mailbox = 'INBOX', flags = [], options = {}) {
    const client = await imapOf(user);
    return client.append(mailbox, await fixtures.buildMessage(options), flags);
}

// Delivers over LMTP; `from` is used as header and envelope sender
async function deliver(user, from) {
    const raw = await fixtures.buildMessage(Object.assign({ to: user.address }, from ? { from } : {}));
    return seed.deliver(user.address, raw, from);
}

// IMAP sequence operations on INBOX through the persistent session
async function inInbox(user, fn) {
    const client = await imapOf(user);
    const lock = await client.getMailboxLock('INBOX');
    try {
        // catch up with changes made elsewhere, so sequence numbers name messages that still exist
        await client.noop();
        return await fn(client);
    } finally {
        lock.release();
    }
}

// The current shared mail state and the delivery state as Email/get, Mailbox/get and Thread/get see it
async function getStates(user) {
    const responses = await user.client.call([
        ['Email/get', { accountId: user.accountId, ids: [] }, 'e'],
        ['Mailbox/get', { accountId: user.accountId, ids: [] }, 'm'],
        ['Thread/get', { accountId: user.accountId, ids: [] }, 't']
    ]);
    return { Email: responses[0][1].state, Mailbox: responses[1][1].state, Thread: responses[2][1].state };
}

// REST messages of a mailbox, oldest first
async function restMessages(user, mailbox) {
    const res = await api('GET', `/users/${user.id}/mailboxes/${user.boxes[mailbox].id}/messages?order=asc&limit=250`);
    return res.results;
}

async function restUpload(user, mailbox = 'INBOX') {
    const res = await fetch(`${API_URL}/users/${user.id}/mailboxes/${user.boxes[mailbox].id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'message/rfc822' },
        body: await fixtures.buildMessage()
    });
    expect(res.status).to.equal(200);
    return res.json();
}

// Waits until the stream got no event for `ms` and checks it received no state event at all
async function expectNoState(es, ms = QUIET) {
    await clock.delay(ms);
    expect(es.named('state').map(event => event.data)).to.deep.equal([]);
}

// Event source id of a settled stream: the id of its last state event
async function settledId(es) {
    const last = await es.settle();
    expect(last, 'a state event').to.be.ok;
    return last.id;
}

// ---- JMAP services started in this process, with their own event source configuration ----

const apps = [];

/**
 * Starts the JMAP service in this process (a separate process from the test server, like another
 * worker), with event source limits for the scenario. `scale` speeds up the stream timers (ping,
 * maximum lifetime) by that factor, so scenarios about long intervals run in seconds.
 */
async function startApp(eventSource = {}, scale = 1, extra = {}) {
    if (!db.database) {
        await db.connect();
    }
    const deps = jmapService.createDeps();
    if (scale !== 1) {
        deps.timers = { setTimeout: (fn, ms) => setTimeout(fn, ms / scale), clearTimeout };
    }
    const app = createApp(deps, Object.assign(appOptions(eventSource), extra));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const entry = { app, deps, base: `http://127.0.0.1:${app.server.address().port}`, scale };
    apps.push(entry);
    return entry;
}

function appOptions(eventSource) {
    return Object.assign({}, config.jmap, {
        eventSource: Object.assign({}, config.jmap.eventSource, eventSource),
        accessSecret: config.api.accessControl.secret,
        roles: config.api.roles,
        tokenLifetime: config.api.accessControl.tokenLifetime
    });
}

async function stopApps() {
    for (const { app, deps } of apps.splice(0)) {
        app.server.closeAllConnections();
        await app.close().catch(() => false);
        deps.notifier.subscriber.disconnect();
    }
}

// A state string of the account for an arbitrary journal anchor, signed like lib/jmap/state.js does
function stateFor(user, anchor) {
    const sum = crypto.createHmac('sha256', config.api.accessControl.secret).update(`${user.accountId}:${anchor}`).digest('hex').slice(0, 8);
    return `${anchor}${sum}`;
}

describe('JMAP push (push.yaml)', () => {
    afterEach(() => sse.closeAll());
    after(stopApps);

    describe('connection, parameters and authentication', () => {
        let user;

        before(async () => {
            user = await createUser();
        });

        scenario('ESRC-001', async () => {
            const session = await user.client.session();
            const template = session.eventSourceUrl;
            for (const variable of ['{types}', '{closeafter}', '{ping}']) {
                expect(template.split(variable).length - 1, variable).to.equal(1);
            }
        });

        scenario('ESRC-002', async () => {
            const anonymous = await stream(null);
            expectRefused(anonymous, 401);
            expect(anonymous.headers.get('www-authenticate')).to.be.a('string').and.not.empty;

            const victim = await createUser();
            const redis = new Redis(config.dbs.redis);
            try {
                const failuresBefore = Number(await redis.get(`auth_user:${victim.id}`)) || 0;
                const wrong = await stream(null, {}, { authorization: jmap.basic(victim.username, 'not-the-password') });
                expectRefused(wrong, 401);
                expect(wrong.headers.get('www-authenticate')).to.be.a('string').and.not.empty;
                // the failure counts towards the login lockout
                expect(Number(await redis.get(`auth_user:${victim.id}`)) || 0).to.equal(failuresBefore + 1);
            } finally {
                redis.disconnect();
            }
        });

        scenario('ESRC-003', async () => {
            const token = await accounts.createToken(user);
            const jmapAsp = await accounts.createAsp(user, ['jmap']);
            const imapAsp = await accounts.createAsp(user, ['imap']);

            const withToken = await stream(null, {}, { authorization: `Bearer ${token}` });
            expect(withToken.status).to.equal(200);
            const withAsp = await stream(null, {}, { authorization: jmap.basic(user.username, jmapAsp) });
            expect(withAsp.status).to.equal(200);

            const imapOnly = jmap.basic(user.username, imapAsp);
            const refused = await stream(null, {}, { authorization: imapOnly });
            const fromApi = await new jmap.JmapClient(imapOnly).request({ using: [jmap.URN.core], methodCalls: [] });
            expectRefused(refused, fromApi.status);
            expect(fromApi.status).to.equal(401);
            expect(refused.body.toString()).to.equal(fromApi.body.toString());
        });

        scenario('ESRC-004', async () => {
            const es = await openStream(user);
            expect(es.headers.get('content-type')).to.match(/^text\/event-stream/);
            expect(es.headers.get('content-length')).to.equal(null);
            await clock.delay(1000);
            expect(es.ended).to.be.false;
        });

        scenario('ESRC-005', async () => {
            const es = await openStream(user, {}, { headers: { 'Accept-Encoding': 'gzip' } });
            expect(es.headers.get('cache-control')).to.match(/no-store|no-cache/);
            expect(es.headers.get('x-accel-buffering')).to.equal('no');
            expect(es.headers.get('content-encoding')).to.equal(null);
            const first = await es.until(() => es.comments[0], 1000, 'no comment line within one second');
            expect(first.at - es.startedAt).to.be.below(1000);
            expect(es.events).to.deep.equal([]);
        });

        scenario('ESRC-006', async () => {
            for (const method of ['POST', 'DELETE']) {
                const res = await user.client.raw(esPath(), { method });
                expect([404, 405], method).to.include(res.status);
                expect(res.headers.get('content-type') || '').to.not.match(/event-stream/);
            }
        });

        scenario('ESRC-015', async () => {
            for (const types of ['Email,Nonsense', 'email']) {
                expectRefused(await stream(user, { types }), 400);
            }
        });

        scenario('ESRC-016', async () => {
            expectRefused(await stream(user, { types: null }), 400);
            expectRefused(await stream(user, { types: '' }), 400);
        });

        scenario('ESRC-020', async () => {
            for (const closeafter of [null, 'yes', 'State']) {
                expectRefused(await stream(user, { closeafter }), 400);
            }
        });

        scenario('ESRC-027', async () => {
            for (const ping of [null, '-5', 'abc', '1.5']) {
                expectRefused(await stream(user, { ping }), 400);
            }
        });

        scenario('ESRC-052', async () => {
            // a free port for the service that stays off
            const probe = net.createServer();
            await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
            const port = probe.address().port;
            await new Promise(resolve => probe.close(resolve));

            const result = await new Promise((resolve, reject) =>
                jmapService.start(Object.assign(appOptions({}), { enabled: false, port }), (err, app) => (err ? reject(err) : resolve(app)))
            );
            expect(result).to.equal(false);
            let failure = null;
            try {
                await fetch(`http://127.0.0.1:${port}${esPath()}`, { headers: { Authorization: basicOf(user) } });
            } catch (err) {
                failure = err;
            }
            // nothing listens: the connection is refused, so no stream can exist
            expect(failure, 'connection refused').to.be.an('error');
        });

        scenario('ESRC-053', async () => {
            const origin = 'https://webmail.example';
            const cors = await startApp({}, 1, { cors: { origins: [origin] } });

            const allowed = await openStream(user, {}, { base: cors.base, headers: { Origin: origin } });
            expect(allowed.headers.get('content-type')).to.match(/^text\/event-stream/);
            expect(allowed.headers.get('access-control-allow-origin')).to.equal(origin);
            expect(allowed.headers.get('vary')).to.match(/\bOrigin\b/);
            // the stream works: a change arrives as a state event
            await append(user);
            expect(Object.keys(changedOf(await allowed.next(), user))).to.include('Email');

            const other = await openStream(user, {}, { base: cors.base, headers: { Origin: 'https://evil.example' } });
            expect(other.headers.get('content-type')).to.match(/^text\/event-stream/);
            expect(other.headers.get('access-control-allow-origin')).to.be.null;
        });

        scenario('EDLV-017', async () => {
            const [[getName, getArgs], [changesName, changesArgs]] = await user.client.call([
                ['EmailDelivery/get', { accountId: user.accountId, ids: null }, 'g'],
                ['EmailDelivery/changes', { accountId: user.accountId, sinceState: 'x' }, 'c']
            ]);
            expect([getName, getArgs.type]).to.deep.equal(['error', 'unknownMethod']);
            expect([changesName, changesArgs.type]).to.deep.equal(['error', 'unknownMethod']);
        });

        scenario('PUSH-001', async () => {});
    });

    describe('state events', () => {
        let user;

        before(async () => {
            user = await createUser();
            await append(user);
            await append(user, 'INBOX', ['\\Seen']);
            await inInbox(user, client => client.messageFlagsAdd('1', ['\\Flagged']));
        });

        scenario('ESRC-007', async () => {
            const es = await openStream(user);
            await clock.delay(3000);
            expect(es.named('state')).to.deep.equal([]);
            expect(es.named('ping')).to.deep.equal([]);
        });

        scenario('ESRC-008', async () => {
            const es = await openStream(user);
            await append(user);
            const event = await es.next();
            expect(event.event).to.equal('state');
            expect(event.json['@type']).to.equal('StateChange');
            expect(Object.keys(event.json.changed)).to.deep.equal([user.accountId]);
            const changed = changedOf(event, user);
            expect(changed).to.be.an('object').and.not.empty;
            for (const value of Object.values(changed)) {
                expect(value).to.be.a('string');
            }
            await es.settle();
        });

        scenario('ESRC-009', async () => {
            const es = await openStream(user);
            await append(user);
            await es.next();
            const last = await es.settle();
            const states = await getStates(user);
            for (const type of MAIL_TYPES) {
                expect(changedOf(last, user)[type], type).to.equal(states[type]);
            }
        });

        scenario('ESRC-010', async () => {
            const es = await openStream(user);
            await inInbox(user, client => client.messageFlagsAdd('2', ['\\Flagged']));
            const event = await es.next();
            const changed = changedOf(event, user);
            expect(Object.keys(changed).sort()).to.deep.equal(['Email', 'Mailbox', 'Thread']);
            expect(new Set(Object.values(changed)).size).to.equal(1);
            await es.settle();
        });

        scenario('ESRC-011', async () => {
            const es = await openStream(user, { types: 'Mailbox' });
            await append(user);
            const event = await es.next();
            expect(Object.keys(changedOf(event, user))).to.deep.equal(['Mailbox']);
            await es.settle();
        });

        scenario('ESRC-012', async () => {
            const es = await openStream(user, { types: 'Email,Thread' });
            await append(user);
            const event = await es.next();
            expect(Object.keys(changedOf(event, user)).sort()).to.deep.equal(['Email', 'Thread']);
            await es.settle();
        });

        scenario('ESRC-013', async () => {
            const es = await openStream(user);
            await deliver(user);
            const event = await es.next();
            expect(Object.keys(changedOf(event, user)).sort()).to.deep.equal([...ALL_TYPES, 'Quota'].sort());
            await es.settle();
        });

        scenario('EDLV-001', async () => {
            const es = await openStream(user);
            await deliver(user);
            const event = await es.next();
            expect(Object.keys(changedOf(event, user))).to.include.members(ALL_TYPES);
            await es.settle();
        });

        scenario('ESRC-014', async () => {
            await api('POST', `/users/${user.id}/mailboxes`, { path: 'Esrc014' });
            const es = await openStream(user, { types: 'EmailDelivery,VacationResponse' });
            await inInbox(user, async client => {
                await client.messageFlagsAdd('1', ['$Esrc014']);
                await client.messageMove('2', 'Esrc014');
            });
            await expectNoState(es);
        });

        scenario('ESRC-017', async () => {
            const es = await openStream(user, { closeafter: 'state' });
            await append(user);
            const event = await es.next();
            expect(event.id).to.be.a('string').and.not.empty;
            await es.waitEnd();
            expect(es.error).to.equal(null);
            expect(es.named('state')).to.have.length(1);
        });

        scenario('ESRC-019', async () => {
            const es = await openStream(user);
            const anchors = [];
            for (let i = 0; i < 3; i++) {
                if (i) {
                    await clock.delay(2000);
                }
                await append(user);
                await es.next();
                // the append may notify more than once, the last state is the one to compare with
                anchors.push(changedOf(await es.settle(300), user).Email);
            }
            expect(es.ended).to.be.false;
            expect(anchors[1] > anchors[0] && anchors[2] > anchors[1], anchors.join(' ')).to.be.true;
        });

        scenario('ESRC-029', async () => {
            const es = await openStream(user);
            await append(user);
            await es.next();
            const first = await es.settle(300);
            await clock.delay(1500);
            await append(user);
            await es.next();
            const second = await es.settle(300);
            for (const event of [first, second]) {
                expect(event.id).to.match(/^[\x21-\x7e]+$/);
            }
            expect(first.id).to.not.equal(second.id);
        });

        scenario('ESRC-036', async () => {
            await append(user);
            await clock.delay(1000);
            const es = await openStream(user);
            await expectNoState(es);
        });

        scenario('ESRC-037', async () => {
            await append(user);
            const before = await getStates(user);
            const [message] = await restMessages(user, 'INBOX');
            const es = await openStream(user);
            await api('PUT', `/users/${user.id}/mailboxes/${user.boxes.INBOX.id}/messages/${message.id}`, { moveTo: user.boxes['\\Trash'].id });
            const event = await es.next();
            const changed = changedOf(event, user);
            expect(changed.Email).to.be.a('string').and.not.equal(before.Email);
            expect(changed.Mailbox).to.be.a('string').and.not.equal(before.Mailbox);
            await es.settle();
        });

        scenario('ESRC-038', async () => {
            const es = await openStream(user, { types: 'Mailbox' });
            const client = await imapOf(user);
            await client.mailboxCreate('Esrc038');
            const created = changedOf(await es.next(), user).Mailbox;
            const afterCreate = changedOf(await es.settle(300), user).Mailbox;
            await client.mailboxDelete('Esrc038');
            const deleted = changedOf(await es.next(), user).Mailbox;
            expect(created).to.be.a('string');
            expect(deleted).to.be.a('string').and.not.equal(afterCreate);
        });

        scenario('ESRC-043', async () => {
            // a \Flagged message, and a message flagged \Deleted in its own mailbox so the expunge touches only it
            await inInbox(user, client => client.messageFlagsAdd('1', ['\\Flagged']));
            await api('POST', `/users/${user.id}/mailboxes`, { path: 'Esrc043' });
            await append(user, 'Esrc043', ['\\Deleted']);
            await clock.delay(500);
            const before = await getStates(user);

            const es = await openStream(user);
            await inInbox(user, client => client.messageFlagsAdd('1', ['\\Flagged']));
            await expectNoState(es, 1500);

            const client = await imapOf(user);
            const lock = await client.getMailboxLock('Esrc043');
            try {
                await client.messageDelete('1:*');
            } finally {
                lock.release();
            }
            await clock.delay(1000);
            for (const event of es.states()) {
                expect(changedOf(event, user).Email).to.not.equal(before.Email);
            }
        });

        scenario('ESRC-044', async () => {
            const streams = [await openStream(user), await openStream(user), await openStream(user, { types: 'Mailbox' })];
            await append(user);
            const events = await Promise.all(streams.map(es => es.next()));
            expect(Object.keys(changedOf(events[2], user))).to.deep.equal(['Mailbox']);
            expect(Object.keys(changedOf(events[0], user))).to.include('Email');
            expect(Object.keys(changedOf(events[1], user))).to.include('Email');
            await Promise.all(streams.map(es => es.settle()));
        });

        scenario('ESRC-045', async () => {
            const other = await createUser();
            const mine = await openStream(user);
            const theirs = await openStream(other);
            await deliver(user);
            const event = await mine.next();
            expect(Object.keys(event.json.changed)).to.deep.equal([user.accountId]);
            await expectNoState(theirs, 1500);
            await mine.settle();
        });
    });

    describe('last event id and replay', () => {
        let user;

        before(async () => {
            user = await createUser();
            await deliver(user);
        });

        // A stream that got a state event and was closed, settled: its last event id
        async function idAfterChange(params, change) {
            const es = await openStream(user, params);
            await change();
            await es.next();
            const id = await settledId(es);
            es.close();
            return id;
        }

        scenario('ESRC-030', async () => {
            const id = await idAfterChange({}, () => append(user));
            const es = await openStream(user, {}, { headers: { 'Last-Event-ID': id } });
            await expectNoState(es);
        });

        scenario('ESRC-031', async () => {
            const id = await idAfterChange({}, () => append(user));
            await append(user);
            const es = await openStream(user, {}, { headers: { 'Last-Event-ID': id } });
            const event = await es.next('state', 1000);
            expect(event.at - es.startedAt).to.be.below(1000);
            expect(event.id).to.be.a('string').and.not.equal(id);
            const states = await getStates(user);
            for (const type of MAIL_TYPES) {
                expect(changedOf(event, user)[type], type).to.equal(states[type]);
            }
            await clock.delay(1000);
            expect(es.named('state')).to.have.length(1);
        });

        scenario('ESRC-032', async () => {
            const id = await idAfterChange({ types: 'EmailDelivery' }, () => deliver(user));
            await inInbox(user, client => client.messageFlagsAdd('1', ['$Esrc032']));
            const es = await openStream(user, { types: 'EmailDelivery' }, { headers: { 'Last-Event-ID': id } });
            await expectNoState(es);
        });

        scenario('ESRC-033', async () => {
            // an event id from before the journal retention (the default retention is a few hours)
            const old = seed.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 30 * 24 * 3600).toString();
            await append(user);
            const es = await openStream(user, {}, { headers: { 'Last-Event-ID': stateFor(user, old) } });
            const event = await es.next('state', 1000);
            expect(Object.keys(changedOf(event, user)).sort()).to.deep.equal([...STAR_TYPES].sort());
            const states = await getStates(user);
            for (const type of MAIL_TYPES) {
                expect(changedOf(event, user)[type], type).to.equal(states[type]);
            }
        });

        scenario('ESRC-034', async () => {
            const other = await createUser();
            const otherStream = await openStream(other);
            await deliver(other);
            await otherStream.next();
            const foreignId = await settledId(otherStream);

            for (const lastEventId of ['garbage', foreignId]) {
                const es = await openStream(user, {}, { headers: { 'Last-Event-ID': lastEventId } });
                const event = await es.next('state', 1000);
                expect(Object.keys(event.json.changed), lastEventId).to.deep.equal([user.accountId]);
                expect(Object.keys(changedOf(event, user)).sort()).to.deep.equal([...STAR_TYPES].sort());
                const states = await getStates(user);
                for (const type of MAIL_TYPES) {
                    expect(changedOf(event, user)[type], type).to.equal(states[type]);
                }
                es.close();
            }
        });

        scenario('ESRC-035', async () => {
            const id = await idAfterChange({}, () => append(user));
            await append(user);
            const es = await openStream(user, { closeafter: 'state' }, { headers: { 'Last-Event-ID': id } });
            await es.next('state', 1000);
            await es.waitEnd(1000);
            expect(es.error).to.equal(null);
        });

        scenario('EDLV-016', async () => {
            const id = await idAfterChange({ types: 'EmailDelivery' }, () => deliver(user));
            await deliver(user);
            const es = await openStream(user, { types: 'EmailDelivery' }, { headers: { 'Last-Event-ID': id } });
            const event = await es.next('state', 1000);
            expect(Object.keys(changedOf(event, user))).to.deep.equal(['EmailDelivery']);
        });
    });

    describe('ping and lifetime', () => {
        let user;
        // pings every 2 seconds at the least, real time
        let fast;
        // default limits, timers 100 times faster
        let scaled;

        before(async () => {
            user = await createUser();
            fast = await startApp({ minPing: 2 });
            scaled = await startApp({}, 100);
        });

        scenario('ESRC-018', async () => {
            const es = await openStream(user, { closeafter: 'state', ping: '5' }, { base: scaled.base });
            await es.next('ping');
            await es.next('ping');
            expect(es.ended).to.be.false;
            await append(user);
            await es.next('state');
            await es.waitEnd();
            expect(es.named('state')).to.have.length(1);
        });

        scenario('ESRC-021', async () => {
            const es = await openStream(user, { ping: '2' }, { base: fast.base });
            await clock.delay(7000);
            const pings = es.named('ping');
            expect(pings).to.have.length(3);
            let previous = es.startedAt;
            for (const ping of pings) {
                expect(JSON.parse(ping.data)).to.deep.equal({ interval: 2 });
                expect(ping.at - previous).to.be.within(1800, 2600);
                previous = ping.at;
            }
        });

        scenario('ESRC-022', async () => {
            const es = await openStream(user, { ping: '5' }, { base: scaled.base });
            await append(user);
            await es.next('state');
            const id = await settledId(es);
            await es.next('ping');
            await es.next('ping');
            for (const ping of es.named('ping')) {
                expect(ping).to.not.have.property('id');
            }
            // the last event id of the client is still the one of the state event
            const ids = es.events.filter(event => 'id' in event).map(event => event.id);
            expect(ids[ids.length - 1]).to.equal(id);
            es.close();

            const again = await openStream(user, {}, { headers: { 'Last-Event-ID': id } });
            await expectNoState(again, 1500);
        });

        scenario('ESRC-023', async () => {
            const es = await openStream(user, { ping: '0' }, { base: scaled.base });
            // longer than the maximum ping of 300 seconds
            await clock.delay((300 * 1000) / scaled.scale + 1000);
            expect(es.named('ping')).to.deep.equal([]);
        });

        scenario('ESRC-024', async () => {
            const es = await openStream(user, { ping: '1' }, { base: scaled.base });
            const first = await es.next('ping');
            const second = await es.next('ping');
            expect(first.json).to.deep.equal({ interval: 5 });
            expect(second.json).to.deep.equal({ interval: 5 });
            // five seconds apart on the scaled clock
            expect((second.at - first.at) * scaled.scale).to.be.within(4000, 10000);
        });

        scenario('ESRC-025', async () => {
            const es = await openStream(user, { ping: '86400' }, { base: scaled.base });
            const ping = await es.next('ping', 6000);
            expect(ping.json).to.deep.equal({ interval: 300 });
            expect((ping.at - es.startedAt) * scaled.scale).to.be.within(290 * 1000, 450 * 1000);
        });

        scenario('ESRC-026', async () => {
            for (const interval of [30, 300]) {
                const es = await openStream(user, { ping: String(interval) }, { base: scaled.base });
                const ping = await es.next('ping', 6000);
                expect(ping.json).to.deep.equal({ interval });
                es.close();
            }
            const deps = jmapService.createDeps();
            try {
                for (const eventSource of [{ minPing: 31 }, { maxPing: 299 }]) {
                    expect(() => createApp(deps, appOptions(eventSource)), JSON.stringify(eventSource)).to.throw(/minPing|maxPing/);
                }
            } finally {
                deps.notifier.subscriber.disconnect();
            }
        });

        scenario('ESRC-028', async () => {
            const es = await openStream(user, { ping: '4' }, { base: fast.base });
            await clock.delay(3000);
            await append(user);
            const state = await es.next('state');
            const ping = await es.next('ping', 6000);
            expect(es.named('ping')).to.have.length(1);
            expect(state.at - es.startedAt).to.be.within(3000, 4500);
            // the timer restarted with the state event
            expect(ping.at - state.at).to.be.within(3800, 4600);
        });

        scenario('ESRC-051', async () => {
            // a maximum lifetime of 30 seconds, on a clock 10 times faster
            const short = await startApp({ maxDuration: 30 }, 10);
            const es = await openStream(user, {}, { base: short.base });
            await append(user);
            await es.next();
            const id = await settledId(es);
            const endedAt = await es.waitEnd(5000);
            expect(es.error).to.equal(null);
            expect((endedAt - es.startedAt) * short.scale).to.be.within(29 * 1000, 40 * 1000);

            // a change after the end is not lost for the reconnecting client
            await append(user);
            const again = await openStream(user, {}, { base: short.base, headers: { 'Last-Event-ID': id } });
            const event = await again.next('state', 1000);
            expect(changedOf(event, user).Email).to.equal((await getStates(user)).Email);
        });
    });

    describe('fan out and limits', () => {
        scenario('ESRC-041', async () => {
            // the stream is served by this process, the changes are made in the test server process
            const worker = await startApp();
            const user = await createUser();
            const es = await openStream(user, {}, { base: worker.base });
            await append(user);
            await es.next();
            await es.settle();
            await deliver(user);
            const event = await es.next();
            expect(Object.keys(changedOf(event, user))).to.include('EmailDelivery');
        });

        scenario('ESRC-042', async () => {
            const user = await createUser();
            const es = await openStream(user);
            const client = await imapOf(user);
            const raws = await Promise.all(Array.from({ length: 100 }, () => fixtures.buildMessage()));
            await Promise.all(raws.map(raw => client.append('INBOX', raw)));
            await es.next();
            const last = await es.settle(1000, 15000);
            expect(es.named('state').length).to.be.below(100);
            expect(changedOf(last, user).Email).to.equal((await getStates(user)).Email);
        });

        scenario('ESRC-046', async () => {
            const limited = await startApp({ maxStreams: 3 });
            const user = await createUser();
            const streams = [];
            for (let i = 0; i < 3; i++) {
                streams.push(await openStream(user, {}, { base: limited.base }));
            }
            const refused = await stream(user, {}, { base: limited.base });
            expectRefused(refused, 429);
            expect(refused.headers.get('retry-after')).to.match(/^\d+$/);

            await append(user);
            await Promise.all(streams.map(es => es.next()));

            streams[0].close();
            const accepted = await clock.waitFor(
                async () => {
                    const es = await stream(user, {}, { base: limited.base });
                    return es.status === 200 && es;
                },
                { timeout: 3000, message: 'no stream accepted after one closed' }
            );
            expect(accepted.status).to.equal(200);
        });

        scenario('ESRC-047', async () => {
            const limited = await startApp({ maxStreams: 2 });
            const user = await createUser();
            // a slot is released when the server sees the client go away, which takes a moment
            const accepted = () =>
                clock.waitFor(
                    async () => {
                        const es = await stream(user, {}, { base: limited.base });
                        return es.status === 200 ? es : es.close();
                    },
                    { timeout: 3000, message: 'the stream limit did not free up' }
                );
            for (let i = 0; i < 20; i++) {
                const pair = [await accepted(), await accepted()];
                pair.forEach(es => es.close());
            }
            const last = [await accepted(), await accepted()];
            expect(last.map(es => es.status)).to.deep.equal([200, 200]);
            const counters = new Redis(config.dbs.redis);
            try {
                expect(Number(await counters.hget('lim:jmap-eventsource', user.id))).to.equal(2);
            } finally {
                counters.disconnect();
            }
        });
    });

    describe('revoked credentials', () => {
        // the stream ends and the same credentials are refused afterwards
        async function expectRevoked(es, authorization) {
            await es.waitEnd(5000);
            const states = es.named('state').length;
            await clock.delay(300);
            expect(es.named('state').length).to.equal(states);
            const again = await stream(null, {}, { authorization });
            expect(again.status).to.not.equal(200);
            expect(again.headers.get('content-type') || '').to.not.match(/event-stream/);
            return again;
        }

        scenario('ESRC-048', async () => {
            const user = await createUser();
            const created = await api('POST', `/users/${user.id}/asps`, { description: 'esrc-048', scopes: ['jmap'], generateMobileconfig: false });
            const authorization = jmap.basic(user.username, created.password);
            const es = await openStream(null, {}, { authorization });
            // a stream with another credential of the same user is not affected
            const unaffected = await openStream(user);
            await api('DELETE', `/users/${user.id}/asps/${created.id}`);
            const again = await expectRevoked(es, authorization);
            expect(again.status).to.equal(401);
            expect(unaffected.ended).to.be.false;
        });

        scenario('ESRC-049', async () => {
            const user = await createUser();
            const token = await accounts.createToken(user);
            const basic = basicOf(user);
            const withPassword = await openStream(user);
            const withToken = await openStream(null, {}, { authorization: `Bearer ${token}` });
            // revoking one token ends only the stream of that token
            const revokedToken = await accounts.createToken(user);
            const withRevoked = await openStream(null, {}, { authorization: `Bearer ${revokedToken}` });
            await api('DELETE', '/authenticate', null, { headers: { 'X-Access-Token': revokedToken } });
            expect((await expectRevoked(withRevoked, `Bearer ${revokedToken}`)).status).to.equal(401);
            expect(withPassword.ended).to.be.false;
            expect(withToken.ended).to.be.false;
            await api('PUT', `/users/${user.id}`, { password: 'Jm4pScenario-Changed' });
            expect((await expectRevoked(withPassword, basic)).status).to.equal(401);
            expect((await expectRevoked(withToken, `Bearer ${token}`)).status).to.equal(401);
        });

        scenario('ESRC-054', async () => {
            // default limits but a long lifetime, timers 300 times faster: the credential is checked about every second
            const scaled = await startApp({ maxDuration: 36000 }, 300);
            const user = await createUser();
            const token = await accounts.createToken(user);
            const authorization = `Bearer ${token}`;
            const withToken = await openStream(null, {}, { authorization, base: scaled.base });
            const unaffected = await openStream(user, {}, { base: scaled.base });
            // gone from Redis without any notification, as when its idle TTL runs out
            const redis = new Redis(config.dbs.redis);
            try {
                await redis.del(`tn:token:${crypto.createHash('sha256').update(token).digest('hex')}`);
            } finally {
                redis.disconnect();
            }
            await withToken.waitEnd(5000);
            const again = await stream(null, {}, { authorization, base: scaled.base });
            expectRefused(again, 401);
            // the account password stream passed the same checks and stays open
            expect(unaffected.ended).to.be.false;
            await append(user);
            expect(Object.keys(changedOf(await unaffected.next(), user))).to.include('Email');
        });

        scenario('ESRC-055', async () => {
            const user = await createUser();
            const es = await openStream(user);
            const asp = await api('POST', `/users/${user.id}/asps`, { description: 'esrc-055', scopes: ['jmap'], generateMobileconfig: false });
            const withAsp = await openStream(null, {}, { authorization: jmap.basic(user.username, asp.password) });
            // the first second factor of the account is a WebAuthn credential
            const authenticator = new SoftwareWebAuthnAuthenticator('example.com');
            const { registrationOptions } = await api('POST', `/users/${user.id}/2fa/webauthn/registration-challenge`, {
                description: 'esrc-055',
                origin: 'https://example.com',
                rpId: 'example.com',
                authenticatorAttachment: 'cross-platform'
            });
            const attestation = authenticator.createRegistrationResponse(registrationOptions.challenge, 'https://example.com');
            await api('POST', `/users/${user.id}/2fa/webauthn/registration-attestation`, Object.assign({ rpId: 'example.com' }, attestation));
            // every stream of the account ends, as when TOTP is enabled
            expect((await expectRevoked(es, basicOf(user))).status).to.equal(401);
            await withAsp.waitEnd(5000);
        });

        scenario('ESRC-050', async () => {
            const changes = {
                disabled: user => api('PUT', `/users/${user.id}`, { disabled: true }),
                suspended: user => api('PUT', `/users/${user.id}`, { suspended: true }),
                disabledScopes: user => api('PUT', `/users/${user.id}`, { disabledScopes: ['jmap'] }),
                deleted: user => accounts.deleteUser(user.id)
            };
            for (const [name, change] of Object.entries(changes)) {
                const user = await createUser();
                const es = await openStream(user);
                await change(user);
                try {
                    await expectRevoked(es, basicOf(user));
                } catch (err) {
                    err.message = `${name}: ${err.message}`;
                    throw err;
                }
            }
        });
    });

    describe('EmailDelivery', () => {
        let user;

        before(async () => {
            user = await createUser();
            await api('POST', `/users/${user.id}/mailboxes`, { path: 'Lists' });
            user.boxes = await accounts.mailboxes(user);
            for (let i = 0; i < 6; i++) {
                await append(user);
            }
        });

        // a stream of EmailDelivery only; `change(es)` must produce exactly `count` events (0 for none)
        async function deliveryEvents(change, count, quiet = QUIET) {
            const es = await openStream(user, { types: 'EmailDelivery' });
            await change(es);
            if (count) {
                await es.until(() => es.named('state').length >= count, 5000, `expected ${count} state events`);
            }
            await clock.delay(quiet);
            const events = es.states();
            expect(
                events.map(event => event.data),
                'state events'
            ).to.have.length(count);
            for (const event of events) {
                expect(Object.keys(changedOf(event, user))).to.deep.equal(['EmailDelivery']);
                expect(changedOf(event, user).EmailDelivery).to.be.a('string');
            }
            es.close();
            return events;
        }

        scenario('EDLV-002', async () => {
            await deliveryEvents(() => deliver(user), 1, 1000);
        });

        scenario('EDLV-003', async () => {
            // the Haraka plugin stores inbound mail with FilterHandler.storeMessage in its own process
            if (!db.database) {
                await db.connect();
            }
            const deps = jmapService.createDeps();
            const filterHandler = new FilterHandler({ db, sender: config.sender, messageHandler: deps.messageHandler, loggelf: () => false });
            const store = async () => {
                const userData = await filterHandler.getUserDataAsync(user.address);
                const raw = await fixtures.buildMessage({ to: user.address });
                await filterHandler.storeMessage(userData, {
                    sender: 'sender@example.net',
                    recipient: user.address,
                    chunks: [raw],
                    chunklen: raw.length,
                    meta: { source: 'MX', from: 'sender@example.net', to: [user.address], time: new Date() }
                });
            };
            try {
                await deliveryEvents(store, 1, 1000);
            } finally {
                deps.notifier.subscriber.disconnect();
            }
        });

        scenario('EDLV-004', async () => {
            const events = await deliveryEvents(
                async es => {
                    await deliver(user);
                    await es.next();
                    await clock.delay(5000);
                    await deliver(user);
                },
                2,
                500
            );
            expect(changedOf(events[0], user).EmailDelivery).to.not.equal(changedOf(events[1], user).EmailDelivery);
        });

        scenario('EDLV-005', async () => {
            const [, second] = await restMessages(user, 'INBOX');
            await deliveryEvents(async () => {
                await inInbox(user, client => client.messageFlagsAdd('1', ['\\Seen']));
                await api('PUT', `/users/${user.id}/mailboxes/${user.boxes.INBOX.id}/messages/${second.id}`, { addLabels: ['Edlv005'] });
            }, 0);
        });

        scenario('EDLV-006', async () => {
            await deliveryEvents(async () => {
                await inInbox(user, client => client.messageMove('1', 'Lists'));
                const [first] = await restMessages(user, 'INBOX');
                await api('PUT', `/users/${user.id}/mailboxes/${user.boxes.INBOX.id}/messages/${first.id}`, { moveTo: user.boxes.Lists.id });
            }, 0);
        });

        scenario('EDLV-007', async () => {
            await deliveryEvents(() => inInbox(user, client => client.messageCopy('1', 'Lists')), 1);
        });

        scenario('EDLV-008', async () => {
            await deliveryEvents(async () => {
                await inInbox(user, client => client.messageDelete('1'));
                const [first] = await restMessages(user, 'INBOX');
                await api('DELETE', `/users/${user.id}/mailboxes/${user.boxes.INBOX.id}/messages/${first.id}`);
            }, 0);
        });

        scenario('EDLV-009', async () => {
            await deliveryEvents(() => append(user, user.boxes['\\Drafts'].path, ['\\Draft']), 1);
            // updating the draft (phase 1: a keyword change over IMAP) does not change EmailDelivery
            await deliveryEvents(async () => {
                const client = await imapOf(user);
                const lock = await client.getMailboxLock(user.boxes['\\Drafts'].path);
                try {
                    await client.messageFlagsAdd('1', ['\\Seen']);
                } finally {
                    lock.release();
                }
            }, 0);
        });

        scenario('EDLV-010', async () => {
            await deliveryEvents(
                () =>
                    api('POST', `/users/${user.id}/submit`, {
                        to: [{ address: 'external-recipient@example.org' }],
                        subject: 'EDLV-010',
                        text: 'Sent copy'
                    }),
                1
            );
            const sent = await restMessages(user, '\\Sent');
            expect(sent.map(message => message.subject)).to.include('EDLV-010');
        });

        scenario('EDLV-011', async () => {
            await deliveryEvents(
                async es => {
                    await append(user);
                    await es.next();
                    await restUpload(user);
                },
                2,
                1000
            );
        });

        scenario('EDLV-013', async () => {
            const [message] = await restMessages(user, 'INBOX');
            await api('DELETE', `/users/${user.id}/mailboxes/${user.boxes.INBOX.id}/messages/${message.id}`);
            const archived = await clock.waitFor(async () => (await api('GET', `/users/${user.id}/archived/messages?limit=250`)).results[0]);
            await deliveryEvents(() => api('POST', `/users/${user.id}/archived/messages/${archived.id}/restore`, {}), 1);
        });

        scenario('EDLV-014', async () => {
            await api('POST', `/users/${user.id}/filters`, { name: 'lists', query: { from: 'list@lists.example' }, action: { mailbox: user.boxes.Lists.id } });
            await api('POST', `/users/${user.id}/filters`, { name: 'spam', query: { from: 'spam@spam.example' }, action: { spam: true } });
            await deliveryEvents(
                async () => {
                    await deliver(user, 'list@lists.example');
                    await deliver(user, 'spam@spam.example');
                },
                2,
                1000
            );
            expect((await restMessages(user, 'Lists')).some(message => message.from && message.from.address === 'list@lists.example')).to.be.true;
            expect((await restMessages(user, '\\Junk')).some(message => message.from && message.from.address === 'spam@spam.example')).to.be.true;
        });

        scenario('EDLV-015', async () => {
            const target = await createUser();
            await api('POST', `/users/${target.id}/filters`, { name: 'drop', query: { from: 'drop@drop.example' }, action: { delete: true } });
            const es = await openStream(target);
            await deliver(target, 'drop@drop.example');
            await expectNoState(es);
            expect(await restMessages(target, 'INBOX')).to.deep.equal([]);
        });
    });
});
