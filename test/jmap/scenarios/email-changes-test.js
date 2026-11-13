/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Catalogue file email-changes.yaml (ECHG), plus WDX-001, WDX-002 and WDX-004 of wildduck.yaml.

const tls = require('tls');
const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');
const { formatState, EXPIRY_MARGIN } = require('../../../lib/jmap/state');
const { journalAnchors } = require('../../../lib/journal-state');
const serverDb = require('../../../lib/db');
const MessageHandler = require('../../../lib/message-handler');

const { ObjectId } = seed;
const EMAIL_ID = /^M[0-9a-f]{24}$/;
const RETENTION_KEY = 'const:journal:time';
const CAP = config.jmap.changes.maxChanges;
const SCAN_LIMIT = (config.jmap.changes && config.jmap.changes.scanLimit) || 10000;
// background tasks (label deletion, restore, clear folder) start a minute after the server
const TASK_WAIT = 90 * 1000;

const emailId = doc => `M${(doc.root || doc._id).toString()}`;
const threadId = doc => `T${doc.thread.toString()}`;

// ---- accounts and JMAP calls

async function account() {
    const user = await accounts.createUser();
    await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
    const client = jmap.forUser(user);
    await client.session();
    const boxes = await accounts.mailboxes(user);
    return { user, client, boxes };
}

async function state(client) {
    return (await client.method('Email/get', { ids: [] })).state;
}

function changes(client, sinceState, extra = {}) {
    return client.method('Email/changes', Object.assign({ sinceState }, extra));
}

/** Runs one call and answers the error type of an error response */
async function errorOf(client, name, args) {
    if (!client.accountId) {
        await client.session();
    }
    const [[responseName, responseArgs]] = await client.call([[name, args, 'c0']]);
    expect(responseName, JSON.stringify(responseArgs)).to.equal('error');
    return responseArgs.type;
}

/** Follows a change chain until hasMoreChanges is false; answers the pages */
async function follow(client, sinceState, maxChanges, method = 'Email/changes', maxPages = 500) {
    const pages = [];
    let since = sinceState;
    for (;;) {
        const page = await client.method(method, maxChanges === undefined ? { sinceState: since } : { sinceState: since, maxChanges });
        pages.push(page);
        expect(page.oldState).to.equal(since);
        if (!page.hasMoreChanges) {
            return pages;
        }
        expect(page.newState, 'an intermediate state makes progress').to.not.equal(since);
        since = page.newState;
        expect(pages.length, 'the chain ends').to.be.below(maxPages);
    }
}

/** Applies pages to a client cache: the net created, updated and destroyed sets */
function accumulate(pages) {
    const net = { created: new Set(), updated: new Set(), destroyed: new Set() };
    for (const page of pages) {
        for (const id of page.created) {
            if (net.destroyed.delete(id)) {
                net.updated.add(id);
            } else {
                net.created.add(id);
            }
        }
        for (const id of page.updated) {
            if (!net.created.has(id)) {
                net.updated.add(id);
            }
        }
        for (const id of page.destroyed) {
            if (!net.created.delete(id)) {
                net.updated.delete(id);
                net.destroyed.add(id);
            }
        }
    }
    return { created: [...net.created].sort(), updated: [...net.updated].sort(), destroyed: [...net.destroyed].sort() };
}

const sorted = list => [...list].sort();
const lists = page => ({ created: sorted(page.created), updated: sorted(page.updated), destroyed: sorted(page.destroyed) });
const allIds = page => [...page.created, ...page.updated, ...page.destroyed];

function expectChanges(page, expected) {
    expect(lists(page)).to.deep.equal({
        created: sorted(expected.created || []),
        updated: sorted(expected.updated || []),
        destroyed: sorted(expected.destroyed || [])
    });
}

function expectEmpty(page) {
    expectChanges(page, {});
}

async function getEmails(client, ids, properties = ['id', 'mailboxIds', 'keywords']) {
    return client.method('Email/get', { ids, properties });
}

async function getEmail(client, id, properties) {
    const res = await getEmails(client, [id], properties);
    expect(res.notFound, `${id} is found`).to.deep.equal([]);
    return res.list[0];
}

// ---- seeding

async function messageDocs(user, filter = {}) {
    const db = await seed.db();
    return db
        .collection('messages')
        .find(Object.assign({ user: new ObjectId(user.id) }, filter))
        .sort({ _id: 1 })
        .toArray();
}

/** Email ids of messages in a mailbox, by uid */
async function idsByUid(user, mailboxId, uids) {
    const docs = await messageDocs(user, { mailbox: new ObjectId(mailboxId), uid: { $in: uids } });
    const byUid = new Map(docs.map(doc => [doc.uid, emailId(doc)]));
    return uids.map(uid => byUid.get(uid));
}

/** Appends messages over IMAP in one session; answers their Email ids in order */
async function appendEmails(ctx, path = 'INBOX', count = 1, flags = [], options = {}) {
    const uids = await seed.withImap(ctx.user, async client => {
        const result = [];
        for (let i = 0; i < count; i++) {
            const raw = await fixtures.buildMessage(options);
            result.push((await client.append(path, raw, flags)).uid);
        }
        return result;
    });
    const boxes = await accounts.mailboxes(ctx.user);
    return idsByUid(ctx.user, boxes[path].id, uids);
}

const appendEmail = async (ctx, path, flags, options) => (await appendEmails(ctx, path, 1, flags, options))[0];

/** Runs fn with an IMAP session that has `path` selected */
function inMailbox(ctx, path, fn) {
    return seed.withImap(ctx.user, async client => {
        await client.mailboxOpen(path);
        return fn(client);
    });
}

/** The uid of an Email in its current mailbox */
async function locate(ctx, id) {
    const docs = await messageDocs(ctx.user, { root: new ObjectId(id.slice(1)) });
    expect(docs.length, `message ${id} exists`).to.be.at.least(1);
    const doc = docs[docs.length - 1];
    return { uid: doc.uid, mailbox: doc.mailbox.toString(), doc };
}

/** Delivers a message over LMTP; answers its Email id */
async function deliverEmail(ctx, options = {}) {
    const messageId = `<${crypto.randomBytes(8).toString('hex')}@scenario.example>`;
    await seed.deliver(ctx.user.address, await fixtures.buildMessage(Object.assign({ messageId }, options)));
    const docs = await clock.waitFor(async () => {
        const found = await messageDocs(ctx.user, { msgid: messageId });
        return found.length && found;
    });
    return emailId(docs[0]);
}

/** Uploads a message through the REST API; answers its Email id */
async function uploadEmail(ctx, mailbox = ctx.boxes.INBOX.id, extra = {}) {
    const res = await api('POST', `/users/${ctx.user.id}/mailboxes/${mailbox}/messages`, Object.assign({ subject: 'uploaded', text: 'Hello' }, extra));
    const docs = await messageDocs(ctx.user, { mailbox: new ObjectId(mailbox), uid: res.message.id });
    return emailId(docs[0]);
}

// ---- journal retention and POP3

async function setRetention(ms) {
    const db = await seed.db();
    await db.collection('settings').updateOne({ key: RETENTION_KEY }, { $set: { key: RETENTION_KEY, value: ms } }, { upsert: true });
}

async function resetRetention() {
    const db = await seed.db();
    await db.collection('settings').deleteOne({ key: RETENTION_KEY });
}

const stateAge = stateString => Date.now() - new ObjectId(stateString.slice(0, 24)).getTimestamp().getTime();

/** A state string of this account for any anchor, made the way the server makes them */
const stateFor = (ctx, anchor) => formatState({ options: { accessSecret: config.api.accessControl.secret }, account: { id: ctx.client.accountId } }, anchor);

/**
 * Runs a POP3 session: login, then `fn(command)` where command(line, multiline) answers the response,
 * then QUIT. Answers once the server closed the connection.
 */
async function pop3(user, fn) {
    const socket = tls.connect({ host: '127.0.0.1', port: config.pop3.port, rejectUnauthorized: false });
    let buffer = '';
    let waiting = null;
    const check = () => {
        if (!waiting) {
            return;
        }
        const end = waiting.multiline ? (buffer.startsWith('-ERR') ? buffer.indexOf('\r\n') : buffer.indexOf('\r\n.\r\n')) : buffer.indexOf('\r\n');
        if (end >= 0) {
            const length = waiting.multiline && !buffer.startsWith('-ERR') ? end + 5 : end + 2;
            const response = buffer.slice(0, length);
            buffer = buffer.slice(length);
            const { resolve } = waiting;
            waiting = null;
            resolve(response);
        }
    };
    socket.on('data', chunk => {
        buffer += chunk.toString('binary');
        check();
    });
    const read = multiline =>
        new Promise(resolve => {
            waiting = { resolve, multiline };
            check();
        });
    const command = async (line, multiline = false) => {
        socket.write(`${line}\r\n`);
        const response = await read(multiline);
        expect(response, line).to.match(/^\+OK/);
        return response;
    };
    const closed = new Promise(resolve => socket.once('close', resolve));
    await new Promise((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
    await read(false);
    await command(`USER ${user.username}`);
    await command(`PASS ${user.password}`);
    await fn(command);
    await command('QUIT');
    await closed;
}

/** POP3 applies DELE and RETR after it answered QUIT: the changes once they are there */
const pop3Applied = (ctx, since) =>
    clock.waitFor(
        async () => {
            const page = await changes(ctx.client, since);
            return allIds(page).length && page;
        },
        { message: 'the POP3 update is applied' }
    );

/** The POP3 message number of a message, from UIDL (which lists message _ids) */
async function pop3Number(command, messageDocId) {
    const listing = await command('UIDL', true);
    const line = listing.split('\r\n').find(row => row.split(' ')[1] === messageDocId);
    expect(line, `message ${messageDocId} is listed`).to.exist;
    return Number(line.split(' ')[0]);
}

/**
 * Waits until ObjectIds made in this process sort after a state. Journal ids from different processes
 * within the same second do not sort by time (the server tolerates that with jmap.changes.safetyWindow,
 * which the single process test server runs at zero); the garbage collector of a real server runs long
 * after the state was read.
 */
async function afterSecondOf(stateString) {
    const second = new ObjectId(stateString.slice(0, 24)).getTimestamp().getTime() / 1000;
    await clock.waitFor(() => Math.floor(Date.now() / 1000) > second, { timeout: 3000 });
}

// ---- the garbage collector's expiry step, run in process for one user

let gcHandler = null;
async function expireMessages(user) {
    if (!gcHandler) {
        await new Promise((resolve, reject) => serverDb.connect(err => (err ? reject(err) : resolve())));
        gcHandler = new MessageHandler({
            users: serverDb.users,
            database: serverDb.database,
            redis: serverDb.redis,
            gridfs: serverDb.gridfs,
            attachments: config.attachments
        });
    }
    // tasks.js archiveExpiredMessages(), limited to the test user
    const expired = await messageDocs(user, { exp: true, rdate: { $lte: Date.now() } });
    for (const messageData of expired) {
        await gcHandler.delAsync({ messageData, archive: !messageData.userDeleted && !messageData.copied });
    }
    return expired.length;
}

async function mailboxTotals(client) {
    const res = await client.method('Mailbox/get', { ids: null, properties: ['id', 'totalEmails', 'role', 'name'] });
    return new Map(res.list.map(mailbox => [mailbox.id, mailbox]));
}

describe('Email/changes and state strings (email-changes.yaml)', function () {
    this.timeout(60000);

    describe('state strings', () => {
        scenario('ECHG-001', async () => {
            const user = await accounts.createUser();
            const res = await jmap.forUser(user).method('Email/get', { ids: [] });
            expect(res.state).to.be.a('string').that.is.not.empty;
            expect(res.list).to.deep.equal([]);
            expect(res.notFound).to.deep.equal([]);
        });

        scenario('ECHG-002', async () => {
            const ctx = await account();
            await appendEmails(ctx, 'INBOX', 3);
            const states = [];
            for (let i = 0; i < 3; i++) {
                const responses = await ctx.client.call([
                    ['Email/get', { accountId: true, ids: [] }, 'g'],
                    ['Email/query', { accountId: true }, 'q'],
                    ['Thread/get', { accountId: true, ids: [] }, 't']
                ]);
                states.push(responses[0][1].state);
                if (i === 0) {
                    const responsesWithChanges = await ctx.client.call([['Email/changes', { accountId: true, sinceState: states[0] }, 'c']]);
                    expect(responsesWithChanges[0][0]).to.equal('Email/changes');
                }
            }
            expect(new Set(states).size).to.equal(1);
        });

        scenario('ECHG-003', async () => {
            const ctx = await account();
            await appendEmails(ctx, 'INBOX', 2);
            const responses = await ctx.client.call([
                ['Email/get', { accountId: true, ids: [] }, 'e'],
                ['Thread/get', { accountId: true, ids: [] }, 't'],
                ['Mailbox/get', { accountId: true, ids: null }, 'm']
            ]);
            const states = responses.map(([, args]) => args.state);
            expect(states[0]).to.be.a('string');
            expect(states).to.deep.equal([states[0], states[0], states[0]]);
        });

        scenario('ECHG-004', async () => {
            const ctx = await account();
            await appendEmails(ctx, 'INBOX', 2);
            const s0 = await state(ctx.client);
            const res = await changes(ctx.client, s0);
            expect(res.oldState).to.equal(s0);
            expect(res.newState).to.equal(s0);
            expect(res.hasMoreChanges).to.be.false;
            expectEmpty(res);
        });

        scenario('ECHG-005', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            await appendEmail(ctx);
            const res = await changes(ctx.client, s0);
            expect(Object.keys(res).sort()).to.deep.equal(['accountId', 'created', 'destroyed', 'hasMoreChanges', 'newState', 'oldState', 'updated']);
            expect(res.accountId).to.equal(ctx.client.accountId);
            expect(res.oldState).to.equal(s0);
            expect(res.newState).to.be.a('string');
            expect(res.hasMoreChanges).to.be.a('boolean');
            for (const list of ['created', 'updated', 'destroyed']) {
                expect(res[list]).to.be.an('array');
                for (const id of res[list]) {
                    expect(id).to.match(EMAIL_ID);
                }
            }
            expect(res.created).to.have.lengthOf(1);
        });

        scenario('ECHG-006', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            await appendEmail(ctx);
            const [[, got], [, res]] = await ctx.client.call([
                ['Email/get', { accountId: true, ids: [] }, 'g'],
                ['Email/changes', { accountId: true, sinceState: s0 }, 'c']
            ]);
            expect(got.state).to.not.equal(s0);
            expect(res.oldState).to.equal(s0);
            expect(res.newState).to.equal(got.state);
        });

        scenario('ECHG-007', async () => {
            const ctx = await account();
            const [first, second] = await appendEmails(ctx, 'INBOX', 2);
            const s0 = await state(ctx.client);
            await appendEmails(ctx, 'INBOX', 2);
            await inMailbox(ctx, 'INBOX', async client => {
                await client.messageFlagsAdd({ uid: (await locate(ctx, first)).uid }, ['\\Flagged'], { uid: true });
                await client.messageDelete({ uid: (await locate(ctx, second)).uid }, { uid: true });
            });
            const [[, res], [, got]] = await ctx.client.call([
                ['Email/changes', { accountId: true, sinceState: s0 }, 'c'],
                ['Email/get', { accountId: true, ids: [] }, 'g']
            ]);
            expect(res.hasMoreChanges).to.be.false;
            expect(res.newState).to.equal(got.state);
        });

        scenario('ECHG-008', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            await appendEmail(ctx);
            const first = await changes(ctx.client, s0);
            const s1 = first.newState;
            const res = await changes(ctx.client, s1);
            expectEmpty(res);
            expect(res.hasMoreChanges).to.be.false;
            expect(res.newState).to.equal(s1);
        });

        scenario('ECHG-009', async () => {
            const ctx = await account();
            const db = await seed.db();
            const user = new ObjectId(ctx.user.id);
            // as if the user existed before JMAP: no anchor document and no journal entries
            await db.collection('journal').deleteMany({ user });
            await db.collection('jmap.state').deleteOne({ _id: user });
            const client = jmap.forUser(ctx.user);
            const first = await state(client);
            const second = await state(client);
            expect(first).to.be.a('string').that.is.not.empty;
            expect(second).to.equal(first);
            const res = await changes(client, first);
            expectEmpty(res);
            expect(res.newState).to.equal(first);
        });

        scenario('ECHG-010', async () => {
            const ctx = await account();
            await appendEmails(ctx, 'INBOX', 2);
            const s0 = await state(ctx.client);
            const db = await seed.db();
            await db.collection('journal').deleteMany({ user: new ObjectId(ctx.user.id) });
            expect(await state(ctx.client)).to.equal(s0);
        });

        scenario('ECHG-011', async () => {
            const ctx = await account();
            await appendEmails(ctx, 'INBOX', 2);
            const s0 = await state(ctx.client);
            const db = await seed.db();
            await db.collection('journal').deleteMany({ user: new ObjectId(ctx.user.id) });
            // S0 is older than the retention minus the safety margin, but younger than the retention
            await setRetention(stateAge(s0) + EXPIRY_MARGIN / 2);
            try {
                const res = await changes(ctx.client, s0);
                expectEmpty(res);
                expect(res.newState).to.equal(s0);
                expect(res.hasMoreChanges).to.be.false;
            } finally {
                await resetRetention();
            }
        });

        scenario('ECHG-012', async () => {
            const ctx = await account();
            await appendEmails(ctx, 'INBOX', 2);
            const s0 = await state(ctx.client);
            // a fresh process: the state computed from the database and the configuration alone
            const db = await seed.db();
            const anchors = await journalAnchors(db, new ObjectId(ctx.user.id));
            expect(stateFor(ctx, anchors.journal)).to.equal(s0);
            const client = jmap.forUser(ctx.user);
            expect(await state(client)).to.equal(s0);
            expectEmpty(await changes(client, s0));
        });

        scenario('ECHG-013', async () => {
            const a = await account();
            const b = await account();
            const s0 = await state(a.client);
            await deliverEmail(b);
            expect(await state(a.client)).to.equal(s0);
        });

        scenario('ECHG-014', async () => {
            const ctx = await account();
            await appendEmail(ctx);
            const s0 = await state(ctx.client);
            const password = `${ctx.user.password}-changed`;
            await api('PUT', `/users/${ctx.user.id}`, { name: 'Renamed User', quota: 2 * 1024 * 1024 * 1024, password });
            await accounts.createAsp(ctx.user);
            const client = jmap.forUser(Object.assign({}, ctx.user, { password }));
            expect(await state(client)).to.equal(s0);
        });

        scenario('ECHG-015', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: 'Empty one' });
            const [[, res], [, mailboxes]] = await ctx.client.call([
                ['Email/changes', { accountId: true, sinceState: s0 }, 'c'],
                ['Mailbox/get', { accountId: true, ids: null }, 'm']
            ]);
            expect(res.newState).to.not.equal(s0);
            expect(res.newState).to.equal(mailboxes.state);
            expect(res.hasMoreChanges).to.be.false;
            expectEmpty(res);
        });

        scenario('ECHG-016', async () => {
            const ctx = await account();
            const existing = await appendEmail(ctx);
            const s0 = await state(ctx.client);
            await appendEmail(ctx);
            await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: (await locate(ctx, existing)).uid }, ['\\Flagged'], { uid: true }));
            const responses = await ctx.client.call([
                ['Email/changes', { accountId: true, sinceState: s0 }, 'e'],
                ['Thread/changes', { accountId: true, sinceState: s0 }, 't'],
                ['Mailbox/changes', { accountId: true, sinceState: s0 }, 'm']
            ]);
            expect(responses.map(([name]) => name)).to.deep.equal(['Email/changes', 'Thread/changes', 'Mailbox/changes']);
            const newState = responses[0][1].newState;
            for (const [, res] of responses) {
                expect(res.oldState).to.equal(s0);
                expect(res.newState).to.equal(newState);
                expect(res.hasMoreChanges).to.be.false;
            }
        });

        scenario('ECHG-017', async () => {
            const ctx = await account();
            const st = (await ctx.client.method('Thread/get', { ids: [] })).state;
            const sm = (await ctx.client.method('Mailbox/get', { ids: null })).state;
            const id = await appendEmail(ctx);
            expect((await changes(ctx.client, st)).created).to.deep.equal([id]);
            expect((await changes(ctx.client, sm)).created).to.deep.equal([id]);
        });
    });

    describe('Emails created', () => {
        scenario('ECHG-018', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await deliverEmail(ctx);
            expectChanges(await changes(ctx.client, s0), { created: [id] });
            const email = await getEmail(ctx.client, id);
            expect(email.mailboxIds).to.deep.equal({ [`F${ctx.boxes.INBOX.id}`]: true });
        });

        scenario('ECHG-019', async () => {
            // LMTP and the Haraka plugin both store through FilterHandler.storeMessage
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await deliverEmail(ctx);
            expectChanges(await changes(ctx.client, s0), { created: [id] });
        });

        scenario('ECHG-020', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await appendEmail(ctx, 'Archive');
            expectChanges(await changes(ctx.client, s0), { created: [id] });
            expect((await getEmail(ctx.client, id)).mailboxIds).to.deep.equal({ [`F${ctx.boxes.Archive.id}`]: true });
        });

        scenario('ECHG-021', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await uploadEmail(ctx);
            expectChanges(await changes(ctx.client, s0), { created: [id] });
        });

        scenario('ECHG-022', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            await api('POST', `/users/${ctx.user.id}/submit`, {
                to: [{ address: 'recipient@example.net' }],
                subject: 'submitted',
                text: 'Hello',
                sendTime: new Date(Date.now() + 3600 * 1000).toISOString()
            });
            const [copy] = await messageDocs(ctx.user, { mailbox: new ObjectId(ctx.boxes['\\Sent'].id) });
            expect(copy, 'the sent copy is stored').to.exist;
            expect((await changes(ctx.client, s0)).created).to.include(emailId(copy));
        });

        scenario('ECHG-024', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const ids = [...(await appendEmails(ctx, 'INBOX', 3)), ...(await appendEmails(ctx, 'Archive', 2))];
            for (let i = 0; i < 3; i++) {
                ids.push(await deliverEmail(ctx));
            }
            expect(new Set(ids).size).to.equal(8);
            expectChanges(await changes(ctx.client, s0), { created: ids });
        });

        scenario('ECHG-025', async () => {
            const ctx = await account();
            const existing = await appendEmail(ctx);
            const s0 = await state(ctx.client);
            const added = await appendEmails(ctx, 'INBOX', 2);
            await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: (await locate(ctx, existing)).uid }, ['\\Flagged'], { uid: true }));
            const responses = await ctx.client.call([
                ['Email/changes', { accountId: true, sinceState: s0 }, 'c1'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 'c1', name: 'Email/changes', path: '/created' }, properties: ['id'] }, 'c2'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 'c1', name: 'Email/changes', path: '/updated' }, properties: ['id'] }, 'c3']
            ]);
            expect(responses[1][1].list.map(email => email.id).sort()).to.deep.equal(sorted(added));
            expect(responses[1][1].notFound).to.deep.equal([]);
            expect(responses[2][1].list.map(email => email.id)).to.deep.equal([existing]);
            expect(responses[2][1].notFound).to.deep.equal([]);
        });

        scenario('ECHG-026', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await appendEmail(ctx, 'INBOX', ['\\Deleted']);
            expect(allIds(await changes(ctx.client, s0))).to.not.include(id);
        });
    });

    describe('Emails updated', () => {
        // a fresh account with one message in INBOX
        async function withEmail(flags = []) {
            const ctx = await account();
            ctx.id = await appendEmail(ctx, 'INBOX', flags);
            return ctx;
        }

        const flagOp = (ctx, op, flags, path = 'INBOX') =>
            inMailbox(ctx, path, async client => client[op]({ uid: (await locate(ctx, ctx.id)).uid }, flags, { uid: true }));

        scenario('ECHG-027', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await flagOp(ctx, 'messageFlagsAdd', ['\\Seen']);
            expectChanges(await changes(ctx.client, s0), { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id, ['keywords'])).keywords).to.have.property('$seen', true);
        });

        scenario('ECHG-028', async () => {
            const ctx = await withEmail();
            const flags = [
                ['\\Flagged', '$flagged'],
                ['\\Answered', '$answered'],
                ['\\Draft', '$draft'],
                ['$Forwarded', '$forwarded'],
                ['$MDNSent', '$mdnsent'],
                ['project_x', 'project_x']
            ];
            for (const [flag, keyword] of flags) {
                const s0 = await state(ctx.client);
                await flagOp(ctx, 'messageFlagsAdd', [flag]);
                expectChanges(await changes(ctx.client, s0), { updated: [ctx.id] });
                expect((await getEmail(ctx.client, ctx.id, ['keywords'])).keywords, flag).to.have.property(keyword, true);
            }
        });

        scenario('ECHG-029', async () => {
            const ctx = await withEmail(['\\Seen', '\\Flagged']);
            const s0 = await state(ctx.client);
            await flagOp(ctx, 'messageFlagsRemove', ['\\Flagged']);
            expectChanges(await changes(ctx.client, s0), { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id, ['keywords'])).keywords).to.not.have.property('$flagged');
        });

        scenario('ECHG-030', async () => {
            const ctx = await withEmail(['\\Seen']);
            const s0 = await state(ctx.client);
            await flagOp(ctx, 'messageFlagsSet', ['\\Flagged', '\\Answered']);
            const res = await changes(ctx.client, s0);
            expectChanges(res, { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id, ['keywords'])).keywords).to.deep.equal({ $flagged: true, $answered: true });
        });

        scenario('ECHG-031', async () => {
            const ctx = await withEmail(['\\Seen']);
            const s0 = await state(ctx.client);
            await flagOp(ctx, 'messageFlagsAdd', ['\\Seen']);
            const [[, got], [, res]] = await ctx.client.call([
                ['Email/get', { accountId: true, ids: [] }, 'g'],
                ['Email/changes', { accountId: true, sinceState: s0 }, 'c']
            ]);
            expect(got.state).to.equal(s0);
            expectEmpty(res);
        });

        scenario('ECHG-032', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            const { uid } = await locate(ctx, ctx.id);
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${uid}`, { seen: true, flagged: true });
            expectChanges(await changes(ctx.client, s0), { updated: [ctx.id] });
        });

        scenario('ECHG-034', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => client.messageMove({ uid: (await locate(ctx, ctx.id)).uid }, 'Archive', { uid: true }));
            expectChanges(await changes(ctx.client, s0), { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id)).mailboxIds).to.deep.equal({ [`F${ctx.boxes.Archive.id}`]: true });
        });

        scenario('ECHG-035', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            const { uid } = await locate(ctx, ctx.id);
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${uid}`, { moveTo: ctx.boxes.Archive.id });
            expectChanges(await changes(ctx.client, s0), { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id)).mailboxIds).to.deep.equal({ [`F${ctx.boxes.Archive.id}`]: true });
        });

        scenario('ECHG-037', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            const { doc } = await locate(ctx, ctx.id);
            await pop3(ctx.user, async command => command(`DELE ${await pop3Number(command, doc._id.toString())}`));
            expectChanges(await pop3Applied(ctx, s0), { updated: [ctx.id] });
            const email = await getEmail(ctx.client, ctx.id);
            expect(email.mailboxIds).to.deep.equal({ [`F${ctx.boxes['\\Trash'].id}`]: true });
            expect(email.keywords).to.have.property('$seen', true);
        });

        scenario('ECHG-038', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            const { doc } = await locate(ctx, ctx.id);
            await pop3(ctx.user, async command => command(`RETR ${await pop3Number(command, doc._id.toString())}`, true));
            expectChanges(await pop3Applied(ctx, s0), { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id)).keywords).to.have.property('$seen', true);
        });

        scenario('ECHG-039', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => client.messageCopy({ uid: (await locate(ctx, ctx.id)).uid }, 'Archive', { uid: true }));
            const res = await changes(ctx.client, s0);
            expect(res.created).to.have.lengthOf(1);
            const [copyId] = res.created;
            expect(copyId).to.not.equal(ctx.id);
            expect(res.updated).to.not.include(ctx.id);
            expect(res.destroyed).to.not.include(ctx.id);
            const { list } = await getEmails(ctx.client, [ctx.id, copyId], ['id', 'mailboxIds', 'blobId', 'size', 'receivedAt']);
            const original = list.find(email => email.id === ctx.id);
            const copy = list.find(email => email.id === copyId);
            expect(copy.mailboxIds).to.deep.equal({ [`F${ctx.boxes.Archive.id}`]: true });
            expect(copy.size).to.equal(original.size);
            expect(copy.receivedAt).to.equal(original.receivedAt);
            const session = await ctx.client.session();
            const download = async blobId =>
                (
                    await ctx.client.raw(
                        session.downloadUrl
                            .replace('{accountId}', ctx.client.accountId)
                            .replace('{blobId}', blobId)
                            .replace('{type}', encodeURIComponent('message/rfc822'))
                            .replace('{name}', 'message.eml')
                    )
                ).body;
            expect((await download(copy.blobId)).equals(await download(original.blobId))).to.be.true;
        });

        scenario('ECHG-040', async () => {
            const ctx = await withEmail();
            const label = await api('POST', `/users/${ctx.user.id}/labels`, { name: 'Project L' });
            const keyword = `$wdlabel$${label.id}`;
            const { uid } = await locate(ctx, ctx.id);
            const s0 = await state(ctx.client);
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${uid}`, { addLabels: ['Project L'] });
            const first = await changes(ctx.client, s0);
            expectChanges(first, { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id, ['keywords'])).keywords).to.have.property(keyword, true);
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${uid}`, { removeLabels: ['Project L'] });
            expectChanges(await changes(ctx.client, first.newState), { updated: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id, ['keywords'])).keywords).to.not.have.property(keyword);
        });

        scenario('ECHG-041', async function () {
            this.timeout(TASK_WAIT + 30000);
            const ctx = await account();
            const ids = await appendEmails(ctx, 'INBOX', 3);
            const label = await api('POST', `/users/${ctx.user.id}/labels`, { name: 'Doomed' });
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/1:*`, { addLabels: ['Doomed'] }).catch(async () => {
                for (const id of ids) {
                    await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${(await locate(ctx, id)).uid}`, {
                        addLabels: ['Doomed']
                    });
                }
            });
            const s0 = await state(ctx.client);
            await api('DELETE', `/users/${ctx.user.id}/labels/${label.id}`);
            const res = await clock.waitFor(
                async () => {
                    const page = await changes(ctx.client, s0);
                    return ids.every(id => page.updated.includes(id)) && page;
                },
                { timeout: TASK_WAIT, message: 'label deletion reports the Emails' }
            );
            expect(res.updated).to.include.members(ids);
            for (const email of (await getEmails(ctx.client, ids, ['keywords'])).list) {
                expect(email.keywords).to.not.have.property(`$wdlabel$${label.id}`);
            }
        });

        scenario('ECHG-042', async () => {
            const ctx = await account();
            const ids = await appendEmails(ctx, 'INBOX', 50);
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', client => client.messageFlagsAdd('1:*', ['\\Seen']));
            const res = await changes(ctx.client, s0);
            expect(res.updated).to.have.lengthOf(50);
            expectChanges(res, { updated: ids });
        });

        scenario('ECHG-043', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => {
                const { uid } = await locate(ctx, ctx.id);
                await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true });
                await client.messageFlagsRemove({ uid }, ['\\Flagged'], { uid: true });
                await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
                await client.messageMove({ uid }, 'Archive', { uid: true });
            });
            expectChanges(await changes(ctx.client, s0), { updated: [ctx.id] });
        });

        scenario('ECHG-044', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => client.messageMove({ uid: (await locate(ctx, ctx.id)).uid }, 'Archive', { uid: true }));
            await inMailbox(ctx, 'Archive', async client => client.messageMove({ uid: (await locate(ctx, ctx.id)).uid }, 'INBOX', { uid: true }));
            const res = await changes(ctx.client, s0);
            expect(res.updated).to.include(ctx.id);
            expect(res.created).to.not.include(ctx.id);
            expect(res.destroyed).to.not.include(ctx.id);
            expect((await getEmail(ctx.client, ctx.id)).mailboxIds).to.deep.equal({ [`F${ctx.boxes.INBOX.id}`]: true });
        });

        scenario('ECHG-045', async () => {
            const ctx = await account();
            await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: 'Work' });
            const ids = await appendEmails(ctx, 'Work', 3);
            const before = (await getEmails(ctx.client, ids)).list.map(email => email.mailboxIds);
            const s0 = await state(ctx.client);
            await seed.withImap(ctx.user, client => client.mailboxRename('Work', 'Projects'));
            const res = await changes(ctx.client, s0);
            expectEmpty(res);
            expect(res.newState).to.not.equal(s0);
            expect((await getEmails(ctx.client, ids)).list.map(email => email.mailboxIds)).to.deep.equal(before);
        });
    });

    describe('Emails destroyed', () => {
        async function withEmail(flags = []) {
            const ctx = await account();
            ctx.id = await appendEmail(ctx, 'INBOX', flags);
            return ctx;
        }

        const onEmail = (ctx, fn, path = 'INBOX') => inMailbox(ctx, path, async client => fn(client, (await locate(ctx, ctx.id)).uid));

        scenario('ECHG-046', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await onEmail(ctx, (client, uid) => client.messageDelete({ uid }, { uid: true }));
            expectChanges(await changes(ctx.client, s0), { destroyed: [ctx.id] });
            expect((await getEmails(ctx.client, [ctx.id])).notFound).to.deep.equal([ctx.id]);
        });

        scenario('ECHG-047', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await onEmail(ctx, (client, uid) => client.messageFlagsAdd({ uid }, ['\\Deleted'], { uid: true }));
            expectChanges(await changes(ctx.client, s0), { destroyed: [ctx.id] });
            expect((await getEmails(ctx.client, [ctx.id])).notFound).to.deep.equal([ctx.id]);
        });

        scenario('ECHG-048', async () => {
            const ctx = await withEmail();
            await onEmail(ctx, (client, uid) => client.messageFlagsAdd({ uid }, ['\\Deleted'], { uid: true }));
            const s0 = await state(ctx.client);
            await onEmail(ctx, (client, uid) => client.messageFlagsRemove({ uid }, ['\\Deleted'], { uid: true }));
            expectChanges(await changes(ctx.client, s0), { created: [ctx.id] });
            await getEmail(ctx.client, ctx.id);
        });

        scenario('ECHG-049', async () => {
            const ctx = await withEmail();
            const start = await state(ctx.client);
            await onEmail(ctx, (client, uid) => client.messageFlagsAdd({ uid }, ['\\Deleted'], { uid: true }));
            const seen = await changes(ctx.client, start);
            expect(seen.destroyed).to.deep.equal([ctx.id]);
            const s0 = seen.newState;
            await onEmail(ctx, (client, uid) => client.messageDelete({ uid }, { uid: true }));
            const res = await changes(ctx.client, s0);
            expect(res.created).to.not.include(ctx.id);
            expect(res.updated).to.not.include(ctx.id);
        });

        scenario('ECHG-050', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await onEmail(ctx, async (client, uid) => {
                await client.messageFlagsAdd({ uid }, ['\\Deleted'], { uid: true });
                await client.messageFlagsRemove({ uid }, ['\\Deleted'], { uid: true });
            });
            const res = await changes(ctx.client, s0);
            expect(res.destroyed).to.not.include(ctx.id);
            expect(res.created).to.not.include(ctx.id);
            await getEmail(ctx.client, ctx.id);
        });

        scenario('ECHG-051', async () => {
            const ctx = await withEmail(['\\Deleted']);
            const s0 = await state(ctx.client);
            await onEmail(ctx, async (client, uid) => {
                await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true });
                await client.messageMove({ uid }, 'Archive', { uid: true });
            });
            const res = await changes(ctx.client, s0);
            expect(res.created).to.not.include(ctx.id);
            expect(res.updated).to.not.include(ctx.id);
        });

        scenario('ECHG-052', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await api('DELETE', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${(await locate(ctx, ctx.id)).uid}`);
            expectChanges(await changes(ctx.client, s0), { destroyed: [ctx.id] });
            expect((await getEmails(ctx.client, [ctx.id])).notFound).to.deep.equal([ctx.id]);
        });

        scenario('ECHG-053', async () => {
            const ctx = await withEmail();
            await api('DELETE', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${(await locate(ctx, ctx.id)).uid}`);
            const archived = await api('GET', `/users/${ctx.user.id}/archived/messages`);
            expect(archived.results).to.have.lengthOf(1);
            const s0 = await state(ctx.client);
            const restored = await api('POST', `/users/${ctx.user.id}/archived/messages/${archived.results[0].id}/restore`, {});
            const res = await changes(ctx.client, s0);
            // the archive keeps the root, so the restored Email has its old id
            expectChanges(res, { created: [ctx.id] });
            expect((await getEmail(ctx.client, ctx.id)).mailboxIds).to.deep.equal({ [`F${restored.mailbox}`]: true });
        });

        scenario('ECHG-054', async function () {
            this.timeout(TASK_WAIT + 30000);
            const ctx = await account();
            const ids = await appendEmails(ctx, 'INBOX', 5);
            const start = new Date(Date.now() - 60 * 1000).toISOString();
            for (const id of ids) {
                await api('DELETE', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${(await locate(ctx, id)).uid}`);
            }
            const s0 = await state(ctx.client);
            await api('POST', `/users/${ctx.user.id}/archived/restore`, { start, end: new Date(Date.now() + 60 * 1000).toISOString() });
            const res = await clock.waitFor(
                async () => {
                    const page = await changes(ctx.client, s0);
                    return page.created.length >= 5 && page;
                },
                { timeout: TASK_WAIT, message: 'the restore task restores five messages' }
            );
            expect(res.created).to.have.lengthOf(5);
            expectChanges(res, { created: ids });
        });

        scenario('ECHG-056', async () => {
            const ctx = await account();
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.Archive.id}`, { retention: 24 * 3600 * 1000 });
            const ids = await appendEmails(ctx, 'Archive', 2);
            const db = await seed.db();
            await db.collection('messages').updateMany({ mailbox: new ObjectId(ctx.boxes.Archive.id) }, { $set: { exp: true, rdate: Date.now() - 1000 } });
            const before = await mailboxTotals(ctx.client);
            expect(before.get(`F${ctx.boxes.Archive.id}`).totalEmails).to.equal(2);
            const s0 = await state(ctx.client);
            await afterSecondOf(s0);
            expect(await expireMessages(ctx.user)).to.equal(2);
            expectChanges(await changes(ctx.client, s0), { destroyed: ids });
            expect((await mailboxTotals(ctx.client)).get(`F${ctx.boxes.Archive.id}`).totalEmails).to.equal(0);
        });

        scenario('ECHG-057', async () => {
            const ctx = await account();
            await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: 'Temp' });
            const ids = await appendEmails(ctx, 'Temp', 4);
            const s0 = await state(ctx.client);
            await seed.withImap(ctx.user, client => client.mailboxDelete('Temp'));
            expectChanges(await changes(ctx.client, s0), { destroyed: ids });
            expect(sorted((await getEmails(ctx.client, ids)).notFound)).to.deep.equal(sorted(ids));
        });

        scenario('ECHG-058', async () => {
            const ctx = await account();
            const created = await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: 'Short lived' });
            const ids = await appendEmails(ctx, 'Short lived', 3);
            const s0 = await state(ctx.client);
            await api('DELETE', `/users/${ctx.user.id}/mailboxes/${created.id}`);
            const [[, emails], [, mailboxes]] = await ctx.client.call([
                ['Email/changes', { accountId: true, sinceState: s0 }, 'e'],
                ['Mailbox/changes', { accountId: true, sinceState: s0 }, 'm']
            ]);
            expect(sorted(emails.destroyed)).to.deep.equal(sorted(ids));
            expect(mailboxes.destroyed).to.include(`F${created.id}`);
            expect(emails.newState).to.equal(mailboxes.newState);
        });

        scenario('ECHG-060', async function () {
            this.timeout(TASK_WAIT + 30000);
            const ctx = await account();
            const ids = await appendEmails(ctx, 'Trash', 30);
            const s0 = await state(ctx.client);
            await api('DELETE', `/users/${ctx.user.id}/mailboxes/${ctx.boxes['\\Trash'].id}/messages?async=true`);
            const res = await clock.waitFor(
                async () => {
                    const page = await changes(ctx.client, s0);
                    return page.destroyed.length >= 30 && page;
                },
                { timeout: TASK_WAIT, message: 'the clear-folder task removes 30 messages' }
            );
            expect(res.destroyed).to.have.lengthOf(30);
            expectChanges(res, { destroyed: ids });
        });

        scenario('ECHG-061', async () => {
            const ctx = await account();
            const d1 = await appendEmail(ctx, 'Drafts', ['\\Draft']);
            const s0 = await state(ctx.client);
            const d2 = await appendEmail(ctx, 'Drafts', ['\\Draft']);
            await inMailbox(ctx, 'Drafts', async client => client.messageDelete({ uid: (await locate(ctx, d1)).uid }, { uid: true }));
            expectChanges(await changes(ctx.client, s0), { created: [d2], destroyed: [d1] });
        });

        scenario('ECHG-062', async () => {
            const ctx = await withEmail();
            const s0 = await state(ctx.client);
            await onEmail(ctx, async (client, uid) => {
                await client.messageCopy({ uid }, 'Archive', { uid: true });
                await client.messageDelete({ uid }, { uid: true });
            });
            const res = await changes(ctx.client, s0);
            expect(res.created).to.have.lengthOf(1);
            expect(res.created[0]).to.not.equal(ctx.id);
            expectChanges(res, { created: res.created, destroyed: [ctx.id] });
        });

        scenario('ECHG-063', async () => {
            const ctx = await account();
            const hidden = await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: 'Secret' });
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${hidden.id}`, { hidden: true });
            const s0 = await state(ctx.client);
            const id = await uploadEmail(ctx, hidden.id);
            const { uid } = await locate(ctx, id);
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${hidden.id}/messages/${uid}`, { flagged: true });
            await seed
                .withImap(ctx.user, async client => {
                    await client.mailboxOpen('Secret');
                    await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
                })
                .catch(() => false);
            expect(allIds(await changes(ctx.client, s0))).to.not.include(id);
        });
    });

    describe('delivery filters', () => {
        const SENDER = 'filtered-sender@example.net';
        async function withFilter(action) {
            const ctx = await account();
            await api('POST', `/users/${ctx.user.id}/filters`, { name: 'scenario', query: { from: SENDER }, action: action(ctx) });
            return ctx;
        }
        const deliverMatching = async ctx => {
            const messageId = `<${crypto.randomBytes(8).toString('hex')}@scenario.example>`;
            await seed.deliver(ctx.user.address, await fixtures.buildMessage({ from: SENDER, messageId }), SENDER);
            return messageId;
        };
        const storedId = async (ctx, messageId) =>
            emailId(
                (
                    await clock.waitFor(async () => {
                        const docs = await messageDocs(ctx.user, { msgid: messageId });
                        return docs.length && docs;
                    })
                )[0]
            );

        scenario('ECHG-064', async () => {
            const ctx = await withFilter(c => ({ mailbox: c.boxes.Archive.id }));
            const s0 = await state(ctx.client);
            const id = await storedId(ctx, await deliverMatching(ctx));
            expectChanges(await changes(ctx.client, s0), { created: [id] });
            expect((await getEmail(ctx.client, id)).mailboxIds).to.deep.equal({ [`F${ctx.boxes.Archive.id}`]: true });
        });

        scenario('ECHG-065', async () => {
            const ctx = await withFilter(() => ({ seen: true, flag: true }));
            const s0 = await state(ctx.client);
            const id = await storedId(ctx, await deliverMatching(ctx));
            expectChanges(await changes(ctx.client, s0), { created: [id] });
            const { keywords } = await getEmail(ctx.client, id);
            expect(keywords).to.include({ $seen: true, $flagged: true });
        });

        scenario('ECHG-066', async () => {
            const ctx = await withFilter(() => ({ delete: true }));
            const s0 = await state(ctx.client);
            await deliverMatching(ctx);
            const [[, got], [, res]] = await ctx.client.call([
                ['Email/get', { accountId: true, ids: [] }, 'g'],
                ['Email/changes', { accountId: true, sinceState: s0 }, 'c']
            ]);
            expect(got.state).to.equal(s0);
            expectEmpty(res);
        });

        scenario('ECHG-067', async () => {
            const ctx = await withFilter(() => ({ spam: true }));
            const s0 = await state(ctx.client);
            const id = await storedId(ctx, await deliverMatching(ctx));
            expectChanges(await changes(ctx.client, s0), { created: [id] });
            const junk = [...(await mailboxTotals(ctx.client)).values()].find(mailbox => mailbox.role === 'junk');
            expect((await getEmail(ctx.client, id)).mailboxIds).to.deep.equal({ [junk.id]: true });
        });

        scenario('ECHG-068', async () => {
            const ctx = await withFilter(() => ({ targets: ['forward-target@example.org'] }));
            const s0 = await state(ctx.client);
            const id = await storedId(ctx, await deliverMatching(ctx));
            expectChanges(await changes(ctx.client, s0), { created: [id] });
        });
    });

    describe('coalescing', () => {
        scenario('ECHG-069', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await appendEmail(ctx);
            await inMailbox(ctx, 'INBOX', async client => client.messageDelete({ uid: (await locate(ctx, id)).uid }, { uid: true }));
            const res = await changes(ctx.client, s0);
            expect(allIds(res)).to.not.include(id);
            expect(res.newState).to.not.equal(s0);
        });

        scenario('ECHG-070', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await appendEmail(ctx);
            await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: (await locate(ctx, id)).uid }, ['\\Flagged'], { uid: true }));
            const res = await changes(ctx.client, s0);
            expect(res.created).to.deep.equal([id]);
            expect(res.updated).to.not.include(id);
        });

        scenario('ECHG-071', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const id = await deliverEmail(ctx);
            await inMailbox(ctx, 'INBOX', async client => client.messageMove({ uid: (await locate(ctx, id)).uid }, 'Archive', { uid: true }));
            expectChanges(await changes(ctx.client, s0), { created: [id] });
            expect((await getEmail(ctx.client, id)).mailboxIds).to.deep.equal({ [`F${ctx.boxes.Archive.id}`]: true });
        });

        scenario('ECHG-072', async () => {
            const ctx = await account();
            const id = await appendEmail(ctx);
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => {
                const { uid } = await locate(ctx, id);
                await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true });
                await client.messageMove({ uid }, 'Archive', { uid: true });
            });
            await inMailbox(ctx, 'Archive', async client => client.messageDelete({ uid: (await locate(ctx, id)).uid }, { uid: true }));
            expectChanges(await changes(ctx.client, s0), { destroyed: [id] });
        });

        scenario('ECHG-073', async () => {
            const ctx = await account();
            const old = await appendEmails(ctx, 'INBOX', 5);
            await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: (await locate(ctx, old[4])).uid }, ['\\Deleted'], { uid: true }));
            const s0 = await state(ctx.client);
            const fresh = await appendEmails(ctx, 'INBOX', 5);
            await inMailbox(ctx, 'INBOX', async client => {
                const uid = async id => (await locate(ctx, id)).uid;
                await client.messageFlagsAdd({ uid: await uid(old[0]) }, ['\\Seen'], { uid: true });
                await client.messageFlagsAdd({ uid: await uid(old[0]) }, ['\\Flagged'], { uid: true });
                await client.messageMove({ uid: await uid(old[1]) }, 'Archive', { uid: true });
                await client.messageCopy({ uid: await uid(old[2]) }, 'Archive', { uid: true });
                await client.messageDelete({ uid: await uid(old[3]) }, { uid: true });
                await client.messageFlagsRemove({ uid: await uid(old[4]) }, ['\\Deleted'], { uid: true });
                await client.messageFlagsAdd({ uid: await uid(fresh[0]) }, ['\\Seen'], { uid: true });
                await client.messageMove({ uid: await uid(fresh[1]) }, 'Archive', { uid: true });
                await client.messageDelete({ uid: await uid(fresh[2]) }, { uid: true });
                await client.messageFlagsAdd({ uid: await uid(fresh[3]) }, ['\\Deleted'], { uid: true });
                await client.messageFlagsRemove({ uid: await uid(fresh[3]) }, ['\\Deleted'], { uid: true });
            });
            await inMailbox(ctx, 'Archive', async client => client.messageMove({ uid: (await locate(ctx, old[1])).uid }, 'INBOX', { uid: true }));
            const res = await changes(ctx.client, s0);
            const ids = allIds(res);
            expect(new Set(ids).size, 'no id is listed twice').to.equal(ids.length);
            expect(res.created.length + res.updated.length + res.destroyed.length).to.be.above(5);
        });

        scenario('ECHG-074', async () => {
            const ctx = await account();
            const [e1, e2] = await appendEmails(ctx, 'INBOX', 2);
            const s0 = await state(ctx.client);
            const e3 = await appendEmail(ctx);
            await inMailbox(ctx, 'INBOX', async client => {
                await client.messageFlagsAdd({ uid: (await locate(ctx, e1)).uid }, ['\\Flagged'], { uid: true });
                await client.messageDelete({ uid: (await locate(ctx, e2)).uid }, { uid: true });
            });
            expectChanges(await changes(ctx.client, s0), { created: [e3], updated: [e1], destroyed: [e2] });
        });

        scenario('ECHG-075', async () => {
            const ctx = await account();
            const [a, b, c] = await appendEmails(ctx, 'INBOX', 3);
            const states = [await state(ctx.client)];
            const uid = async id => (await locate(ctx, id)).uid;
            const created = await appendEmails(ctx, 'INBOX', 3);
            states.push(await state(ctx.client));
            await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: await uid(a) }, ['\\Flagged'], { uid: true }));
            states.push(await state(ctx.client));
            await inMailbox(ctx, 'INBOX', async client => client.messageDelete({ uid: await uid(b) }, { uid: true }));
            states.push(await state(ctx.client));
            await inMailbox(ctx, 'INBOX', async client => client.messageMove({ uid: await uid(c) }, 'Archive', { uid: true }));
            states.push(await state(ctx.client));
            const x = await appendEmail(ctx);
            await inMailbox(ctx, 'INBOX', async client => client.messageDelete({ uid: await uid(x) }, { uid: true }));
            states.push(await state(ctx.client));

            const expected = [
                { created, updated: [a, c], destroyed: [b] },
                { updated: [a, c], destroyed: [b] },
                { updated: [c], destroyed: [b] },
                { updated: [c] },
                {},
                {}
            ];
            for (let i = 0; i < states.length; i++) {
                const res = await changes(ctx.client, states[i]);
                expectChanges(res, expected[i]);
                expect(res.newState, `from S${i}`).to.equal(states[5]);
            }
        });

        scenario('ECHG-076', async () => {
            const ctx = await account();
            const [e, f] = await appendEmails(ctx, 'INBOX', 2);
            const start = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => client.messageDelete({ uid: (await locate(ctx, e)).uid }, { uid: true }));
            const s0 = (await changes(ctx.client, start)).newState;
            await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: (await locate(ctx, f)).uid }, ['\\Flagged'], { uid: true }));
            expectChanges(await changes(ctx.client, s0), { updated: [f] });
        });
    });

    describe('maxChanges and paging', () => {
        scenario('ECHG-077', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const ids = await appendEmails(ctx, 'INBOX', 5);
            const current = await state(ctx.client);
            for (const maxChanges of [5, 50]) {
                const res = await changes(ctx.client, s0, { maxChanges });
                expectChanges(res, { created: ids });
                expect(res.hasMoreChanges).to.be.false;
                expect(res.newState).to.equal(current);
            }
        });

        scenario('ECHG-078', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            for (let i = 0; i < 5; i++) {
                await appendEmail(ctx);
            }
            const s5 = await state(ctx.client);
            const res = await changes(ctx.client, s0, { maxChanges: 2 });
            expect(allIds(res).length).to.be.at.most(2);
            expect(res.hasMoreChanges).to.be.true;
            expect(res.newState).to.not.equal(s0);
            expect(res.newState).to.not.equal(s5);
        });

        scenario('ECHG-079', async () => {
            const ctx = await account();
            const older = await appendEmails(ctx, 'INBOX', 3);
            const s0 = await state(ctx.client);
            await appendEmails(ctx, 'INBOX', 7);
            await inMailbox(ctx, 'INBOX', async client => {
                await client.messageFlagsAdd({ uid: (await locate(ctx, older[0])).uid }, ['\\Flagged'], { uid: true });
                await client.messageFlagsAdd({ uid: (await locate(ctx, older[1])).uid }, ['\\Flagged'], { uid: true });
                await client.messageDelete({ uid: (await locate(ctx, older[2])).uid }, { uid: true });
            });
            const pages = await follow(ctx.client, s0, 3);
            for (const page of pages) {
                expect(allIds(page).length).to.be.at.most(3);
            }
            const whole = await changes(ctx.client, s0);
            expect(accumulate(pages)).to.deep.equal(lists(whole));
            expect(pages[pages.length - 1].newState).to.equal(await state(ctx.client));
        });

        scenario('ECHG-080', async () => {
            const ctx = await account();
            const base = await appendEmails(ctx, 'INBOX', 6);
            const uid = async id => (await locate(ctx, id)).uid;
            const states = [await state(ctx.client)];
            const batches = [
                () => appendEmails(ctx, 'INBOX', 2),
                () => inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: await uid(base[0]) }, ['\\Seen'], { uid: true })),
                () => inMailbox(ctx, 'INBOX', async client => client.messageMove({ uid: await uid(base[1]) }, 'Archive', { uid: true })),
                () => inMailbox(ctx, 'INBOX', async client => client.messageDelete({ uid: await uid(base[2]) }, { uid: true })),
                async () => {
                    const [x] = await appendEmails(ctx, 'INBOX', 1);
                    await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: await uid(x) }, ['\\Flagged'], { uid: true }));
                },
                () =>
                    inMailbox(ctx, 'INBOX', async client => {
                        await client.messageFlagsAdd({ uid: await uid(base[3]) }, ['\\Flagged'], { uid: true });
                        await client.messageMove({ uid: await uid(base[4]) }, 'Archive', { uid: true });
                    }),
                async () => {
                    const [y] = await appendEmails(ctx, 'INBOX', 1);
                    await inMailbox(ctx, 'INBOX', async client => client.messageDelete({ uid: await uid(y) }, { uid: true }));
                },
                () => inMailbox(ctx, 'INBOX', async client => client.messageDelete({ uid: await uid(base[5]) }, { uid: true }))
            ];
            for (const batch of batches) {
                await batch();
                states.push(await state(ctx.client));
            }
            const current = states[states.length - 1];
            for (const since of states) {
                const whole = lists(await changes(ctx.client, since));
                for (let maxChanges = 1; maxChanges <= 8; maxChanges++) {
                    const pages = await follow(ctx.client, since, maxChanges);
                    for (const page of pages) {
                        expect(allIds(page).length).to.be.at.most(maxChanges);
                    }
                    expect(pages[pages.length - 1].newState).to.equal(current);
                    expect(accumulate(pages), `from ${since} with maxChanges ${maxChanges}`).to.deep.equal(whole);
                }
            }
        });

        scenario('ECHG-081', async () => {
            const ctx = await account();
            const old = await appendEmails(ctx, 'INBOX', 4);
            const s0 = await state(ctx.client);
            await appendEmails(ctx, 'INBOX', 2);
            await inMailbox(ctx, 'INBOX', async client => {
                await client.messageFlagsAdd({ uid: (await locate(ctx, old[0])).uid }, ['\\Flagged'], { uid: true });
                await client.messageFlagsAdd({ uid: (await locate(ctx, old[1])).uid }, ['\\Flagged'], { uid: true });
                await client.messageDelete({ uid: (await locate(ctx, old[2])).uid }, { uid: true });
                await client.messageDelete({ uid: (await locate(ctx, old[3])).uid }, { uid: true });
            });
            const res = await changes(ctx.client, s0, { maxChanges: 4 });
            expect(allIds(res).length).to.be.at.most(4);
            expect(res.hasMoreChanges).to.be.true;
        });

        scenario('ECHG-082', async () => {
            const ctx = await account();
            const id = await appendEmail(ctx);
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => {
                const { uid } = await locate(ctx, id);
                for (let i = 0; i < 20; i++) {
                    await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true });
                    await client.messageFlagsRemove({ uid }, ['\\Flagged'], { uid: true });
                }
            });
            const added = await appendEmails(ctx, 'INBOX', 3);
            const pages = await follow(ctx.client, s0, 1, 'Email/changes', 10);
            expect(accumulate(pages)).to.deep.equal({ created: sorted(added), updated: [id], destroyed: [] });
        });

        scenario('ECHG-083', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            await appendEmails(ctx, 'INBOX', 6);
            const first = await changes(ctx.client, s0, { maxChanges: 2 });
            expect(first.hasMoreChanges).to.be.true;
            const si = first.newState;
            const later = await appendEmail(ctx);
            const [laterDoc] = await messageDocs(ctx.user, { root: new ObjectId(later.slice(1)) });
            const mailbox = await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: 'Later' });
            const responses = await ctx.client.call([
                ['Email/changes', { accountId: true, sinceState: si }, 'e'],
                ['Thread/changes', { accountId: true, sinceState: si }, 't'],
                ['Mailbox/changes', { accountId: true, sinceState: si }, 'm']
            ]);
            expect(responses.map(([name]) => name)).to.deep.equal(['Email/changes', 'Thread/changes', 'Mailbox/changes']);
            expect(responses[0][1].created).to.include(later);
            expect(responses[0][1].created).to.have.lengthOf(5);
            expect(allIds(responses[1][1])).to.include(threadId(laterDoc));
            // a mailbox created in the same second as SI may be listed as updated
            expect(allIds(responses[2][1])).to.include(`F${mailbox.id}`);
        });

        scenario('ECHG-084', async () => {
            const ctx = await account();
            const ids = await appendEmails(ctx, 'INBOX', 20);
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', client => client.messageFlagsAdd('1:*', ['\\Flagged']));
            const pages = await follow(ctx.client, s0, 1);
            expect(pages).to.have.lengthOf(20);
            pages.forEach((page, i) => {
                expect(page.updated).to.have.lengthOf(1);
                expect(page.hasMoreChanges).to.equal(i < 19);
            });
            expect(sorted(pages.flatMap(page => page.updated))).to.deep.equal(sorted(ids));
        });

        scenario('ECHG-085', async () => {
            const ctx = await account();
            const ids = await appendEmails(ctx, 'INBOX', 3);
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', client => client.messageMove('1:*', 'Archive'));
            let since = s0;
            const updated = new Set();
            for (let i = 0; i < 20; i++) {
                const page = await changes(ctx.client, since, { maxChanges: 1 });
                expect(page.created).to.deep.equal([]);
                expect(page.destroyed).to.deep.equal([]);
                page.updated.forEach(id => updated.add(id));
                expect((await getEmails(ctx.client, ids)).notFound).to.deep.equal([]);
                if (!page.hasMoreChanges) {
                    break;
                }
                since = page.newState;
            }
            expect(sorted(updated)).to.deep.equal(sorted(ids));
        });

        scenario('ECHG-086', async () => {
            const ctx = await account();
            const others = await appendEmails(ctx, 'INBOX', 3);
            const s0 = await state(ctx.client);
            const x = await appendEmail(ctx);
            await inMailbox(ctx, 'INBOX', async client => {
                for (const id of others) {
                    await client.messageFlagsAdd({ uid: (await locate(ctx, id)).uid }, ['\\Flagged'], { uid: true });
                }
                await client.messageDelete({ uid: (await locate(ctx, x)).uid }, { uid: true });
            });
            const pages = await follow(ctx.client, s0, 1);
            const createdAt = pages.findIndex(page => page.created.includes(x));
            const destroyedAt = pages.findIndex(page => page.destroyed.includes(x));
            if (createdAt >= 0) {
                expect(destroyedAt, 'X is destroyed on a later page').to.be.above(createdAt);
            }
            const net = accumulate(pages);
            expect([...net.created, ...net.updated]).to.not.include(x);
        });

        scenario('ECHG-087', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const ids = [];
            for (let i = 0; i < 3; i++) {
                ids.push(await appendEmail(ctx));
                // activity that changes the state but no Email
                await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: `Between ${i}` });
            }
            let since = s0;
            for (const id of ids) {
                const page = await changes(ctx.client, since, { maxChanges: 1 });
                expect(page.created).to.deep.equal([id]);
                since = page.newState;
            }
        });

        scenario('ECHG-088', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const ids = await appendEmails(ctx, 'INBOX', 4);
            const first = await changes(ctx.client, s0, { maxChanges: 2 });
            expect(first.hasMoreChanges).to.be.true;
            ids.push(...(await appendEmails(ctx, 'INBOX', 2)));
            const pages = [first, ...(await follow(ctx.client, first.newState, 2))];
            expect(accumulate(pages)).to.deep.equal({ created: sorted(ids), updated: [], destroyed: [] });
            expect(pages[pages.length - 1].newState).to.equal(await state(ctx.client));
        });

        describe('the server cap', () => {
            let ctx;
            let s0;
            let ids;

            before(async function () {
                this.timeout(120000);
                ctx = await account();
                s0 = await state(ctx.client);
                ids = await appendEmails(ctx, 'INBOX', 150);
            });

            scenario('ECHG-089', async () => {
                expect(CAP, 'the test server caps a response at 100 ids').to.equal(100);
                for (const extra of [{}, { maxChanges: null }]) {
                    const res = await changes(ctx.client, s0, extra);
                    expect(allIds(res).length).to.be.at.most(CAP);
                    expect(res.hasMoreChanges).to.be.true;
                    expect(res.newState).to.not.equal(s0);
                    const rest = await follow(ctx.client, res.newState);
                    expect(accumulate([res, ...rest])).to.deep.equal({ created: sorted(ids), updated: [], destroyed: [] });
                }
            });

            scenario('ECHG-090', async () => {
                const res = await changes(ctx.client, s0, { maxChanges: 9007199254740991 });
                expect(allIds(res).length).to.be.at.most(CAP);
                expect(res.hasMoreChanges).to.be.true;
            });
        });

        scenario('ECHG-093', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const ids = await appendEmails(ctx, 'INBOX', 5);
            const threads = (await messageDocs(ctx.user)).filter(doc => ids.includes(emailId(doc))).map(threadId);
            expect(new Set(threads).size).to.equal(5);
            const pages = await follow(ctx.client, s0, 2, 'Thread/changes');
            pages.forEach((page, i) => {
                expect(allIds(page).length).to.be.at.most(2);
                expect(page.hasMoreChanges).to.equal(i < pages.length - 1);
            });
            const returned = new Set(pages.flatMap(allIds));
            expect(sorted(returned)).to.deep.equal(sorted(threads));
            expect(pages[pages.length - 1].newState).to.equal(await state(ctx.client));
        });

        scenario('ECHG-094', async () => {
            const ctx = await account();
            const [first] = await appendEmails(ctx, 'INBOX', 1, [], { subject: 'Thread topic', messageId: '<topic-1@scenario.example>' });
            await appendEmails(ctx, 'INBOX', 1, [], {
                subject: 'Re: Thread topic',
                messageId: '<topic-2@scenario.example>',
                inReplyTo: '<topic-1@scenario.example>',
                references: ['<topic-1@scenario.example>']
            });
            const docs = await messageDocs(ctx.user);
            expect(new Set(docs.map(threadId)).size, 'the two messages share a thread').to.equal(1);
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', async client => client.messageFlagsAdd({ uid: (await locate(ctx, first)).uid }, ['\\Seen'], { uid: true }));
            const res = await ctx.client.method('Thread/changes', { sinceState: s0 });
            expect(res.newState).to.not.equal(s0);
            expectEmpty(res);
        });

        scenario('ECHG-095', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            await appendEmails(ctx, 'INBOX', 6);
            const chains = { 'Email/changes': { since: s0, ids: new Set(), done: false }, 'Thread/changes': { since: s0, ids: new Set(), done: false } };
            for (let i = 0; i < 20 && !Object.values(chains).every(chain => chain.done); i++) {
                for (const [method, chain] of Object.entries(chains)) {
                    if (!chain.done) {
                        const page = await ctx.client.method(method, { sinceState: chain.since, maxChanges: 2 });
                        allIds(page).forEach(id => chain.ids.add(id));
                        chain.since = page.newState;
                        chain.done = !page.hasMoreChanges;
                    }
                }
            }
            expect(chains['Email/changes'].done && chains['Thread/changes'].done).to.be.true;
            expect(chains['Email/changes'].since).to.equal(chains['Thread/changes'].since);
            expect(chains['Email/changes'].ids.size).to.equal(6);
            expect(chains['Thread/changes'].ids.size).to.equal(6);
        });

        scenario('ECHG-096', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            const ids = await appendEmails(ctx, 'INBOX', 4);
            const [[, first], [, second]] = await ctx.client.call([
                ['Email/changes', { accountId: true, sinceState: s0, maxChanges: 2 }, 'c1'],
                ['Email/changes', { accountId: true, '#sinceState': { resultOf: 'c1', name: 'Email/changes', path: '/newState' }, maxChanges: 2 }, 'c2']
            ]);
            expect(first.created).to.have.lengthOf(2);
            expect(second.created).to.have.lengthOf(2);
            expect(second.hasMoreChanges).to.be.false;
            expect(sorted([...first.created, ...second.created])).to.deep.equal(sorted(ids));
        });
    });

    describe('errors and expiry', () => {
        let ctx;
        before(async () => {
            ctx = await account();
        });

        scenario('ECHG-091', async () => {
            const s0 = await state(ctx.client);
            expect(await errorOf(ctx.client, 'Email/changes', { accountId: ctx.client.accountId, sinceState: s0, maxChanges: 0 })).to.equal('invalidArguments');
        });

        scenario('ECHG-092', async () => {
            const s0 = await state(ctx.client);
            for (const maxChanges of [-1, 1.5, '5', true, []]) {
                expect(
                    await errorOf(ctx.client, 'Email/changes', { accountId: ctx.client.accountId, sinceState: s0, maxChanges }),
                    JSON.stringify(maxChanges)
                ).to.equal('invalidArguments');
            }
            // 2^53 + 1 is not representable, sent as raw JSON
            const body = `{"using":["${jmap.URN.core}","${jmap.URN.mail}"],"methodCalls":[["Email/changes",{"accountId":"${ctx.client.accountId}","sinceState":"${s0}","maxChanges":9007199254740993},"c0"]]}`;
            const res = await ctx.client.request(body);
            expect(res.status).to.equal(200);
            expect(res.json.methodResponses[0][0]).to.equal('error');
            expect(res.json.methodResponses[0][1].type).to.equal('invalidArguments');
        });

        scenario('ECHG-099', async () => {
            for (const sinceState of [1, null, {}, undefined]) {
                const args = { accountId: ctx.client.accountId };
                if (sinceState !== undefined) {
                    args.sinceState = sinceState;
                }
                expect(await errorOf(ctx.client, 'Email/changes', args), JSON.stringify(sinceState)).to.equal('invalidArguments');
            }
        });

        scenario('ECHG-100', async () => {
            for (const sinceState of ['bogus', '0', '', 'x'.repeat(5000), 'abc\u0000\u0001\u001fdef']) {
                expect(
                    await errorOf(ctx.client, 'Email/changes', { accountId: ctx.client.accountId, sinceState }),
                    JSON.stringify(sinceState.slice(0, 20))
                ).to.equal('cannotCalculateChanges');
            }
        });

        scenario('ECHG-101', async () => {
            const s0 = await state(ctx.client);
            const future = ObjectId.createFromTime(Math.floor(Date.now() / 1000) + 3600);
            const sinceState = stateFor(ctx, future);
            expect(sinceState).to.not.equal(s0);
            expect(await errorOf(ctx.client, 'Email/changes', { accountId: ctx.client.accountId, sinceState })).to.equal('cannotCalculateChanges');
        });

        scenario('ECHG-102', async () => {
            const a = await account();
            const b = await account();
            await appendEmail(a);
            await appendEmail(b);
            const sb = await state(b.client);
            expect(await errorOf(a.client, 'Email/changes', { accountId: a.client.accountId, sinceState: sb })).to.equal('cannotCalculateChanges');
        });

        scenario('ECHG-103', async () => {
            const other = await accounts.createUser();
            const s0 = await state(ctx.client);
            const unknown = `u${crypto.randomBytes(12).toString('hex')}`;
            expect(await errorOf(ctx.client, 'Email/changes', { accountId: unknown, sinceState: s0 })).to.equal('accountNotFound');
            expect(await errorOf(ctx.client, 'Email/changes', { accountId: `u${other.id}`, sinceState: s0 })).to.equal('accountNotFound');
        });

        scenario('ECHG-104', async () => {
            const s0 = await state(ctx.client);
            expect(await errorOf(ctx.client, 'Email/changes', { sinceState: s0 })).to.equal('invalidArguments');
            expect(await errorOf(ctx.client, 'Email/changes', { accountId: null, sinceState: s0 })).to.equal('invalidArguments');
        });

        describe('journal retention', () => {
            afterEach(resetRetention);

            scenario('ECHG-097', async () => {
                const c = await account();
                const s0 = await state(c.client);
                await setRetention(1000);
                await clock.delay(1500);
                await appendEmail(c);
                expect(await errorOf(c.client, 'Email/changes', { accountId: c.client.accountId, sinceState: s0 })).to.equal('cannotCalculateChanges');
                await resetRetention();
                // recovery: a fresh state works
                const s1 = await state(c.client);
                expectEmpty(await changes(c.client, s1));
            });

            scenario('ECHG-098', async () => {
                const c = await account();
                const s0 = await state(c.client);
                const ids = await appendEmails(c, 'INBOX', 2);
                // S0 older than R - M, younger than R
                await setRetention(stateAge(s0) + EXPIRY_MARGIN / 2);
                expect(await errorOf(c.client, 'Email/changes', { accountId: c.client.accountId, sinceState: s0 })).to.equal('cannotCalculateChanges');
                // S0 younger than R - M
                await setRetention(stateAge(s0) + EXPIRY_MARGIN + 30 * 1000);
                expectChanges(await changes(c.client, s0), { created: ids });
            });

            scenario('ECHG-105', async () => {
                const c = await account();
                const s0 = await state(c.client);
                await setRetention(1000);
                await clock.delay(1500);
                await appendEmail(c);
                expect(await errorOf(c.client, 'Email/changes', { accountId: c.client.accountId, sinceState: s0 })).to.equal('cannotCalculateChanges');
            });

            scenario('ECHG-106', async () => {
                const c = await account();
                const s0 = await state(c.client);
                await setRetention(1000);
                await clock.delay(1500);
                expect(await errorOf(c.client, 'Email/changes', { accountId: c.client.accountId, sinceState: s0 })).to.equal('cannotCalculateChanges');
                await resetRetention();
                const s1 = await state(c.client);
                const id = await appendEmail(c);
                expectChanges(await changes(c.client, s1), { created: [id] });
            });
        });
    });

    describe('concurrency and scale', () => {
        scenario('ECHG-110', async function () {
            this.timeout(120000);
            const ctx = await account();
            const toMove = await appendEmails(ctx, 'INBOX', 25);
            const moveUids = await Promise.all(toMove.map(async id => (await locate(ctx, id)).uid));
            const s0 = await state(ctx.client);
            const appended = [];
            const imapWriter = () =>
                seed.withImap(ctx.user, async client => {
                    await client.mailboxOpen('Archive');
                    const uids = [];
                    for (let i = 0; i < 10; i++) {
                        uids.push((await client.append('Archive', await fixtures.buildMessage())).uid);
                    }
                    for (const uid of uids.slice(0, 5)) {
                        await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true });
                    }
                    appended.push(...uids);
                });
            const apiMover = async () => {
                for (const uid of moveUids) {
                    await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${uid}`, { moveTo: ctx.boxes.Archive.id });
                }
            };
            const delivered = [];
            const lmtpWriter = async () => {
                for (let i = 0; i < 25; i++) {
                    delivered.push(await deliverEmail(ctx));
                }
            };
            await Promise.all([...Array.from({ length: 10 }, imapWriter), apiMover(), lmtpWriter()]);
            const created = [...(await idsByUid(ctx.user, ctx.boxes.Archive.id, appended)), ...delivered];
            const net = accumulate(await follow(ctx.client, s0));
            expect(net.created).to.include.members(created);
            expect(net.updated).to.include.members(toMove);
        });

        scenario('ECHG-111', async function () {
            this.timeout(120000);
            const ctx = await account();
            const pool = await appendEmails(ctx, 'INBOX', 20);
            const s0 = await state(ctx.client);
            const deadline = Date.now() + 10 * 1000;
            const appended = [];
            const touched = new Set();
            const delivered = [];
            const writers = [
                seed.withImap(ctx.user, async client => {
                    await client.mailboxOpen('INBOX');
                    while (Date.now() < deadline) {
                        appended.push((await client.append('INBOX', await fixtures.buildMessage())).uid);
                        const id = pool[appended.length % pool.length];
                        touched.add(id);
                        await client.messageFlagsAdd({ uid: (await locate(ctx, id)).uid }, ['\\Seen'], { uid: true });
                    }
                }),
                (async () => {
                    let i = 0;
                    while (Date.now() < deadline) {
                        const id = pool[i++ % pool.length];
                        const { uid, mailbox } = await locate(ctx, id);
                        const target = mailbox === ctx.boxes.INBOX.id ? ctx.boxes.Archive.id : ctx.boxes.INBOX.id;
                        await api('PUT', `/users/${ctx.user.id}/mailboxes/${mailbox}/messages/${uid}`, { moveTo: target });
                        touched.add(id);
                    }
                })(),
                (async () => {
                    while (Date.now() < deadline) {
                        delivered.push(await deliverEmail(ctx));
                    }
                })()
            ];
            const polled = [];
            let since = s0;
            const poll = async () => {
                for (;;) {
                    const page = await changes(ctx.client, since);
                    polled.push(page);
                    since = page.newState;
                    if (!page.hasMoreChanges) {
                        return;
                    }
                }
            };
            let finished = false;
            const allWriters = Promise.all(writers).then(() => {
                finished = true;
            });
            while (!finished) {
                await poll();
                await clock.delay(200);
            }
            await allWriters;
            await poll();

            const createdIds = [...(await idsByUid(ctx.user, ctx.boxes.INBOX.id, appended)), ...delivered];
            const union = new Set(polled.flatMap(allIds));
            for (const id of [...createdIds, ...touched]) {
                expect(union.has(id), `${id} was reported`).to.be.true;
            }
            // created twice only with a destroy in between
            const createdOnce = new Set();
            for (const page of polled) {
                for (const id of page.created) {
                    expect(createdOnce.has(id), `${id} created twice`).to.be.false;
                    createdOnce.add(id);
                }
                page.destroyed.forEach(id => createdOnce.delete(id));
            }
        });

        scenario('ECHG-112', async () => {
            const ctx = await account();
            const s0 = await state(ctx.client);
            // 20 calls in flight around the append, within the limit of concurrent requests per account
            let remaining = 20;
            const readings = [];
            const reader = async () => {
                const client = jmap.forUser(ctx.user);
                while (remaining-- > 0) {
                    readings.push(await state(client));
                }
            };
            const readers = Promise.all(Array.from({ length: 6 }, reader));
            const id = await appendEmail(ctx);
            await readers;
            const observed = new Set(readings);
            const s1 = await state(ctx.client);
            observed.add(s0);
            expect([...observed].every(value => value === s0 || value === s1)).to.be.true;
            for (const value of observed) {
                expectChanges(await changes(ctx.client, value), value === s0 ? { created: [id] } : {});
            }
        });

        scenario('ECHG-113', async function () {
            this.timeout(180000);
            const ctx = await account();
            const s0 = await state(ctx.client);
            await afterSecondOf(s0);
            // journal entries as the store writes them for 10000 new messages; Email/changes reads only the journal
            const db = await seed.db();
            const user = new ObjectId(ctx.user.id);
            const mailbox = new ObjectId(ctx.boxes.INBOX.id);
            const ids = [];
            for (let batch = 0; batch < 10; batch++) {
                const entries = [];
                for (let i = 0; i < 1000; i++) {
                    const root = new ObjectId();
                    ids.push(`M${root}`);
                    entries.push({
                        command: 'EXISTS',
                        user,
                        mailbox,
                        uid: batch * 1000 + i + 1,
                        message: root,
                        root,
                        thread: new ObjectId(),
                        origin: 'imap',
                        modseq: 1,
                        created: new Date()
                    });
                }
                await db.collection('journal').insertMany(entries, { ordered: true });
            }
            const pages = await follow(ctx.client, s0, 500);
            expect(pages.length).to.be.at.least(20);
            for (const page of pages) {
                expect(allIds(page).length).to.be.at.most(500);
            }
            const all = pages.flatMap(page => page.created);
            expect(new Set(all).size).to.equal(all.length);
            expect(sorted(all)).to.deep.equal(sorted(ids));
            expect(pages[pages.length - 1].newState).to.equal(await state(ctx.client));
            await db.collection('journal').deleteMany({ user });
        });

        scenario('ECHG-114', async function () {
            this.timeout(300000);
            const ctx = await account();
            await Promise.all(
                Array.from({ length: 10 }, () =>
                    seed.withImap(ctx.user, async client => {
                        for (let i = 0; i < 500; i++) {
                            await client.append('INBOX', await fixtures.buildMessage());
                        }
                    })
                )
            );
            const ids = (await messageDocs(ctx.user)).map(emailId);
            expect(ids).to.have.lengthOf(5000);
            const s0 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', client => client.messageFlagsAdd('1:*', ['\\Seen']));
            const s1 = await state(ctx.client);
            await inMailbox(ctx, 'INBOX', client => client.messageDelete('1:*'));
            expect(accumulate(await follow(ctx.client, s1, 5000))).to.deep.equal({ created: [], updated: [], destroyed: sorted(ids) });
            expect(accumulate(await follow(ctx.client, s0, 5000))).to.deep.equal({ created: [], updated: [], destroyed: sorted(ids) });
        });

        scenario('ECHG-115', async function () {
            this.timeout(180000);
            const ctx = await account();
            const s0 = await state(ctx.client);
            await afterSecondOf(s0);
            const db = await seed.db();
            const user = new ObjectId(ctx.user.id);
            const mailbox = new ObjectId(ctx.boxes.INBOX.id);
            const roots = Array.from({ length: 1000 }, () => new ObjectId());
            const entry = root => ({
                _id: new ObjectId(),
                command: 'FETCH',
                user,
                mailbox,
                uid: 1,
                message: root,
                root,
                thread: root,
                flags: ['\\Seen'],
                modseq: 1,
                created: new Date()
            });
            // 190000 flag changes on 50 messages, then 10000 over all 1000
            const ids = [];
            try {
                for (let batch = 0; batch < 20; batch++) {
                    const entries = Array.from({ length: 10000 }, (v, i) => entry(batch < 19 ? roots[i % 50] : roots[i % 1000]));
                    ids.push(...entries.map(doc => doc._id.toString()));
                    await db.collection('journal').insertMany(entries, { ordered: true });
                }
                const started = Date.now();
                const res = await changes(ctx.client, s0, { maxChanges: 100 });
                const elapsed = Date.now() - started;
                expect(allIds(res).length).to.be.at.most(100);
                expect(res.hasMoreChanges).to.be.true;
                // the scan stopped after the scan limit, and the intermediate state is where it stopped. Positions
                // are counted in the order the journal is read (by _id): ids made in one second compare by a
                // counter that wraps, so the order of creation is not always that order
                ids.sort();
                const position = ids.indexOf(res.newState.slice(0, 24));
                expect(position, 'the intermediate state is a scanned entry').to.be.at.least(0);
                expect(position).to.be.below(SCAN_LIMIT);
                expect(elapsed).to.be.below(10000);
            } finally {
                await db.collection('journal').deleteMany({ user });
            }
        });
    });
});

describe('cross protocol invariants (wildduck.yaml WDX)', function () {
    this.timeout(60000);

    scenario('WDX-001', async () => {
        const ctx = await account();
        const ids = await appendEmails(ctx, 'INBOX', 3);
        const before = await mailboxTotals(ctx.client);
        const s0 = await state(ctx.client);
        const { doc } = await locate(ctx, ids[1]);
        await pop3(ctx.user, async command => command(`DELE ${await pop3Number(command, doc._id.toString())}`));
        const res = await pop3Applied(ctx, s0);
        // POP3 moves deleted messages to Trash
        expectChanges(res, { updated: [ids[1]] });
        const after = await mailboxTotals(ctx.client);
        expect(after.get(`F${ctx.boxes.INBOX.id}`).totalEmails).to.equal(before.get(`F${ctx.boxes.INBOX.id}`).totalEmails - 1);
        expect(after.get(`F${ctx.boxes['\\Trash'].id}`).totalEmails).to.equal(before.get(`F${ctx.boxes['\\Trash'].id}`).totalEmails + 1);
    });

    scenario('WDX-002', async () => {
        const ctx = await account();
        await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.Archive.id}`, { retention: 3600 * 1000 });
        const ids = await Promise.all([uploadEmail(ctx, ctx.boxes.Archive.id), uploadEmail(ctx, ctx.boxes.Archive.id)]);
        // the messages are older than the retention; retentionTime is aged too, because the background retention
        // task recomputes rdate from it and would otherwise move the expiry back into the future
        const db = await seed.db();
        const received = new Date(Date.now() - 2 * 3600 * 1000);
        await db
            .collection('messages')
            .updateMany(
                { mailbox: new ObjectId(ctx.boxes.Archive.id) },
                { $set: { exp: true, idate: received, retentionTime: received.getTime(), rdate: received.getTime() + 3600 * 1000 } }
            );
        const s0 = await state(ctx.client);
        await afterSecondOf(s0);
        expect(await expireMessages(ctx.user)).to.equal(2);
        expectChanges(await changes(ctx.client, s0), { destroyed: ids });
        expect(sorted((await getEmails(ctx.client, ids)).notFound)).to.deep.equal(sorted(ids));
    });

    scenario('WDX-004', async function () {
        this.timeout(TASK_WAIT + 30000);
        const ctx = await account();
        const ids = await appendEmails(ctx, 'INBOX', 2);
        const label = await api('POST', `/users/${ctx.user.id}/labels`, { name: 'Tagged' });
        const keyword = `$wdlabel$${label.id}`;
        const s0 = await state(ctx.client);
        await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${(await locate(ctx, ids[0])).uid}`, { addLabels: ['Tagged'] });
        const first = await changes(ctx.client, s0);
        expectChanges(first, { updated: [ids[0]] });
        expect((await getEmail(ctx.client, ids[0], ['keywords'])).keywords).to.have.property(keyword, true);
        await api('DELETE', `/users/${ctx.user.id}/labels/${label.id}`);
        const second = await clock.waitFor(
            async () => {
                const page = await changes(ctx.client, first.newState);
                return page.updated.includes(ids[0]) && page;
            },
            { timeout: TASK_WAIT, message: 'label deletion reports the Email' }
        );
        expect(second.updated).to.include(ids[0]);
        for (const email of (await getEmails(ctx.client, ids, ['keywords'])).list) {
            expect(email.keywords).to.not.have.property(keyword);
        }
    });
});
