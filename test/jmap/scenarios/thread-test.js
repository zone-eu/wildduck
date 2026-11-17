/* eslint no-unused-expressions: 0 */
/* globals before: false */
'use strict';

// Catalogue file thread.yaml: Thread/get and Thread/changes (THR).

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { scenario, api, accounts, seed, clock, jmap } = require('../harness');

const ID_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DAY = 24 * 3600 * 1000;
const BASE_DATE = Date.UTC(2026, 0, 10, 12, 0, 0);
const day = n => new Date(BASE_DATE + n * DAY);

const tag = () => crypto.randomBytes(5).toString('hex');

/**
 * A raw RFC 822 message with exact control over the threading headers. The subject is written as
 * given (raw UTF-8 when it is not ASCII) unless `encodedSubject` is set.
 */
function rawMessage(options = {}) {
    const lines = [
        `From: ${options.from || 'Sender <sender@example.net>'}`,
        `To: ${options.to || 'Recipient <recipient@example.com>'}`,
        `Subject: ${options.encodedSubject || options.subject || 'No subject'}`,
        `Message-ID: ${options.messageId || `<${tag()}@scenario.example>`}`,
        `Date: ${(options.date || new Date()).toUTCString()}`
    ];
    if (options.inReplyTo) {
        lines.push(`In-Reply-To: ${options.inReplyTo}`);
    }
    if (options.references) {
        lines.push(`References: ${options.references}`);
    }
    lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', options.body || `Body ${tag()}`, '');
    return Buffer.from(lines.join('\r\n'));
}

const messageIdOf = raw => /^Message-ID: (.*)$/im.exec(raw.toString())[1].trim();

/** The stored document of a message by its Message-ID, once it exists */
async function storedDoc(user, messageId) {
    const db = await seed.db();
    return clock.waitFor(
        () =>
            db
                .collection('messages')
                .findOne(
                    { user: new seed.ObjectId(user.id), msgid: messageId },
                    { projection: { _id: true, root: true, thread: true, uid: true, mailbox: true } }
                ),
        { message: `message ${messageId} not stored` }
    );
}

const emailIdOf = doc => `M${(doc.root || doc._id).toString()}`;

/** Delivers a raw message over LMTP and answers its Email id */
async function deliver(user, options = {}) {
    const raw = rawMessage(options);
    await seed.deliver(
        [].concat(user).map(entry => entry.address),
        raw
    );
    const users = [].concat(user);
    const docs = await Promise.all(users.map(entry => storedDoc(entry, messageIdOf(raw))));
    return users.length === 1 ? emailIdOf(docs[0]) : docs.map(emailIdOf);
}

/** Appends a raw message over IMAP and answers its Email id */
async function append(user, path, options = {}, flags = [], idate) {
    const raw = rawMessage(options);
    await seed.withImap(user, client => client.append(path, raw, flags, idate));
    return emailIdOf(await storedDoc(user, messageIdOf(raw)));
}

/** The stored document of an Email id */
async function docOf(user, emailId) {
    const db = await seed.db();
    const docs = await db
        .collection('messages')
        .find({ user: new seed.ObjectId(user.id), root: new seed.ObjectId(emailId.slice(1)) })
        .sort({ _id: -1 })
        .limit(1)
        .toArray();
    return docs[0];
}

/** Changes IMAP flags of one message (by Email id) in the mailbox it is in */
async function imapFlags(user, emailId, action, flags) {
    const doc = await docOf(user, emailId);
    const db = await seed.db();
    const mailbox = await db.collection('mailboxes').findOne({ _id: doc.mailbox });
    await seed.withImap(user, async client => {
        await client.mailboxOpen(mailbox.path);
        if (action === 'add') {
            await client.messageFlagsAdd(String(doc.uid), flags, { uid: true });
        } else {
            await client.messageFlagsRemove(String(doc.uid), flags, { uid: true });
        }
    });
}

/** Flags messages \Deleted and expunges them over IMAP */
async function imapExpunge(user, emailIds) {
    for (const emailId of emailIds) {
        const doc = await docOf(user, emailId);
        const db = await seed.db();
        const mailbox = await db.collection('mailboxes').findOne({ _id: doc.mailbox });
        await seed.withImap(user, async client => {
            await client.mailboxOpen(mailbox.path);
            await client.messageDelete(String(doc.uid), { uid: true });
        });
    }
}

async function threadIdsOf(client, emailIds) {
    const res = await client.method('Email/get', { ids: emailIds, properties: ['threadId'] });
    expect(res.notFound).to.deep.equal([]);
    const byId = Object.fromEntries(res.list.map(entry => [entry.id, entry.threadId]));
    return emailIds.map(id => byId[id]);
}

async function threadIdOf(client, emailId) {
    return (await threadIdsOf(client, [emailId]))[0];
}

async function getThread(client, ids, extra = {}) {
    return client.method('Thread/get', Object.assign({ ids }, extra));
}

async function emailIdsOfThread(client, threadId) {
    const res = await getThread(client, [threadId]);
    return res.list.length ? res.list[0].emailIds : null;
}

async function stateOf(client) {
    return (await getThread(client, [])).state;
}

async function threadChanges(client, sinceState, extra = {}) {
    return client.method('Thread/changes', Object.assign({ sinceState }, extra));
}

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
}

/** A user, its JMAP client and the JMAP mailbox ids keyed by path and role */
async function setupUser() {
    const user = await accounts.createUser();
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

async function createMailbox(user, path) {
    const res = await api('POST', `/users/${user.id}/mailboxes`, { path });
    return `F${res.id}`;
}

// A state string of the account for a journal anchor (the format of lib/jmap/state.js), used to
// simulate a state that the journal retention has passed
function forgedState(accountId, anchor) {
    const sum = crypto.createHmac('sha256', config.api.accessControl.secret).update(`${accountId}:${anchor}`).digest('hex').slice(0, 8);
    return `${anchor}${sum}`;
}

describe('JMAP Thread (thread.yaml)', () => {
    describe('Thread/get', () => {
        // one shared account: two threads, read only scenarios
        let user;
        let client;
        let t1;
        let t2;
        let emailsT1;
        let emailsT2;

        before(async () => {
            ({ user, client } = await setupUser());
            const subject = `Shared fixture ${tag()}`;
            const msgidA = `<t1a.${tag()}@x>`;
            const a = await deliver(user, { subject, messageId: msgidA });
            const b = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgidA, references: msgidA });
            const c = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgidA, references: msgidA });
            const other = `Other fixture ${tag()}`;
            const msgidD = `<t2d.${tag()}@x>`;
            const d = await deliver(user, { subject: other, messageId: msgidD });
            const e = await deliver(user, { subject: `Re: ${other}`, inReplyTo: msgidD });
            emailsT1 = [a, b, c];
            emailsT2 = [d, e];
            [t1, t2] = await threadIdsOf(client, [a, d]);
        });

        scenario('THR-001', async () => {
            const { user: single, client: own } = await setupUser();
            const emailId = await deliver(single, { subject: `Alone ${tag()}` });
            const threadId = await threadIdOf(own, emailId);
            const res = await getThread(own, [threadId]);
            expect(res.accountId).to.equal(own.accountId);
            expect(res.state).to.be.a('string');
            expect(res.notFound).to.deep.equal([]);
            expect(res.list).to.have.length(1);
            expect(res.list[0]).to.have.all.keys('id', 'emailIds');
            expect(res.list[0]).to.deep.equal({ id: threadId, emailIds: [emailId] });
        });

        scenario('THR-002', async () => {
            const all = emailsT1.concat(emailsT2);
            const threadIds = await threadIdsOf(client, all);
            const distinct = [...new Set(threadIds)];
            expect(distinct).to.have.length(2);
            for (const id of distinct) {
                expect(id).to.match(ID_SHAPE);
                expect(id.length).to.be.at.most(255);
                expect(id[0]).to.not.equal(all[0][0]);
                expect(id[0]).to.not.equal('F');
            }
            const res = await getThread(client, distinct);
            expect(res.notFound).to.deep.equal([]);
            expect(res.list.map(entry => entry.id).sort()).to.deep.equal(distinct.sort());
        });

        scenario('THR-003', async () => {
            const res = await getThread(client, [t1, t2]);
            expect(res.list).to.have.length(2);
            const first = res.list.find(entry => entry.id === t1);
            const second = res.list.find(entry => entry.id === t2);
            expect(first.emailIds).to.have.length(3);
            expect(second.emailIds).to.have.length(2);
            expect(first.emailIds.filter(id => second.emailIds.includes(id))).to.deep.equal([]);
            expect([...first.emailIds].sort()).to.deep.equal([...emailsT1].sort());
            expect([...second.emailIds].sort()).to.deep.equal([...emailsT2].sort());
            const emails = await client.method('Email/get', { ids: first.emailIds.concat(second.emailIds), properties: ['id'] });
            expect(emails.notFound).to.deep.equal([]);
        });

        scenario('THR-004', async () => {
            const unknown = `T${new seed.ObjectId().toString()}`;
            const mailboxes = await client.method('Mailbox/get', { ids: null, properties: ['id'] });
            const mailboxId = mailboxes.list[0].id;
            const res = await getThread(client, [t1, unknown, 'nonsense', emailsT1[0], mailboxId]);
            expect(res.list.map(entry => entry.id)).to.deep.equal([t1]);
            expect(res.notFound.sort()).to.deep.equal([unknown, 'nonsense', emailsT1[0], mailboxId].sort());
        });

        scenario('THR-005', async () => {
            const res = await getThread(client, []);
            expect(res.list).to.deep.equal([]);
            expect(res.notFound).to.deep.equal([]);
            expect(res.state).to.be.a('string');
            await expectError(getThread(client, null), 'invalidArguments');
        });

        scenario('THR-006', async () => {
            const session = await client.session();
            const max = session.capabilities[jmap.URN.core].maxObjectsInGet;
            const ids = Array.from({ length: max + 1 }, () => `T${new seed.ObjectId().toString()}`);
            await expectError(getThread(client, ids), 'requestTooLarge');
        });

        scenario('THR-007', async () => {
            const first = await getThread(client, [t1], { properties: ['emailIds'] });
            expect(first.list[0]).to.have.all.keys('id', 'emailIds');
            const second = await getThread(client, [t1], { properties: [] });
            expect(second.list[0]).to.deep.equal({ id: t1 });
            await expectError(getThread(client, [t1], { properties: ['subject'] }), 'invalidArguments');
        });

        scenario('THR-008', async () => {
            const { client: other } = await setupUser();
            const [[name1, res1], [name2, res2], [name3, res3]] = await other.call([
                ['Thread/get', { accountId: client.accountId, ids: [t1] }, 'a'],
                ['Thread/changes', { accountId: client.accountId, sinceState: await stateOf(client) }, 'b'],
                ['Thread/get', { accountId: true, ids: [t1] }, 'c']
            ]);
            expect(name1).to.equal('error');
            expect(res1.type).to.equal('accountNotFound');
            expect(name2).to.equal('error');
            expect(res2.type).to.equal('accountNotFound');
            expect(name3).to.equal('Thread/get');
            expect(res3.list).to.deep.equal([]);
            expect(res3.notFound).to.deep.equal([t1]);
        });

        scenario('THR-015', async () => {
            const { user: own, client: ownClient } = await setupUser();
            for (let i = 0; i < 2; i++) {
                const subject = `Chain ${i} ${tag()}`;
                const first = await deliver(own, { subject });
                const msgid = (await docOf(own, first)).msgid;
                await deliver(own, { subject: `Re: ${subject}`, inReplyTo: msgid });
            }
            const boxes = await ownClient.method('Mailbox/get', { ids: null, properties: ['role'] });
            const inbox = boxes.list.find(entry => entry.role === 'inbox').id;
            const responses = await ownClient.call([
                ['Email/query', { accountId: true, filter: { inMailbox: inbox }, collapseThreads: true, limit: 2 }, 'q'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['threadId'] }, 'e'],
                ['Thread/get', { accountId: true, '#ids': { resultOf: 'e', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['subject'] }, 'e2']
            ]);
            expect(responses.map(entry => entry[0])).to.deep.equal(['Email/query', 'Email/get', 'Thread/get', 'Email/get']);
            const threads = responses[2][1];
            expect(threads.list).to.have.length(2);
            expect(threads.notFound).to.deep.equal([]);
            const emails = responses[3][1];
            expect(emails.list).to.have.length(4);
            expect(emails.notFound).to.deep.equal([]);
            expect(emails.list.map(entry => entry.id).sort()).to.deep.equal(threads.list.flatMap(entry => entry.emailIds).sort());
        });
    });

    describe('emailIds order and membership', () => {
        scenario('THR-009', async () => {
            const { user, client } = await setupUser();
            const subject = `Ordered ${tag()}`;
            const msgid = `<order.${tag()}@x>`;
            // append order M1, M2, M3; internal dates M2 < M3 < M1; Date headers M3 < M1 < M2
            const m1 = await append(user, 'INBOX', { subject, messageId: msgid, date: day(1) }, [], day(5));
            const m2 = await append(user, 'INBOX', { subject: `Re: ${subject}`, inReplyTo: msgid, date: day(2) }, [], day(1));
            const m3 = await append(user, 'INBOX', { subject: `Re: ${subject}`, inReplyTo: msgid, date: day(0) }, [], day(3));
            const threadId = await threadIdOf(client, m1);
            expect(await threadIdsOf(client, [m2, m3])).to.deep.equal([threadId, threadId]);
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal([m2, m3, m1]);
            const emails = await client.method('Email/get', { ids: [m2, m3, m1], properties: ['receivedAt'] });
            const received = emails.list.map(entry => entry.receivedAt);
            expect([...received].sort()).to.deep.equal(received);
        });

        scenario('THR-010', async () => {
            const { user, client } = await setupUser();
            const subject = `Same date ${tag()}`;
            const msgid = `<same.${tag()}@x>`;
            const emails = [
                await append(user, 'INBOX', { subject, messageId: msgid }, [], day(2)),
                await append(user, 'INBOX', { subject: `Re: ${subject}`, inReplyTo: msgid }, [], day(2)),
                await append(user, 'INBOX', { subject: `Re: ${subject}`, inReplyTo: msgid }, [], day(2))
            ];
            const threadId = await threadIdOf(client, emails[0]);
            const expected = [...emails].sort();
            const flags = ['\\Seen', '\\Flagged', '$Custom', '\\Answered', '\\Seen'];
            for (let i = 0; i < 5; i++) {
                expect(await emailIdsOfThread(client, threadId)).to.deep.equal(expected);
                await imapFlags(user, emails[i % 3], i % 2 ? 'remove' : 'add', [flags[i]]);
            }
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal(expected);
        });

        scenario('THR-011', async () => {
            const { user, client } = await setupUser();
            const subject = `Late ${tag()}`;
            const msgid = `<late.${tag()}@x>`;
            const a = await append(user, 'INBOX', { subject, messageId: msgid }, [], day(1));
            const b = await append(user, 'INBOX', { subject: `Re: ${subject}`, inReplyTo: msgid }, [], day(3));
            const e = await append(user, 'Drafts', { subject: `Re: ${subject}`, inReplyTo: msgid }, ['\\Draft'], day(4));
            const f = await append(user, 'INBOX', { subject: `Re: ${subject}`, inReplyTo: msgid }, [], day(2));
            const threadId = await threadIdOf(client, a);
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal([a, f, b, e]);
        });

        scenario('THR-012', async () => {
            const { user, client } = await setupUser();
            const boxes = await accounts.mailboxes(user);
            const subject = `Conversation ${tag()}`;
            const msgid = `<conv.${tag()}@x>`;
            const original = await deliver(user, { subject, messageId: msgid });
            const early = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const reply = await append(user, boxes['\\Sent'].path, { subject: `Re: ${subject}`, inReplyTo: msgid }, ['\\Seen']);
            const answer = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            await api('PUT', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages`, {
                message: String((await docOf(user, early)).uid),
                moveTo: boxes['\\Trash'].id
            });

            const threadId = await threadIdOf(client, original);
            const emailIds = await emailIdsOfThread(client, threadId);
            expect([...emailIds].sort()).to.deep.equal([original, early, reply, answer].sort());
            const emails = await client.method('Email/get', { ids: emailIds, properties: ['threadId', 'mailboxIds', 'receivedAt'] });
            expect(emails.list.map(entry => entry.id)).to.deep.equal(emailIds);
            const received = emails.list.map(entry => entry.receivedAt);
            expect([...received].sort()).to.deep.equal(received);
            expect(new Set(emails.list.map(entry => entry.threadId))).to.deep.equal(new Set([threadId]));
            const mailboxIds = new Set(emails.list.flatMap(entry => Object.keys(entry.mailboxIds)));
            expect(mailboxIds).to.deep.equal(new Set([`F${boxes.INBOX.id}`, `F${boxes['\\Sent'].id}`, `F${boxes['\\Trash'].id}`]));
        });

        scenario('THR-013', async () => {
            const { user, client } = await setupUser();
            const subject = `Deleted member ${tag()}`;
            const msgid = `<del.${tag()}@x>`;
            const m1 = await deliver(user, { subject, messageId: msgid });
            const m2 = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const m3 = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const threadId = await threadIdOf(client, m1);
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal([m1, m2, m3]);

            await imapFlags(user, m2, 'add', ['\\Deleted']);
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal([m1, m3]);

            await imapFlags(user, m2, 'remove', ['\\Deleted']);
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal([m1, m2, m3]);
            expect(await threadIdOf(client, m2)).to.equal(threadId);
        });

        scenario('THR-014', async () => {
            const { user, client } = await setupUser();
            const subject = `All deleted ${tag()}`;
            const msgid = `<alldel.${tag()}@x>`;
            const m1 = await deliver(user, { subject, messageId: msgid });
            const m2 = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const threadId = await threadIdOf(client, m1);
            await imapFlags(user, m1, 'add', ['\\Deleted']);
            await imapFlags(user, m2, 'add', ['\\Deleted']);
            const res = await getThread(client, [threadId]);
            expect(res.list).to.deep.equal([]);
            expect(res.notFound).to.deep.equal([threadId]);
        });
    });

    describe('threading rule', () => {
        let user;
        let client;

        before(async () => {
            ({ user, client } = await setupUser());
        });

        scenario('THR-016', async () => {
            const a = `<a.${tag()}@x>`;
            const b = `<b.${tag()}@x>`;
            const subject = `Quarterly plan ${tag()}`;
            const ea = await deliver(user, { subject, messageId: a });
            const eb = await deliver(user, { subject: `Re: ${subject}`, messageId: b, inReplyTo: a, references: a });
            const ec = await deliver(user, { subject: `RE: Re: ${subject}`, references: `${a} ${b}` });
            const threads = await threadIdsOf(client, [ea, eb, ec]);
            expect(new Set(threads).size).to.equal(1);
            expect([...(await emailIdsOfThread(client, threads[0]))].sort()).to.deep.equal([ea, eb, ec].sort());
        });

        scenario('THR-017', async () => {
            const subject = `Hello ${tag()}`;
            const emails = [
                await deliver(user, { subject }),
                await deliver(user, { subject: `Re: ${subject}` }),
                await deliver(user, { subject: `Fwd: ${subject}` })
            ];
            const threads = await threadIdsOf(client, emails);
            expect(new Set(threads).size).to.equal(3);
            for (const threadId of threads) {
                expect(await emailIdsOfThread(client, threadId)).to.have.length(1);
            }
        });

        scenario('THR-018', async () => {
            const a = `<inv.${tag()}@x>`;
            const ea = await deliver(user, { subject: `Invoice 42 ${tag()}`, messageId: a });
            const eb = await deliver(user, { subject: `Lunch on Friday? ${tag()}`, inReplyTo: a });
            const [ta, tb] = await threadIdsOf(client, [ea, eb]);
            expect(tb).to.not.equal(ta);
            expect(await emailIdsOfThread(client, ta)).to.deep.equal([ea]);
        });

        scenario('THR-019', async () => {
            const a = `<budget.${tag()}@x>`;
            const word = `Budget${tag()}`;
            const ea = await deliver(user, { subject: `${word}   review`, messageId: a });
            const subjects = [
                `Re: ${word} review`,
                `Fwd: Re: ${word} review`,
                `FW: ${word} review`,
                `[finance-list] Re: ${word} review`,
                `Re: [EXTERNAL] ${word} review`,
                `${word} review (fwd)`,
                `RE:  ${word}\treview`
            ];
            const replies = [];
            for (const subject of subjects) {
                replies.push(await deliver(user, { subject, references: a }));
            }
            const threads = await threadIdsOf(client, [ea, ...replies]);
            expect(threads).to.have.length(8);
            expect(new Set(threads).size).to.equal(1);
        });

        scenario('THR-020', async () => {
            const a = `<nfc.${tag()}@x>`;
            const word = `Café ${tag()}`;
            const ea = await deliver(user, { subject: word, messageId: a });
            const decomposed = `Re: ${word.normalize('NFD')}`;
            expect(decomposed).to.not.equal(`Re: ${word}`);
            const encoded = `=?UTF-8?B?${Buffer.from(decomposed).toString('base64')}?=`;
            const eb = await deliver(user, { encodedSubject: encoded, inReplyTo: a });
            const [ta, tb] = await threadIdsOf(client, [ea, eb]);
            expect(tb).to.equal(ta);
        });

        scenario('THR-021', async () => {
            const id = `brackets.${tag()}@x`;
            const subject = `Brackets ${tag()}`;
            const ea = await deliver(user, { subject, messageId: `<${id}>` });
            const eb = await deliver(user, { subject, inReplyTo: id });
            const [ta, tb] = await threadIdsOf(client, [ea, eb]);
            expect(tb).to.equal(ta);
        });

        scenario('THR-022', async () => {
            const a = `<parent.${tag()}@x>`;
            const subject = `Topic ${tag()}`;
            const eb = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: a });
            const tb = await threadIdOf(client, eb);
            const ea = await deliver(user, { subject, messageId: a });
            expect(await threadIdOf(client, ea)).to.equal(tb);
            expect(await threadIdOf(client, eb)).to.equal(tb);
            expect(await emailIdsOfThread(client, tb)).to.deep.equal([eb, ea]);
        });

        scenario('THR-023', async () => {
            const { user: own, client: ownClient } = await setupUser();
            const a = `<link-a.${tag()}@x>`;
            const b = `<link-b.${tag()}@x>`;
            const subject = `Linked ${tag()}`;
            const ea = await deliver(own, { subject, messageId: a });
            const eb = await deliver(own, { subject, messageId: b });
            const [t1, t2] = await threadIdsOf(ownClient, [ea, eb]);
            expect(t1).to.not.equal(t2);
            const state = await stateOf(ownClient);

            const ec = await deliver(own, { subject, references: `${a} ${b}` });
            const tc = await threadIdOf(ownClient, ec);
            expect([t1, t2]).to.include(tc);
            expect(await threadIdsOf(ownClient, [ea, eb])).to.deep.equal([t1, t2]);
            const changes = await ownClient.method('Email/changes', { sinceState: state });
            expect(changes.destroyed).to.deep.equal([]);
            const threads = await getThread(ownClient, [t1, t2]);
            expect(threads.notFound).to.deep.equal([]);
            expect(threads.list).to.have.length(2);
        });

        scenario('THR-024', async () => {
            const other = await accounts.createUser();
            const otherClient = jmap.forUser(other);
            const a = `<shared.${tag()}@x>`;
            const subject = `Shared ${tag()}`;
            const [aA, aB] = await deliver([user, other], { subject, messageId: a });
            const [rA, rB] = await deliver([user, other], { subject: `Re: ${subject}`, inReplyTo: a });
            const [tA, tA2] = await threadIdsOf(client, [aA, rA]);
            const [tB, tB2] = await threadIdsOf(otherClient, [aB, rB]);
            expect(tA2).to.equal(tA);
            expect(tB2).to.equal(tB);
            expect(await emailIdsOfThread(client, tA)).to.deep.equal([aA, rA]);
            expect(await emailIdsOfThread(otherClient, tB)).to.deep.equal([aB, rB]);
            expect((await getThread(otherClient, [tA])).notFound).to.deep.equal([tA]);
            expect((await getThread(client, [tB])).notFound).to.deep.equal([tB]);
        });

        scenario('THR-025', async () => {
            const { user: own, client: ownClient } = await setupUser();
            const a = `<expired.${tag()}@x>`;
            const subject = `Expiring ${tag()}`;
            const ea = await deliver(own, { subject, messageId: a });
            const t1 = await threadIdOf(ownClient, ea);
            const db = await seed.db();
            await db.collection('threads').deleteOne({ _id: new seed.ObjectId(t1.slice(1)), user: new seed.ObjectId(own.id) });
            const state = await stateOf(ownClient);

            const reply = await deliver(own, { subject: `Re: ${subject}`, inReplyTo: a });
            const t2 = await threadIdOf(ownClient, reply);
            expect(t2).to.not.equal(t1);
            expect(await threadIdOf(ownClient, ea)).to.equal(t1);
            expect(await emailIdsOfThread(ownClient, t1)).to.deep.equal([ea]);
            const changes = await threadChanges(ownClient, state);
            expect(changes.created).to.deep.equal([t2]);
            expect(changes.destroyed).to.deep.equal([]);
        });
    });

    describe('thread ids across changes', () => {
        scenario('THR-026', async () => {
            const { user, client } = await setupUser();
            const boxes = await accounts.mailboxes(user);
            await createMailbox(user, 'Projects');
            const subject = `Immutable ${tag()}`;
            const msgid = `<imm.${tag()}@x>`;
            const e1 = await deliver(user, { subject, messageId: msgid });
            const e2 = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const threadId = await threadIdOf(client, e1);
            const extra = [];

            const check = async () => {
                expect(await threadIdsOf(client, [e1, e2, ...extra])).to.deep.equal(Array(2 + extra.length).fill(threadId));
                expect([...(await emailIdsOfThread(client, threadId))].sort()).to.deep.equal([e1, e2, ...extra].sort());
            };

            await check();
            await imapFlags(user, e1, 'add', ['\\Seen', '\\Flagged']);
            await check();
            await seed.withImap(user, async imapClient => {
                await imapClient.mailboxOpen('INBOX');
                await imapClient.messageMove(String((await docOf(user, e1)).uid), 'Projects', { uid: true });
            });
            await check();
            await seed.withImap(user, imapClient => imapClient.mailboxRename('Projects', 'Projects renamed'));
            await check();
            await api('PUT', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages`, {
                message: String((await docOf(user, e2)).uid),
                moveTo: boxes['\\Trash'].id
            });
            await check();
            extra.push(await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid }));
            await check();
        });

        scenario('THR-027', async () => {
            const { user, client } = await setupUser();
            const projects = await createMailbox(user, 'Projects');
            const e1 = await deliver(user, { subject: `Copied ${tag()}` });
            const threadId = await threadIdOf(client, e1);
            const state = await stateOf(client);
            await seed.withImap(user, async imapClient => {
                await imapClient.mailboxOpen('INBOX');
                await imapClient.messageCopy('1:*', 'Projects');
            });
            const emailIds = await emailIdsOfThread(client, threadId);
            expect(emailIds).to.have.length(2);
            expect(emailIds).to.include(e1);
            const e2 = emailIds.find(id => id !== e1);
            const copy = await client.method('Email/get', { ids: [e2], properties: ['mailboxIds', 'threadId'] });
            expect(copy.list[0].mailboxIds).to.deep.equal({ [projects]: true });
            expect(copy.list[0].threadId).to.equal(threadId);
            const changes = await threadChanges(client, state);
            expect(changes.updated).to.deep.equal([threadId]);
            expect(changes.created).to.deep.equal([]);
            expect(changes.destroyed).to.deep.equal([]);
        });

        scenario('THR-028', async () => {
            const { user, client } = await setupUser();
            const subject = `Draft reply ${tag()}`;
            const msgid = `<draft.${tag()}@x>`;
            const a = await deliver(user, { subject, messageId: msgid });
            // A is read: RFC 8621 counts a thread as unread in every mailbox it touches when any of its Emails is unread
            await imapFlags(user, a, 'add', ['\\Seen']);
            const threadId = await threadIdOf(client, a);
            const draft = await append(user, 'Drafts', { subject: `Re: ${subject}`, inReplyTo: msgid }, ['\\Draft'], new Date(Date.now() + 1000));
            expect(await threadIdOf(client, draft)).to.equal(threadId);
            const emailIds = await emailIdsOfThread(client, threadId);
            expect(emailIds[emailIds.length - 1]).to.equal(draft);
            const boxes = await client.method('Mailbox/get', { ids: null, properties: ['role', 'totalThreads', 'unreadThreads'] });
            const inbox = boxes.list.find(entry => entry.role === 'inbox');
            const drafts = boxes.list.find(entry => entry.role === 'drafts');
            expect(inbox.totalThreads).to.equal(1);
            expect(drafts.totalThreads).to.equal(1);
            expect(drafts.unreadThreads).to.equal(0);
        });
    });

    describe('Thread/changes', () => {
        scenario('THR-030', async () => {
            const { user, client } = await setupUser();
            await deliver(user, { subject: `Quiet ${tag()}` });
            const state = await stateOf(client);
            const res = await threadChanges(client, state);
            expect(res).to.deep.equal({
                accountId: client.accountId,
                oldState: state,
                newState: state,
                hasMoreChanges: false,
                created: [],
                updated: [],
                destroyed: []
            });
        });

        scenario('THR-031', async () => {
            const { user, client } = await setupUser();
            const state = await stateOf(client);
            const emailId = await deliver(user, { subject: `New thread ${tag()}` });
            const threadId = await threadIdOf(client, emailId);
            const [[, threads], [, emails]] = await client.call([
                ['Thread/changes', { accountId: true, sinceState: state }, 't'],
                ['Email/changes', { accountId: true, sinceState: state }, 'e']
            ]);
            expect(threads.created).to.deep.equal([threadId]);
            expect(threads.updated).to.deep.equal([]);
            expect(threads.destroyed).to.deep.equal([]);
            expect(emails.created).to.deep.equal([emailId]);
            expect(threads.newState).to.equal(emails.newState);
        });

        scenario('THR-032', async () => {
            const { user, client } = await setupUser();
            const msgid = `<join.${tag()}@x>`;
            const subject = `Joined ${tag()}`;
            const first = await deliver(user, { subject, messageId: msgid });
            const threadId = await threadIdOf(client, first);
            const state = await stateOf(client);
            await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const res = await threadChanges(client, state);
            expect(res.updated).to.deep.equal([threadId]);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(await emailIdsOfThread(client, threadId)).to.have.length(2);
        });

        scenario('THR-033', async () => {
            const { user, client } = await setupUser();
            const msgid = `<remove.${tag()}@x>`;
            const subject = `Removal ${tag()}`;
            const m1 = await deliver(user, { subject, messageId: msgid });
            const m2 = await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const threadId = await threadIdOf(client, m1);
            const s1 = await stateOf(client);

            await imapExpunge(user, [m1]);
            const first = await threadChanges(client, s1);
            expect(first.updated).to.deep.equal([threadId]);
            expect(first.created).to.deep.equal([]);
            expect(first.destroyed).to.deep.equal([]);
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal([m2]);

            await imapExpunge(user, [m2]);
            const second = await threadChanges(client, first.newState);
            expect(second.destroyed).to.deep.equal([threadId]);
            expect(second.created).to.deep.equal([]);
            expect(second.updated).to.deep.equal([]);
            expect((await getThread(client, [threadId])).notFound).to.deep.equal([threadId]);
        });

        scenario('THR-035', async () => {
            const { user, client } = await setupUser();
            const e = await deliver(user, { subject: `Toggle ${tag()}` });
            const threadId = await threadIdOf(client, e);
            const s1 = await stateOf(client);

            await imapFlags(user, e, 'add', ['\\Deleted']);
            const first = await threadChanges(client, s1);
            expect(first.destroyed).to.deep.equal([threadId]);
            expect(first.created).to.deep.equal([]);
            expect(first.updated).to.deep.equal([]);

            await imapFlags(user, e, 'remove', ['\\Deleted']);
            const second = await threadChanges(client, first.newState);
            expect(second.created).to.deep.equal([threadId]);
            expect(second.updated).to.deep.equal([]);
            expect(second.destroyed).to.deep.equal([]);
            expect((await getThread(client, [threadId])).list).to.deep.equal([{ id: threadId, emailIds: [e] }]);
        });

        scenario('THR-036', async () => {
            const { user, client } = await setupUser();
            const s1 = await stateOf(client);
            const e = await deliver(user, { subject: `Short lived ${tag()}` });
            const threadId = await threadIdOf(client, e);
            await imapExpunge(user, [e]);
            const res = await threadChanges(client, s1);
            expect(res.created).to.not.include(threadId);
            expect(res.updated).to.not.include(threadId);
            expect(res.destroyed).to.not.include(threadId);
            expect(res.newState).to.not.equal(s1);
        });

        scenario('THR-037', async () => {
            const { user, client } = await setupUser();
            await createMailbox(user, 'Projects');
            const msgid = `<move.${tag()}@x>`;
            const subject = `Moving ${tag()}`;
            const m1 = await deliver(user, { subject, messageId: msgid });
            await deliver(user, { subject: `Re: ${subject}`, inReplyTo: msgid });
            const threadId = await threadIdOf(client, m1);
            const before = await emailIdsOfThread(client, threadId);
            const s1 = await stateOf(client);
            await seed.withImap(user, async imapClient => {
                await imapClient.mailboxOpen('INBOX');
                await imapClient.messageMove(String((await docOf(user, m1)).uid), 'Projects', { uid: true });
            });
            const res = await threadChanges(client, s1);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.updated.filter(id => id !== threadId)).to.deep.equal([]);
            expect(await emailIdsOfThread(client, threadId)).to.deep.equal(before);
        });

        scenario('THR-038', async () => {
            const { user, client } = await setupUser();
            const e = await deliver(user, { subject: `Seen ${tag()}` });
            const threadId = await threadIdOf(client, e);
            const s1 = await stateOf(client);
            await imapFlags(user, e, 'add', ['\\Seen']);
            const res = await threadChanges(client, s1);
            expect(res.newState).to.not.equal(s1);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.updated.filter(id => id !== threadId)).to.deep.equal([]);
        });

        scenario('THR-039', async () => {
            const { user, client } = await setupUser();
            const s1 = await stateOf(client);
            const emails = [];
            for (let i = 0; i < 5; i++) {
                emails.push(await deliver(user, { subject: `Page ${i} ${tag()}` }));
            }
            const threadIds = await threadIdsOf(client, emails);

            const created = [];
            let state = s1;
            for (let page = 0; page < 10; page++) {
                const res = await threadChanges(client, state, { maxChanges: 2 });
                const ids = res.created.concat(res.updated, res.destroyed);
                expect(ids.length).to.be.at.most(2);
                expect(res.newState).to.not.equal(state);
                created.push(...res.created);
                state = res.newState;
                if (!res.hasMoreChanges) {
                    break;
                }
            }
            expect(created.sort()).to.deep.equal([...threadIds].sort());
            await expectError(threadChanges(client, s1, { maxChanges: 0 }), 'invalidArguments');
        });

        scenario('THR-040', async () => {
            const { user, client } = await setupUser();
            await deliver(user, { subject: `Expired state ${tag()}` });
            // an anchor older than any journal retention stands for a state whose changes expired
            const expired = forgedState(client.accountId, seed.ObjectId.createFromTime(Math.floor((Date.now() - 400 * DAY) / 1000)).toString());
            await expectError(threadChanges(client, expired), 'cannotCalculateChanges');
            await expectError(threadChanges(client, crypto.randomBytes(12).toString('base64')), 'cannotCalculateChanges');
        });
    });
});
