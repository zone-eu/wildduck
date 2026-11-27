/* eslint no-unused-expressions: 0, no-invalid-this: 0, no-control-regex: 0 */
/* global before, after */
'use strict';

// Catalogue file email-set.yaml, Email/set create: storing (ESET-110 to ESET-147) and limits,
// quota and the other protocols' view of a created Email (ESET-221 to ESET-231).

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, api, seed, clock, jmap } = require('../harness');
const { startInstance, stopInstance, captureLog } = require('../harness/instance');
const { imapFor, download } = require('./email-get-helpers');
const {
    THREAD_ID,
    account,
    set,
    create,
    expectCreated,
    expectNotCreated,
    expectProperties,
    seedEmail,
    emailOf,
    state,
    imapFlags,
    docOf,
    pathOf,
    restMessage,
    storageUsed,
    counts,
    draft,
    rawOf,
    upload,
    headerFields,
    fieldsNamed
} = require('./email-set-helpers');

const text = (value, extra = {}) => Object.assign({ textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value } } }, extra);

async function draftsCount(ctx) {
    return (await ctx.client.method('Email/query', { filter: { inMailbox: ctx.mb.Drafts }, calculateTotal: true })).total;
}

const ENCODED_WORD = new RegExp('=\\?[^?]+\\?[QBqb]\\?[^?]*\\?=', 'g');
const ascii = value => /^[\x00-\x7f]*$/.test(value);

describe('Email/set create (email-set.yaml)', function () {
    this.timeout(120000);
    let ctx;

    before(async () => {
        ctx = await account();
    });

    scenario('ESET-110', async () => {
        const own = await account();
        await api('PUT', `/users/${own.user.id}`, { imapMaxUpload: 100 });
        // the IMAP upload of the day uses the allowance up
        await seedEmail(own, { content: Buffer.from(`Subject: big\r\n\r\n${'x'.repeat(200)}`) });
        const before = await draftsCount(own);
        const res = await create(own.client, draft(own, text('rate limited')));
        expect(res.created).to.equal(null);
        expect(['rateLimit', 'overQuota']).to.include(res.notCreated.c1.type);
        expect(await draftsCount(own)).to.equal(before);
    });

    scenario('ESET-111', async () => {
        const res = await create(ctx.client, draft(ctx));
        const created = expectCreated(res);
        expect(created.blobId).to.be.a('string');
        expect(created.threadId).to.match(THREAD_ID);
        expect(created.size).to.be.a('number');
        const email = await emailOf(ctx, created.id, ['keywords', 'from', 'subject', 'mailboxIds']);
        expect(email).to.deep.equal({ id: created.id, keywords: {}, from: null, subject: null, mailboxIds: { [ctx.mb.Drafts]: true } });
    });

    scenario('ESET-112', async () => {
        const from = [{ name: 'Alice', email: 'alice@example.com' }];
        const to = [{ name: 'Bob', email: 'bob@example.com' }];
        const created = expectCreated(await create(ctx.client, draft(ctx, text('Hello', { from, to, subject: 'Plain text' }))));
        const email = await emailOf(ctx, created.id, ['bodyStructure', 'textBody', 'htmlBody', 'bodyValues', 'from', 'to', 'subject']);
        const full = await ctx.client.method('Email/get', {
            ids: [created.id],
            properties: ['bodyStructure', 'textBody', 'htmlBody', 'bodyValues', 'from', 'to', 'subject'],
            fetchTextBodyValues: true
        });
        const got = full.list[0];
        expect(got.bodyStructure.type).to.equal('text/plain');
        expect(got.bodyStructure.subParts === null || got.bodyStructure.subParts === undefined).to.be.true;
        expect(got.textBody.map(part => part.partId)).to.deep.equal([got.bodyStructure.partId]);
        expect(got.htmlBody.map(part => part.partId)).to.deep.equal([got.bodyStructure.partId]);
        // a single part body is stored with its last line terminated (catalogue notes)
        expect(got.bodyValues[got.bodyStructure.partId].value).to.equal('Hello\n');
        expect(got.from).to.deep.equal(from);
        expect(got.to).to.deep.equal(to);
        expect(got.subject).to.equal('Plain text');
        expect(email.subject).to.equal('Plain text');
    });

    scenario('ESET-113', async () => {
        const created = expectCreated(
            await create(ctx.client, draft(ctx, { htmlBody: [{ partId: 'h', type: 'text/html' }], bodyValues: { h: { value: '<p>Hi</p>' } } }))
        );
        const { list } = await ctx.client.method('Email/get', {
            ids: [created.id],
            properties: ['bodyStructure', 'textBody', 'htmlBody', 'bodyValues'],
            fetchHTMLBodyValues: true
        });
        const got = list[0];
        expect(got.bodyStructure.type).to.equal('text/html');
        expect(got.bodyStructure.subParts === null || got.bodyStructure.subParts === undefined).to.be.true;
        expect(got.htmlBody.map(part => part.partId)).to.deep.equal([got.bodyStructure.partId]);
        expect(got.textBody.map(part => part.partId)).to.deep.equal([got.bodyStructure.partId]);
        expect(got.bodyValues[got.bodyStructure.partId].value).to.equal('<p>Hi</p>\n');
    });

    scenario('ESET-114', async () => {
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, { textBody: [{ partId: 't' }], htmlBody: [{ partId: 'h' }], bodyValues: { t: { value: 'plain' }, h: { value: '<b>html</b>' } } })
            )
        );
        const got = await emailOf(ctx, created.id, ['bodyStructure', 'textBody', 'htmlBody', 'attachments', 'hasAttachment']);
        expect(got.bodyStructure.type).to.equal('multipart/alternative');
        expect(got.bodyStructure.subParts.map(part => part.type)).to.deep.equal(['text/plain', 'text/html']);
        expect(got.textBody.map(part => part.partId)).to.deep.equal([got.bodyStructure.subParts[0].partId]);
        expect(got.htmlBody.map(part => part.partId)).to.deep.equal([got.bodyStructure.subParts[1].partId]);
        expect(got.attachments).to.deep.equal([]);
        expect(got.hasAttachment).to.equal(false);
    });

    scenario('ESET-115', async () => {
        const res = await create(ctx.client, draft(ctx, text('body', { subject: 'Not echoed' })));
        const created = expectCreated(res);
        expect(created).to.include.all.keys('id', 'blobId', 'threadId', 'size');
        expect(Object.keys(created).every(key => ['id', 'blobId', 'threadId', 'size', 'keywords', 'receivedAt'].includes(key))).to.be.true;
        for (const key of ['updated', 'destroyed', 'notCreated', 'notUpdated', 'notDestroyed']) {
            expect(res[key], key).to.equal(null);
        }
    });

    scenario('ESET-116', async () => {
        const own = await account();
        const s0 = await state(own.client);
        const res = await create(own.client, draft(own));
        const created = expectCreated(res);
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.not.equal(s0);
        const emailChanges = await own.client.method('Email/changes', { sinceState: s0 });
        expect(emailChanges.created).to.deep.equal([created.id]);
        expect(emailChanges.updated).to.deep.equal([]);
        expect(emailChanges.destroyed).to.deep.equal([]);
        expect((await own.client.method('Mailbox/changes', { sinceState: s0 })).updated).to.deep.equal([own.mb.Drafts]);
    });

    scenario('ESET-117', async () => {
        const before = await draftsCount(ctx);
        const object = draft(ctx, text('same', { subject: 'Same' }));
        const res = await set(ctx.client, { create: { a: object, b: object, c: object, d: object, e: object } });
        const created = Object.values(res.created);
        expect(created).to.have.length(5);
        expect(new Set(created.map(entry => entry.id)).size).to.equal(5);
        expect(new Set(created.map(entry => entry.blobId)).size).to.equal(5);
        expect(await draftsCount(ctx)).to.equal(before + 5);
    });

    scenario('ESET-118', async () => {
        const before = await draftsCount(ctx);
        const body = text('x', { subject: 'no mailbox' });
        for (const mailboxIds of [undefined, {}, null]) {
            const object = Object.assign({}, body);
            if (mailboxIds !== undefined) {
                object.mailboxIds = mailboxIds;
            }
            expectProperties(expectNotCreated(await create(ctx.client, object), 'invalidProperties'), ['mailboxIds']);
        }
        expect(await draftsCount(ctx)).to.equal(before);
    });

    scenario('ESET-119', async () => {
        for (const mailboxIds of [{ F000000000000000000000000: true }, { 'invalid id!': true }, { [ctx.mb.Drafts]: false }]) {
            expectProperties(expectNotCreated(await create(ctx.client, { mailboxIds }), 'invalidProperties'), ['mailboxIds']);
        }
    });

    scenario('ESET-120', async () => {
        const own = await account();
        expectNotCreated(await create(own.client, { mailboxIds: { [own.mb.Drafts]: true, [own.mb.INBOX]: true } }), 'tooManyMailboxes');
        expect(await draftsCount(own)).to.equal(0);
        expect((await own.client.method('Email/query', { filter: { inMailbox: own.mb.INBOX } })).ids).to.deep.equal([]);
    });

    scenario('ESET-121', async function () {
        const accountId = ctx.client.accountId;
        const responses = await ctx.client.call([
            ['Mailbox/set', { accountId, create: { mb: { name: `Projects ${Date.now()}` } } }, 'm'],
            ['Email/set', { accountId, create: { c1: { mailboxIds: { '#mb': true } } } }, 'e']
        ]);
        if (responses[0][0] === 'error' && responses[0][1].type === 'unknownMethod') {
            // Mailbox/set (work package 2.2) is not in this tree yet
            return this.skip();
        }
        const mailbox = responses[0][1].created.mb.id;
        const created = expectCreated(responses[1][1]);
        expect((await emailOf(ctx, created.id, ['mailboxIds'])).mailboxIds).to.deep.equal({ [mailbox]: true });
    });

    scenario('ESET-122', async () => {
        const own = await account();
        for (const name of ['INBOX', 'Sent', 'Archive']) {
            const created = expectCreated(await create(own.client, { mailboxIds: { [own.mb[name]]: true }, subject: `In ${name}` }));
            const doc = await docOf(own, created.id);
            const flags = await imapFlags(own, await pathOf(own, doc.mailbox), doc.uid);
            expect(flags, name).to.not.include('\\Draft');
        }
    });

    scenario('ESET-123', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { keywords: { $draft: true, $seen: true, todo: true } })));
        expect((await emailOf(ctx, created.id, ['keywords'])).keywords).to.deep.equal({ $draft: true, $seen: true, todo: true });
        const doc = await docOf(ctx, created.id);
        const flags = await imapFlags(ctx, 'Drafts', doc.uid);
        expect(flags).to.include.members(['\\Draft', '\\Seen', 'todo']);
    });

    scenario('ESET-124', async () => {
        const own = await account();
        const before = (await counts(own, [own.mb.Drafts]))[own.mb.Drafts].unreadEmails;
        const ids = [];
        for (const object of [draft(own), draft(own, { keywords: {} })]) {
            ids.push(expectCreated(await create(own.client, object)).id);
        }
        for (const id of ids) {
            expect((await emailOf(own, id, ['keywords'])).keywords).to.deep.equal({});
        }
        expect((await counts(own, [own.mb.Drafts]))[own.mb.Drafts].unreadEmails).to.equal(before + 2);
    });

    scenario('ESET-125', async () => {
        const before = await draftsCount(ctx);
        for (const keywords of [{ $seen: false }, { 'bad keyword': true }, { $deleted: true }, ['$seen']]) {
            expectProperties(expectNotCreated(await create(ctx.client, draft(ctx, { keywords })), 'invalidProperties'), ['keywords']);
        }
        expect(await draftsCount(ctx)).to.equal(before);
    });

    scenario('ESET-126', async () => {
        const own = await account();
        const created = expectCreated(
            await create(
                own.client,
                draft(
                    own,
                    text('draft body', {
                        keywords: { $draft: true },
                        from: [{ email: own.user.address }],
                        to: [{ email: 'to@example.com' }],
                        subject: 'A draft'
                    })
                )
            )
        );
        const doc = await docOf(own, created.id);
        expect(await imapFlags(own, 'Drafts', doc.uid)).to.include('\\Draft');
        expect((await restMessage(own, created.id)).draft).to.equal(true);
        expect((await counts(own, [own.mb.Drafts]))[own.mb.Drafts].unreadEmails).to.equal(0);
    });

    scenario('ESET-127', async () => {
        const before = Math.floor(Date.now() / 1000) * 1000;
        const created = expectCreated(await create(ctx.client, draft(ctx)));
        const after = Date.now();
        const { receivedAt } = await emailOf(ctx, created.id, ['receivedAt']);
        expect(receivedAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        const time = Date.parse(receivedAt);
        expect(time).to.be.within(before, after);
        const doc = await docOf(ctx, created.id);
        const session = await imapFor(ctx.user);
        await session.mailboxOpen('Drafts');
        const fetched = await session.fetchOne(String(doc.uid), { internalDate: true }, { uid: true });
        expect(Math.floor(fetched.internalDate.getTime() / 1000) * 1000).to.equal(time);
    });

    scenario('ESET-128', async () => {
        const own = await account();
        const newer = expectCreated(await create(own.client, draft(own, { receivedAt: '2015-01-01T00:00:00Z' })));
        const created = expectCreated(await create(own.client, draft(own, { receivedAt: '2014-10-30T14:12:00Z' })));
        expect((await emailOf(own, created.id, ['receivedAt'])).receivedAt).to.equal('2014-10-30T14:12:00Z');
        const doc = await docOf(own, created.id);
        const session = await imapFor(own.user);
        await session.mailboxOpen('Drafts');
        const fetched = await session.fetchOne(String(doc.uid), { internalDate: true }, { uid: true });
        expect(fetched.internalDate.toISOString()).to.equal('2014-10-30T14:12:00.000Z');
        const { ids } = await own.client.method('Email/query', { filter: { inMailbox: own.mb.Drafts }, sort: [{ property: 'receivedAt', isAscending: true }] });
        expect(ids).to.deep.equal([created.id, newer.id]);
    });

    scenario('ESET-129', async () => {
        for (const receivedAt of ['2014-10-30T14:12:00+02:00', '2014-10-30', 'yesterday', 1414678320]) {
            expectProperties(expectNotCreated(await create(ctx.client, draft(ctx, { receivedAt })), 'invalidProperties'), ['receivedAt']);
        }
    });

    scenario('ESET-130', async () => {
        const before = await draftsCount(ctx);
        const values = {
            id: 'M000000000000000000000001',
            blobId: 'Bu000000000000000000000001',
            threadId: 'T000000000000000000000001',
            size: 1,
            hasAttachment: false,
            preview: 'x'
        };
        for (const [property, value] of Object.entries(values)) {
            expectProperties(expectNotCreated(await create(ctx.client, draft(ctx, { [property]: value })), 'invalidProperties'), [property]);
        }
        expect(await draftsCount(ctx)).to.equal(before);
    });

    scenario('ESET-131', async () => {
        const error = expectNotCreated(await create(ctx.client, draft(ctx, { unknown: 1, another: 2 })), 'invalidProperties');
        expect(error.properties).to.include.members(['unknown', 'another']);
    });

    scenario('ESET-132', async () => {
        const res = await set(ctx.client, { create: { a: 'string', b: draft(ctx) } });
        expect(res.created).to.have.all.keys('b');
        expect(res.notCreated.a.type).to.equal('invalidProperties');
    });

    scenario('ESET-133', async () => {
        const object = draft(ctx, {
            from: [{ name: 'From Person', email: 'from@example.com' }],
            sender: [{ name: 'Sender Person', email: 'sender@example.com' }],
            replyTo: [{ name: 'Reply', email: 'reply@example.com' }],
            to: [
                { name: 'To One', email: 'to1@example.com' },
                { name: 'To Two', email: 'to2@example.com' }
            ],
            cc: [{ name: 'Cc Person', email: 'cc@example.com' }],
            bcc: [{ name: 'Bcc Person', email: 'bcc@example.com' }]
        });
        const created = expectCreated(await create(ctx.client, object));
        const properties = ['from', 'sender', 'replyTo', 'to', 'cc', 'bcc'];
        const email = await emailOf(ctx, created.id, properties);
        for (const property of properties) {
            expect(email[property], property).to.deep.equal(object[property]);
        }
        const raw = await rawOf(ctx, created.blobId);
        for (const [field, property] of [
            ['From', 'from'],
            ['Sender', 'sender'],
            ['Reply-To', 'replyTo'],
            ['To', 'to'],
            ['Cc', 'cc'],
            ['Bcc', 'bcc']
        ]) {
            const lines = fieldsNamed(raw, field);
            expect(lines, field).to.have.length(1);
            for (const address of object[property]) {
                expect(lines[0]).to.include(`${address.name} <${address.email}>`);
            }
        }
    });

    scenario('ESET-134', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { bcc: [{ email: 'hidden@example.com' }] })));
        expect((await emailOf(ctx, created.id, ['bcc'])).bcc).to.deep.equal([{ name: null, email: 'hidden@example.com' }]);
        expect(fieldsNamed(await rawOf(ctx, created.blobId), 'Bcc')).to.deep.equal(['Bcc: hidden@example.com']);
    });

    scenario('ESET-135', async () => {
        const from = [
            { name: 'One', email: 'one@example.com' },
            { name: 'Two', email: 'two@example.com' }
        ];
        const created = expectCreated(await create(ctx.client, draft(ctx, { from, sender: [{ name: 'One', email: 'one@example.com' }] })));
        expect((await emailOf(ctx, created.id, ['from'])).from).to.deep.equal(from);
    });

    scenario('ESET-136', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, text('no from', { to: [{ email: 'to@example.com' }], subject: 'Anonymous' }))));
        expect((await emailOf(ctx, created.id, ['from'])).from).to.equal(null);
        expect(fieldsNamed(await rawOf(ctx, created.blobId), 'From')).to.deep.equal([]);
    });

    scenario('ESET-137', async () => {
        const to = [{ name: 'Doe, "JD" John', email: 'jd@example.com' }];
        const subject = 'bob@example.com, hello and more';
        const created = expectCreated(await create(ctx.client, draft(ctx, { to, subject })));
        const email = await emailOf(ctx, created.id, ['to', 'subject']);
        expect(email.to).to.deep.equal(to);
        expect(email.subject).to.equal(subject);
    });

    scenario('ESET-138', async () => {
        const subject = 'Café привет \u{1F600} résumé';
        const from = [{ name: 'Jürgen Жук \u{1F600}', email: 'jurgen@example.com' }];
        const created = expectCreated(await create(ctx.client, draft(ctx, { subject, from })));
        const raw = await rawOf(ctx, created.blobId);
        for (const field of [...fieldsNamed(raw, 'Subject'), ...fieldsNamed(raw, 'From')]) {
            expect(ascii(field), field).to.be.true;
            for (const word of field.match(ENCODED_WORD) || []) {
                expect(word.length, word).to.be.at.most(75);
            }
        }
        const email = await emailOf(ctx, created.id, ['subject', 'from']);
        expect(email.subject).to.equal(subject);
        expect(email.from).to.deep.equal(from);
    });

    scenario('ESET-139', async () => {
        const first = expectCreated(await create(ctx.client, draft(ctx, { to: [{ email: 'user@xn--bcher-kva.example' }] })));
        expect((await emailOf(ctx, first.id, ['to'])).to).to.deep.equal([{ name: null, email: 'user@xn--bcher-kva.example' }]);
        expect(ascii(headerFields(await rawOf(ctx, first.blobId)).join('\r\n'))).to.be.true;

        const second = expectCreated(await create(ctx.client, draft(ctx, { to: [{ email: 'jürgen@bücher.example' }] })));
        const [address] = (await emailOf(ctx, second.id, ['to'])).to;
        // the domain may come back in its ASCII form; the mailbox is the same
        expect(['jürgen@bücher.example', 'jürgen@xn--bcher-kva.example']).to.include(address.email);
        const raw = await download(ctx.client, second.blobId);
        const header = raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('utf8');
        // 8 bit header content only where the address needs it (an RFC 6532 message)
        for (const line of header.split('\r\n').filter(line => !ascii(line))) {
            expect(line, line).to.match(/^To: /);
        }
    });

    scenario('ESET-140', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { subject: 'Quarterly report' })));
        const email = await emailOf(ctx, created.id, ['subject', 'header:Subject']);
        expect(email.subject).to.equal('Quarterly report');
        expect(email['header:Subject']).to.equal(' Quarterly report');
        const doc = await docOf(ctx, created.id);
        const session = await imapFor(ctx.user);
        await session.mailboxOpen('Drafts');
        const fetched = await session.fetchOne(String(doc.uid), { envelope: true }, { uid: true });
        expect(fetched.envelope.subject).to.equal('Quarterly report');
    });

    scenario('ESET-141', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { sentAt: '2019-05-02T03:15:00+07:00' })));
        const email = await emailOf(ctx, created.id, ['sentAt', 'header:Date', 'receivedAt']);
        expect(email.sentAt).to.equal('2019-05-02T03:15:00+07:00');
        expect(email['header:Date']).to.equal(' Thu, 02 May 2019 03:15:00 +0700');
        expect(Math.abs(Date.parse(email.receivedAt) - Date.now())).to.be.below(60 * 1000);
    });

    scenario('ESET-142', async () => {
        const ids = { messageId: ['m1@example.com'], inReplyTo: ['p1@example.com'], references: ['r1@example.com', 'p1@example.com'] };
        const created = expectCreated(await create(ctx.client, draft(ctx, ids)));
        expect(await emailOf(ctx, created.id, Object.keys(ids))).to.deep.equal(Object.assign({ id: created.id }, ids));
        const raw = await rawOf(ctx, created.blobId);
        expect(fieldsNamed(raw, 'Message-ID')).to.deep.equal(['Message-ID: <m1@example.com>']);
        expect(fieldsNamed(raw, 'In-Reply-To')).to.deep.equal(['In-Reply-To: <p1@example.com>']);
        expect(fieldsNamed(raw, 'References')).to.deep.equal(['References: <r1@example.com> <p1@example.com>']);
    });

    scenario('ESET-143', async () => {
        const values = [];
        for (let i = 0; i < 2; i++) {
            const created = expectCreated(await create(ctx.client, draft(ctx)));
            const { messageId } = await emailOf(ctx, created.id, ['messageId']);
            expect(messageId).to.have.length(1);
            expect(messageId[0]).to.match(/^[^<>@\s]+@[^<>@\s]+$/);
            expect(fieldsNamed(await rawOf(ctx, created.blobId), 'Message-ID')).to.have.length(1);
            values.push(messageId[0]);
        }
        expect(values[0]).to.not.equal(values[1]);
    });

    scenario('ESET-144', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx)));
        const { sentAt } = await emailOf(ctx, created.id, ['sentAt']);
        expect(Math.abs(Date.parse(sentAt) - Date.now())).to.be.below(10 * 1000);
        const dates = fieldsNamed(await rawOf(ctx, created.blobId), 'Date');
        expect(dates).to.have.length(1);
        expect(dates[0]).to.match(
            /^Date: (Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/
        );
    });

    scenario('ESET-145', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { messageId: ['fixed@example.com'], sentAt: '2020-01-01T00:00:00Z' })));
        const raw = await rawOf(ctx, created.blobId);
        expect(fieldsNamed(raw, 'Message-ID')).to.deep.equal(['Message-ID: <fixed@example.com>']);
        const dates = fieldsNamed(raw, 'Date');
        expect(dates).to.have.length(1);
        expect(Date.parse(dates[0].slice(5))).to.equal(Date.parse('2020-01-01T00:00:00Z'));
    });

    scenario('ESET-146', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, text('plain'))));
        const raw = await rawOf(ctx, created.blobId);
        expect(fieldsNamed(raw, 'MIME-Version')).to.deep.equal(['MIME-Version: 1.0']);
        expect(fieldsNamed(raw, 'X-Mailer')).to.deep.equal([]);
        expect(fieldsNamed(raw, 'User-Agent')).to.deep.equal([]);
        const res = await create(ctx.client, draft(ctx, text('plain', { 'header:MIME-Version': ' 1.1' })));
        if (res.created) {
            expect(fieldsNamed(await rawOf(ctx, res.created.c1.blobId), 'MIME-Version')).to.deep.equal(['MIME-Version: 1.1']);
        } else {
            expectProperties(res.notCreated.c1, ['header:MIME-Version']);
        }
    });

    scenario('ESET-147', async () => {
        const own = await account();
        const tag = Date.now().toString(36);
        const original = await seedEmail(own, {
            content: Buffer.from([`Subject: Plan`, 'From: a@example.com', `Message-ID: <a${tag}@example.com>`, '', 'the plan'].join('\r\n'))
        });
        const { threadId } = await emailOf(own, original.id, ['threadId']);
        const reply = expectCreated(
            await create(own.client, draft(own, { inReplyTo: [`a${tag}@example.com`], references: [`a${tag}@example.com`], subject: 'Re: Plan' }))
        );
        expect(reply.threadId).to.equal(threadId);
        const thread = await own.client.method('Thread/get', { ids: [threadId] });
        expect([...thread.list[0].emailIds].sort()).to.deep.equal([original.id, reply.id].sort());
        const other = expectCreated(
            await create(own.client, draft(own, { inReplyTo: [`a${tag}@example.com`], references: [`a${tag}@example.com`], subject: 'Other' }))
        );
        expect(other.threadId).to.not.equal(threadId);
    });

    // ---- limits

    describe('with small limits', () => {
        const LIMIT = 64 * 1024;
        let instance;
        let small;

        before(async () => {
            captureLog();
            instance = await startInstance({ limits: Object.assign({}, config.jmap.limits, { maxSizeUpload: LIMIT }) });
            small = await account();
            const client = small.client;
            const raw = client.raw.bind(client);
            client.raw = (target, init) => raw(target.startsWith('http') ? target : instance.url + target, init);
            await client.session();
        });

        after(() => stopInstance(instance.app));

        scenario('ESET-221', async () => {
            const session = await small.client.session();
            const max = session.accounts[small.client.accountId].accountCapabilities[jmap.URN.mail].maxSizeAttachmentsPerEmail;
            expect(max).to.equal(LIMIT);
            const blob = await upload(small, Buffer.alloc(40 * 1024, 7));
            const used = await storageUsed(small);
            const res = await create(
                small.client,
                draft(
                    small,
                    text('too much', { attachments: [0, 1, 2].map(i => ({ blobId: blob.blobId, type: 'application/octet-stream', name: `${i}.bin` })) })
                )
            );
            expectNotCreated(res, 'tooLarge');
            expect(await draftsCount(small)).to.equal(0);
            expect(await storageUsed(small)).to.equal(used);
        });

        scenario('ESET-222', async () => {
            const a = await upload(small, Buffer.alloc(40 * 1024, 1));
            const b = await upload(small, Buffer.alloc(30 * 1024, 2));
            const attach = blobs => draft(small, { attachments: blobs.map(blob => ({ blobId: blob.blobId, type: 'application/octet-stream' })) });
            expectNotCreated(await create(small.client, attach([a, b])), 'tooLarge');
            expectCreated(await create(small.client, attach([a])));
            // exactly the limit fits
            const exact = await upload(small, Buffer.alloc(LIMIT, 3));
            expectCreated(await create(small.client, attach([exact])));
        });
    });

    scenario('ESET-223', async () => {
        const own = await account();
        await seedEmail(own);
        const used = await storageUsed(own);
        await api('PUT', `/users/${own.user.id}`, { quota: used + 5 * 1024 });
        const blob = await upload(own, Buffer.alloc(50 * 1024, 5));
        expectNotCreated(await create(own.client, draft(own, { attachments: [{ blobId: blob.blobId, type: 'application/octet-stream' }] })), 'overQuota');
        expect(await draftsCount(own)).to.equal(0);
        expect(await storageUsed(own)).to.equal(used);
        expectCreated(await create(own.client, draft(own, text('small'))));
    });

    scenario('ESET-224', async () => {
        const own = await account();
        const before = await storageUsed(own);
        const created = expectCreated(await create(own.client, draft(own, text('counted'))));
        expect(await storageUsed(own)).to.equal(before + created.size);
        expect((await set(own.client, { destroy: [created.id] })).destroyed).to.deep.equal([created.id]);
        expect(await storageUsed(own)).to.equal(before);
    });

    scenario('ESET-225', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        await api('PUT', `/users/${own.user.id}`, { quota: 1 });
        expect((await set(own.client, { update: { [id]: { 'keywords/$seen': true } } })).updated).to.have.property(id);
        expect((await set(own.client, { update: { [id]: { mailboxIds: { [own.mb.Trash]: true } } } })).updated).to.have.property(id);
        expect((await set(own.client, { destroy: [id] })).destroyed).to.deep.equal([id]);
        expectNotCreated(await create(own.client, draft(own)), 'overQuota');
    });

    scenario('ESET-226', async () => {
        const own = await account();
        const pubKey = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'user2-public.key'), 'utf8');
        await api('PUT', `/users/${own.user.id}`, { pubKey, encryptMessages: true });
        const created = expectCreated(await create(own.client, { mailboxIds: { [own.mb.INBOX]: true }, subject: 'Secret', ...text('top secret') }));
        const raw = await download(own.client, created.blobId);
        expect(raw.length).to.equal(created.size);
        expect(raw.toString('binary')).to.match(/Content-Type: multipart\/encrypted/i);
        expect(raw.toString('binary')).to.not.include('top secret');
        const doc = await docOf(own, created.id);
        const session = await imapFor(own.user);
        await session.mailboxOpen('INBOX');
        const fetched = await session.fetchOne(String(doc.uid), { size: true, source: true }, { uid: true });
        expect(fetched.size).to.equal(created.size);
        expect(fetched.source.equals(raw)).to.be.true;
    });

    scenario('ESET-227', async () => {
        const own = await account();
        const blob = await upload(own, Buffer.from('attached bytes'), 'application/octet-stream');
        const created = expectCreated(
            await create(
                own.client,
                draft(own, {
                    keywords: { $seen: true, $draft: true },
                    textBody: [{ partId: 't' }],
                    htmlBody: [{ partId: 'h' }],
                    bodyValues: { t: { value: 'text' }, h: { value: '<p>html</p>' } },
                    attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', name: 'a.bin' }]
                })
            )
        );
        const raw = await download(own.client, created.blobId);
        const { receivedAt } = await emailOf(own, created.id, ['receivedAt']);
        const doc = await docOf(own, created.id);
        const session = await imapFor(own.user);
        await session.mailboxOpen('Drafts');
        const fetched = await session.fetchOne(String(doc.uid), { size: true, source: true, internalDate: true, flags: true }, { uid: true });
        expect(fetched.source.equals(raw)).to.be.true;
        expect(fetched.size).to.equal(created.size);
        expect(raw.length).to.equal(created.size);
        expect(fetched.internalDate.toISOString().replace(/\.\d{3}Z$/, 'Z')).to.equal(receivedAt);
        expect([...fetched.flags].filter(flag => flag !== '\\Recent').sort()).to.deep.equal(['\\Draft', '\\Seen']);
    });

    scenario('ESET-228', async () => {
        const own = await account();
        const img = await upload(own, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
        const pdf = await upload(own, Buffer.from('%PDF-1.4 test'), 'application/pdf');
        const created = expectCreated(
            await create(
                own.client,
                draft(own, {
                    from: [{ name: 'Alice', email: 'alice@example.com' }],
                    to: [{ name: 'Bob', email: 'bob@example.com' }],
                    cc: [{ name: null, email: 'carol@example.com' }],
                    subject: 'Structure',
                    messageId: ['structure@example.com'],
                    inReplyTo: ['parent@example.com'],
                    textBody: [{ partId: 't' }],
                    htmlBody: [{ partId: 'h' }],
                    bodyValues: { t: { value: 'text' }, h: { value: '<p>html</p>' } },
                    attachments: [
                        { blobId: img.blobId, type: 'image/png', disposition: 'inline', cid: 'img1@example.com', name: 'img.png' },
                        { blobId: pdf.blobId, type: 'application/pdf', disposition: 'attachment', name: 'doc.pdf' }
                    ]
                })
            )
        );
        const email = await emailOf(own, created.id, ['bodyStructure', 'from', 'to', 'cc', 'subject', 'messageId', 'inReplyTo']);
        const doc = await docOf(own, created.id);
        const session = await imapFor(own.user);
        await session.mailboxOpen('Drafts');
        const fetched = await session.fetchOne(String(doc.uid), { bodyStructure: true, envelope: true }, { uid: true });

        const compare = (jmapPart, imapPart) => {
            expect(imapPart.type, jmapPart.partId).to.equal(jmapPart.type);
            if (jmapPart.subParts) {
                expect(imapPart.childNodes.length).to.equal(jmapPart.subParts.length);
                jmapPart.subParts.forEach((sub, i) => compare(sub, imapPart.childNodes[i]));
                return;
            }
            expect(imapPart.part).to.equal(jmapPart.partId);
            const name =
                (imapPart.dispositionParameters && imapPart.dispositionParameters.filename) || (imapPart.parameters && imapPart.parameters.name) || null;
            expect(name).to.equal(jmapPart.name);
            expect(imapPart.id ? imapPart.id.replace(/^<|>$/g, '') : null).to.equal(jmapPart.cid);
            if (imapPart.encoding === 'base64') {
                // encoded octets: four for every three, a line break every 76 characters
                const encoded = Math.ceil(jmapPart.size / 3) * 4;
                expect(imapPart.size).to.be.within(encoded, encoded + Math.ceil(encoded / 76) * 2);
            } else {
                expect(['7bit', 'quoted-printable']).to.include(imapPart.encoding);
                expect(imapPart.size).to.be.at.least(jmapPart.size);
            }
        };
        compare(email.bodyStructure, fetched.bodyStructure);
        const envelope = fetched.envelope;
        expect(envelope.subject).to.equal(email.subject);
        expect(envelope.from.map(entry => ({ name: entry.name || null, email: entry.address }))).to.deep.equal(email.from);
        expect(envelope.to.map(entry => ({ name: entry.name || null, email: entry.address }))).to.deep.equal(email.to);
        expect(envelope.cc.map(entry => ({ name: entry.name || null, email: entry.address }))).to.deep.equal(email.cc);
        expect(envelope.messageId).to.equal(`<${email.messageId[0]}>`);
        expect(envelope.inReplyTo).to.equal(`<${email.inReplyTo[0]}>`);
    });

    scenario('ESET-229', async () => {
        const own = await account();
        const session = await seed.imap(own.user);
        const opened = await session.mailboxOpen('Drafts');
        const uidNext = opened.uidNext;
        const exists = new Promise(resolve => session.on('exists', resolve));
        const idling = session.idle();
        await clock.delay(200);
        const created = expectCreated(await create(own.client, draft(own)));
        const event = await Promise.race([exists, clock.delay(8000).then(() => null)]);
        expect(event, 'untagged EXISTS while idling').to.exist;
        const doc = await docOf(own, created.id);
        expect(doc.uid).to.equal(uidNext);
        await session.logout().catch(() => false);
        await idling.catch(() => false);
        const status = await (await imapFor(own.user)).status('Drafts', { uidNext: true });
        expect(status.uidNext).to.equal(uidNext + 1);
    });

    scenario('ESET-230', async () => {
        const own = await account();
        const content = Buffer.from('attachment content for rest');
        const blob = await upload(own, content, 'text/plain');
        const created = expectCreated(
            await create(
                own.client,
                draft(own, {
                    keywords: { $draft: true },
                    from: [{ name: 'Alice', email: 'alice@example.com' }],
                    to: [{ name: 'Bob', email: 'bob@example.com' }],
                    subject: 'Seen by REST',
                    textBody: [{ partId: 't' }],
                    htmlBody: [{ partId: 'h' }],
                    bodyValues: { t: { value: 'text content' }, h: { value: '<p>html content</p>' } },
                    attachments: [{ blobId: blob.blobId, type: 'text/plain', name: 'notes.txt', disposition: 'attachment' }]
                })
            )
        );
        const rest = await restMessage(own, created.id);
        expect(rest.subject).to.equal('Seen by REST');
        expect(rest.from).to.deep.equal({ name: 'Alice', address: 'alice@example.com' });
        expect(rest.to).to.deep.equal([{ name: 'Bob', address: 'bob@example.com' }]);
        expect(rest.draft).to.equal(true);
        expect(rest.text).to.include('text content');
        expect([].concat(rest.html).join('')).to.include('html content');
        expect(rest.attachments).to.have.length(1);
        expect(rest.attachments[0].filename).to.equal('notes.txt');
        expect(rest.attachments[0].size).to.be.within(content.length, Math.ceil(content.length / 3) * 4 + 4);
    });

    scenario('ESET-231', async () => {
        const accountId = ctx.client.accountId;
        const blob = await upload(ctx, Buffer.from('file'), 'application/octet-stream');
        const responses = await ctx.client.call([
            [
                'Email/set',
                {
                    accountId,
                    create: {
                        c1: draft(ctx, {
                            subject: 'Same request',
                            textBody: [{ partId: 't' }],
                            htmlBody: [{ partId: 'h' }],
                            bodyValues: { t: { value: 'Short preview text' }, h: { value: '<p>Short preview text</p>' } },
                            attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', name: 'f.bin' }]
                        })
                    }
                },
                'a'
            ],
            [
                'Email/get',
                {
                    accountId,
                    ids: ['#c1'],
                    properties: ['preview', 'hasAttachment', 'bodyStructure', 'textBody', 'htmlBody', 'attachments', 'bodyValues'],
                    fetchAllBodyValues: true
                },
                'b'
            ]
        ]);
        const email = responses[1][1].list[0];
        expect(email.id).to.equal(responses[0][1].created.c1.id);
        expect(email.preview.length).to.be.at.most(128);
        expect(email.preview).to.equal('Short preview text');
        expect(email.hasAttachment).to.equal(true);
        expect(email.bodyStructure.type).to.equal('multipart/mixed');
        expect(email.textBody).to.have.length(1);
        expect(email.htmlBody).to.have.length(1);
        expect(email.attachments.map(part => part.name)).to.deep.equal(['f.bin']);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('Short preview text');
        expect(email.bodyValues[email.htmlBody[0].partId].value).to.equal('<p>Short preview text</p>');
    });
});
