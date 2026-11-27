/* eslint no-unused-expressions: 0, no-invalid-this: 0, no-control-regex: 0 */
/* global before */
'use strict';

// Catalogue file email-set.yaml, Email/set create: header properties and injection safety
// (ESET-148 to ESET-174), body structure and content (ESET-175 to ESET-197) and blobs (ESET-198
// to ESET-220).

const { expect } = require('chai');
const libmime = require('libmime');
const { scenario, seed, fixtures, jmap } = require('../harness');
const { imapFor, download, imapDecodedPart, leaves } = require('./email-get-helpers');
const StorageHandler = require('../../../lib/storage-handler');
const {
    account,
    set,
    create,
    expectCreated,
    expectNotCreated,
    expectProperties,
    seedEmail,
    emailOf,
    docOf,
    draft,
    rawOf,
    upload,
    fieldsNamed
} = require('./email-set-helpers');

const CRLF = '\r\n';
const ascii = value => /^[\x00-\x7f]*$/.test(value);
const text = (value, extra = {}) => Object.assign({ textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value } } }, extra);

/** Every physical line of a raw message */
const physicalLines = raw => raw.split(CRLF);

/** The header section of a raw message (or MIME part) as a string */
const headerSection = raw => raw.slice(0, raw.indexOf(CRLF + CRLF));

/** Email/get with all body values */
async function full(ctx, id, properties, extra = {}) {
    const { list } = await ctx.client.method('Email/get', Object.assign({ ids: [id], properties, fetchAllBodyValues: true }, extra));
    return list[0];
}

/** Bytes of a downloaded blob */
const bytes = (ctx, blobId) => download(ctx.client, blobId);

/** The raw MIME part of a raw message by IMAP part path (1, 1.2, ...) through IMAP BODY[n.MIME] and BODY[n] */
async function imapPart(ctx, id, section) {
    const doc = await docOf(ctx, id);
    const session = await imapFor(ctx.user);
    const path = (await (await seed.db()).collection('mailboxes').findOne({ _id: doc.mailbox })).path;
    await session.mailboxOpen(path);
    const fetched = await session.fetchOne(String(doc.uid), { bodyParts: [`${section}.mime`, section] }, { uid: true });
    return { mime: fetched.bodyParts.get(`${section}.mime`).toString('binary'), body: fetched.bodyParts.get(section).toString('binary') };
}

describe('Email/set create: headers and bodies (email-set.yaml)', function () {
    this.timeout(120000);
    let ctx;

    before(async () => {
        ctx = await account();
    });

    const rejects = async (object, properties) => {
        const res = await create(ctx.client, draft(ctx, object));
        const error = expectNotCreated(res, 'invalidProperties');
        if (properties) {
            expectProperties(error, properties);
        }
        return error;
    };

    // ---- header properties

    scenario('ESET-148', async () => {
        await rejects({ headers: [{ name: 'X-Foo', value: ' bar' }] }, ['headers']);
    });

    scenario('ESET-149', async () => {
        const error = await rejects({
            bodyStructure: { type: 'text/plain', partId: 't', headers: [{ name: 'X-Foo', value: ' bar' }] },
            bodyValues: { t: { value: 'x' } }
        });
        expect(error.properties.every(property => property.startsWith('bodyStructure'))).to.be.true;
    });

    scenario('ESET-150', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { 'header:X-Custom': ' some value' })));
        expect(fieldsNamed(await rawOf(ctx, created.blobId), 'X-Custom')).to.deep.equal(['X-Custom: some value']);
        expect((await emailOf(ctx, created.id, ['header:X-Custom']))['header:X-Custom']).to.equal(' some value');
    });

    scenario('ESET-151', async () => {
        for (const name of ['Subject', 'Comments', 'List-Id', 'X-Foo']) {
            for (const value of ['plain words', 'Sõna кириллица \u{1F600}']) {
                const property = `header:${name}:asText`;
                const created = expectCreated(await create(ctx.client, draft(ctx, { [property]: value })));
                const raw = await rawOf(ctx, created.blobId);
                expect(fieldsNamed(raw, name), name).to.have.length(1);
                expect(ascii(fieldsNamed(raw, name)[0])).to.be.true;
                expect((await emailOf(ctx, created.id, [property]))[property], property).to.equal(value);
            }
        }
    });

    scenario('ESET-152', async () => {
        const resent = [{ name: 'Foo Bar', email: 'foo@example.net' }];
        const groups = [
            {
                name: 'Team',
                addresses: [
                    { name: 'A', email: 'a@example.com' },
                    { name: 'B', email: 'b@example.com' }
                ]
            },
            { name: null, addresses: [{ name: 'C', email: 'c@example.com' }] }
        ];
        const created = expectCreated(await create(ctx.client, draft(ctx, { 'header:Resent-To:asAddresses': resent, 'header:Cc:asGroupedAddresses': groups })));
        const email = await emailOf(ctx, created.id, ['header:Resent-To:asAddresses', 'header:Cc:asGroupedAddresses']);
        expect(email['header:Resent-To:asAddresses']).to.deep.equal(resent);
        expect(email['header:Cc:asGroupedAddresses']).to.deep.equal(groups);
        const cc = fieldsNamed(await rawOf(ctx, created.blobId), 'Cc')[0].replace(/\r\n[ \t]+/g, ' ');
        expect(cc).to.equal('Cc: Team: A <a@example.com>, B <b@example.com>;, C <c@example.com>');

        const empty = [{ name: 'Nobody', addresses: [] }];
        const second = expectCreated(await create(ctx.client, draft(ctx, { 'header:Cc:asGroupedAddresses': empty })));
        expect((await emailOf(ctx, second.id, ['header:Cc:asGroupedAddresses']))['header:Cc:asGroupedAddresses']).to.deep.equal(empty);
    });

    scenario('ESET-153', async () => {
        const values = {
            'header:X-Ref:asMessageIds': ['a@b'],
            'header:Resent-Date:asDate': '2020-02-03T04:05:06Z',
            'header:List-Unsubscribe:asURLs': ['mailto:u@example.com', 'https://example.com/u']
        };
        const created = expectCreated(await create(ctx.client, draft(ctx, values)));
        const raw = await rawOf(ctx, created.blobId);
        expect(fieldsNamed(raw, 'X-Ref')).to.deep.equal(['X-Ref: <a@b>']);
        expect(fieldsNamed(raw, 'Resent-Date')).to.deep.equal(['Resent-Date: Mon, 03 Feb 2020 04:05:06 +0000']);
        expect(fieldsNamed(raw, 'List-Unsubscribe')).to.deep.equal(['List-Unsubscribe: <mailto:u@example.com>, <https://example.com/u>']);
        const email = await emailOf(ctx, created.id, Object.keys(values));
        for (const [property, value] of Object.entries(values)) {
            expect(email[property], property).to.deep.equal(value);
        }
    });

    scenario('ESET-154', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { 'header:X-Tag:all': [' cat', ' dog', ' mouse'] })));
        expect(fieldsNamed(await rawOf(ctx, created.blobId), 'X-Tag')).to.deep.equal(['X-Tag: cat', 'X-Tag: dog', 'X-Tag: mouse']);
        expect((await emailOf(ctx, created.id, ['header:X-Tag:all']))['header:X-Tag:all']).to.deep.equal([' cat', ' dog', ' mouse']);
        await rejects({ 'header:X-Tag': [' cat', ' dog'] }, ['header:X-Tag']);
    });

    scenario('ESET-155', async () => {
        const values = {
            'header:Subject:asAddresses': [{ name: null, email: 'a@example.com' }],
            'header:From:asText': 'text',
            'header:Date:asMessageIds': ['a@b'],
            'header:To:asURLs': ['mailto:a@b'],
            'header:Message-ID:asDate': '2020-01-01T00:00:00Z'
        };
        for (const [property, value] of Object.entries(values)) {
            await rejects({ [property]: value }, [property]);
        }
    });

    scenario('ESET-156', async () => {
        const values = { 'header:X-Foo:asAddresses': 'not a list', 'header:X-Foo:asDate': 'not a date', 'header:X-Foo': 5, 'header:X-Foo:asBogus': 'x' };
        for (const [property, value] of Object.entries(values)) {
            await rejects({ [property]: value }, [property]);
        }
    });

    scenario('ESET-157', async () => {
        const cases = [
            { from: [{ email: 'a@example.com' }], 'header:From': ' b@example.com' },
            { subject: 'a', 'header:SUBJECT:asText': 'b' },
            { 'header:X-Foo': ' a', 'header:x-foo:asText': 'b' },
            { messageId: ['a@b'], 'header:Message-ID:asMessageIds': ['c@d'] }
        ];
        for (const object of cases) {
            await rejects(object, Object.keys(object));
        }
    });

    scenario('ESET-158', async () => {
        for (const property of ['header:Content-Type', 'header:Content-Disposition', 'header:content-transfer-encoding']) {
            await rejects({ [property]: property.endsWith('Type') ? ' text/plain' : property.endsWith('Disposition') ? ' inline' : ' base64' }, [property]);
        }
        expectCreated(await create(ctx.client, draft(ctx, { 'header:X-Content-Info': ' ok' })));
    });

    scenario('ESET-159', async () => {
        const error = await rejects({
            subject: 'a',
            bodyStructure: { type: 'text/plain', partId: 't', 'header:Subject': ' b' },
            bodyValues: { t: { value: 'x' } }
        });
        expect(error.properties).to.include('bodyStructure');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, { bodyStructure: { type: 'text/plain', partId: 't', 'header:Subject': ' b' }, bodyValues: { t: { value: 'x' } } })
            )
        );
        expect(fieldsNamed(await rawOf(ctx, created.blobId), 'Subject')).to.deep.equal(['Subject: b']);
    });

    scenario('ESET-160', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { 'header:X-Foo': null, 'header:X-Bar:asMessageIds': null })));
        const raw = await rawOf(ctx, created.blobId);
        expect(fieldsNamed(raw, 'X-Foo')).to.deep.equal([]);
        expect(fieldsNamed(raw, 'X-Bar')).to.deep.equal([]);
        expect((await emailOf(ctx, created.id, ['header:X-Foo']))['header:X-Foo']).to.equal(null);
    });

    scenario('ESET-161', async () => {
        for (const property of ['header:X Foo', 'header:', 'header:X-Foö', 'header:X:Y:Z:asText', 'header:X-\u0001Foo']) {
            await rejects({ [property]: ' value' }, [property]);
        }
    });

    scenario('ESET-162', async () => {
        const property = 'header:X-A\r\nBcc: evil@example.com';
        await rejects({ [property]: ' x' }, [property]);
    });

    scenario('ESET-163', async () => {
        for (const value of [' a\r\nb', ' a\rb', ' a\nb', ' a\fb']) {
            await rejects({ 'header:X-Test': value }, ['header:X-Test']);
        }
    });

    scenario('ESET-164', async () => {
        for (const value of [' a\r\n b', ' a\tb']) {
            const created = expectCreated(await create(ctx.client, draft(ctx, { 'header:X-Test': value })));
            expect((await emailOf(ctx, created.id, ['header:X-Test']))['header:X-Test']).to.equal(value);
            const raw = await rawOf(ctx, created.blobId);
            expect(fieldsNamed(raw, 'X-Test')).to.deep.equal([`X-Test:${value}`]);
        }
    });

    scenario('ESET-165', async () => {
        for (const value of [' a\r\nBcc: evil@example.com', ' a\r\n\r\ninjected body']) {
            await rejects({ 'header:X-Test': value }, ['header:X-Test']);
        }
    });

    scenario('ESET-166', async () => {
        const value = 'Hi\r\nBcc: evil@example.com';
        for (const object of [{ subject: value }, { 'header:X-Note:asText': value }]) {
            const res = await create(ctx.client, draft(ctx, object));
            if (!res.created) {
                expectProperties(res.notCreated.c1, Object.keys(object));
                continue;
            }
            const { headers } = await emailOf(ctx, res.created.c1.id, ['headers']);
            expect(headers.filter(header => header.name.toLowerCase() === 'bcc')).to.deep.equal([]);
            expect(headers.filter(header => header.name.toLowerCase() === 'subject')).to.have.length(object.subject ? 1 : 0);
            if (object.subject) {
                expect((await emailOf(ctx, res.created.c1.id, ['subject'])).subject).to.equal(value);
            }
        }
    });

    scenario('ESET-167', async () => {
        const res = await create(ctx.client, draft(ctx, { to: [{ name: 'A\r\nBcc: evil@example.com', email: 'a@example.com' }] }));
        if (res.created) {
            const { headers, to } = await emailOf(ctx, res.created.c1.id, ['headers', 'to']);
            expect(headers.filter(header => header.name.toLowerCase() === 'bcc')).to.deep.equal([]);
            expect(to).to.have.length(1);
            expect(to[0].email).to.equal('a@example.com');
        } else {
            expectProperties(res.notCreated.c1, ['to']);
        }
        await rejects({ to: [{ email: 'a@example.com\r\nBcc: evil@example.com' }] }, ['to']);
    });

    scenario('ESET-168', async () => {
        await rejects({ messageId: ['a@b\r\nX-Evil: 1'] }, ['messageId']);
        await rejects({ references: ['a@b>\r\n<c@d'] }, ['references']);
        await rejects({ 'header:List-Post:asURLs': ['mailto:a@b\r\nX-Evil: 1'] }, ['header:List-Post:asURLs']);
        for (const id of ['a b@c', '<a@b>', 'a\u0001@b']) {
            await rejects({ messageId: [id] }, ['messageId']);
        }
    });

    scenario('ESET-169', async () => {
        const blob = await upload(ctx, Buffer.from('part'), 'text/plain');
        const part = extra => ({ attachments: [Object.assign({ blobId: blob.blobId, type: 'text/plain' }, extra)] });
        for (const extra of [
            { type: 'text/plain\r\nX-Evil: 1' },
            { cid: 'x\r\nX-Evil: 1' },
            { disposition: 'attachment\r\nX-Evil: 1' },
            { language: ['en\r\nX-Evil: 1'] },
            { location: 'http://x\r\nX-Evil: 1' },
            { charset: 'utf-8\r\nX-Evil: 1' }
        ]) {
            await rejects(part(extra), ['attachments']);
        }
        const res = await create(ctx.client, draft(ctx, part({ name: 'a.txt\r\nContent-Type: text/html' })));
        if (res.created) {
            const raw = await rawOf(ctx, res.created.c1.blobId);
            expect(raw).to.not.match(/^X-Evil/im);
            expect(raw.match(/^Content-Type: text\/html/gim)).to.equal(null);
        } else {
            expectProperties(res.notCreated.c1, ['attachments']);
        }
    });

    scenario('ESET-170', async () => {
        for (const object of [{ subject: 'a\u0000b' }, { 'header:X-Test': ' a\u0000b' }, { from: [{ name: 'A\u0001B', email: 'a@example.com' }] }]) {
            const res = await create(ctx.client, draft(ctx, object));
            if (res.created) {
                const raw = await rawOf(ctx, res.created.c1.blobId);
                expect(headerSection(raw)).to.not.include('\u0000');
                expect(headerSection(raw)).to.not.include('\u0001');
            } else {
                expectProperties(res.notCreated.c1, Object.keys(object));
            }
        }
    });

    scenario('ESET-171', async () => {
        const asciiSubject = Array.from({ length: 80 }, (_, i) => `word${i}`)
            .join(' ')
            .slice(0, 400);
        const unicodeSubject = 'äöüß '.repeat(80).slice(0, 400);
        const to = Array.from({ length: 60 }, (_, i) => ({ name: `Recipient ${i}`, email: `r${i}@example.com` }));
        const references = Array.from({ length: 50 }, (_, i) => `ref${i}.${Date.now()}@example.com`);
        for (const object of [{ subject: asciiSubject, to, references }, { subject: unicodeSubject }]) {
            const created = expectCreated(await create(ctx.client, draft(ctx, object)));
            const raw = await rawOf(ctx, created.blobId);
            const lines = physicalLines(headerSection(raw));
            expect(Math.max(...lines.map(line => Buffer.byteLength(line, 'binary')))).to.be.at.most(998);
            // folded where the syntax allows it
            expect(Math.max(...lines.map(line => line.length))).to.be.at.most(100);
            const email = await emailOf(ctx, created.id, Object.keys(object));
            for (const [property, value] of Object.entries(object)) {
                expect(email[property], property).to.deep.equal(value);
            }
        }
    });

    scenario('ESET-172', async () => {
        const res = await create(ctx.client, draft(ctx, { 'header:X-Long': ' ' + 'x'.repeat(2000) }));
        if (res.created) {
            const raw = await rawOf(ctx, res.created.c1.blobId);
            expect(Math.max(...physicalLines(raw).map(line => line.length))).to.be.at.most(998);
        } else {
            expectProperties(res.notCreated.c1, ['header:X-Long']);
        }
    });

    scenario('ESET-173', async () => {
        for (const to of ['a@example.com', [{ name: 'A' }], [{ email: null }], [{ email: 5 }], [null]]) {
            await rejects({ to }, ['to']);
        }
    });

    scenario('ESET-174', async () => {
        for (const keywords of [{ $draft: true }, {}]) {
            const created = expectCreated(await create(ctx.client, draft(ctx, { keywords, to: [{ email: 'not an address' }] })));
            const { to } = await emailOf(ctx, created.id, ['to']);
            expect(to).to.have.length(1);
            expect(`${to[0].name || ''} ${to[0].email || ''}`.trim()).to.equal('not an address');
        }
    });

    // ---- body structure

    scenario('ESET-175', async () => {
        const created = expectCreated(
            await create(ctx.client, draft(ctx, { bodyStructure: { type: 'text/plain', partId: 't' }, bodyValues: { t: { value: 'body' } } }))
        );
        const email = await full(ctx, created.id, ['bodyStructure', 'textBody', 'bodyValues']);
        expect(email.bodyStructure.type).to.equal('text/plain');
        expect(email.bodyStructure.subParts === null || email.bodyStructure.subParts === undefined).to.be.true;
        expect(email.textBody.map(part => part.partId)).to.deep.equal([email.bodyStructure.partId]);
        expect(email.bodyValues[email.bodyStructure.partId].value).to.equal('body\n');
    });

    scenario('ESET-176', async () => {
        const base = { bodyStructure: { type: 'text/plain', partId: 't' }, bodyValues: { t: { value: 'x' } } };
        const blob = await upload(ctx, Buffer.from('x'));
        for (const [property, value] of [
            ['textBody', [{ partId: 't' }]],
            ['htmlBody', [{ partId: 't', type: 'text/html' }]],
            ['attachments', [{ blobId: blob.blobId, type: 'application/octet-stream' }]]
        ]) {
            await rejects(Object.assign({}, base, { [property]: value }), ['bodyStructure', property]);
        }
    });

    scenario('ESET-177', async () => {
        const pdf = await upload(ctx, Buffer.from('%PDF-1.4 pdf content'), 'application/pdf');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    bodyStructure: {
                        type: 'multipart/mixed',
                        subParts: [
                            { type: 'text/plain', partId: 't' },
                            { type: 'application/pdf', blobId: pdf.blobId, name: 'a.pdf', disposition: 'attachment' }
                        ]
                    },
                    bodyValues: { t: { value: 'see attached' } }
                })
            )
        );
        const email = await full(ctx, created.id, ['bodyStructure', 'textBody', 'attachments', 'hasAttachment']);
        expect(email.bodyStructure.type).to.equal('multipart/mixed');
        expect(email.bodyStructure.subParts.map(part => part.type)).to.deep.equal(['text/plain', 'application/pdf']);
        expect(email.bodyStructure.subParts.every(part => typeof part.partId === 'string')).to.be.true;
        expect(email.textBody.map(part => part.partId)).to.deep.equal([email.bodyStructure.subParts[0].partId]);
        expect(email.attachments).to.have.length(1);
        expect(email.attachments[0]).to.include({ type: 'application/pdf', name: 'a.pdf' });
        expect(email.hasAttachment).to.equal(true);
    });

    scenario('ESET-178', async () => {
        const img = await upload(ctx, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
        const doc = await upload(ctx, Buffer.from('%PDF-1.4'), 'application/pdf');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    bodyStructure: {
                        type: 'multipart/mixed',
                        subParts: [
                            {
                                type: 'multipart/alternative',
                                subParts: [
                                    { type: 'text/plain', partId: 't' },
                                    {
                                        type: 'multipart/related',
                                        subParts: [
                                            { type: 'text/html', partId: 'h' },
                                            { type: 'image/png', blobId: img.blobId, disposition: 'inline', cid: 'img1' }
                                        ]
                                    }
                                ]
                            },
                            { type: 'application/pdf', blobId: doc.blobId, disposition: 'attachment', name: 'doc.pdf' }
                        ]
                    },
                    bodyValues: { t: { value: 'plain' }, h: { value: '<img src="cid:img1">' } }
                })
            )
        );
        const email = await full(ctx, created.id, ['bodyStructure', 'textBody', 'htmlBody', 'attachments']);
        const shape = part => (part.subParts ? { type: part.type, subParts: part.subParts.map(shape) } : part.type);
        expect(shape(email.bodyStructure)).to.deep.equal({
            type: 'multipart/mixed',
            subParts: [
                { type: 'multipart/alternative', subParts: ['text/plain', { type: 'multipart/related', subParts: ['text/html', 'image/png'] }] },
                'application/pdf'
            ]
        });
        expect(email.textBody.map(part => part.type)).to.deep.equal(['text/plain']);
        expect(email.htmlBody.map(part => part.type)).to.deep.equal(['text/html']);
        expect(email.attachments.map(part => ({ type: part.type, disposition: part.disposition, cid: part.cid }))).to.deep.equal([
            { type: 'image/png', disposition: 'inline', cid: 'img1' },
            { type: 'application/pdf', disposition: 'attachment', cid: null }
        ]);
    });

    scenario('ESET-179', async () => {
        const e1 = await seedEmail(ctx, { subject: 'Digest one' });
        const e2 = await seedEmail(ctx, { subject: 'Digest two' });
        const b1 = (await emailOf(ctx, e1.id, ['blobId'])).blobId;
        const b2 = (await emailOf(ctx, e2.id, ['blobId'])).blobId;
        const digest = expectCreated(
            await create(ctx.client, draft(ctx, { bodyStructure: { type: 'multipart/digest', subParts: [{ blobId: b1 }, { blobId: b2 }] } }))
        );
        const structure = (await full(ctx, digest.id, ['bodyStructure'])).bodyStructure;
        expect(structure.type).to.equal('multipart/digest');
        expect(structure.subParts.map(part => part.type)).to.deep.equal(['message/rfc822', 'message/rfc822']);

        for (const type of ['multipart/report', 'multipart/x-custom']) {
            const created = expectCreated(
                await create(
                    ctx.client,
                    draft(ctx, {
                        bodyStructure: {
                            type,
                            subParts: [
                                { type: 'text/plain', partId: 't' },
                                { type: 'text/html', partId: 'h' }
                            ]
                        },
                        bodyValues: { t: { value: 'one' }, h: { value: '<p>two</p>' } }
                    })
                )
            );
            const email = await full(ctx, created.id, ['bodyStructure', 'textBody', 'htmlBody', 'attachments']);
            expect(email.bodyStructure.type).to.equal(type);
            // like multipart/mixed: inline text parts in order, both in textBody and htmlBody
            expect(email.textBody.map(part => part.type)).to.deep.equal(['text/plain', 'text/html']);
            expect(email.htmlBody.map(part => part.type)).to.deep.equal(['text/plain', 'text/html']);
            expect(email.attachments).to.deep.equal([]);
        }
    });

    scenario('ESET-180', async () => {
        const blob = await upload(ctx, Buffer.from('x'));
        const values = { bodyValues: { t: { value: 'x' } } };
        const cases = [
            { type: 'multipart/mixed', partId: 't', subParts: [{ type: 'text/plain', partId: 't' }] },
            { type: 'multipart/mixed', blobId: blob.blobId, subParts: [{ type: 'text/plain', partId: 't' }] },
            { type: 'multipart/mixed' },
            { type: 'multipart/mixed', subParts: [] },
            { type: 'text/plain', partId: 't', subParts: [{ type: 'text/plain', partId: 't' }] },
            { type: 'notatype', partId: 't' },
            { type: 'multipart/mixed', subParts: { type: 'text/plain', partId: 't' } }
        ];
        for (const bodyStructure of cases) {
            const error = await rejects(Object.assign({ bodyStructure }, values));
            expect(
                error.properties.every(property => property.startsWith('bodyStructure')),
                JSON.stringify(bodyStructure)
            ).to.be.true;
        }
    });

    scenario('ESET-181', async () => {
        const nested = levels => {
            let bodyStructure = { type: 'text/plain', partId: 't' };
            for (let i = 0; i < levels; i++) {
                bodyStructure = { type: 'multipart/mixed', subParts: [bodyStructure] };
            }
            return draft(ctx, { bodyStructure, bodyValues: { t: { value: 'deep' } } });
        };
        const refused = await ctx.client.request({
            using: [jmap.URN.core, jmap.URN.mail],
            methodCalls: [['Email/set', { accountId: ctx.client.accountId, create: { c1: nested(200) } }, 'c0']]
        });
        expect(refused.status).to.equal(400);
        expect(refused.json.type).to.equal('urn:ietf:params:jmap:error:notJSON');
        // beyond the builder limit, within the JSON limit
        const res = await create(ctx.client, nested(25));
        expect(res.created).to.equal(null);
        expect(['invalidProperties', 'tooLarge']).to.include(res.notCreated.c1.type);
    });

    scenario('ESET-182', async () => {
        const values = { bodyValues: { a: { value: 'a' }, b: { value: 'b' } } };
        await rejects(Object.assign({ textBody: [{ partId: 'a' }, { partId: 'b' }] }, values), ['textBody']);
        await rejects(Object.assign({ htmlBody: [{ partId: 'a' }, { partId: 'b' }] }, values), ['htmlBody']);
        await rejects(Object.assign({ textBody: [] }, values), ['textBody']);
    });

    scenario('ESET-183', async () => {
        const values = { bodyValues: { a: { value: 'a' } } };
        await rejects(Object.assign({ textBody: [{ partId: 'a', type: 'text/html' }] }, values), ['textBody']);
        await rejects(Object.assign({ htmlBody: [{ partId: 'a', type: 'text/plain' }] }, values), ['htmlBody']);
        const created = expectCreated(await create(ctx.client, draft(ctx, Object.assign({ htmlBody: [{ partId: 'a' }] }, values))));
        expect((await full(ctx, created.id, ['bodyStructure'])).bodyStructure.type).to.equal('text/html');
    });

    scenario('ESET-184', async () => {
        const blob = await upload(ctx, Buffer.from('text'), 'text/plain');
        await rejects({ textBody: [{ partId: 'a', blobId: blob.blobId }], bodyValues: { a: { value: 'a' } } }, ['textBody']);
        await rejects({ textBody: [{ type: 'text/plain' }] }, ['textBody']);
    });

    scenario('ESET-185', async () => {
        await rejects({ textBody: [{ partId: 'a' }], bodyValues: { b: { value: 'x' } } }, ['textBody']);
        await rejects({ textBody: [{ partId: 'a' }] }, ['textBody']);
    });

    scenario('ESET-186', async () => {
        await rejects({ textBody: [{ partId: 'a', charset: 'utf-8' }], bodyValues: { a: { value: 'a' } } }, ['textBody']);
        await rejects({ textBody: [{ partId: 'a', size: 3 }], bodyValues: { a: { value: 'a' } } }, ['textBody']);
    });

    scenario('ESET-187', async () => {
        const blob = await upload(ctx, Buffer.alloc(100, 'a'), 'text/plain');
        for (const size of [105, 100]) {
            const created = expectCreated(
                await create(ctx.client, draft(ctx, { attachments: [{ blobId: blob.blobId, type: 'text/plain', size, disposition: 'attachment' }] }))
            );
            const { attachments } = await full(ctx, created.id, ['attachments']);
            expect(attachments[0].size).to.equal(100);
        }
    });

    scenario('ESET-188', async () => {
        const blob = await upload(ctx, Buffer.from('x'));
        for (const value of [' base64', ' 7bit', ' binary']) {
            await rejects({ textBody: [{ partId: 't', 'header:Content-Transfer-Encoding': value }], bodyValues: { t: { value: 'x' } } }, ['textBody']);
            await rejects({ attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', 'header:Content-Transfer-Encoding': value }] }, [
                'attachments'
            ]);
            await rejects(
                { bodyStructure: { type: 'text/plain', partId: 't', 'header:Content-Transfer-Encoding': value }, bodyValues: { t: { value: 'x' } } },
                ['bodyStructure']
            );
        }
    });

    scenario('ESET-189', async () => {
        await rejects(text('x', { bodyValues: { t: { value: 'x', isTruncated: true } } }), ['bodyValues']);
        await rejects(text('x', { bodyValues: { t: { value: 'x', isEncodingProblem: true } } }), ['bodyValues']);
        expectCreated(await create(ctx.client, draft(ctx, text('x', { bodyValues: { t: { value: 'x', isTruncated: false, isEncodingProblem: false } } }))));
        expectCreated(await create(ctx.client, draft(ctx, text('x'))));
    });

    scenario('ESET-190', async () => {
        for (const bodyValues of [{ t: 'text' }, { t: { value: 5 } }, { t: {} }, [{ value: 'x' }]]) {
            await rejects({ textBody: [{ partId: 't' }], bodyValues }, ['bodyValues']);
        }
    });

    scenario('ESET-191', async () => {
        const created = expectCreated(await create(ctx.client, draft(ctx, { textBody: [{ partId: 'a' }], bodyValues: { a: { value: '' } } })));
        const email = await full(ctx, created.id, ['textBody', 'bodyValues']);
        expect(email.textBody[0].size).to.equal(0);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('');
    });

    scenario('ESET-192', async () => {
        const value = 'ASCII, äöü éè, 中文字, emoji \u{1F600}\u{1F680}';
        const created = expectCreated(await create(ctx.client, draft(ctx, text(value))));
        const email = await full(ctx, created.id, ['textBody', 'bodyValues']);
        const part = email.textBody[0];
        expect(email.bodyValues[part.partId]).to.deep.equal({ value, isEncodingProblem: false, isTruncated: false });
        expect(part.charset).to.equal('utf-8');
        const raw = await rawOf(ctx, created.blobId);
        expect(ascii(raw)).to.be.true;
        expect(fieldsNamed(raw, 'Content-Transfer-Encoding')[0]).to.match(/^Content-Transfer-Encoding: (quoted-printable|base64)$/i);
    });

    scenario('ESET-193', async () => {
        const value = 'A short plain line.\nAnother one.';
        const created = expectCreated(await create(ctx.client, draft(ctx, text(value))));
        const raw = await rawOf(ctx, created.blobId);
        const encoding = fieldsNamed(raw, 'Content-Transfer-Encoding')[0];
        expect(encoding).to.match(/^Content-Transfer-Encoding: (7bit|quoted-printable)$/i);
        expect(raw).to.include('A short plain line.\r\nAnother one.');
    });

    scenario('ESET-194', async () => {
        const plain = 'x'.repeat(2000);
        const htmlValue = `<p>${'y'.repeat(5000)}</p>`;
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, { textBody: [{ partId: 't' }], htmlBody: [{ partId: 'h' }], bodyValues: { t: { value: plain }, h: { value: htmlValue } } })
            )
        );
        const raw = await rawOf(ctx, created.blobId);
        expect(Math.max(...physicalLines(raw).map(line => line.length))).to.be.at.most(998);
        const email = await full(ctx, created.id, ['textBody', 'htmlBody', 'bodyValues']);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal(plain);
        expect(email.bodyValues[email.htmlBody[0].partId].value).to.equal(htmlValue);
    });

    scenario('ESET-195', async () => {
        // a text part next to an html part, so the value is not the last line of the message
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    textBody: [{ partId: 't' }],
                    htmlBody: [{ partId: 'h' }],
                    bodyValues: { t: { value: 'ab\r\ncde\rfgh\nij' }, h: { value: '<p>x</p>' } }
                })
            )
        );
        const raw = await rawOf(ctx, created.blobId);
        const body = raw.slice(raw.indexOf(CRLF + CRLF) + 4);
        expect(body.replace(/\r\n/g, '')).to.not.match(/[\r\n]/);
        const email = await full(ctx, created.id, ['textBody', 'bodyValues']);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('ab\ncde\nfgh\nij');
    });

    scenario('ESET-196', async () => {
        const value = 'From here\n.\n..\ntrailing spaces   \nend\n';
        const created = expectCreated(await create(ctx.client, draft(ctx, text(value))));
        const email = await full(ctx, created.id, ['textBody', 'bodyValues']);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal(value);
        const doc = await docOf(ctx, created.id);
        const raw = await rawOf(ctx, created.blobId);
        const encoding = /Content-Transfer-Encoding: (\S+)/i.exec(raw)[1];
        const decoded = await imapDecodedPart(ctx.user, 'Drafts', doc.uid, 'text', encoding);
        expect(decoded.toString('utf8').replace(/\r\n/g, '\n')).to.equal(value);
    });

    scenario('ESET-197', async () => {
        const content = await fixtures.buildMessage({ text: 'inner text', attachments: [{ filename: 'inner.txt', content: 'inner attachment' }] });
        const e = await seedEmail(ctx, { content });
        const blob = (await emailOf(ctx, e.id, ['blobId'])).blobId;
        const value = '--leading dashes\n-- signature\n--';
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, text(value, { attachments: [{ blobId: blob, type: 'text/plain', name: 'raw.txt', disposition: 'attachment' }] }))
            )
        );
        const email = await full(ctx, created.id, ['bodyStructure', 'bodyValues', 'textBody', 'attachments']);
        expect(email.bodyStructure.subParts).to.have.length(2);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal(value);
        expect((await bytes(ctx, email.attachments[0].blobId)).equals(content)).to.be.true;
        const raw = await rawOf(ctx, created.blobId);
        const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw)[1];
        expect(content.toString('binary')).to.not.include(boundary);
        expect(value).to.not.include(boundary);
    });

    // ---- blobs

    scenario('ESET-198', async () => {
        const content = Buffer.from(Array.from({ length: 20 * 1024 }, (_, i) => (i * 31) % 256));
        const blob = await upload(ctx, content, 'application/pdf');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(
                    ctx,
                    text('see attached', { attachments: [{ blobId: blob.blobId, type: 'application/pdf', name: 'report.pdf', disposition: 'attachment' }] })
                )
            )
        );
        const email = await full(ctx, created.id, ['hasAttachment', 'attachments']);
        expect(email.hasAttachment).to.equal(true);
        expect(email.attachments).to.have.length(1);
        expect(email.attachments[0]).to.include({ type: 'application/pdf', name: 'report.pdf', disposition: 'attachment', size: content.length });
        expect((await bytes(ctx, email.attachments[0].blobId)).equals(content)).to.be.true;
    });

    scenario('ESET-199', async () => {
        const img = await upload(ctx, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
        const doc = await upload(ctx, Buffer.from('%PDF-1.4'), 'application/pdf');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    textBody: [{ partId: 't' }],
                    htmlBody: [{ partId: 'h' }],
                    bodyValues: { t: { value: 'plain' }, h: { value: '<img src="cid:c1">' } },
                    attachments: [
                        { blobId: img.blobId, type: 'image/png', disposition: 'inline', cid: 'c1' },
                        { blobId: doc.blobId, type: 'application/pdf', disposition: 'attachment', name: 'doc.pdf' }
                    ]
                })
            )
        );
        const email = await full(ctx, created.id, ['bodyStructure', 'textBody', 'htmlBody', 'attachments']);
        const shape = part => (part.subParts ? { type: part.type, subParts: part.subParts.map(shape) } : part.type);
        expect(shape(email.bodyStructure)).to.deep.equal({
            type: 'multipart/mixed',
            subParts: [
                { type: 'multipart/alternative', subParts: ['text/plain', { type: 'multipart/related', subParts: ['text/html', 'image/png'] }] },
                'application/pdf'
            ]
        });
        expect(email.textBody.map(part => part.type)).to.deep.equal(['text/plain']);
        expect(email.htmlBody.map(part => part.type)).to.deep.equal(['text/html']);
        expect(email.attachments.map(part => [part.type, part.disposition, part.cid])).to.deep.equal([
            ['image/png', 'inline', 'c1'],
            ['application/pdf', 'attachment', null]
        ]);
    });

    scenario('ESET-200', async () => {
        const img = await upload(ctx, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
        const doc = await upload(ctx, Buffer.from('%PDF-1.4'), 'application/pdf');
        const html = { htmlBody: [{ partId: 'h' }], bodyValues: { h: { value: '<img src="cid:c1">' } } };
        const related = expectCreated(
            await create(
                ctx.client,
                draft(ctx, Object.assign({ attachments: [{ blobId: img.blobId, type: 'image/png', disposition: 'inline', cid: 'c1' }] }, html))
            )
        );
        const a = (await full(ctx, related.id, ['bodyStructure'])).bodyStructure;
        expect(a.type).to.equal('multipart/related');
        expect(a.subParts.map(part => part.type)).to.deep.equal(['text/html', 'image/png']);
        const mixed = expectCreated(
            await create(
                ctx.client,
                draft(ctx, Object.assign({ attachments: [{ blobId: doc.blobId, type: 'application/pdf', disposition: 'attachment' }] }, html))
            )
        );
        const b = (await full(ctx, mixed.id, ['bodyStructure'])).bodyStructure;
        expect(b.type).to.equal('multipart/mixed');
        expect(b.subParts.map(part => part.type)).to.deep.equal(['text/html', 'application/pdf']);
    });

    scenario('ESET-201', async () => {
        const img = await upload(ctx, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
        const html = { htmlBody: [{ partId: 'h' }], bodyValues: { h: { value: '<img src="cid:logo@example.com">' } } };
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, Object.assign({ attachments: [{ blobId: img.blobId, type: 'image/png', cid: 'logo@example.com', disposition: 'inline' }] }, html))
            )
        );
        expect(await rawOf(ctx, created.blobId)).to.include('Content-ID: <logo@example.com>');
        expect((await full(ctx, created.id, ['attachments'])).attachments[0].cid).to.equal('logo@example.com');
        for (const cid of ['logo @example.com', '<logo@example.com>']) {
            await rejects({ attachments: [{ blobId: img.blobId, type: 'image/png', cid, disposition: 'inline' }] }, ['attachments']);
        }
    });

    scenario('ESET-202', async () => {
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    bodyStructure: { type: 'text/plain', partId: 't', language: ['de-DE', 'en-CA'], location: 'http://example.com/uri' },
                    bodyValues: { t: { value: 'x' } }
                })
            )
        );
        const { bodyStructure } = await full(ctx, created.id, ['bodyStructure'], { bodyProperties: ['partId', 'type', 'language', 'location'] });
        expect(bodyStructure.language).to.deep.equal(['de-DE', 'en-CA']);
        expect(bodyStructure.location).to.equal('http://example.com/uri');
        const raw = await rawOf(ctx, created.blobId);
        expect(fieldsNamed(raw, 'Content-Language')).to.deep.equal(['Content-Language: de-DE, en-CA']);
        expect(fieldsNamed(raw, 'Content-Location')).to.deep.equal(['Content-Location: http://example.com/uri']);
    });

    scenario('ESET-203', async () => {
        const blob = await upload(ctx, Buffer.from('binary'), 'application/octet-stream');
        for (const disposition of ['attachment', 'inline', undefined, 'x-custom']) {
            const part = { blobId: blob.blobId, type: 'application/octet-stream', name: 'a.bin' };
            if (disposition) {
                part.disposition = disposition;
            }
            const created = expectCreated(await create(ctx.client, draft(ctx, text('body', { attachments: [part] }))));
            const { attachments } = await full(ctx, created.id, ['attachments']);
            expect(attachments, String(disposition)).to.have.length(1);
            expect(attachments[0].name).to.equal('a.bin');
            expect(attachments[0].disposition).to.equal(disposition || null);
        }
    });

    scenario('ESET-204', async () => {
        const blob = await upload(ctx, Buffer.from('content'), 'application/octet-stream');
        const names = ['résumé 中文.pdf', 'quote "a"; semi\\back.txt', `${'n'.repeat(296)}.txt`];
        for (const name of names) {
            const created = expectCreated(
                await create(
                    ctx.client,
                    draft(ctx, { attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', name, disposition: 'attachment' }] })
                )
            );
            expect((await full(ctx, created.id, ['attachments'])).attachments[0].name).to.equal(name);
            const raw = await rawOf(ctx, created.blobId);
            expect(ascii(raw)).to.be.true;
            expect(Math.max(...physicalLines(raw).map(line => line.length))).to.be.below(998);
            const doc = await docOf(ctx, created.id);
            const session = await imapFor(ctx.user);
            await session.mailboxOpen('Drafts');
            const { bodyStructure } = await session.fetchOne(String(doc.uid), { bodyStructure: true }, { uid: true });
            const node = bodyStructure.childNodes ? bodyStructure.childNodes[0] : bodyStructure;
            const imapName = (node.dispositionParameters && node.dispositionParameters.filename) || (node.parameters && node.parameters.name);
            expect(libmime.decodeWords(imapName)).to.equal(name);
        }
    });

    scenario('ESET-205', async () => {
        const content = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0, 0, 13, 65, 10, 66, 13])]);
        const blob = await upload(ctx, content, 'application/octet-stream');
        const created = expectCreated(
            await create(ctx.client, draft(ctx, { attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', name: 'all.bin' }] }))
        );
        const raw = await rawOf(ctx, created.blobId);
        const part = raw.slice(raw.indexOf('Content-Type: application/octet-stream'));
        expect(part).to.match(/Content-Transfer-Encoding: base64/i);
        const encoded = part
            .slice(part.indexOf(CRLF + CRLF) + 4)
            .split(CRLF)
            .filter(line => line && !line.startsWith('--'));
        expect(Math.max(...encoded.map(line => line.length))).to.be.at.most(76);
        const { attachments } = await full(ctx, created.id, ['attachments']);
        expect((await bytes(ctx, attachments[0].blobId)).equals(content)).to.be.true;
        const doc = await docOf(ctx, created.id);
        expect((await imapDecodedPart(ctx.user, 'Drafts', doc.uid, attachments[0].partId, 'base64')).equals(content)).to.be.true;
    });

    scenario('ESET-206', async () => {
        const content = Buffer.from('line1\nline2\n');
        const blob = await upload(ctx, content, 'text/plain');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, text('body', { attachments: [{ blobId: blob.blobId, type: 'text/plain', disposition: 'attachment', name: 'lf.txt' }] }))
            )
        );
        const { attachments } = await full(ctx, created.id, ['attachments']);
        expect((await bytes(ctx, attachments[0].blobId)).equals(content)).to.be.true;
    });

    scenario('ESET-207', async () => {
        const t = await upload(ctx, Buffer.from('Blob text ä', 'utf8'), 'text/plain');
        const h = await upload(ctx, Buffer.from('<p>Blob html ä</p>', 'utf8'), 'text/html');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    textBody: [{ blobId: t.blobId, type: 'text/plain', charset: 'utf-8' }],
                    htmlBody: [{ blobId: h.blobId, type: 'text/html', charset: 'utf-8' }]
                })
            )
        );
        const email = await full(ctx, created.id, ['textBody', 'htmlBody', 'bodyValues']);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('Blob text ä');
        expect(email.bodyValues[email.htmlBody[0].partId].value).to.equal('<p>Blob html ä</p>');
    });

    scenario('ESET-208', async () => {
        const content = Buffer.from('café crème', 'latin1');
        const blob = await upload(ctx, content, 'text/plain');
        const created = expectCreated(await create(ctx.client, draft(ctx, { textBody: [{ blobId: blob.blobId, type: 'text/plain', charset: 'iso-8859-1' }] })));
        const email = await full(ctx, created.id, ['textBody', 'bodyValues']);
        expect(email.textBody[0].charset).to.equal('iso-8859-1');
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('café crème');
        expect((await bytes(ctx, email.textBody[0].blobId)).equals(content)).to.be.true;
    });

    scenario('ESET-209', async () => {
        const own = await account();
        const pdf = Buffer.from('%PDF-1.4 original attachment bytes');
        const e = await seedEmail(own, {
            content: await fixtures.buildMessage({ attachments: [{ filename: 'orig.pdf', content: pdf, contentType: 'application/pdf' }] })
        });
        const partBlob = (await emailOf(own, e.id, ['attachments'])).attachments[0].blobId;
        const created = expectCreated(await create(own.client, draft(own, { attachments: [{ blobId: partBlob, type: 'application/pdf', name: 'copy.pdf' }] })));
        const attachment = (await emailOf(own, created.id, ['attachments'])).attachments[0];
        expect((await download(own.client, attachment.blobId)).equals(pdf)).to.be.true;
        expect((await set(own.client, { destroy: [e.id] })).destroyed).to.deep.equal([e.id]);
        expect((await download(own.client, attachment.blobId)).equals(pdf)).to.be.true;
    });

    scenario('ESET-210', async () => {
        const own = await account();
        const original = Buffer.from(
            ['Subject: Forward me', 'From: a@example.com', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Kõik ära'].join(
                CRLF
            ),
            'utf8'
        );
        const e = await seedEmail(own, { content: original });
        const blob = (await emailOf(own, e.id, ['blobId'])).blobId;
        const eRaw = await download(own.client, blob);
        const created = expectCreated(
            await create(own.client, draft(own, text('fwd', { attachments: [{ blobId: blob, type: 'message/rfc822', name: 'fwd.eml' }] })))
        );
        const { attachments } = await emailOf(own, created.id, ['attachments']);
        expect(attachments[0].type).to.equal('message/rfc822');
        const part = await imapPart(own, created.id, attachments[0].partId);
        expect(part.mime).to.match(/Content-Transfer-Encoding: (7bit|8bit|binary)/i);
        expect((await download(own.client, attachments[0].blobId)).equals(eRaw)).to.be.true;
        const [[name, parsed]] = await own.client.call([
            ['Email/parse', { accountId: own.client.accountId, blobIds: [attachments[0].blobId], properties: ['subject'] }, 'p']
        ]);
        if (!(name === 'error' && parsed.type === 'unknownMethod')) {
            // Email/parse is work package 2.8
            expect(parsed.parsed[attachments[0].blobId].subject).to.equal('Forward me');
        }
    });

    scenario('ESET-211', async () => {
        const own = await account();
        const pdf = Buffer.from('%PDF-1.4 same call');
        const e = await seedEmail(own, {
            content: await fixtures.buildMessage({ attachments: [{ filename: 'x.pdf', content: pdf, contentType: 'application/pdf' }] })
        });
        const partBlob = (await emailOf(own, e.id, ['attachments'])).attachments[0].blobId;
        const res = await set(own.client, {
            create: { c1: draft(own, { attachments: [{ blobId: partBlob, type: 'application/pdf', name: 'x.pdf' }] }) },
            destroy: [e.id]
        });
        expect(res.destroyed).to.deep.equal([e.id]);
        const created = expectCreated(res);
        const attachment = (await emailOf(own, created.id, ['attachments'])).attachments[0];
        expect((await download(own.client, attachment.blobId)).equals(pdf)).to.be.true;
    });

    scenario('ESET-212', async () => {
        const blob = await upload(ctx, Buffer.from('part'), 'application/octet-stream');
        const created = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    bodyStructure: {
                        type: 'multipart/mixed',
                        subParts: [
                            { type: 'text/plain', partId: 't' },
                            {
                                type: 'application/octet-stream',
                                blobId: blob.blobId,
                                disposition: 'attachment',
                                'header:X-Part-Info': ' abc',
                                'header:Content-Description:asText': 'desc'
                            }
                        ]
                    },
                    bodyValues: { t: { value: 'x' } }
                })
            )
        );
        const bodyProperties = ['partId', 'subParts', 'header:X-Part-Info', 'header:Content-Description:asText'];
        const email = await full(ctx, created.id, ['bodyStructure', 'header:X-Part-Info'], { bodyProperties });
        expect(email['header:X-Part-Info']).to.equal(null);
        const [textPart, attachmentPart] = email.bodyStructure.subParts;
        expect(attachmentPart['header:X-Part-Info']).to.equal(' abc');
        expect(attachmentPart['header:Content-Description:asText']).to.equal('desc');
        expect(textPart['header:X-Part-Info']).to.equal(null);
    });

    scenario('ESET-213', async () => {
        const blob = await upload(ctx, Buffer.from('part'), 'image/png');
        const cases = [
            { type: 'image/png', 'header:Content-Type': ' image/png' },
            { disposition: 'inline', 'header:Content-Disposition': ' inline' },
            { cid: 'a@b', 'header:Content-ID': ' <a@b>' },
            { language: ['en'], 'header:Content-Language': ' en' },
            { location: 'http://x', 'header:Content-Location': ' http://x' }
        ];
        for (const extra of cases) {
            await rejects({ attachments: [Object.assign({ blobId: blob.blobId, type: 'image/png' }, extra)] }, ['attachments']);
        }
    });

    scenario('ESET-214', async () => {
        const blob = await upload(ctx, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
        const created = expectCreated(await create(ctx.client, draft(ctx, { attachments: [{ blobId: blob.blobId, name: 'x.png' }] })));
        // without a disposition an image is shown inline, so look for it in the whole structure
        const { bodyStructure } = await full(ctx, created.id, ['bodyStructure']);
        const part = leaves(bodyStructure).find(entry => entry.name === 'x.png');
        expect(['image/png', 'application/octet-stream']).to.include(part.type);
    });

    scenario('ESET-215', async () => {
        const blob = await upload(ctx, Buffer.from('present'));
        const x1 = 'Bu000000000000000000000001';
        const x2 = 'Bm000000000000000000000002';
        const before = (await ctx.client.method('Email/query', { filter: { inMailbox: ctx.mb.Drafts }, calculateTotal: true })).total;
        const res = await create(ctx.client, draft(ctx, { attachments: [x1, blob.blobId, x2].map(blobId => ({ blobId, type: 'application/octet-stream' })) }));
        expect(expectNotCreated(res, 'blobNotFound').notFound.sort()).to.deep.equal([x1, x2].sort());
        expect((await ctx.client.method('Email/query', { filter: { inMailbox: ctx.mb.Drafts }, calculateTotal: true })).total).to.equal(before);
    });

    scenario('ESET-216', async () => {
        const other = await account();
        const otherUpload = await upload(other, Buffer.from('secret of B'));
        const { id } = await seedEmail(other, { subject: 'B private' });
        const otherMessage = (await emailOf(other, id, ['blobId'])).blobId;
        for (const blobId of [otherUpload.blobId, otherMessage]) {
            const res = await create(ctx.client, draft(ctx, { attachments: [{ blobId, type: 'application/octet-stream' }] }));
            expect(expectNotCreated(res, 'blobNotFound').notFound).to.deep.equal([blobId]);
        }
    });

    scenario('ESET-217', async () => {
        const res = await create(ctx.client, draft(ctx, { attachments: [{ blobId: 'not a blob id!', type: 'text/plain' }] }));
        expect(res.created).to.equal(null);
        if (res.notCreated.c1.type === 'blobNotFound') {
            expect(res.notCreated.c1.notFound).to.deep.equal(['not a blob id!']);
        } else {
            expectProperties(res.notCreated.c1, ['attachments']);
        }
        await rejects({ attachments: [{ blobId: 5, type: 'text/plain' }] }, ['attachments']);
    });

    scenario('ESET-218', async () => {
        const blob = await upload(ctx, Buffer.from('soon gone'));
        const db = await seed.db();
        await db
            .collection('storage.files')
            .updateOne({ _id: new seed.ObjectId(blob.blobId.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() - 1000) } });
        const res = await create(ctx.client, draft(ctx, { attachments: [{ blobId: blob.blobId, type: 'application/octet-stream' }] }));
        expect(expectNotCreated(res, 'blobNotFound').notFound).to.deep.equal([blob.blobId]);
    });

    scenario('ESET-219', async () => {
        const content = Buffer.from('outlives the upload');
        const blob = await upload(ctx, content);
        const created = expectCreated(
            await create(ctx.client, draft(ctx, { attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', name: 'keep.bin' }] }))
        );
        const db = await seed.db();
        await db
            .collection('storage.files')
            .updateOne({ _id: new seed.ObjectId(blob.blobId.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() - 1000) } });
        await new StorageHandler({ database: db, gridfs: db, users: db }).removeExpiredUploads();
        expect(await db.collection('storage.files').countDocuments({ _id: new seed.ObjectId(blob.blobId.slice(2)) })).to.equal(0);
        const { attachments } = await full(ctx, created.id, ['attachments']);
        expect(attachments[0].name).to.equal('keep.bin');
        expect((await bytes(ctx, attachments[0].blobId)).equals(content)).to.be.true;
    });

    scenario('ESET-220', async () => {
        const content = Buffer.from('shared upload');
        const blob = await upload(ctx, content);
        const part = name => ({ blobId: blob.blobId, type: 'application/octet-stream', name });
        const res = await set(ctx.client, {
            create: { one: draft(ctx, { attachments: [part('a.bin')] }), two: draft(ctx, { attachments: [part('b.bin'), part('c.bin')] }) }
        });
        expect(res.created).to.have.all.keys('one', 'two');
        for (const created of Object.values(res.created)) {
            for (const attachment of (await full(ctx, created.id, ['attachments'])).attachments) {
                expect((await bytes(ctx, attachment.blobId)).equals(content)).to.be.true;
            }
        }
        expect((await bytes(ctx, blob.blobId)).equals(content)).to.be.true;
    });
});
