/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file email-import-copy.yaml, Email/import (EIMP), and the import scenarios of other files:
// ECHG-109 (email-changes.yaml), EDLV-012 (push.yaml) and BLOB-034 (blob.yaml).

const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, api, seed, clock, jmap } = require('../harness');
const { startInstance, stopInstance, connect } = require('../harness/instance');
const sse = require('../harness/sse');
const StorageHandler = require('../../../lib/storage-handler');
const h = require('./email-get-helpers');

const EMAIL_ID = /^M[0-9a-f]{24}$/;

/** Uploads a body and answers the blob id */
async function upload(client, body, type = 'message/rfc822', base = jmap.JMAP_URL) {
    const res = await client.raw(`${base}/jmap/upload/${client.accountId}/`, { method: 'POST', body, headers: { 'Content-Type': type } });
    expect(res.status, res.body.toString()).to.equal(201);
    return res.json.blobId;
}

/** Email/import answering the response arguments */
const importEmails = (client, emails, extra = {}) => client.method('Email/import', Object.assign({ emails }, extra));

/** Imports one blob into one mailbox and answers the created entry (fails when it was not created) */
async function importOne(client, blobId, mailboxId, extra = {}) {
    const res = await importEmails(client, { one: Object.assign({ blobId, mailboxIds: { [mailboxId]: true } }, extra) });
    expect(res.notCreated, JSON.stringify(res.notCreated)).to.equal(null);
    return res.created.one;
}

/** Imports one entry that must fail and answers its SetError */
async function importFails(client, entry) {
    const res = await importEmails(client, { bad: entry });
    expect(res.created, JSON.stringify(res.created)).to.equal(null);
    return res.notCreated.bad;
}

async function methodError(client, name, args, using) {
    try {
        await client.method(name, args, using);
    } catch (err) {
        if (err.type) {
            return err.type;
        }
        throw err;
    }
    throw new Error(`${name} did not fail`);
}

const message = (subject, extra = [], body = `Body of ${subject}`) =>
    h.raw(
        'From: Import Sender <sender@example.org>',
        'To: Import Rcpt <rcpt@example.com>',
        `Subject: ${subject}`,
        'Date: Mon, 06 Jan 2020 10:00:00 +0000',
        `Message-ID: <${crypto.randomBytes(6).toString('hex')}@import.example>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        ...extra,
        '',
        body,
        ''
    );

/** The stored message document of an Email id */
async function messageDoc(user, emailId) {
    const db = await seed.db();
    return db.collection('messages').findOne({ user: new seed.ObjectId(user.id), root: new seed.ObjectId(emailId.slice(1)) });
}

const messageCount = async user => (await seed.db()).collection('messages').countDocuments({ user: new seed.ObjectId(user.id) });
const storageUsed = async user => (await api('GET', `/users/${user.id}`)).limits.quota.used;

/** IMAP FETCH of the message of an Email id */
async function imapFetch(user, emailId, query) {
    const doc = await messageDoc(user, emailId);
    const db = await seed.db();
    const mailbox = await db.collection('mailboxes').findOne({ _id: doc.mailbox });
    return seed.withImap(user, async client => {
        await client.mailboxOpen(mailbox.path);
        return client.fetchOne(String(doc.uid), query, { uid: true });
    });
}

describe('Email/import', function () {
    this.timeout(180000);
    let ctx;
    let boxes;

    // a user with an Archive mailbox; boxes maps role or name to the Mailbox id
    async function newContext(options) {
        const created = await h.newUser(options);
        await api('POST', `/users/${created.user.id}/mailboxes`, { path: 'Archive' });
        const list = (await created.client.method('Mailbox/get', { ids: null })).list;
        const byName = {};
        for (const mailbox of list) {
            byName[mailbox.role || mailbox.name] = mailbox.id;
            byName[mailbox.name] = mailbox.id;
        }
        return Object.assign(created, { boxes: byName });
    }

    const state = async (client = ctx.client) => (await client.method('Email/get', { ids: [] })).state;
    const mailbox = async (id, client = ctx.client) => (await client.method('Mailbox/get', { ids: [id] })).list[0];

    before(async () => {
        ctx = await newContext();
        boxes = ctx.boxes;
    });

    scenario('EIMP-001', async () => {
        const content = message('Imported one');
        const blob = await upload(ctx.client, content);
        const res = await importEmails(ctx.client, { i1: { blobId: blob, mailboxIds: { [boxes.inbox]: true } } });
        expect(res.notCreated).to.equal(null);
        const created = res.created.i1;
        expect(created.id).to.match(EMAIL_ID);
        expect(created.blobId).to.be.a('string');
        expect(created.threadId).to.match(/^T[0-9a-f]{24}$/);
        expect(created.size).to.equal(content.length);
        const email = await h.getOne(ctx.client, created.id, {
            properties: ['subject', 'from', 'mailboxIds', 'textBody', 'bodyValues'],
            fetchTextBodyValues: true
        });
        expect(email.subject).to.equal('Imported one');
        expect(email.from).to.deep.equal([{ name: 'Import Sender', email: 'sender@example.org' }]);
        expect(email.mailboxIds).to.deep.equal({ [boxes.inbox]: true });
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('Body of Imported one\n');
    });

    scenario('EIMP-002', async () => {
        const blob = await upload(ctx.client, message('State check'));
        const s0 = await state();
        const [[name, res]] = await ctx.client.call([
            ['Email/import', { accountId: ctx.client.accountId, emails: { e: { blobId: blob, mailboxIds: { [boxes.inbox]: true } } } }, 'c0']
        ]);
        expect(name).to.equal('Email/import');
        expect(res).to.have.all.keys('accountId', 'oldState', 'newState', 'created', 'notCreated');
        expect(res.accountId).to.equal(ctx.client.accountId);
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.not.equal(s0);
        expect(res.created).to.have.all.keys('e');
        expect(res.notCreated).to.equal(null);
        expect(await state()).to.equal(res.newState);
        const changes = await ctx.client.method('Email/changes', { sinceState: s0 });
        expect(changes.created).to.include(res.created.e.id);
    });

    scenario('EIMP-003', async () => {
        const [inboxBefore, archiveBefore] = [await mailbox(boxes.inbox), await mailbox(boxes.Archive)];
        const blobs = [];
        for (const subject of ['Multi one', 'Multi two', 'Multi three']) {
            blobs.push(await upload(ctx.client, message(subject)));
        }
        const res = await importEmails(ctx.client, {
            a: { blobId: blobs[0], mailboxIds: { [boxes.inbox]: true } },
            b: { blobId: blobs[1], mailboxIds: { [boxes.Archive]: true } },
            c: { blobId: blobs[2], mailboxIds: { [boxes.inbox]: true } }
        });
        expect(res.created).to.have.all.keys('a', 'b', 'c');
        const ids = Object.values(res.created).map(entry => entry.id);
        expect(new Set(ids).size).to.equal(3);
        const emails = await ctx.client.method('Email/get', { ids, properties: ['mailboxIds'] });
        const where = Object.fromEntries(emails.list.map(email => [email.id, Object.keys(email.mailboxIds)]));
        expect(where[res.created.a.id]).to.deep.equal([boxes.inbox]);
        expect(where[res.created.b.id]).to.deep.equal([boxes.Archive]);
        expect(where[res.created.c.id]).to.deep.equal([boxes.inbox]);
        expect((await mailbox(boxes.inbox)).totalEmails).to.equal(inboxBefore.totalEmails + 2);
        expect((await mailbox(boxes.Archive)).totalEmails).to.equal(archiveBefore.totalEmails + 1);
    });

    scenario('EIMP-004', async () => {
        const blob = await upload(ctx.client, message('One of two'));
        const s0 = await state();
        const unknown = `Bu${new seed.ObjectId().toString()}`;
        const res = await importEmails(ctx.client, {
            ok: { blobId: blob, mailboxIds: { [boxes.inbox]: true } },
            bad: { blobId: unknown, mailboxIds: { [boxes.inbox]: true } }
        });
        expect(res.created).to.have.all.keys('ok');
        expect(res.notCreated).to.have.all.keys('bad');
        expect(res.notCreated.bad.type).to.equal('invalidProperties');
        expect(res.newState).to.not.equal(s0);
        const email = await h.getOne(ctx.client, res.created.ok.id, { properties: ['mailboxIds'] });
        expect(email.mailboxIds).to.deep.equal({ [boxes.inbox]: true });
    });

    scenario('EIMP-005', async () => {
        const blob = await upload(ctx.client, message('Malformed arguments'));
        const before = await messageCount(ctx.user);
        expect(await methodError(ctx.client, 'Email/import', {})).to.equal('invalidArguments');
        expect(await methodError(ctx.client, 'Email/import', { emails: [{ blobId: blob, mailboxIds: { [boxes.inbox]: true } }] })).to.equal('invalidArguments');
        const stringEntry = await importEmails(ctx.client, { a: 'string' });
        expect(stringEntry.created).to.equal(null);
        expect(stringEntry.notCreated.a.type).to.equal('invalidProperties');
        expect(await methodError(ctx.client, 'Email/import', { emails: { a: { blobId: blob, mailboxIds: { [boxes.inbox]: true } } }, extra: true })).to.equal(
            'invalidArguments'
        );
        expect(await messageCount(ctx.user)).to.equal(before);
    });

    scenario('EIMP-006', async () => {
        const blob = await upload(ctx.client, message('Account errors'));
        const emails = { a: { blobId: blob, mailboxIds: { [boxes.inbox]: true } } };
        expect(await methodError(ctx.client, 'Email/import', { emails }, [jmap.URN.core])).to.equal('unknownMethod');
        expect(await methodError(ctx.client, 'Email/import', { accountId: 'uffffffffffffffffffffffff', emails })).to.equal('accountNotFound');
        const [[name, res]] = await ctx.client.call([['Email/import', { emails }, 'c0']]);
        expect(name).to.equal('error');
        expect(res.type).to.equal('invalidArguments');
    });

    scenario('EIMP-007', async () => {
        const blob = await upload(ctx.client, message('Mailbox ids'));
        const before = await messageCount(ctx.user);
        const variants = [undefined, {}, null, { [`F${new seed.ObjectId().toString()}`]: true }, { [boxes.inbox]: false }, [boxes.inbox]];
        for (const mailboxIds of variants) {
            const entry = { blobId: blob };
            if (mailboxIds !== undefined) {
                entry.mailboxIds = mailboxIds;
            }
            const error = await importFails(ctx.client, entry);
            expect(error.type, JSON.stringify(mailboxIds)).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['mailboxIds']);
        }
        expect(await messageCount(ctx.user)).to.equal(before);
    });

    scenario('EIMP-008', async () => {
        const blob = await upload(ctx.client, message('Two mailboxes'));
        const [inbox, archive] = [await mailbox(boxes.inbox), await mailbox(boxes.Archive)];
        const error = await importFails(ctx.client, { blobId: blob, mailboxIds: { [boxes.inbox]: true, [boxes.Archive]: true } });
        expect(error.type).to.equal('tooManyMailboxes');
        expect((await mailbox(boxes.inbox)).totalEmails).to.equal(inbox.totalEmails);
        expect((await mailbox(boxes.Archive)).totalEmails).to.equal(archive.totalEmails);
    });

    scenario('EIMP-009', async function () {
        const blob = await upload(ctx.client, message('Into a new mailbox'));
        const responses = await ctx.client.call([
            ['Mailbox/set', { accountId: ctx.client.accountId, create: { mb: { name: `Imported${crypto.randomBytes(3).toString('hex')}` } } }, 'm'],
            ['Email/import', { accountId: ctx.client.accountId, emails: { e: { blobId: blob, mailboxIds: { '#mb': true } } } }, 'i']
        ]);
        if (responses[0][0] === 'error' && responses[0][1].type === 'unknownMethod') {
            // Mailbox/set (work package 2.2) is built in parallel; this scenario runs once it is merged
            this.skip();
        }
        const mailboxId = responses[0][1].created.mb.id;
        const [name, res] = responses[1];
        expect(name).to.equal('Email/import');
        expect(res.notCreated).to.equal(null);
        const email = await h.getOne(ctx.client, res.created.e.id, { properties: ['mailboxIds'] });
        expect(email.mailboxIds).to.deep.equal({ [mailboxId]: true });
    });

    scenario('EIMP-010', async () => {
        const blob = await upload(ctx.client, message('No keywords'));
        const res = await importEmails(ctx.client, {
            none: { blobId: blob, mailboxIds: { [boxes.Archive]: true } },
            empty: { blobId: blob, mailboxIds: { [boxes.Archive]: true }, keywords: {} }
        });
        expect(res.created).to.have.all.keys('none', 'empty');
        for (const entry of Object.values(res.created)) {
            const email = await h.getOne(ctx.client, entry.id, { properties: ['keywords'] });
            expect(email.keywords).to.deep.equal({});
            expect((await messageDoc(ctx.user, entry.id)).unseen).to.equal(true);
            const fetched = await imapFetch(ctx.user, entry.id, { flags: true });
            expect([...fetched.flags]).to.deep.equal([]);
        }
    });

    scenario('EIMP-011', async () => {
        const blob = await upload(ctx.client, message('With keywords'));
        const created = await importOne(ctx.client, blob, boxes.inbox, { keywords: { $seen: true, $flagged: true, $forwarded: true, Imported: true } });
        const email = await h.getOne(ctx.client, created.id, { properties: ['keywords'] });
        expect(email.keywords).to.deep.equal({ $seen: true, $flagged: true, $forwarded: true, imported: true });
        const fetched = await imapFetch(ctx.user, created.id, { flags: true });
        expect([...fetched.flags].map(flag => flag.toLowerCase())).to.have.members(['\\seen', '\\flagged', '$forwarded', 'imported']);
        expect([...fetched.flags]).to.include.members(['\\Seen', '\\Flagged', '$Forwarded']);
    });

    scenario('EIMP-012', async () => {
        const blob = await upload(ctx.client, message('Bad keywords'));
        const before = await messageCount(ctx.user);
        for (const keywords of [{ $seen: false }, { 'bad keyword': true }, ['$seen'], 'x', { $deleted: true }]) {
            const error = await importFails(ctx.client, { blobId: blob, mailboxIds: { [boxes.inbox]: true }, keywords });
            expect(error.type, JSON.stringify(keywords)).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['keywords']);
        }
        expect(await messageCount(ctx.user)).to.equal(before);
    });

    scenario('EIMP-013', async () => {
        const blob = await upload(ctx.client, message('A draft'));
        const drafts = await mailbox(boxes.drafts);
        const created = await importOne(ctx.client, blob, boxes.drafts, { keywords: { $draft: true } });
        const fetched = await imapFetch(ctx.user, created.id, { flags: true });
        expect([...fetched.flags]).to.include('\\Draft');
        const doc = await messageDoc(ctx.user, created.id);
        const rest = await api('GET', `/users/${ctx.user.id}/mailboxes/${doc.mailbox}/messages/${doc.uid}`);
        expect(rest.draft).to.equal(true);
        const after = await mailbox(boxes.drafts);
        expect(after.totalEmails).to.equal(drafts.totalEmails + 1);
        expect(after.unreadEmails).to.equal(drafts.unreadEmails);
    });

    scenario('EIMP-014', async () => {
        const blob = await upload(ctx.client, message('Explicit date', [], 'body'));
        const created = await importOne(ctx.client, blob, boxes.inbox, { receivedAt: '2018-03-04T05:06:07Z' });
        const email = await h.getOne(ctx.client, created.id, { properties: ['receivedAt', 'sentAt'] });
        expect(email.receivedAt).to.equal('2018-03-04T05:06:07Z');
        expect(email.sentAt).to.equal('2020-01-06T10:00:00Z');
        const fetched = await imapFetch(ctx.user, created.id, { internalDate: true });
        expect(fetched.internalDate.toISOString()).to.equal('2018-03-04T05:06:07.000Z');
    });

    scenario('EIMP-015', async () => {
        const content = Buffer.concat([
            Buffer.from(
                'Received: from mx.example.org by mail.example.com; Wed, 02 Jan 2019 03:04:05 +0000\r\n' +
                    'Received: from origin.example.net by mx.example.org; Tue, 01 Jan 2019 01:00:00 +0000\r\n'
            ),
            message('Received header')
        ]);
        const blob = await upload(ctx.client, content);
        const created = await importOne(ctx.client, blob, boxes.inbox);
        const email = await h.getOne(ctx.client, created.id, { properties: ['receivedAt'] });
        expect(email.receivedAt).to.equal('2019-01-02T03:04:05Z');
        const fetched = await imapFetch(ctx.user, created.id, { internalDate: true });
        expect(fetched.internalDate.toISOString()).to.equal('2019-01-02T03:04:05.000Z');
    });

    scenario('EIMP-016', async () => {
        const blob = await upload(ctx.client, message('No received header'));
        const started = Date.now();
        const created = await importOne(ctx.client, blob, boxes.inbox);
        const email = await h.getOne(ctx.client, created.id, { properties: ['receivedAt', 'sentAt'] });
        expect(email.sentAt).to.equal('2020-01-06T10:00:00Z');
        expect(new Date(email.receivedAt).getTime()).to.be.closeTo(started, 5000);
    });

    scenario('EIMP-017', async () => {
        const blob = await upload(ctx.client, message('Bad dates'));
        for (const receivedAt of ['2018-03-04T05:06:07+01:00', 'not a date', 12345]) {
            const error = await importFails(ctx.client, { blobId: blob, mailboxIds: { [boxes.inbox]: true }, receivedAt });
            expect(error.type, String(receivedAt)).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['receivedAt']);
        }
    });

    scenario('EIMP-018', async () => {
        for (const blobId of [`Bu${new seed.ObjectId().toString()}`, 'not a blob!', 5, undefined]) {
            const entry = { mailboxIds: { [boxes.inbox]: true } };
            if (blobId !== undefined) {
                entry.blobId = blobId;
            }
            const error = await importFails(ctx.client, entry);
            expect(error.type, String(blobId)).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['blobId']);
        }
    });

    describe('blobs that are not usable', () => {
        let storage;
        before(async () => {
            const db = await connect();
            storage = new StorageHandler({ database: db.database, users: db.users, gridfs: db.gridfs });
        });

        scenario('EIMP-019', async () => {
            const other = await h.newUser();
            const foreign = await upload(other.client, message('Not yours'));
            const own = await upload(ctx.client, message('Expired'));
            const db = await seed.db();
            await db
                .collection('storage.files')
                .updateOne({ _id: new seed.ObjectId(own.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() - 1000) } });
            await storage.removeExpiredUploads();
            const before = await messageCount(ctx.user);
            const errors = [];
            for (const blobId of [foreign, own]) {
                const error = await importFails(ctx.client, { blobId, mailboxIds: { [boxes.inbox]: true } });
                expect(error.type).to.equal('invalidProperties');
                expect(error.properties).to.deep.equal(['blobId']);
                errors.push(error);
            }
            // the two answers are the same: nothing tells the other user's blob from a missing one
            expect(errors[0]).to.deep.equal(errors[1]);
            expect(await messageCount(ctx.user)).to.equal(before);
        });
    });

    scenario('EIMP-020', async () => {
        const random = crypto.randomBytes(1024);
        random[0] = 0x01;
        const blobs = [
            await upload(ctx.client, h.PNG, 'image/png'),
            await upload(ctx.client, '', 'message/rfc822'),
            await upload(ctx.client, random, 'application/octet-stream')
        ];
        const s0 = await state();
        const before = await messageCount(ctx.user);
        for (const blobId of blobs) {
            const error = await importFails(ctx.client, { blobId, mailboxIds: { [boxes.inbox]: true } });
            expect(error.type).to.equal('invalidEmail');
        }
        expect(await messageCount(ctx.user)).to.equal(before);
        expect(await state()).to.equal(s0);
    });

    scenario('EIMP-021', async () => {
        const blob = await upload(ctx.client, message('Extra properties'));
        for (const [key, value] of [
            ['subject', 'x'],
            ['id', 'M1']
        ]) {
            const error = await importFails(ctx.client, { blobId: blob, mailboxIds: { [boxes.inbox]: true }, [key]: value });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal([key]);
        }
    });

    scenario('EIMP-022', async () => {
        const attached = ['From: Attached <attached@example.org>', 'To: someone@example.com', 'Subject: The attached one', '', 'Attached body', ''].join(
            h.CRLF
        );
        const { id } = await h.append(ctx.user, h.mime(h.multipart('mixed', [h.text('Outer body'), h.part(['Content-Type: message/rfc822'], attached)])));
        const outer = await h.getOne(ctx.client, id, { properties: ['attachments'] });
        const part = outer.attachments.find(entry => entry.type === 'message/rfc822');
        const created = await importOne(ctx.client, part.blobId, boxes.Archive);
        expect(created.size).to.equal(part.size);
        const email = await h.getOne(ctx.client, created.id, {
            properties: ['subject', 'from', 'mailboxIds', 'textBody', 'bodyValues', 'size'],
            fetchTextBodyValues: true
        });
        expect(email.subject).to.equal('The attached one');
        expect(email.from).to.deep.equal([{ name: 'Attached', email: 'attached@example.org' }]);
        expect(email.mailboxIds).to.deep.equal({ [boxes.Archive]: true });
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('Attached body\n');
        expect(email.size).to.equal(part.size);
    });

    scenario('EIMP-023', async () => {
        const { id } = await h.append(ctx.user, message('Existing email'), { flags: ['\\Seen'] });
        const original = await h.getOne(ctx.client, id, { properties: ['blobId', 'keywords', 'mailboxIds'] });
        expect(original.keywords).to.deep.equal({ $seen: true });
        const created = await importOne(ctx.client, original.blobId, boxes.Archive);
        expect(created.id).to.not.equal(id);
        const copy = await h.getOne(ctx.client, created.id, { properties: ['keywords', 'mailboxIds', 'blobId'] });
        expect(copy.keywords).to.deep.equal({});
        expect(copy.mailboxIds).to.deep.equal({ [boxes.Archive]: true });
        expect(Buffer.compare(await h.download(ctx.client, copy.blobId), await h.download(ctx.client, original.blobId))).to.equal(0);
        const after = await h.getOne(ctx.client, id, { properties: ['blobId', 'keywords', 'mailboxIds'] });
        expect(after).to.deep.equal(original);
    });

    scenario('EIMP-024', async () => {
        const blob = await upload(ctx.client, message('Twice'));
        const emails = { a: { blobId: blob, mailboxIds: { [boxes.Archive]: true } }, b: { blobId: blob, mailboxIds: { [boxes.Archive]: true } } };
        const first = await importEmails(ctx.client, emails);
        const second = await importEmails(ctx.client, emails);
        expect(first.notCreated).to.equal(null);
        expect(second.notCreated).to.equal(null);
        const ids = [...Object.values(first.created), ...Object.values(second.created)].map(entry => entry.id);
        expect(new Set(ids).size).to.equal(4);
        // a keyword on one of them, over IMAP
        const doc = await messageDoc(ctx.user, ids[0]);
        await seed.withImap(ctx.user, async client => {
            await client.mailboxOpen('Archive');
            await client.messageFlagsAdd(String(doc.uid), ['\\Flagged'], { uid: true });
        });
        const list = (await ctx.client.method('Email/get', { ids, properties: ['keywords'] })).list;
        const keywords = Object.fromEntries(list.map(email => [email.id, email.keywords]));
        expect(keywords[ids[0]]).to.deep.equal({ $flagged: true });
        for (const other of ids.slice(1)) {
            expect(keywords[other]).to.deep.equal({});
        }
    });

    scenario('EIMP-025', async () => {
        const content = message('Download after import');
        const blob = await upload(ctx.client, content);
        const created = await importOne(ctx.client, blob, boxes.inbox);
        expect(created.blobId).to.not.equal(blob);
        expect(created.size).to.equal(content.length);
        expect(Buffer.compare(await h.download(ctx.client, blob), content)).to.equal(0);
        expect(Buffer.compare(await h.download(ctx.client, created.blobId), content)).to.equal(0);
    });

    scenario('EIMP-026', async () => {
        const content = message('Built with Blob/upload').toString();
        const using = [jmap.URN.core, jmap.URN.mail, jmap.URN.blob];
        const [[, uploaded], [, imported]] = await ctx.client.call(
            [
                ['Blob/upload', { accountId: ctx.client.accountId, create: { b1: { data: [{ 'data:asText': content }] } } }, 'u'],
                ['Email/import', { accountId: ctx.client.accountId, emails: { e1: { blobId: '#b1', mailboxIds: { [boxes.inbox]: true } } } }, 'i']
            ],
            using
        );
        expect(uploaded.created.b1.id).to.be.a('string');
        expect(imported.notCreated).to.equal(null);
        expect(imported.created.e1.id).to.match(EMAIL_ID);
        expect(imported.created.e1.size).to.equal(Buffer.byteLength(content));

        const [[name, failed]] = await ctx.client.call(
            [['Email/import', { accountId: ctx.client.accountId, emails: { e2: { blobId: '#nope', mailboxIds: { [boxes.inbox]: true } } } }, 'i']],
            using
        );
        if (name === 'error') {
            expect(failed.type).to.equal('invalidResultReference');
        } else {
            expect(failed.created).to.equal(null);
            expect(failed.notCreated.e2.type).to.equal('invalidProperties');
            expect(failed.notCreated.e2.properties).to.deep.equal(['blobId']);
        }
    });

    describe('with a small message size limit', () => {
        let instance;
        const LIMIT = 2048;
        before(async () => {
            instance = await startInstance({ limits: Object.assign({}, config.jmap.limits, { maxSizeMessage: LIMIT }) });
        });
        after(async () => {
            await stopInstance(instance.app);
        });

        scenario('EIMP-027', async () => {
            const big = message('Too large', [], 'x'.repeat(LIMIT));
            const blob = await upload(ctx.client, big);
            const stored = await h.append(
                ctx.user,
                h.mime(h.multipart('mixed', [h.text('outer'), h.part(['Content-Type: message/rfc822'], big.toString('binary'))]))
            );
            const part = (await h.getOne(ctx.client, stored.id, { properties: ['attachments'] })).attachments[0];
            const before = await messageCount(ctx.user);
            const client = jmap.forUser(ctx.user);
            client.accountId = ctx.client.accountId;
            for (const blobId of [blob, part.blobId]) {
                const res = await client.raw(`${instance.url}/jmap/api/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        using: [jmap.URN.core, jmap.URN.mail],
                        methodCalls: [['Email/import', { accountId: client.accountId, emails: { big: { blobId, mailboxIds: { [boxes.inbox]: true } } } }, 'c0']]
                    })
                });
                const [name, args] = res.json.methodResponses[0];
                expect(name).to.equal('Email/import');
                expect(args.created).to.equal(null);
                expect(args.notCreated.big.type).to.equal('tooLarge');
            }
            expect(await messageCount(ctx.user)).to.equal(before);
        });
    });

    scenario('EIMP-028', async () => {
        const quotaCtx = await newContext();
        const filler = await h.append(quotaCtx.user, message('Filler', [], 'f'.repeat(4000)));
        const content = message('Over quota', [], 'q'.repeat(2000));
        const blob = await upload(quotaCtx.client, content);
        const used = await storageUsed(quotaCtx.user);
        await api('PUT', `/users/${quotaCtx.user.id}`, { quota: used + content.length - 1 });
        const error = await importFails(quotaCtx.client, { blobId: blob, mailboxIds: { [quotaCtx.boxes.inbox]: true } });
        expect(error.type).to.equal('overQuota');
        expect(await storageUsed(quotaCtx.user)).to.equal(used);
        // free space: delete the filler
        const doc = await messageDoc(quotaCtx.user, filler.id);
        await api('DELETE', `/users/${quotaCtx.user.id}/mailboxes/${doc.mailbox}/messages/${doc.uid}`);
        await clock.waitFor(async () => (await storageUsed(quotaCtx.user)) < used);
        const created = await importOne(quotaCtx.client, blob, quotaCtx.boxes.inbox);
        expect(created.id).to.match(EMAIL_ID);
    });

    scenario('EIMP-029', async () => {
        const session = await ctx.client.session();
        const max = Math.min(session.capabilities[jmap.URN.core].maxSizeUpload, 64 * 1024 * 1024);
        const attachment = crypto.randomBytes(Math.floor(((max - 4096) * 3) / 4 / 78) * 76);
        const content = h.mime(h.multipart('mixed', [h.text('large one'), h.base64(['Content-Type: application/octet-stream; name="big.bin"'], attachment)]));
        expect(content.length).to.be.below(max);
        expect(content.length).to.be.above(max * 0.95);
        const blob = await upload(ctx.client, content);
        const created = await importOne(ctx.client, blob, boxes.Archive);
        expect(created.size).to.equal(content.length);
        const email = await h.getOne(ctx.client, created.id, { properties: ['bodyStructure', 'blobId'] });
        expect(Buffer.compare(await h.download(ctx.client, email.blobId), content)).to.equal(0);
        const big = email.bodyStructure.subParts[1];
        expect(big.size).to.equal(attachment.length);
        expect(Buffer.compare(await h.download(ctx.client, big.blobId), attachment)).to.equal(0);
        const fetched = await imapFetch(ctx.user, created.id, { size: true });
        expect(fetched.size).to.equal(content.length);
    });

    scenario('EIMP-030', async () => {
        const session = await ctx.client.session();
        const max = session.capabilities[jmap.URN.core].maxObjectsInSet;
        const blob = await upload(ctx.client, message('Too many'));
        const emails = {};
        for (let i = 0; i <= max; i++) {
            emails[`e${i}`] = { blobId: blob, mailboxIds: { [boxes.inbox]: true } };
        }
        const before = await messageCount(ctx.user);
        expect(await methodError(ctx.client, 'Email/import', { emails })).to.equal('requestTooLarge');
        expect(await messageCount(ctx.user)).to.equal(before);
    });

    scenario('EIMP-031', async () => {
        const blob = await upload(ctx.client, message('If in state'));
        const s0 = await state();
        const first = await importEmails(ctx.client, { a: { blobId: blob, mailboxIds: { [boxes.inbox]: true } } }, { ifInState: s0 });
        expect(first.created).to.have.all.keys('a');
        const before = await messageCount(ctx.user);
        expect(await methodError(ctx.client, 'Email/import', { ifInState: s0, emails: { b: { blobId: blob, mailboxIds: { [boxes.inbox]: true } } } })).to.equal(
            'stateMismatch'
        );
        expect(await messageCount(ctx.user)).to.equal(before);
    });

    scenario('EIMP-032', async () => {
        const blob = await upload(ctx.client, message('All fail'));
        const s0 = await state();
        const res = await importEmails(ctx.client, {
            a: { blobId: `Bu${new seed.ObjectId().toString()}`, mailboxIds: { [boxes.inbox]: true } },
            b: { blobId: blob, mailboxIds: { [`F${new seed.ObjectId().toString()}`]: true } }
        });
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.equal(s0);
        expect(res.created).to.equal(null);
        expect(res.notCreated).to.have.all.keys('a', 'b');
    });

    scenario('EIMP-033', async () => {
        const threadCtx = await newContext();
        const tag = crypto.randomBytes(4).toString('hex');
        const msgid = `<a-${tag}@example.com>`;
        const first = h.raw(
            'From: a@example.com',
            'To: b@example.com',
            'Subject: Topic',
            `Message-ID: ${msgid}`,
            'Date: Mon, 06 Jan 2020 10:00:00 +0000',
            '',
            'first',
            ''
        );
        const { id } = await h.append(threadCtx.user, first, { date: new Date('2020-01-06T10:00:00Z') });
        const original = await h.getOne(threadCtx.client, id, { properties: ['threadId'] });
        const reply = h.raw('From: b@example.com', 'To: a@example.com', 'Subject: Re: Topic', `In-Reply-To: ${msgid}`, `References: ${msgid}`, '', 'reply', '');
        const unrelated = h.raw(
            'From: b@example.com',
            'To: a@example.com',
            'Subject: Different matter',
            `In-Reply-To: ${msgid}`,
            `References: ${msgid}`,
            '',
            'other',
            ''
        );
        const replied = await importOne(threadCtx.client, await upload(threadCtx.client, reply), threadCtx.boxes.inbox, { receivedAt: '2020-01-07T10:00:00Z' });
        const other = await importOne(threadCtx.client, await upload(threadCtx.client, unrelated), threadCtx.boxes.inbox, {
            receivedAt: '2020-01-08T10:00:00Z'
        });
        expect(replied.threadId).to.equal(original.threadId);
        expect(other.threadId).to.not.equal(original.threadId);
        const threads = await threadCtx.client.method('Thread/get', { ids: [original.threadId] });
        expect(threads.list[0].emailIds).to.deep.equal([id, replied.id]);
        expect((await mailbox(threadCtx.boxes.inbox, threadCtx.client)).totalThreads).to.equal(2);
    });

    scenario('EIMP-034', async () => {
        const content = message('Seen everywhere');
        const blob = await upload(ctx.client, content);
        const idle = await seed.imap(ctx.user);
        await idle.mailboxOpen('INBOX');
        const exists = new Promise(resolve => idle.on('exists', resolve));
        const idling = idle.idle();
        const created = await importOne(ctx.client, blob, boxes.inbox, { receivedAt: '2021-05-06T07:08:09Z', keywords: { $flagged: true, $answered: true } });
        const event = await Promise.race([exists, clock.delay(8000).then(() => null)]);
        expect(event, 'EXISTS seen by the idling session').to.not.equal(null);
        await idle.logout().catch(() => idle.close());
        await idling.catch(() => false);
        const fetched = await imapFetch(ctx.user, created.id, { size: true, internalDate: true, flags: true, source: true });
        expect(Buffer.compare(fetched.source, content)).to.equal(0);
        expect(fetched.size).to.equal(created.size);
        expect(fetched.internalDate.toISOString()).to.equal('2021-05-06T07:08:09.000Z');
        expect([...fetched.flags]).to.have.members(['\\Flagged', '\\Answered']);
        const doc = await messageDoc(ctx.user, created.id);
        const rest = await api('GET', `/users/${ctx.user.id}/mailboxes/${doc.mailbox}/messages/${doc.uid}`);
        expect(rest.subject).to.equal('Seen everywhere');
        expect(rest).to.deep.include({ seen: false, flagged: true, answered: true, draft: false });
    });

    scenario('EIMP-035', async () => {
        const content = Buffer.from(
            [
                'From: Jürgen Größe <jürgen@example.org>',
                'To: Ünïcode <üser@example.com>',
                'Subject: Grüße aus Köln ☕',
                'Message-ID: <eai-import@example.com>',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'body',
                ''
            ].join('\r\n'),
            'utf8'
        );
        const blob = await upload(ctx.client, content, 'message/global');
        const created = await importOne(ctx.client, blob, boxes.inbox);
        const email = await h.getOne(ctx.client, created.id, { properties: ['subject', 'from', 'to', 'blobId'] });
        expect(email.subject).to.equal('Grüße aus Köln ☕');
        expect(email.from).to.deep.equal([{ name: 'Jürgen Größe', email: 'jürgen@example.org' }]);
        expect(email.to).to.deep.equal([{ name: 'Ünïcode', email: 'üser@example.com' }]);
        expect(Buffer.compare(await h.download(ctx.client, email.blobId), content)).to.equal(0);
    });

    scenario('EIMP-036', async () => {
        const content = Buffer.from('From: lf@example.org\nTo: rcpt@example.com\nSubject: Bare LF\n\nline one\nline two\n');
        const blob = await upload(ctx.client, content);
        const created = await importOne(ctx.client, blob, boxes.inbox);
        const stored = await h.download(ctx.client, created.blobId);
        expect(created.size).to.equal(stored.length);
        const fetched = await imapFetch(ctx.user, created.id, { size: true, source: true });
        expect(fetched.size).to.equal(created.size);
        expect(Buffer.compare(fetched.source, stored)).to.equal(0);
        expect(Buffer.compare(await h.download(ctx.client, blob), content)).to.equal(0);
    });

    scenario('EIMP-037', async () => {
        const content = Buffer.from('From: nul@example.org\r\nSubject: has \0 nul\r\n\r\nbody \0 with nul\r\n', 'binary');
        const blob = await upload(ctx.client, content);
        const before = await messageCount(ctx.user);
        const error = await importFails(ctx.client, { blobId: blob, mailboxIds: { [boxes.inbox]: true } });
        expect(error.type).to.equal('invalidEmail');
        expect(await messageCount(ctx.user)).to.equal(before);
    });

    scenario('EIMP-038', async () => {
        // no bare LF: a message with one is stored with CRLF line breaks throughout (EIMP-036)
        const binary = Buffer.from([0, 1, 2, 0xff, 0xfe, 13, 10, 0x80, 13, 0x7f]);
        const latin = Buffer.from('Grüße, Ålesund', 'latin1').toString('binary');
        const content = Buffer.concat([
            h.mime(
                h.multipart('mixed', [
                    h.part(['Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: 8bit'], latin),
                    h.part(['Content-Type: application/octet-stream; name="raw.bin"', 'Content-Transfer-Encoding: binary'], binary.toString('binary'))
                ])
            )
        ]);
        const blob = await upload(ctx.client, content);
        const created = await importOne(ctx.client, blob, boxes.inbox);
        expect(Buffer.compare(await h.download(ctx.client, created.blobId), content)).to.equal(0);
        const email = await h.getOne(ctx.client, created.id, { properties: ['textBody', 'attachments', 'bodyValues'], fetchTextBodyValues: true });
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('Grüße, Ålesund');
        const part = email.attachments.find(entry => entry.name === 'raw.bin');
        expect(Buffer.compare(await h.download(ctx.client, part.blobId), binary)).to.equal(0);
    });

    scenario('ECHG-109', async () => {
        const blob = await upload(ctx.client, message('Changes after import'));
        const s0 = await state();
        const res = await importEmails(ctx.client, { e: { blobId: blob, mailboxIds: { [boxes.inbox]: true } } });
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.not.equal(s0);
        const changes = await ctx.client.method('Email/changes', { sinceState: s0 });
        expect(changes.created).to.include(res.created.e.id);
        expect(changes.newState).to.equal(res.newState);
    });

    scenario('EDLV-012', async () => {
        const blob = await upload(ctx.client, message('Delivery event'));
        const stream = await sse.open('/jmap/eventsource/?types=EmailDelivery&closeafter=no&ping=0', {
            authorization: jmap.basic(ctx.user.username, ctx.user.password)
        });
        try {
            expect(stream.status).to.equal(200);
            await stream.until(() => stream.comments.length || stream.events.length, 5000, 'the stream did not start');
            await stream.settle(300);
            await importOne(ctx.client, blob, boxes.inbox);
            const event = await stream.next('state', 8000);
            expect(Object.keys(event.json.changed[ctx.client.accountId])).to.deep.equal(['EmailDelivery']);
        } finally {
            stream.close();
        }
    });

    scenario('BLOB-034', async () => {
        const content = message('Blob after import');
        const blob = await upload(ctx.client, content, 'message/rfc822');
        const created = await importOne(ctx.client, blob, boxes.inbox);
        expect(created.blobId).to.match(/^Bm[0-9a-f]{24}$/);
        expect(Buffer.compare(await h.download(ctx.client, blob), content)).to.equal(0);
        expect(Buffer.compare(await h.download(ctx.client, created.blobId), content)).to.equal(0);
    });

    after(() => sse.closeAll());
});
