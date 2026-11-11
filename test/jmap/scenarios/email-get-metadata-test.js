/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-get.yaml: the /get call shape, ids and the metadata properties (EGET-001 to
// EGET-042), cross protocol agreement (EGET-180, EGET-183, EGET-184) and wildduck.yaml WDX-005.

const fs = require('fs');
const crypto = require('crypto');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');
const { newUser, append, appendAll, get, getOne, getError, expectInvalid, download, imapFor, emailIdOf, message, raw } = require('./email-get-helpers');

const { URN } = jmap;
const ID_CHARS = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/;
const DEFAULT_KEYS = [
    'id',
    'blobId',
    'threadId',
    'mailboxIds',
    'keywords',
    'size',
    'receivedAt',
    'messageId',
    'inReplyTo',
    'references',
    'sender',
    'from',
    'to',
    'cc',
    'bcc',
    'replyTo',
    'subject',
    'sentAt',
    'hasAttachment',
    'preview',
    'bodyValues',
    'textBody',
    'htmlBody',
    'attachments'
];

// the message id of an ENVELOPE field without angle brackets (and without trailing junk)
const bareId = value => {
    const match = value && /<([^<>]+)>/.exec(value);
    return match ? match[1] : null;
};

const unknownEmailId = () => 'M' + crypto.randomBytes(12).toString('hex');

/** The Email ids of a mailbox (or of the account) from Email/query */
async function queryIds(client, filter) {
    const res = await client.method('Email/query', filter ? { filter } : {});
    return res.ids;
}

/** Fetches one message over IMAP by UID in the given mailbox */
async function imapFetch(user, path, uid, query) {
    const client = await imapFor(user);
    await client.mailboxOpen(path);
    return client.fetchOne(String(uid), query, { uid: true });
}

/** IMAP flags in their JMAP keyword form, without \Recent */
function flagsAsKeywords(flags) {
    const map = { '\\seen': '$seen', '\\flagged': '$flagged', '\\answered': '$answered', '\\draft': '$draft' };
    const keywords = {};
    for (const flag of flags) {
        const lower = flag.toLowerCase();
        if (lower !== '\\recent') {
            keywords[map[lower] || lower] = true;
        }
    }
    return keywords;
}

const mixedMessage = () =>
    fixtures.buildMessage({
        text: 'Plain text version',
        html: '<p>HTML version</p>',
        attachments: [{ filename: 'notes.txt', content: 'attached notes' }]
    });

describe('Email/get call shape and ids (email-get.yaml)', () => {
    let ctx;
    let ids;

    before(async () => {
        ctx = await newUser();
        ids = await appendAll(ctx.user, [await fixtures.buildMessage(), await fixtures.buildMessage(), await mixedMessage()]);
    });

    scenario('EGET-001', async () => {
        const { user, client } = await newUser();
        await append(user, await fixtures.buildMessage());
        const [id] = await queryIds(client);
        const responses = await client.call([['Email/get', { accountId: client.accountId, ids: [id] }, 'call-1']]);
        expect(responses).to.have.length(1);
        const [name, args, callId] = responses[0];
        expect(name).to.equal('Email/get');
        expect(callId).to.equal('call-1');
        expect(args.accountId).to.equal(client.accountId);
        expect(args.state).to.be.a('string').that.is.not.empty;
        expect(args.list).to.have.length(1);
        expect(args.list[0].id).to.equal(id);
        expect(args.notFound).to.deep.equal([]);
    });

    scenario('EGET-002', async () => {
        const id = 'M' + '0'.repeat(24);
        const res = await get(ctx.client, id);
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.deep.equal([id]);
    });

    scenario('EGET-003', async () => {
        const mailbox = (await accounts.mailboxes(ctx.user)).INBOX.id;
        const bad = ['invalid', 'M123', 'Mzzzzzzzzzzzzzzzzzzzzzzzz', 'F' + mailbox];
        const res = await get(ctx.client, bad);
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.have.members(bad);
        expect(res.notFound).to.have.length(4);
    });

    scenario('EGET-004', async () => {
        const unknown = unknownEmailId();
        const res = await get(ctx.client, [ids[0], unknown, ids[1]], { properties: ['id'] });
        expect(res.list.map(email => email.id)).to.have.members([ids[0], ids[1]]);
        expect(res.list).to.have.length(2);
        expect(res.notFound).to.deep.equal([unknown]);
    });

    scenario('EGET-005', async () => {
        const unknown = unknownEmailId();
        const res = await get(ctx.client, [ids[0], ids[0], unknown, unknown], { properties: ['id'] });
        expect(res.list).to.deep.equal([{ id: ids[0] }]);
        expect(res.notFound).to.deep.equal([unknown]);
    });

    scenario('EGET-006', async () => {
        const res = await get(ctx.client, []);
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.deep.equal([]);
        expect(res.state).to.be.a('string').that.is.not.empty;
    });

    scenario('EGET-007', async () => {
        for (const args of [{ ids: null }, {}]) {
            const err = await getError(ctx.client, args);
            expect(err.type, JSON.stringify(args)).to.equal('invalidArguments');
        }
    });

    scenario('EGET-008', async () => {
        const bad = [{ ids: ids[0] }, { ids: [1] }, { ids: [ids[0]], properties: 'subject' }, { ids: [ids[0]], properties: [null] }];
        for (const args of bad) {
            // each bad call is followed by a good one in the same request
            const responses = await ctx.client.call([
                ['Email/get', Object.assign({ accountId: ctx.client.accountId }, args), 'bad'],
                ['Email/get', { accountId: ctx.client.accountId, ids: [ids[0]], properties: ['id'] }, 'good']
            ]);
            expect(responses[0][0], JSON.stringify(args)).to.equal('error');
            expect(responses[0][1].type).to.equal('invalidArguments');
            expect(responses[1][0]).to.equal('Email/get');
            expect(responses[1][1].list).to.deep.equal([{ id: ids[0] }]);
        }
    });

    scenario('EGET-009', async () => {
        const other = await accounts.createUser();
        for (const accountId of ['u' + crypto.randomBytes(12).toString('hex'), 'u' + other.id]) {
            const res = await ctx.client.request({ using: [URN.core, URN.mail], methodCalls: [['Email/get', { accountId, ids: [ids[0]] }, 'c0']] });
            expect(res.status).to.equal(200);
            const [[name, args]] = res.json.methodResponses;
            expect(name).to.equal('error');
            expect(args.type).to.equal('accountNotFound');
        }
    });

    scenario('EGET-010', async () => {
        const b = await newUser();
        const { id } = await append(b.user, await fixtures.buildMessage());
        const res = await get(ctx.client, id);
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.deep.equal([id]);
        expect(JSON.stringify(res)).to.not.include('Scenario message');
    });

    scenario('EGET-011', async () => {
        for (const using of [[URN.core], []]) {
            const res = await ctx.client.request({ using, methodCalls: [['Email/get', { accountId: ctx.client.accountId, ids: [ids[0]] }, 'c0']] });
            expect(res.status).to.equal(200);
            const [[name, args]] = res.json.methodResponses;
            expect(name).to.equal('error');
            expect(args.type).to.equal('unknownMethod');
        }
    });

    scenario('EGET-012', async () => {
        const email = await getOne(ctx.client, ids[2]);
        expect(Object.keys(email)).to.have.members(DEFAULT_KEYS);
        expect(Object.keys(email)).to.have.length(DEFAULT_KEYS.length);
        expect(email).to.not.have.property('headers');
        expect(email).to.not.have.property('bodyStructure');
        expect(email.bodyValues).to.deep.equal({});
    });

    scenario('EGET-013', async () => {
        const email = await getOne(ctx.client, ids[0], { properties: null });
        expect(Object.keys(email)).to.have.members(DEFAULT_KEYS);
        expect(Object.keys(email)).to.have.length(DEFAULT_KEYS.length);
    });

    scenario('EGET-014', async () => {
        const email = await getOne(ctx.client, ids[0], { properties: ['subject', 'size'] });
        expect(Object.keys(email)).to.have.members(['id', 'subject', 'size']);
        expect(Object.keys(email)).to.have.length(3);
    });

    scenario('EGET-015', async () => {
        const email = await getOne(ctx.client, ids[0], { properties: [] });
        expect(email).to.deep.equal({ id: ids[0] });
    });

    scenario('EGET-016', async () => {
        for (const [properties, offending] of [
            [['subject', 'invalid'], 'invalid'],
            [['Subject'], 'Subject'],
            [['deliveredTo'], 'deliveredTo']
        ]) {
            const err = await expectInvalid(ctx.client, { ids: [ids[0]], properties });
            expect(err.response.description, offending).to.include(offending);
            expect(err.response).to.not.have.property('list');
        }
    });

    scenario('EGET-017', async () => {
        const { id } = await append(
            ctx.user,
            await fixtures.buildMessage({
                cc: 'Copy <copy@example.com>',
                text: 'Plain',
                html: '<b>Rich</b>',
                attachments: [{ filename: 'a.txt', content: 'attachment' }]
            })
        );
        const properties = [...DEFAULT_KEYS, 'headers', 'bodyStructure'];
        const email = await getOne(ctx.client, id, { properties });
        expect(Object.keys(email)).to.have.members(properties);
        expect(Object.keys(email)).to.have.length(26);
        expect(email.headers).to.be.an('array').that.is.not.empty;
        for (const header of email.headers) {
            expect(Object.keys(header)).to.have.members(['name', 'value']);
            expect(header.name).to.be.a('string');
            expect(header.value).to.be.a('string');
        }
        expect(email.bodyStructure).to.be.an('object');
        expect(email.bodyStructure.type).to.be.a('string');
        expect(email.textBody).to.be.an('array');
        expect(email.htmlBody).to.be.an('array');
        expect(email.attachments).to.be.an('array');
        expect(email.bodyValues).to.be.an('object');
        expect(email.size).to.be.a('number');
        expect(email.receivedAt).to.be.a('string');
        expect(email.keywords).to.be.an('object');
        expect(email.mailboxIds).to.be.an('object');
        expect(email.from).to.be.an('array');
        expect(email.subject).to.be.a('string');
        expect(email.sentAt).to.be.a('string');
        expect(email.messageId).to.be.an('array');
        expect(email.hasAttachment).to.be.a('boolean');
        expect(email.preview).to.be.a('string');
    });

    scenario('EGET-018', async () => {
        const { user, client } = await newUser();
        const { uid, id } = await append(user, await fixtures.buildMessage());
        const s1 = (await get(client, id)).state;
        expect((await get(client, id)).state).to.equal(s1);

        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
        const s2 = await clock.waitFor(async () => {
            const state = (await get(client, id)).state;
            return state !== s1 && state;
        });
        const changes = await client.method('Email/changes', { sinceState: s1 });
        expect(changes.newState).to.equal(s2);
    });

    scenario('EGET-019', async () => {
        const session = await ctx.client.session();
        const max = session.capabilities[URN.core].maxObjectsInGet;
        expect(max).to.be.a('number');
        const many = Array.from({ length: max }, (entry, i) => (i === 0 ? ids[0] : unknownEmailId()));
        const res = await get(ctx.client, many, { properties: ['id'] });
        expect(res.list).to.have.length(1);
        expect(res.notFound).to.have.length(max - 1);

        const err = await getError(ctx.client, { ids: [...many, unknownEmailId()], properties: ['id'] });
        expect(err.type).to.equal('requestTooLarge');
        expect(err.response).to.not.have.property('list');
    });

    scenario('EGET-020', async () => {
        const { user, client } = await newUser();
        const appended = await appendAll(user, [await fixtures.buildMessage(), await fixtures.buildMessage(), await fixtures.buildMessage()]);
        const responses = await client.call([
            ['Email/query', { accountId: client.accountId }, 'q'],
            ['Email/get', { accountId: client.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g']
        ]);
        const [name, args] = responses[1];
        expect(name).to.equal('Email/get');
        expect(args.list.map(email => email.id)).to.have.members(appended);
        expect(args.list).to.have.length(3);
        expect(args.list.every(email => typeof email.subject === 'string')).to.be.true;
    });

    scenario('EGET-021', async () => {
        const { user, client } = await newUser();
        await append(user, await fixtures.buildMessage());
        await seed.deliver(user.address, await fixtures.buildMessage());
        const all = await clock.waitFor(async () => {
            const found = await queryIds(client);
            return found.length === 2 && found;
        });
        const res = await get(client, all, { properties: ['id', 'blobId', 'threadId', 'mailboxIds'] });
        expect(res.list).to.have.length(2);
        for (const email of res.list) {
            expect(email.id).to.match(/^M[0-9a-f]{24}$/);
            expect(email.blobId).to.match(ID_CHARS);
            expect(email.threadId).to.match(ID_CHARS);
            for (const key of Object.keys(email.mailboxIds)) {
                expect(key).to.match(ID_CHARS);
            }
        }
    });
});

describe('Email/get visibility across IMAP changes (email-get.yaml)', () => {
    scenario('EGET-022', async () => {
        const { user, client } = await newUser();
        const { id, uid } = await append(user, await fixtures.buildMessage());
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
        const res = await get(client, id);
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.deep.equal([id]);
    });

    scenario('EGET-023', async () => {
        const { user, client } = await newUser();
        const { id, uid } = await append(user, await fixtures.buildMessage());
        const properties = ['blobId', 'threadId', 'size', 'receivedAt', 'keywords'];
        const before = await getOne(client, id, { properties });
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
        expect((await get(client, id)).notFound).to.deep.equal([id]);
        await imap.messageFlagsRemove(String(uid), ['\\Deleted'], { uid: true });
        const after = await getOne(client, id, { properties });
        expect(after.id).to.equal(id);
        for (const property of ['blobId', 'threadId', 'size', 'receivedAt']) {
            expect(after[property], property).to.equal(before[property]);
        }
        expect(Object.keys(after.keywords).some(keyword => keyword.includes('deleted'))).to.be.false;
    });

    scenario('EGET-024', async () => {
        const { user, client } = await newUser();
        const { id, uid } = await append(user, await fixtures.buildMessage());
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageDelete(String(uid), { uid: true });
        const db = await seed.db();
        // WildDuck keeps the expunged message in the archive
        await clock.waitFor(() => db.collection('archived').findOne({ user: new seed.ObjectId(user.id), root: new seed.ObjectId(id.slice(1)) }));
        const res = await get(client, id);
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.deep.equal([id]);
    });

    const MOVE_PROPERTIES = ['blobId', 'threadId', 'size', 'receivedAt', 'keywords', 'mailboxIds'];

    async function expectMoved(client, id, before, targetPath, user) {
        const after = await getOne(client, id, { properties: MOVE_PROPERTIES });
        for (const property of ['blobId', 'threadId', 'size', 'receivedAt', 'keywords']) {
            expect(after[property], property).to.deep.equal(before[property]);
        }
        const target = (await accounts.mailboxes(user))[targetPath].id;
        expect(after.mailboxIds).to.deep.equal({ ['F' + target]: true });
    }

    scenario('EGET-025', async () => {
        const { user, client } = await newUser();
        await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
        const { id, uid } = await append(user, await fixtures.buildMessage(), { flags: ['\\Seen'] });
        const before = await getOne(client, id, { properties: MOVE_PROPERTIES });
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageMove(String(uid), 'Archive', { uid: true });
        await expectMoved(client, id, before, 'Archive', user);
    });

    scenario('EGET-026', async () => {
        const { user, client } = await newUser();
        const archive = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
        const { id, uid } = await append(user, await fixtures.buildMessage(), { flags: ['\\Seen'] });
        const before = await getOne(client, id, { properties: MOVE_PROPERTIES });
        const inbox = (await accounts.mailboxes(user)).INBOX.id;
        await api('PUT', `/users/${user.id}/mailboxes/${inbox}/messages/${uid}`, { moveTo: archive.id });
        await expectMoved(client, id, before, 'Archive', user);
    });

    scenario('EGET-027', async () => {
        const { user, client } = await newUser();
        const archive = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
        const { id: e1, uid } = await append(user, await fixtures.buildMessage());
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageCopy(String(uid), 'Archive', { uid: true });
        const [e2] = await queryIds(client, { inMailbox: 'F' + archive.id });
        expect(e2).to.be.a('string');
        expect(e2).to.not.equal(e1);
        const res = await get(client, [e1, e2], { properties: ['mailboxIds', 'blobId', 'size', 'messageId', 'threadId'] });
        const [one, two] = [e1, e2].map(id => res.list.find(email => email.id === id));
        const inbox = (await accounts.mailboxes(user)).INBOX.id;
        expect(one.mailboxIds).to.deep.equal({ ['F' + inbox]: true });
        expect(two.mailboxIds).to.deep.equal({ ['F' + archive.id]: true });
        expect(two.size).to.equal(one.size);
        expect(two.messageId).to.deep.equal(one.messageId);
        expect((await download(client, two.blobId)).equals(await download(client, one.blobId))).to.be.true;
    });

    scenario('EGET-028', async () => {
        const { user, client } = await newUser();
        const content = await fixtures.buildMessage();
        const [a, b] = await appendAll(user, [content, content]);
        const res = await get(client, [a, b], { properties: ['blobId', 'size', 'messageId', 'subject'] });
        const [one, two] = res.list;
        expect(one.id).to.not.equal(two.id);
        expect(one.blobId).to.not.equal(two.blobId);
        expect(one.size).to.equal(two.size);
        expect(one.messageId).to.deep.equal(two.messageId);
        expect(one.subject).to.equal(two.subject);
    });

    scenario('EGET-029', async () => {
        const { user, client } = await newUser();
        const content = message(
            ['From: a@example.com', 'To: b@example.com', 'Subject: exact bytes', 'Message-ID: <exact@example.com>'],
            'line one\r\nline two\r\n'
        );
        const { id } = await append(user, content);
        const email = await getOne(client, id, { properties: ['blobId', 'size'] });
        const bytes = await download(client, email.blobId);
        expect(bytes.equals(content)).to.be.true;
        expect(bytes.length).to.equal(email.size);
    });

    scenario('EGET-030', async () => {
        const { user, client } = await newUser();
        const original = await fixtures.buildMessage({ subject: 'Thread topic', messageId: '<thread-root@example.com>' });
        const reply = await fixtures.buildMessage({
            subject: 'Re: Thread topic',
            inReplyTo: '<thread-root@example.com>',
            references: '<thread-root@example.com>'
        });
        const [a, b] = await appendAll(user, [original, reply]);
        const c = (await append(user, await fixtures.buildMessage({ subject: 'Something else' }))).id;
        const res = await get(client, [a, b, c], { properties: ['threadId'] });
        const byId = Object.fromEntries(res.list.map(email => [email.id, email.threadId]));
        expect(byId[a]).to.equal(byId[b]);
        expect(byId[c]).to.not.equal(byId[a]);
        const thread = await client.method('Thread/get', { ids: [byId[a]] });
        expect(thread.list[0].emailIds).to.have.members([a, b]);
    });

    scenario('EGET-031', async () => {
        const { user, client } = await newUser();
        const imap = await imapFor(user);
        await imap.mailboxCreate('A');
        await imap.mailboxCreate(['A', 'B']);
        const a = (await append(user, await fixtures.buildMessage())).id;
        const b = (await append(user, await fixtures.buildMessage(), { mailbox: 'A/B' })).id;
        const mailboxes = await client.method('Mailbox/get', { ids: null, properties: ['name', 'parentId', 'role'] });
        const inbox = mailboxes.list.find(mailbox => mailbox.role === 'inbox');
        const parent = mailboxes.list.find(mailbox => mailbox.name === 'A' && !mailbox.parentId);
        const nested = mailboxes.list.find(mailbox => mailbox.name === 'B' && mailbox.parentId === parent.id);
        const res = await get(client, [a, b], { properties: ['mailboxIds'] });
        const byId = Object.fromEntries(res.list.map(email => [email.id, email.mailboxIds]));
        expect(byId[a]).to.deep.equal({ [inbox.id]: true });
        expect(byId[b]).to.deep.equal({ [nested.id]: true });
        expect(byId[a][inbox.id]).to.equal(true);
    });
});

describe('Email/get keywords (email-get.yaml)', () => {
    let ctx;

    before(async () => {
        ctx = await newUser();
    });

    const keywordsAfterAppend = async (flags, content) => {
        const email = await getOne(ctx.client, (await append(ctx.user, content || (await fixtures.buildMessage()), { flags })).id, {
            properties: ['keywords']
        });
        return email.keywords;
    };

    scenario('EGET-032', async () => {
        const keywords = await keywordsAfterAppend([]);
        expect(keywords).to.deep.equal({});
    });

    scenario('EGET-033', async () => {
        const keywords = await keywordsAfterAppend(['\\Seen', '\\Flagged', '\\Draft', '\\Answered', '$Forwarded']);
        expect(keywords).to.deep.equal({ $seen: true, $flagged: true, $draft: true, $answered: true, $forwarded: true });
        expect(Object.keys(keywords).some(key => key.startsWith('\\'))).to.be.false;
    });

    scenario('EGET-034', async () => {
        const keywords = await keywordsAfterAppend(['MyFlag', '$MDNSent', '$Junk', 'NonJunk', '$Phishing']);
        expect(keywords).to.deep.equal({ myflag: true, $mdnsent: true, $junk: true, nonjunk: true, $phishing: true });
        expect(Object.values(keywords).every(value => value === true)).to.be.true;
    });

    scenario('EGET-035', async () => {
        const { id } = await append(ctx.user, await fixtures.buildMessage());
        const db = await seed.db();
        await db
            .collection('messages')
            .updateOne({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(id.slice(1)) }, { $set: { flags: ['Foo', 'foo', '\\SEEN'] } });
        const email = await getOne(ctx.client, id, { properties: ['keywords'] });
        expect(email.keywords).to.deep.equal({ foo: true, $seen: true });
    });

    scenario('EGET-036', async () => {
        const label = await api('POST', `/users/${ctx.user.id}/labels`, { name: `Label ${crypto.randomBytes(3).toString('hex')}` });
        const { id, uid } = await append(ctx.user, await fixtures.buildMessage());
        const inbox = (await accounts.mailboxes(ctx.user)).INBOX.id;
        await api('PUT', `/users/${ctx.user.id}/mailboxes/${inbox}/messages/${uid}`, { addLabels: [label.name] });
        const token = `$wdlabel$${label.id.toLowerCase()}`;
        const email = await getOne(ctx.client, id, { properties: ['keywords'] });
        expect(email.keywords[token]).to.equal(true);
        const fetched = await imapFetch(ctx.user, 'INBOX', uid, { flags: true });
        expect([...fetched.flags].map(flag => flag.toLowerCase())).to.include(token);
    });

    scenario('EGET-037', async () => {
        const { id, uid } = await append(ctx.user, await fixtures.buildMessage());
        expect((await getOne(ctx.client, id, { properties: ['keywords'] })).keywords).to.deep.equal({});
        const imap = await imapFor(ctx.user);
        await imap.mailboxOpen('INBOX');
        await imap.messageFlagsAdd(String(uid), ['\\Seen', 'custom1'], { uid: true });
        const first = await getOne(ctx.client, id, { properties: ['keywords'] });
        expect(first.keywords).to.deep.equal({ $seen: true, custom1: true });
        await imap.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
        const second = await getOne(ctx.client, id, { properties: ['keywords'] });
        expect(second.keywords).to.deep.equal({ custom1: true });
        expect(second.id).to.equal(id);
    });

    scenario('EGET-038', async () => {
        const { user, client } = await newUser();
        const archive = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
        const { id, uid } = await append(user, await fixtures.buildMessage());
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageCopy(String(uid), 'Archive', { uid: true });
        await imap.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        await imap.mailboxOpen('Archive');
        await imap.messageFlagsAdd('1:*', ['custom1'], { uid: true });
        const [copy] = await queryIds(client, { inMailbox: 'F' + archive.id });
        const res = await get(client, [id, copy], { properties: ['keywords'] });
        const byId = Object.fromEntries(res.list.map(email => [email.id, email.keywords]));
        expect(byId[id]).to.deep.equal({ $seen: true });
        expect(byId[copy]).to.deep.equal({ custom1: true });
    });
});

describe('Email/get size, receivedAt and immutable properties (email-get.yaml)', () => {
    scenario('EGET-039', async () => {
        const { user, client } = await newUser();
        const shapes = [
            await fixtures.buildMessage(),
            await fixtures.buildMessage({ attachments: [{ filename: 'data.bin', content: crypto.randomBytes(3000) }] }),
            raw(
                'From: a@example.com',
                'To: b@example.com',
                'Subject: 8bit',
                'Content-Type: text/plain; charset=utf-8',
                'Content-Transfer-Encoding: 8bit',
                '',
                'Tere õhtust, äge ümbrik'
            ),
            fixtures.readFixture('nodemailer.eml'),
            fixtures.readFixture('mimetorture.eml')
        ];
        for (const content of shapes) {
            const { id, uid } = await append(user, content);
            const email = await getOne(client, id, { properties: ['size', 'blobId'] });
            const fetched = await imapFetch(user, 'INBOX', uid, { size: true });
            expect(Number.isInteger(email.size) && email.size >= 0).to.be.true;
            expect(email.size).to.equal(fetched.size);
            expect((await download(client, email.blobId)).length).to.equal(email.size);
        }
    });

    scenario('EGET-040', async () => {
        const { user, client } = await newUser();
        const content = message(['From: a@example.com', 'Subject: dates', 'Date: Mon, 13 Jul 2020 10:11:12 +0200']);
        const { id, uid } = await append(user, content, { date: new Date('2020-07-14T10:11:12+02:00') });
        const email = await getOne(client, id, { properties: ['receivedAt', 'sentAt'] });
        expect(email.receivedAt).to.equal('2020-07-14T08:11:12Z');
        const fetched = await imapFetch(user, 'INBOX', uid, { internalDate: true });
        expect(new Date(email.receivedAt).getTime()).to.equal(fetched.internalDate.getTime());
        expect(new Date(email.sentAt).getTime()).to.not.equal(new Date(email.receivedAt).getTime());
    });

    scenario('EGET-041', async () => {
        const { user, client } = await newUser();
        const sent = Date.now();
        await seed.deliver(user.address, message(['From: a@example.com', 'To: ' + user.address, 'Subject: old date', 'Date: Mon, 1 Jan 2001 10:00:00 +0000']));
        const [id] = await clock.waitFor(async () => {
            const found = await queryIds(client);
            return found.length && found;
        });
        const email = await getOne(client, id, { properties: ['receivedAt'] });
        expect(email.receivedAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(Math.abs(new Date(email.receivedAt).getTime() - sent)).to.be.below(10000);
    });

    scenario('EGET-042', async () => {
        const { user, client } = await newUser();
        await api('POST', `/users/${user.id}/mailboxes`, { path: 'One' });
        await api('POST', `/users/${user.id}/mailboxes`, { path: 'Two' });
        const { id, uid } = await append(user, await fixtures.buildMessage());
        const properties = ['receivedAt', 'size', 'blobId', 'threadId'];
        const reference = await getOne(client, id, { properties });
        const imap = await imapFor(user);
        const check = async () => {
            const email = await getOne(client, id, { properties });
            for (const property of properties) {
                expect(email[property], property).to.equal(reference[property]);
            }
        };
        await imap.mailboxOpen('INBOX');
        await imap.messageFlagsAdd(String(uid), ['\\Seen', '\\Flagged'], { uid: true });
        await check();
        const moved = await imap.messageMove(String(uid), 'One', { uid: true });
        await check();
        await imap.mailboxOpen('One');
        await imap.messageMove(String(moved.uidMap.get(uid)), 'Two', { uid: true });
        await check();
    });
});

describe('Email/get against IMAP and LMTP (email-get.yaml, wildduck.yaml)', () => {
    scenario('EGET-180', async () => {
        const { user, client } = await newUser();
        const label = await api('POST', `/users/${user.id}/labels`, { name: 'Agreement' });
        const contents = [
            fixtures.readFixture('simple.eml'),
            fixtures.readFixture('nodemailer.eml'),
            fixtures.readFixture('fix1.eml'),
            fixtures.readFixture('fix3.eml'),
            fixtures.readFixture('append.eml'),
            await fixtures.buildMessage({ cc: ['Cee <cee@example.com>', 'dee@example.com'], inReplyTo: '<parent@example.com>' }),
            await fixtures.buildMessage({ subject: '=?UTF-8?Q?J=C3=A4rgmine?= teema', from: '"Jõgi, Mari" <mari@example.com>' })
        ];
        const stored = [];
        const flagSets = [[], ['\\Seen'], ['\\Flagged', 'custom'], ['\\Answered', '$Forwarded'], [], ['\\Draft'], []];
        for (const [i, content] of contents.entries()) {
            stored.push(await append(user, content, { flags: flagSets[i] }));
        }
        for (let i = 0; i < 3; i++) {
            await seed.deliver(user.address, await fixtures.buildMessage({ subject: `Delivered ${i}`, to: user.address, cc: 'other@example.com' }));
        }
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        const uids = await clock.waitFor(async () => {
            const found = await imap.search({ all: true }, { uid: true });
            return found.length === 10 && found;
        });
        for (const uid of uids.filter(uid => !stored.some(entry => entry.uid === uid))) {
            stored.push({ uid, id: await emailIdOf(user, 'INBOX', uid) });
        }
        await api('PUT', `/users/${user.id}/mailboxes/${(await accounts.mailboxes(user)).INBOX.id}/messages/${stored[0].uid}`, { addLabels: ['Agreement'] });

        const res = await get(
            client,
            stored.map(entry => entry.id)
        );
        expect(res.list).to.have.length(10);
        const addresses = list => (list || []).map(entry => entry.address || '').sort();
        for (const entry of stored) {
            const email = res.list.find(item => item.id === entry.id);
            const fetched = await imapFetch(user, 'INBOX', entry.uid, { envelope: true, flags: true, internalDate: true, size: true });
            expect(email.size).to.equal(fetched.size);
            expect(new Date(email.receivedAt).getTime()).to.equal(Math.floor(fetched.internalDate.getTime() / 1000) * 1000);
            expect(email.keywords).to.deep.equal(flagsAsKeywords([...fetched.flags]));
            expect(email.subject || '').to.equal(fetched.envelope.subject || '');
            expect((email.messageId || [])[0] || null).to.equal(bareId(fetched.envelope.messageId));
            expect((email.inReplyTo || [])[0] || null).to.equal(bareId(fetched.envelope.inReplyTo));
            for (const field of ['from', 'to', 'cc']) {
                expect((email[field] || []).map(address => address.email).sort(), field).to.deep.equal(addresses(fetched.envelope[field]));
            }
        }
        const labelled = res.list.find(item => item.id === stored[0].id);
        expect(labelled.keywords[`$wdlabel$${label.id}`]).to.equal(true);
    });

    scenario('EGET-183', async function () {
        this.timeout(180000); // eslint-disable-line no-invalid-this
        const { user, client } = await newUser();
        const session = await client.session();
        const max = session.capabilities[URN.core].maxObjectsInGet;
        await api('POST', `/users/${user.id}/mailboxes`, { path: 'Second' });
        await api('POST', `/users/${user.id}/mailboxes`, { path: 'Third' });
        const paths = ['INBOX', 'Second', 'Third'];
        const shapes = [
            i => fixtures.buildMessage({ subject: `Bulk ${i}`, text: `text-of-${i} `.repeat(40) }),
            i => fixtures.buildMessage({ subject: `Bulk ${i}`, text: `plain-of-${i}`, html: `<p>html-of-${i}</p>` }),
            i => fixtures.buildMessage({ subject: `Bulk ${i}`, text: `mixed-of-${i}`, attachments: [{ filename: `f${i}.txt`, content: `file-of-${i}` }] })
        ];
        // several IMAP sessions append in parallel
        const sessions = 10;
        const tags = Array.from({ length: max }, (entry, i) => i);
        await Promise.all(
            Array.from({ length: sessions }, async () => {
                const imap = await seed.imap(user);
                try {
                    while (tags.length) {
                        const i = tags.pop();
                        await imap.append(paths[i % paths.length], await shapes[i % shapes.length](i));
                    }
                } finally {
                    await imap.logout().catch(() => false);
                }
            })
        );
        const db = await seed.db();
        const docs = await db
            .collection('messages')
            .find({ user: new seed.ObjectId(user.id) }, { projection: { _id: true, root: true, subject: true } })
            .toArray();
        expect(docs).to.have.length(max);
        const allIds = docs.map(doc => 'M' + (doc.root || doc._id).toString());

        const res = await get(client, allIds, {
            properties: [...DEFAULT_KEYS, 'bodyStructure'],
            fetchAllBodyValues: true,
            maxBodyValueBytes: 256
        });
        expect(res.notFound).to.deep.equal([]);
        expect(res.list).to.have.length(max);
        expect(new Set(res.list.map(email => email.id)).size).to.equal(max);
        for (const email of res.list) {
            const n = /Bulk (\d+)/.exec(email.subject)[1];
            const values = Object.values(email.bodyValues);
            expect(values.length, email.subject).to.be.above(0);
            for (const value of values) {
                expect(Buffer.byteLength(value.value)).to.be.at.most(256);
                // every value belongs to this Email
                expect(value.value).to.match(new RegExp(`-of-${n}\\b`));
            }
        }
    });

    scenario('EGET-184', async () => {
        const { user, client } = await newUser();
        const content = await fixtures.buildMessage({
            subject: 'Same message twice',
            text: 'Plain text body',
            html: '<p>HTML body</p>',
            attachments: [{ filename: 'attachment.txt', content: 'attachment content' }]
        });
        // LMTP first: delivery drops a message whose Message-ID is already in the mailbox
        await seed.deliver(user.address, content);
        const [delivered] = await clock.waitFor(async () => {
            const found = await queryIds(client);
            return found.length && found;
        });
        const { id: appended } = await append(user, content);
        const properties = [...DEFAULT_KEYS, 'bodyStructure', 'headers'];
        const res = await get(client, [appended, delivered], { properties, fetchAllBodyValues: true });
        const [a, b] = [appended, delivered].map(id => res.list.find(email => email.id === id));
        const deliveryHeaders = ['delivered-to', 'return-path', 'received', 'x-original-to'];
        const strip = email => {
            const copy = JSON.parse(JSON.stringify(email));
            for (const key of ['id', 'blobId', 'threadId', 'receivedAt', 'size', 'mailboxIds', 'keywords']) {
                delete copy[key];
            }
            copy.headers = copy.headers.filter(header => !deliveryHeaders.includes(header.name.toLowerCase()));
            const clean = part => {
                delete part.blobId;
                if (part.headers) {
                    part.headers = part.headers.filter(header => !deliveryHeaders.includes(header.name.toLowerCase()));
                }
                (part.subParts || []).forEach(clean);
            };
            clean(copy.bodyStructure);
            [...copy.textBody, ...copy.htmlBody, ...copy.attachments].forEach(clean);
            return copy;
        };
        expect(strip(b)).to.deep.equal(strip(a));
    });

    scenario('WDX-005', async function () {
        this.timeout(120000); // eslint-disable-line no-invalid-this
        const { user, client } = await newUser();
        const files = fixtures.listFixtures('.eml');
        expect(files.length).to.be.above(5);
        const flagSets = [[], ['\\Seen'], ['\\Flagged', 'Custom'], ['\\Answered', '\\Draft']];
        for (const [i, file] of files.entries()) {
            const content = fs.readFileSync(file);
            const { id, uid } = await append(user, content, { flags: flagSets[i % flagSets.length] });
            const email = await getOne(client, id, { properties: ['size', 'receivedAt', 'keywords', 'blobId'] });
            const fetched = await imapFetch(user, 'INBOX', uid, { size: true, internalDate: true, flags: true, source: true });
            expect(email.size, file).to.equal(fetched.size);
            expect(new Date(email.receivedAt).getTime(), file).to.equal(fetched.internalDate.getTime());
            expect(email.keywords, file).to.deep.equal(flagsAsKeywords([...fetched.flags]));
            const blob = await download(client, email.blobId);
            expect(blob.equals(fetched.source), file).to.be.true;
        }
    });
});
