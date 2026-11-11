/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Catalogue file vacation.yaml: VacationResponse/get and VacationResponse/set (RFC 8621 8), the two way
// mapping to the autoreply of the REST API, and the automatic replies sent on delivery.

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const { GridFSBucket } = require('mongodb');
const { simpleParser } = require('mailparser');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');
const sse = require('../harness/sse');

const { URN } = jmap;
const USING = [URN.core, URN.mail, URN.vacationresponse];
const PROPERTIES = ['fromDate', 'htmlBody', 'id', 'isEnabled', 'subject', 'textBody', 'toDate'];
const DEFAULTS = { id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null };
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY = 24 * 3600 * 1000;
// how long "no reply is queued" is observed; the reply is queued before LMTP answers
const QUIET = 300;

const unique = prefix => `${prefix}${crypto.randomBytes(5).toString('hex')}`;
const external = () => `${unique('s')}@example.net`;
const at = offset => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function client(user) {
    const c = jmap.forUser(user);
    await c.session();
    return c;
}

const call = (c, name, args = {}) => c.method(name, args, USING);
const vget = (c, args = {}) => call(c, 'VacationResponse/get', args);
const vset = (c, args) => call(c, 'VacationResponse/set', args);
const update = (c, patch, extra = {}) => vset(c, Object.assign({ update: { singleton: patch } }, extra));
const current = async c => (await vget(c)).list[0];
const restAutoreply = user => api('GET', `/users/${user.id}/autoreply`);

async function failsWith(promise, type) {
    try {
        await promise;
    } catch (err) {
        expect(err.type, err.message).to.equal(type);
        return err;
    }
    throw new Error(`expected ${type}`);
}

/** Expects an update to fail with invalidProperties naming `properties`, and the object to stay as it was */
async function rejects(c, patch, properties) {
    const before = await vget(c);
    const res = await update(c, patch);
    expect(res.updated, JSON.stringify(patch)).to.not.be.ok;
    expect(res.notUpdated.singleton.type, JSON.stringify(patch)).to.equal('invalidProperties');
    expect(res.notUpdated.singleton.properties, JSON.stringify(patch)).to.include.members(properties);
    expect(res.newState).to.equal(res.oldState);
    const after = await vget(c);
    expect(after.list).to.deep.equal(before.list);
    expect(after.state).to.equal(before.state);
    return res;
}

/** A user with an enabled vacation response, and its JMAP client */
async function vacationUser(patch = {}) {
    const user = await accounts.createUser();
    const c = await client(user);
    const res = await update(c, Object.assign({ isEnabled: true, subject: 'Away', textBody: 'I am away' }, patch));
    expect(res.updated, JSON.stringify(res.notUpdated)).to.have.property('singleton');
    return { user, c };
}

// ---------------------------------------------------------------- delivery and the outbound queue

async function deliverTo(user, sender, options = {}, envelopeFrom = sender) {
    const raw = await fixtures.buildMessage(Object.assign({ from: sender || 'bounce@example.net', to: user.address, subject: 'Hello' }, options));
    await seed.deliver(user.address, raw, envelopeFrom);
    return raw;
}

const senderDb = async () => (await seed.db()).client.db(config.dbs.sender);

/** Queue entries of automatic replies addressed to a recipient */
async function queuedTo(recipient) {
    return (await senderDb()).collection(config.sender.collection).find({ recipient }).toArray();
}

/** Waits until `count` replies are queued for a recipient, then reads and parses the newest one */
async function replyTo(recipient, count = 1) {
    const entries = await clock.waitFor(async () => {
        const list = await queuedTo(recipient);
        return list.length >= count && list;
    });
    expect(entries).to.have.length(count);
    return readQueued(entries.sort((a, b) => a.created - b.created)[count - 1].id);
}

/** The envelope, raw message and parsed message of a queued message */
async function readQueued(id) {
    const database = await senderDb();
    const file = await database.collection(`${config.sender.gfs}.files`).findOne({ filename: `message ${id}` });
    const chunks = [];
    for await (const chunk of new GridFSBucket(database, { bucketName: config.sender.gfs }).openDownloadStream(file._id)) {
        chunks.push(chunk);
    }
    const envelope = file.metadata.data;
    const head = envelope.headers.map(header => header.line).join('\r\n');
    const raw = Buffer.concat([Buffer.from(`${head}\r\n\r\n`, 'binary'), ...chunks]);
    return { id, envelope, head, raw, parsed: await simpleParser(raw) };
}

/** Expects no reply to have been queued for any of the recipients */
async function noReplies(...recipients) {
    await clock.delay(QUIET);
    for (const recipient of recipients) {
        expect(await queuedTo(recipient), `reply to ${recipient}`).to.have.length(0);
    }
}

/** Messages of a user in a mailbox (by special use or path) */
async function messagesIn(user, mailbox) {
    const boxes = await accounts.mailboxes(user);
    return (await api('GET', `/users/${user.id}/mailboxes/${boxes[mailbox].id}/messages`)).results;
}

describe('VacationResponse', function () {
    this.timeout(60000);

    describe('VacationResponse/get', () => {
        let user;
        let c;
        before(async () => {
            user = await accounts.createUser();
            c = await client(user);
        });

        scenario('VAC-001', async () => {
            const session = await c.session();
            expect(session.capabilities[URN.vacationresponse]).to.deep.equal({});
            expect(session.accounts[c.accountId].accountCapabilities[URN.vacationresponse]).to.deep.equal({});
        });

        scenario('VAC-002', async () => {
            for (const using of [[URN.core, URN.mail], [URN.core]]) {
                const responses = await c.call(
                    [
                        ['VacationResponse/get', { accountId: true }, 'g'],
                        ['VacationResponse/set', { accountId: true, update: { singleton: { isEnabled: true } } }, 's']
                    ],
                    using
                );
                expect(responses).to.deep.equal([
                    ['error', { type: 'unknownMethod' }, 'g'],
                    ['error', { type: 'unknownMethod' }, 's']
                ]);
            }
            expect((await current(c)).isEnabled).to.be.false;
        });

        scenario('VAC-003', async () => {
            const fresh = await accounts.createUser();
            const db = await seed.db();
            expect(await db.collection('autoreplies').findOne({ user: new seed.ObjectId(fresh.id) })).to.not.exist;
            const fc = await client(fresh);
            const result = await vget(fc, { ids: null });
            expect(result.accountId).to.equal(fc.accountId);
            expect(result.list).to.deep.equal([DEFAULTS]);
            expect(result.notFound).to.deep.equal([]);
            expect(result.state).to.be.a('string').and.not.empty;
        });

        scenario('VAC-004', async () => {
            const result = await vget(c, { ids: ['singleton'] });
            expect(result.list).to.have.length(1);
            expect(result.list[0].id).to.equal('singleton');
            expect(result.notFound).to.deep.equal([]);
        });

        scenario('VAC-005', async () => {
            const randomId = unique('x');
            let result = await vget(c, { ids: [randomId] });
            expect(result.list).to.deep.equal([]);
            expect(result.notFound).to.deep.equal([randomId]);
            result = await vget(c, { ids: ['singleton', randomId] });
            expect(result.list.map(entry => entry.id)).to.deep.equal(['singleton']);
            expect(result.notFound).to.deep.equal([randomId]);
        });

        scenario('VAC-006', async () => {
            const result = await vget(c, { ids: [] });
            expect(result.list).to.deep.equal([]);
            expect(result.notFound).to.deep.equal([]);
            await failsWith(vget(c, { ids: [''] }), 'invalidArguments');
        });

        scenario('VAC-007', async () => {
            const { c: vc } = await vacationUser({ subject: 'Subject 7', textBody: 'Text 7' });
            let { list } = await vget(vc, { properties: ['isEnabled', 'subject'] });
            expect(list).to.deep.equal([{ id: 'singleton', isEnabled: true, subject: 'Subject 7' }]);
            ({ list } = await vget(vc, { properties: [] }));
            expect(list).to.deep.equal([{ id: 'singleton' }]);
            ({ list } = await vget(vc, { properties: ['subject'] }));
            expect(list).to.deep.equal([{ id: 'singleton', subject: 'Subject 7' }]);
            ({ list } = await vget(vc, { properties: null }));
            expect(Object.keys(list[0]).sort()).to.deep.equal(PROPERTIES);
            expect(list[0]).to.include({ subject: 'Subject 7', textBody: 'Text 7', isEnabled: true });
        });

        scenario('VAC-008', async () => {
            const err = await failsWith(vget(c, { properties: ['isEnabled', 'bogus'] }), 'invalidArguments');
            expect(err.response).to.not.have.property('list');
        });

        scenario('VAC-009', async () => {
            const other = await accounts.createUser();
            await api('PUT', `/users/${other.id}/autoreply`, { status: true, subject: 'Other subject', text: 'Other text' });
            const before = await restAutoreply(other);
            for (const accountId of [`u${other.id}`, `u${crypto.randomBytes(12).toString('hex')}`]) {
                await failsWith(vget(c, { accountId }), 'accountNotFound');
                await failsWith(vset(c, { accountId, update: { singleton: { subject: 'Changed', isEnabled: false } } }), 'accountNotFound');
            }
            expect(await restAutoreply(other)).to.deep.equal(before);
        });
    });

    describe('VacationResponse/set', () => {
        scenario('VAC-010', async () => {
            const user = await accounts.createUser();
            const c = await client(user);
            const values = {
                isEnabled: true,
                fromDate: '2030-01-01T00:00:00Z',
                toDate: '2030-01-15T12:30:00Z',
                subject: 'On holiday',
                textBody: 'I am on holiday until the 15th.',
                htmlBody: '<p>I am on <b>holiday</b> until the 15th.</p>'
            };
            const res = await update(c, values);
            expect(res).to.have.property('updated').that.has.property('singleton');
            if (res.updated.singleton !== null) {
                expect(Object.keys(res.updated.singleton)).to.not.include.members(Object.keys(values));
            }
            expect(res.notUpdated || {}).to.deep.equal({});
            expect(res.newState).to.not.equal(res.oldState);
            const { list } = await vget(c);
            expect(list).to.deep.equal([Object.assign({ id: 'singleton' }, values)]);
            expect(list[0].fromDate).to.match(UTC_DATE);
        });

        scenario('VAC-011', async () => {
            const c = await client(await accounts.createUser());
            const res = await update(c, { isEnabled: true });
            expect(res.updated).to.have.property('singleton');
            expect(await current(c)).to.deep.equal(Object.assign({}, DEFAULTS, { isEnabled: true }));
        });

        scenario('VAC-012', async () => {
            const { c } = await vacationUser({ htmlBody: '<p>away</p>', fromDate: '2030-01-01T00:00:00Z', toDate: '2030-02-01T00:00:00Z' });
            const before = await current(c);
            const res = await update(c, { isEnabled: false });
            expect(res.updated).to.have.property('singleton');
            expect(await current(c)).to.deep.equal(Object.assign({}, before, { isEnabled: false }));
        });

        scenario('VAC-013', async () => {
            const { c } = await vacationUser({ subject: 'S1', textBody: 'T1', htmlBody: '<p>H1</p>' });
            const before = await current(c);
            await update(c, { subject: 'S2' });
            expect(await current(c)).to.deep.equal(Object.assign({}, before, { subject: 'S2' }));
        });

        scenario('VAC-014', async () => {
            const user = await accounts.createUser();
            const c = await client(user);
            await update(c, { fromDate: '2030-01-01T00:00:00Z', toDate: '2030-01-15T00:00:00Z' });
            expect(await current(c)).to.include({ fromDate: '2030-01-01T00:00:00Z', toDate: '2030-01-15T00:00:00Z' });
            await update(c, { fromDate: null, toDate: null });
            expect(await current(c)).to.include({ fromDate: null, toDate: null });
            const rest = await restAutoreply(user);
            expect(rest.start).to.be.undefined;
            expect(rest.end).to.be.undefined;
            const stored = await (await seed.db()).collection('autoreplies').findOne({ user: new seed.ObjectId(user.id) });
            expect(stored.start).to.equal(false);
            expect(stored.end).to.equal(false);
        });

        scenario('VAC-015', async () => {
            const c = await client(await accounts.createUser());
            await update(c, { fromDate: '2030-03-01T08:00:00Z', toDate: null });
            expect(await current(c)).to.include({ fromDate: '2030-03-01T08:00:00Z', toDate: null });
            await update(c, { fromDate: null, toDate: '2030-04-01T08:00:00Z' });
            expect(await current(c)).to.include({ fromDate: null, toDate: '2030-04-01T08:00:00Z' });
        });

        scenario('VAC-016', async () => {
            const { c } = await vacationUser({ fromDate: '2030-01-10T00:00:00Z', toDate: '2030-01-20T00:00:00Z' });
            await rejects(c, { fromDate: '2030-02-01T00:00:00Z', toDate: '2030-01-01T00:00:00Z' }, ['fromDate', 'toDate']);
            const res = await rejects(c, { toDate: '2030-01-05T00:00:00Z' }, ['toDate']);
            expect(res.notUpdated.singleton.properties).to.deep.equal(['toDate']);
        });

        scenario('VAC-017', async () => {
            const c = await client(await accounts.createUser());
            await rejects(c, { fromDate: 'next tuesday' }, ['fromDate']);
            await rejects(c, { fromDate: '2030-01-01T00:00:00+02:00' }, ['fromDate']);
            await rejects(c, { isEnabled: 'true' }, ['isEnabled']);
            await rejects(c, { isEnabled: null }, ['isEnabled']);
            await rejects(c, { subject: 42 }, ['subject']);
            expect(await current(c)).to.deep.equal(DEFAULTS);
        });

        scenario('VAC-018', async () => {
            const c = await client(await accounts.createUser());
            await rejects(c, { bogus: true }, ['bogus']);
            await rejects(c, { id: 'other' }, ['id']);
            const res = await update(c, { id: 'singleton', subject: 'With id' });
            expect(res.updated).to.have.property('singleton');
            expect((await current(c)).subject).to.equal('With id');
        });

        scenario('VAC-019', async () => {
            const { c } = await vacationUser();
            const { list, state } = await vget(c);
            let res = await vset(c, { update: { singleton: {} } });
            expect(res.updated).to.have.property('singleton');
            expect(res.oldState).to.equal(state);
            expect(res.newState).to.equal(state);
            res = await vset(c, { update: {} });
            expect(res.updated || {}).to.deep.equal({});
            expect(res.oldState).to.equal(state);
            expect(res.newState).to.equal(state);
            const after = await vget(c);
            expect(after.list).to.deep.equal(list);
            expect(after.state).to.equal(state);
        });

        scenario('VAC-020', async () => {
            const c = await client(await accounts.createUser());
            const res = await vset(c, { update: { singleton: { subject: 'A' }, other: { subject: 'B' } } });
            expect(res.updated).to.have.property('singleton');
            expect(res.notUpdated.other.type).to.equal('notFound');
            expect((await current(c)).subject).to.equal('A');
        });

        scenario('VAC-021', async () => {
            const user = await accounts.createUser();
            const c = await client(user);
            const res = await vset(c, { create: { c1: { isEnabled: true, textBody: 'hello' } } });
            expect(res.notCreated.c1.type).to.equal('singleton');
            expect(res.created || {}).to.deep.equal({});
            expect(res.newState).to.equal(res.oldState);
            expect(await current(c)).to.deep.equal(DEFAULTS);
            expect((await restAutoreply(user)).status).to.be.false;
        });

        scenario('VAC-022', async () => {
            const { c } = await vacationUser();
            const before = await current(c);
            let res = await vset(c, { destroy: ['singleton'] });
            expect(res.notDestroyed.singleton.type).to.equal('singleton');
            expect(res.destroyed || []).to.deep.equal([]);
            res = await vset(c, { destroy: ['otherId'] });
            expect(res.notDestroyed.otherId.type).to.equal('notFound');
            expect(await current(c)).to.deep.equal(before);
            expect(before.isEnabled).to.be.true;
        });

        scenario('VAC-023', async () => {
            const c = await client(await accounts.createUser());
            const s1 = (await vget(c)).state;
            const res = await update(c, { subject: 'New subject' });
            const s2 = (await vget(c)).state;
            expect(s2).to.not.equal(s1);
            expect(res.newState).to.equal(s2);
            expect((await vget(c)).state).to.equal(s2);
            const rejected = await update(c, { fromDate: 'invalid' });
            expect(rejected.notUpdated.singleton.type).to.equal('invalidProperties');
            expect(rejected.oldState).to.equal(s2);
            expect(rejected.newState).to.equal(s2);
            expect((await vget(c)).state).to.equal(s2);
        });

        scenario('VAC-024', async () => {
            const c = await client(await accounts.createUser());
            const s1 = (await vget(c)).state;
            await update(c, { subject: 'First' });
            const s2 = (await vget(c)).state;
            await failsWith(update(c, { subject: 'Stale' }, { ifInState: s1 }), 'stateMismatch');
            expect((await current(c)).subject).to.equal('First');
            const res = await update(c, { subject: 'Fresh' }, { ifInState: s2 });
            expect(res.updated).to.have.property('singleton');
            expect((await current(c)).subject).to.equal('Fresh');
        });

        scenario('VAC-025', async () => {
            const c = await client(await accounts.createUser());
            const html = '<div dir="ltr"><p>Grüße aus <b>Zürich</b> &amp; 日本 ✓</p><br/></div>';
            await update(c, { htmlBody: html, textBody: null });
            expect(await current(c)).to.include({ htmlBody: html, textBody: null });
        });

        scenario('VAC-026', async () => {
            const c = await client(await accounts.createUser());
            await rejects(c, { subject: 'x'.repeat(2 * 1024 + 1) }, ['subject']);
            await rejects(c, { textBody: 't'.repeat(128 * 1024 + 1) }, ['textBody']);
            await rejects(c, { htmlBody: 'h'.repeat(128 * 1024 + 1) }, ['htmlBody']);
            expect(await current(c)).to.deep.equal(DEFAULTS);
            const atLimit = { subject: 'x'.repeat(2 * 1024), textBody: 't'.repeat(128 * 1024), htmlBody: 'h'.repeat(128 * 1024) };
            const res = await update(c, atLimit);
            expect(res.updated).to.have.property('singleton');
            expect(await current(c)).to.include(atLimit);
        });

        scenario('VAC-027', async () => {
            const { user, c } = await vacationUser();
            const subject = 'Say "hi" \\ back; ok\r\nBcc: injected@example.com';
            const textBody = 'Line "one" \\ two; three\r\nX-Injected: yes\r\n\r\nSubject: not a header';
            await update(c, { subject, textBody });
            expect(await current(c)).to.include({ subject, textBody });

            const sender = external();
            await deliverTo(user, sender);
            const reply = await replyTo(sender);
            expect(reply.parsed.headers.has('x-injected')).to.be.false;
            expect(reply.parsed.headers.has('bcc')).to.be.false;
            expect(reply.envelope.to).to.deep.equal([sender]);
            expect(reply.parsed.text.replace(/\r?\n/g, '\n')).to.include(textBody.replace(/\r\n/g, '\n'));
        });
    });

    describe('REST API round trip', () => {
        scenario('VAC-028', async () => {
            const user = await accounts.createUser();
            const start = '2030-05-01T06:00:00.000Z';
            const end = '2030-05-20T18:00:00.000Z';
            await api('PUT', `/users/${user.id}/autoreply`, { status: true, subject: 'REST subject', text: 'REST text', html: '<p>REST html</p>', start, end });
            const vacation = await current(await client(user));
            expect(vacation).to.include({ isEnabled: true, subject: 'REST subject', textBody: 'REST text', htmlBody: '<p>REST html</p>' });
            expect(vacation.fromDate).to.match(UTC_DATE);
            expect(vacation.toDate).to.match(UTC_DATE);
            expect(new Date(vacation.fromDate).getTime()).to.equal(new Date(start).getTime());
            expect(new Date(vacation.toDate).getTime()).to.equal(new Date(end).getTime());
        });

        scenario('VAC-029', async () => {
            const user = await accounts.createUser();
            await api('PUT', `/users/${user.id}/autoreply`, { status: true, text: 'Only text', subject: '', html: '', start: false, end: false });
            const vacation = await current(await client(user));
            expect(vacation).to.deep.equal(Object.assign({}, DEFAULTS, { isEnabled: true, textBody: 'Only text' }));
        });

        scenario('VAC-030', async () => {
            const user = await accounts.createUser();
            const c = await client(user);
            const values = {
                isEnabled: true,
                fromDate: '2030-06-01T00:00:00Z',
                toDate: '2030-06-30T00:00:00Z',
                subject: 'JMAP subject',
                textBody: 'JMAP text',
                htmlBody: '<p>JMAP html</p>'
            };
            await update(c, values);
            const rest = await restAutoreply(user);
            expect(rest).to.include({ status: true, subject: 'JMAP subject', text: 'JMAP text', html: '<p>JMAP html</p>' });
            expect(new Date(rest.start).getTime()).to.equal(new Date(values.fromDate).getTime());
            expect(new Date(rest.end).getTime()).to.equal(new Date(values.toDate).getTime());
            expect((await api('GET', `/users/${user.id}`)).autoreply).to.be.true;

            await update(c, { isEnabled: false });
            expect((await api('GET', `/users/${user.id}`)).autoreply).to.be.false;
            expect((await restAutoreply(user)).status).to.be.false;
        });

        scenario('VAC-031', async () => {
            const user = await accounts.createUser();
            await api('PUT', `/users/${user.id}/autoreply`, { name: 'Holiday Robot', subject: 'Before' });
            await update(await client(user), { subject: 'After', textBody: 'New text' });
            const rest = await restAutoreply(user);
            expect(rest).to.include({ name: 'Holiday Robot', subject: 'After', text: 'New text' });
        });

        scenario('VAC-032', async () => {
            const { user, c } = await vacationUser();
            const s1 = (await vget(c)).state;
            await api('PUT', `/users/${user.id}/autoreply`, { subject: 'Changed over REST' });
            const second = await vget(c);
            expect(second.list[0].subject).to.equal('Changed over REST');
            const s2 = second.state;
            await api('DELETE', `/users/${user.id}/autoreply`);
            const third = await vget(c);
            const s3 = third.state;
            expect(new Set([s1, s2, s3]).size).to.equal(3);
            expect(third.list).to.deep.equal([DEFAULTS]);
        });

        scenario('VAC-033', async () => {
            const { user, c } = await vacationUser();
            await vget(c);
            for (const types of ['VacationResponse', '*']) {
                const es = await sse.open(`/jmap/eventsource/?types=${types}&closeafter=no&ping=0`, {
                    authorization: jmap.basic(user.username, user.password)
                });
                try {
                    expect(es.status).to.equal(200);
                    await es.until(() => es.comments.some(comment => comment.text.includes('connected')), 5000, 'no connected comment');

                    await update(c, { subject: unique('jmap ') });
                    let event = await es.next();
                    expect(event.json.changed[c.accountId].VacationResponse).to.equal((await vget(c)).state);

                    await api('PUT', `/users/${user.id}/autoreply`, { subject: unique('rest ') });
                    event = await es.next();
                    expect(event.json.changed[c.accountId].VacationResponse).to.equal((await vget(c)).state);
                } finally {
                    es.close();
                }
            }
        });
    });

    describe('automatic replies', () => {
        scenario('VAC-034', async () => {
            const { user } = await vacationUser({ subject: 'Out', textBody: 'Back on Monday.' });
            for (const sender of [external(), (await accounts.createUser()).address]) {
                await deliverTo(user, sender);
                const reply = await replyTo(sender);
                expect(reply.envelope.from).to.equal('');
                expect(reply.envelope.to).to.deep.equal([sender]);
                expect(reply.parsed.to.value.map(entry => entry.address)).to.deep.equal([sender]);
                expect(reply.parsed.from.value[0].address).to.equal(user.address);
                expect(reply.parsed.text.trim()).to.equal('Back on Monday.');
            }
            expect(await messagesIn(user, 'INBOX')).to.have.length(2);
        });

        scenario('VAC-035', async () => {
            // never enabled, with content
            const never = await accounts.createUser();
            await update(await client(never), { subject: 'Stored', textBody: 'Stored text' });
            // enabled, then disabled again
            const { user: disabled, c } = await vacationUser();
            await update(c, { isEnabled: false });

            const first = external();
            const second = external();
            await deliverTo(never, first);
            await deliverTo(disabled, second);
            await noReplies(first, second);
            expect(await messagesIn(never, 'INBOX')).to.have.length(1);
            expect(await messagesIn(disabled, 'INBOX')).to.have.length(1);
        });

        scenario('VAC-036', async () => {
            const { user, c } = await vacationUser();
            const cases = [
                { dates: { fromDate: at(DAY), toDate: null }, reply: false },
                { dates: { fromDate: null, toDate: at(-DAY) }, reply: false },
                { dates: { fromDate: at(-DAY), toDate: at(DAY) }, reply: true },
                { dates: { fromDate: null, toDate: at(DAY) }, reply: true },
                { dates: { fromDate: at(-DAY), toDate: null }, reply: true }
            ];
            for (const entry of cases) {
                const res = await update(c, entry.dates);
                expect(res.updated, JSON.stringify(res.notUpdated)).to.have.property('singleton');
                const sender = external();
                await deliverTo(user, sender);
                if (entry.reply) {
                    await replyTo(sender);
                } else {
                    await noReplies(sender);
                }
            }
        });

        scenario('VAC-037', async () => {
            const interval = 3000;
            await api('POST', '/settings/const:autoreply:interval', { value: interval });
            try {
                const { user } = await vacationUser();
                const a = external();
                const other = external();
                await deliverTo(user, a);
                await deliverTo(user, a);
                await deliverTo(user, other);
                await replyTo(other);
                await clock.delay(QUIET);
                expect(await queuedTo(a)).to.have.length(1);

                await clock.delay(interval + 500);
                await deliverTo(user, a);
                await replyTo(a, 2);
            } finally {
                await api('POST', '/settings/const:autoreply:interval', { value: 4 * 3600 * 1000 });
            }
        });

        scenario('VAC-038', async () => {
            const { user, c } = await vacationUser({ subject: 'First text', textBody: 'First body' });
            const a = external();
            await deliverTo(user, a);
            await replyTo(a);

            const subject = 'Second "text"\r\nX-Injected: yes';
            await update(c, { subject, textBody: 'Second body' });
            await deliverTo(user, a);
            await clock.delay(QUIET);
            expect(await queuedTo(a)).to.have.length(1);

            const fresh = external();
            await deliverTo(user, fresh);
            const reply = await replyTo(fresh);
            expect(reply.parsed.text.trim()).to.equal('Second body');
            expect(reply.parsed.headers.has('x-injected')).to.be.false;
            expect(reply.head).to.not.match(/^X-Injected:/im);
        });

        scenario('VAC-039', async () => {
            const { user } = await vacationUser();
            const automatic = [
                { 'Auto-Submitted': 'auto-generated' },
                { 'Auto-Submitted': 'auto-replied' },
                { Precedence: 'bulk' },
                { Precedence: 'list' },
                { Precedence: 'junk' },
                { 'List-Unsubscribe': '<mailto:unsubscribe@example.net>' },
                { 'X-Auto-Response-Suppress': 'OOF' }
            ];
            const senders = [];
            for (const headers of automatic) {
                const sender = external();
                senders.push(sender);
                await deliverTo(user, sender, { headers });
            }
            const control = external();
            await deliverTo(user, control, { headers: { 'Auto-Submitted': 'no' } });
            await replyTo(control);
            await noReplies(...senders);
            expect(await messagesIn(user, 'INBOX')).to.have.length(automatic.length + 1);
        });

        scenario('VAC-040', async () => {
            const { user } = await vacationUser();
            const senders = ['MAILER-DAEMON@example.com', 'no-reply@example.com', 'noreply@example.com'];
            await deliverTo(user, 'postmaster@example.net', {}, '');
            for (const sender of senders) {
                await deliverTo(user, sender);
            }
            await noReplies(...senders, 'postmaster@example.net');
            expect(await messagesIn(user, 'INBOX')).to.have.length(4);
            const db = await seed.db();
            expect(await db.collection('messages').countDocuments({ user: new seed.ObjectId(user.id), 'outbound.0': { $exists: true } })).to.equal(0);
        });

        scenario('VAC-041', async () => {
            const { user } = await vacationUser();
            const spammer = external();
            await api('POST', `/users/${user.id}/filters`, { name: 'spam', query: { from: spammer }, action: { spam: true } });
            await deliverTo(user, spammer);
            await noReplies(spammer);
            expect(await messagesIn(user, 'Junk')).to.have.length(1);
        });

        scenario('VAC-042', async () => {
            const { user } = await vacationUser();
            const sender = external();
            await deliverTo(user, sender, { to: 'list-members@example.org', cc: 'someone@example.org' });
            await noReplies(sender);
            expect(await messagesIn(user, 'INBOX')).to.have.length(1);

            // the user named in Cc, with a different spelling of the address, is answered
            const named = external();
            const [local, domain] = user.address.split('@');
            await deliverTo(user, named, { to: 'list-members@example.org', cc: `${local.toUpperCase()}+tag@${domain}` });
            await replyTo(named);
        });

        scenario('VAC-043', async () => {
            const { user } = await vacationUser();
            const sender = external();
            const messageId = `<${unique('orig')}@example.net>`;
            await deliverTo(user, sender, { messageId, references: ['<r1@example.net>', '<r2@example.net>'] });
            const reply = await replyTo(sender);
            expect(reply.parsed.headers.get('auto-submitted')).to.equal('auto-replied');
            expect(reply.parsed.inReplyTo).to.equal(messageId);
            expect([].concat(reply.parsed.references)).to.include.members([messageId, '<r1@example.net>', '<r2@example.net>']);
            expect(reply.envelope.from).to.equal('');
        });

        scenario('VAC-044', async () => {
            for (const subject of ['Out of office', 'Nicht im Büro, zurück am Montag ☀']) {
                const { user } = await vacationUser({ subject });
                const sender = external();
                await deliverTo(user, sender, { subject: 'Hello' });
                const reply = await replyTo(sender);
                expect(reply.parsed.subject).to.equal(`Auto: ${subject}`);
                // encoded, the header itself is ASCII
                expect(reply.head).to.match(/^Subject: [\x20-\x7e]+(\r\n[ \t][\x20-\x7e]+)*$/m);
            }
        });

        scenario('VAC-045', async () => {
            const { user } = await vacationUser({ subject: null, textBody: 'Text without a subject' });
            const sender = external();
            await deliverTo(user, sender, { subject: 'Hello' });
            const reply = await replyTo(sender);
            expect(reply.parsed.subject).to.equal('Auto: Re: Hello');
        });

        scenario('VAC-046', async () => {
            const configurations = [
                { patch: { textBody: 'Only text', htmlBody: null }, type: 'text/plain' },
                { patch: { textBody: 'Both text', htmlBody: '<p>Both html</p>' }, type: 'multipart/alternative' },
                { patch: { textBody: null, htmlBody: '<p>Only html</p>' } }
            ];
            for (const { patch, type } of configurations) {
                const { user } = await vacationUser(patch);
                const sender = external();
                await deliverTo(user, sender);
                const { parsed } = await replyTo(sender);
                if (type) {
                    expect(parsed.headers.get('content-type').value).to.equal(type);
                }
                if (patch.textBody) {
                    expect(parsed.text.trim()).to.equal(patch.textBody);
                }
                if (patch.htmlBody) {
                    expect(parsed.html).to.include(patch.htmlBody);
                } else {
                    expect(parsed.html).to.equal(false);
                }
            }
        });

        scenario('VAC-047', async () => {
            const user = await accounts.createUser();
            await update(await client(user), { isEnabled: true });
            const sender = external();
            await deliverTo(user, sender, { subject: 'Hello' });
            const { parsed, raw } = await replyTo(sender);
            expect(parsed.subject).to.equal('Auto: Re: Hello');
            expect(parsed.headers.get('mime-version')).to.equal('1.0');
            expect(parsed.headers.get('content-type').value).to.equal('text/plain');
            expect(raw.toString()).to.match(/\r\n\r\n/);
        });

        scenario('VAC-048', async () => {
            const { user, c } = await vacationUser();
            const mailUsing = [URN.core, URN.mail];
            const { state } = await c.method('Email/get', { ids: [] }, mailUsing);
            const sender = external();
            await deliverTo(user, sender);
            const reply = await replyTo(sender);

            const { ids } = await c.method('Email/query', {}, mailUsing);
            expect(ids).to.have.length(1);
            const changes = await c.method('Email/changes', { sinceState: state }, mailUsing);
            expect(changes.created).to.deep.equal(ids);
            expect(changes.updated).to.deep.equal([]);
            expect(changes.destroyed).to.deep.equal([]);
            expect(await messagesIn(user, '\\Sent')).to.have.length(0);

            const inbox = (await accounts.mailboxes(user)).INBOX;
            const [message] = await messagesIn(user, 'INBOX');
            const details = await api('GET', `/users/${user.id}/mailboxes/${inbox.id}/messages/${message.id}`);
            expect(details.outbound.map(entry => entry.queueId)).to.include(reply.id);
        });
    });
});
