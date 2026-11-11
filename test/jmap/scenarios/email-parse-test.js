/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file email-parse.yaml: Email/parse (RFC 8621 4.9) of uploads, stored messages and attached
// messages, with the Email model of Email/get.

const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, api, seed, fixtures, jmap } = require('../harness');
const { startInstance, stopInstance, connect } = require('../harness/instance');
const StorageHandler = require('../../../lib/storage-handler');
const h = require('./email-get-helpers');

const PARSE_DEFAULTS = [
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

/** Uploads a body and answers the blob id */
async function upload(client, body, type = 'message/rfc822', base = jmap.JMAP_URL) {
    const res = await client.raw(`${base}/jmap/upload/${client.accountId}/`, { method: 'POST', body, headers: { 'Content-Type': type } });
    expect(res.status, res.body.toString()).to.equal(201);
    return res.json.blobId;
}

/** Email/parse answering the response arguments */
const parse = (client, blobIds, args = {}) => client.method('Email/parse', Object.assign({ blobIds }, args));

async function parseError(client, args, using) {
    try {
        await client.method('Email/parse', args, using);
    } catch (err) {
        if (err.type) {
            return err.type;
        }
        throw err;
    }
    throw new Error('Email/parse did not fail');
}

const simpleMessage = (headers = []) =>
    h.raw(
        'From: Alice Example <alice@example.com>',
        'To: Bob Example <bob@example.net>',
        'Subject: Parse me',
        'Date: Tue, 03 Mar 2020 10:20:30 +0000',
        'Message-ID: <parse-one@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        ...headers,
        '',
        'Hello from the parsed message.',
        ''
    );

// an attached message: its own headers and body, as the content of a message/rfc822 part
const embedded = (subject, body = 'An embedded email', extra = []) =>
    [
        'From: Embedded Sender <embedded@example.org>',
        'To: Embedded Rcpt <embedded-rcpt@example.org>',
        `Subject: ${subject}`,
        'Date: Wed, 04 Mar 2020 11:22:33 +0000',
        `Message-ID: <${subject}-embedded@example.org>`,
        ...extra,
        '',
        body
    ].join(h.CRLF);

const outer = (children, headers = h.DEFAULT_TOP) => h.top(headers, h.multipart('mixed', children));
const rfc822 = (content, extra = []) => h.part(['Content-Type: message/rfc822', ...extra], content);

/** Appends a message over IMAP and answers its Email id */
const store = async (ctx, content) => (await h.append(ctx.user, content)).id;

/** The blob id of the first attachment of a stored Email */
async function attachmentBlob(ctx, id, match = () => true) {
    const email = await h.getOne(ctx.client, id, { properties: ['attachments'] });
    const found = email.attachments.find(match);
    expect(found, 'attachment').to.exist;
    return found.blobId;
}

describe('Email/parse', function () {
    this.timeout(120000);
    let ctx;

    before(async () => {
        ctx = await h.newUser();
    });

    scenario('EPAR-001', async () => {
        const blob = await upload(ctx.client, simpleMessage());
        const res = await parse(ctx.client, [blob]);
        expect(res).to.have.all.keys('accountId', 'parsed', 'notParsable', 'notFound');
        expect(res.accountId).to.equal(ctx.client.accountId);
        expect(res.notParsable).to.equal(null);
        expect(res.notFound).to.equal(null);
        expect(Object.keys(res.parsed)).to.deep.equal([blob]);
        const email = res.parsed[blob];
        expect(email.subject).to.equal('Parse me');
        expect(email.from).to.deep.equal([{ name: 'Alice Example', email: 'alice@example.com' }]);
        expect(email.to).to.deep.equal([{ name: 'Bob Example', email: 'bob@example.net' }]);
        expect(email.messageId).to.deep.equal(['parse-one@example.com']);
        expect(email.sentAt).to.equal('2020-03-03T10:20:30Z');
    });

    scenario('EPAR-002', async () => {
        const content = h.mime(
            h.multipart('mixed', [h.multipart('alternative', [h.text('plain text'), h.html('<p>html text</p>')]), h.attachment('text/csv', 'data.csv', 'a,b')])
        );
        const blob = await upload(ctx.client, content);
        for (const properties of [undefined, null]) {
            const res = await parse(ctx.client, [blob], properties === undefined ? {} : { properties });
            const email = res.parsed[blob];
            expect(Object.keys(email)).to.have.members(PARSE_DEFAULTS);
            expect(Object.keys(email)).to.have.length(PARSE_DEFAULTS.length);
            for (const absent of ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt']) {
                expect(email).to.not.have.property(absent);
            }
            expect(email.bodyValues).to.deep.equal({});
        }
    });

    scenario('EPAR-003', async () => {
        const blob = await upload(ctx.client, simpleMessage());
        const res = await parse(ctx.client, [blob], { properties: ['id', 'mailboxIds', 'keywords', 'receivedAt', 'subject'] });
        expect(res.parsed[blob]).to.deep.equal({ id: null, mailboxIds: null, keywords: null, receivedAt: null, subject: 'Parse me' });
    });

    scenario('EPAR-004', async () => {
        const original = await fixtures.buildMessage({ subject: 'Thread topic', messageId: '<epar004-x@example.com>' });
        await store(ctx, original);
        const reply = await fixtures.buildMessage({ subject: 'Re: Thread topic', references: '<epar004-x@example.com>', inReplyTo: '<epar004-x@example.com>' });
        const unrelated = await fixtures.buildMessage({ subject: 'Something else' });
        const b = await upload(ctx.client, reply);
        const c = await upload(ctx.client, unrelated);
        const res = await parse(ctx.client, [b, c], { properties: ['threadId'] });
        expect(res.parsed[b]).to.deep.equal({ threadId: null });
        expect(res.parsed[c]).to.deep.equal({ threadId: null });
    });

    scenario('EPAR-005', async () => {
        const content = simpleMessage();
        const blob = await upload(ctx.client, content);
        const res = await parse(ctx.client, [blob], { properties: ['blobId', 'size'] });
        expect(res.parsed[blob]).to.deep.equal({ blobId: blob, size: content.length });
    });

    scenario('EPAR-006', async () => {
        const id = await store(ctx, outer([h.text('Outer body'), rfc822(embedded('bar'))]));
        const blob = await attachmentBlob(ctx, id, part => part.type === 'message/rfc822');
        const res = await parse(ctx.client, [blob], {
            properties: ['subject', 'from', 'to', 'cc', 'messageId', 'sentAt', 'bodyStructure', 'textBody', 'htmlBody', 'attachments', 'bodyValues'],
            fetchAllBodyValues: true
        });
        const email = res.parsed[blob];
        expect(email.subject).to.equal('bar');
        expect(email.from).to.deep.equal([{ name: 'Embedded Sender', email: 'embedded@example.org' }]);
        expect(email.to).to.deep.equal([{ name: 'Embedded Rcpt', email: 'embedded-rcpt@example.org' }]);
        expect(email.cc).to.equal(null);
        expect(email.messageId).to.deep.equal(['bar-embedded@example.org']);
        expect(email.sentAt).to.equal('2020-03-04T11:22:33Z');
        expect(email.bodyStructure.type).to.equal('text/plain');
        expect(h.noSubParts(email.bodyStructure)).to.be.true;
        expect(email.textBody).to.have.length(1);
        expect(email.htmlBody).to.have.length(1);
        expect(email.attachments).to.deep.equal([]);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('An embedded email');
    });

    scenario('EPAR-007', async () => {
        const inner = embedded('encoded inner', 'S=C3=BCdwind =E2=82=AC', [
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: quoted-printable'
        ]);
        const variants = [
            h.part(
                ['Content-Type: message/rfc822', 'Content-Transfer-Encoding: base64'],
                Buffer.from(inner, 'binary').toString('base64').replace(/.{76}/g, '$&\r\n')
            ),
            h.part(['Content-Type: message/rfc822', 'Content-Transfer-Encoding: quoted-printable'], inner.replace(/[=]/g, '=3D'))
        ];
        for (const variant of variants) {
            const id = await store(ctx, outer([h.text('Outer'), variant]));
            const blob = await attachmentBlob(ctx, id, part => part.type === 'message/rfc822');
            const res = await parse(ctx.client, [blob], { properties: ['from', 'subject', 'textBody', 'bodyValues'], fetchAllBodyValues: true });
            const email = res.parsed[blob];
            expect(email, `parsed ${variant.slice(0, 80)}`).to.exist;
            expect(email.subject).to.equal('encoded inner');
            expect(email.from).to.deep.equal([{ name: 'Embedded Sender', email: 'embedded@example.org' }]);
            expect(email.bodyValues[email.textBody[0].partId].value).to.equal('Südwind €');
            // a part inside the encoded message is reached by decoding and parsing it
            expect((await h.download(ctx.client, email.textBody[0].blobId)).toString()).to.equal('Südwind €');
        }
    });

    scenario('EPAR-008', async () => {
        const id = await store(
            ctx,
            outer(
                [
                    h.text('Outer'),
                    rfc822(
                        [
                            'From: attachedfrom@example.com',
                            'Reply-To: attachedreplyto@example.com',
                            'To: someone@example.com',
                            'Subject: attached',
                            '',
                            'body'
                        ].join(h.CRLF)
                    )
                ],
                ['From: outer@example.com', 'To: rcpt@example.com', 'Subject: outer', 'MIME-Version: 1.0']
            )
        );
        const blob = await attachmentBlob(ctx, id, part => part.type === 'message/rfc822');
        const res = await parse(ctx.client, [blob], { properties: ['from', 'replyTo'] });
        expect(res.parsed[blob]).to.deep.equal({
            from: [{ name: null, email: 'attachedfrom@example.com' }],
            replyTo: [{ name: null, email: 'attachedreplyto@example.com' }]
        });
    });

    scenario('EPAR-009', async () => {
        const digest = h.multipart('digest', [['', embedded('bar')].join(h.CRLF)]);
        const id = await store(ctx, h.mime(digest));
        const email = await h.getOne(ctx.client, id, { properties: ['bodyStructure'] });
        const child = email.bodyStructure.subParts[0];
        expect(child.type).to.equal('message/rfc822');
        const res = await parse(ctx.client, [child.blobId], { properties: ['subject'] });
        expect(res.parsed).to.have.all.keys(child.blobId);
        expect(res.parsed[child.blobId].subject).to.equal('bar');
    });

    scenario('EPAR-010', async () => {
        const properties = [
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
            'headers',
            'hasAttachment',
            'preview',
            'bodyStructure',
            'textBody',
            'htmlBody',
            'attachments',
            'bodyValues'
        ];
        const args = {
            properties,
            bodyProperties: ['type', 'size', 'name', 'charset', 'disposition', 'cid', 'language', 'location', 'subParts'],
            fetchAllBodyValues: true
        };
        for (const name of ['nodemailer.eml', 'mimetorture.eml']) {
            const id = await store(ctx, fixtures.readFixture(name));
            const stored = await h.getOne(ctx.client, id, Object.assign({}, args, { properties: [...properties, 'blobId'] }));
            const res = await parse(ctx.client, [stored.blobId], args);
            const parsed = res.parsed[stored.blobId];
            delete stored.id;
            delete stored.blobId;
            expect(parsed, name).to.deep.equal(stored);
        }
    });

    scenario('EPAR-011', async () => {
        const blob = await upload(ctx.client, simpleMessage());
        const res = await parse(ctx.client, [blob], { properties: ['subject', 'from'] });
        expect(Object.keys(res.parsed[blob])).to.have.members(['subject', 'from']);
        expect(Object.keys(res.parsed[blob])).to.have.length(2);
        const empty = await parse(ctx.client, [blob], { properties: [] });
        expect(empty.parsed[blob]).to.deep.equal({});
    });

    scenario('EPAR-012', async () => {
        const blob = await upload(ctx.client, simpleMessage());
        expect(await parseError(ctx.client, { blobIds: [blob], properties: ['invalid'] })).to.equal('invalidArguments');
        expect(await parseError(ctx.client, { blobIds: [blob], bodyProperties: ['invalid'] })).to.equal('invalidArguments');
        expect(await parseError(ctx.client, { blobIds: [blob], properties: 'subject' })).to.equal('invalidArguments');
        expect(await parseError(ctx.client, { blobIds: blob })).to.equal('invalidArguments');
    });

    scenario('EPAR-013', async () => {
        const content = h.raw(
            'From: Alice <alice@example.com>',
            'To: Friends: one@example.com, two@example.com;, solo@example.com',
            'X-Tra: first value',
            'X-Tra: second value',
            'List-Unsubscribe: <mailto:unsub@example.com>, <https://example.com/unsub>',
            'Date: Thu, 05 Mar 2020 01:02:03 +0200',
            'Subject: header forms',
            '',
            'body'
        );
        const properties = [
            'headers',
            'header:from:asAddresses',
            'header:To:asGroupedAddresses',
            'header:X-TRA:all',
            'header:x-tra:asText',
            'header:List-Unsubscribe:asURLs',
            'header:Date:asDate',
            'header:Missing',
            'header:Missing:all'
        ];
        const blob = await upload(ctx.client, content);
        const parsed = (await parse(ctx.client, [blob], { properties })).parsed[blob];
        expect(Object.keys(parsed)).to.have.members(properties);
        const id = await store(ctx, content);
        const stored = await h.getOne(ctx.client, id, { properties });
        delete stored.id;
        expect(parsed).to.deep.equal(stored);
        expect(parsed['header:X-TRA:all']).to.deep.equal([' first value', ' second value']);
        expect(parsed['header:x-tra:asText']).to.equal('second value');
        expect(parsed['header:Missing']).to.equal(null);
        expect(parsed['header:Missing:all']).to.deep.equal([]);
        expect(parsed['header:from:asAddresses']).to.deep.equal([{ name: 'Alice', email: 'alice@example.com' }]);
        expect(parsed['header:List-Unsubscribe:asURLs']).to.deep.equal(['mailto:unsub@example.com', 'https://example.com/unsub']);
        expect(parsed['header:Date:asDate']).to.equal('2020-03-05T01:02:03+02:00');
        expect(parsed['header:To:asGroupedAddresses']).to.deep.equal([
            {
                name: 'Friends',
                addresses: [
                    { name: null, email: 'one@example.com' },
                    { name: null, email: 'two@example.com' }
                ]
            },
            { name: null, addresses: [{ name: null, email: 'solo@example.com' }] }
        ]);
        expect(parsed.headers.map(header => header.name)).to.deep.equal(['From', 'To', 'X-Tra', 'X-Tra', 'List-Unsubscribe', 'Date', 'Subject']);
    });

    scenario('EPAR-014', async () => {
        const blob = await upload(ctx.client, simpleMessage());
        for (const property of ['header:From:asDate', 'header:Subject:asAddresses', 'header:Date:asText', 'header:X-A:all:asText']) {
            expect(await parseError(ctx.client, { blobIds: [blob], properties: [property] }), property).to.equal('invalidArguments');
        }
    });

    describe('body values', () => {
        let blob;
        let parts;
        before(async () => {
            const content = h.mime(
                h.multipart('mixed', [
                    h.multipart('alternative', [h.text('plain value'), h.html('<p>html value</p>')]),
                    h.part(['Content-Type: text/csv; charset=utf-8', 'Content-Disposition: attachment; filename="t.csv"'], 'a,b,c')
                ])
            );
            blob = await upload(ctx.client, content);
            const res = await parse(ctx.client, [blob], { properties: ['textBody', 'htmlBody', 'attachments'] });
            const email = res.parsed[blob];
            parts = { p: email.textBody[0].partId, h: email.htmlBody[0].partId, t: email.attachments[0].partId };
        });

        scenario('EPAR-015', async () => {
            const values = async flags =>
                (await parse(ctx.client, [blob], Object.assign({ properties: ['textBody', 'htmlBody', 'bodyValues'] }, flags))).parsed[blob];
            expect((await values({})).bodyValues).to.deep.equal({});
            const value = text => ({ value: text, isEncodingProblem: false, isTruncated: false });
            const text = await values({ fetchTextBodyValues: true });
            expect(text.textBody.map(part => part.partId)).to.deep.equal([parts.p]);
            expect(text.bodyValues).to.deep.equal({ [parts.p]: value('plain value') });
            expect((await values({ fetchHTMLBodyValues: true })).bodyValues).to.deep.equal({ [parts.h]: value('<p>html value</p>') });
            expect((await values({ fetchAllBodyValues: true })).bodyValues).to.deep.equal({
                [parts.p]: value('plain value'),
                [parts.h]: value('<p>html value</p>'),
                [parts.t]: value('a,b,c')
            });
        });
    });

    scenario('EPAR-016', async () => {
        const blob = await upload(ctx.client, h.mime(h.text('ab€ and more text')));
        const value = async maxBodyValueBytes => {
            const res = await parse(ctx.client, [blob], { properties: ['textBody', 'bodyValues'], fetchAllBodyValues: true, maxBodyValueBytes });
            const email = res.parsed[blob];
            return email.bodyValues[email.textBody[0].partId];
        };
        expect(await value(3)).to.deep.equal({ value: 'ab', isEncodingProblem: false, isTruncated: true });
        expect(await value(5)).to.deep.equal({ value: 'ab€', isEncodingProblem: false, isTruncated: true });
        // the whole body: the line break that completes the last line is part of it
        expect(await value(0)).to.deep.equal({ value: 'ab€ and more text\n', isEncodingProblem: false, isTruncated: false });
        expect(await parseError(ctx.client, { blobIds: [blob], fetchAllBodyValues: true, maxBodyValueBytes: -1 })).to.equal('invalidArguments');
    });

    scenario('EPAR-017', async () => {
        const blob = await upload(
            ctx.client,
            h.mime(h.multipart('mixed', [h.text('see attached'), h.attachment('application/pdf', 'report.pdf', '%PDF-1.4 fake')]))
        );
        const plain = (await parse(ctx.client, [blob], { properties: ['bodyStructure', 'attachments'] })).parsed[blob];
        const defaults = ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location'];
        for (const leaf of [...h.leaves(plain.bodyStructure), ...plain.attachments]) {
            expect(Object.keys(leaf)).to.have.members(defaults);
        }
        const bodyProperties = ['type', 'name', 'header:Content-Type', 'subParts'];
        const picked = (await parse(ctx.client, [blob], { properties: ['bodyStructure', 'attachments'], bodyProperties })).parsed[blob];
        expect(Object.keys(picked.bodyStructure)).to.have.members(bodyProperties);
        for (const leaf of [...h.leaves(picked.bodyStructure), ...picked.attachments]) {
            expect(Object.keys(leaf)).to.have.members(['type', 'name', 'header:Content-Type']);
        }
        expect(picked.attachments[0]).to.deep.include({ type: 'application/pdf', name: 'report.pdf' });
    });

    scenario('EPAR-018', async () => {
        const id = name => `X-Body-Id: ${name}`;
        const leaf = (name, type, extra = []) => h.part([`Content-Type: ${type}`, id(name), ...extra], `content ${name}`);
        const inline = ['Content-Disposition: inline'];
        const content = h.mime(
            h.multipart('mixed', [
                leaf('A', 'text/plain', inline),
                h.multipart('mixed', [
                    h.multipart('alternative', [
                        h.multipart('mixed', [leaf('B', 'text/plain', inline), leaf('C', 'image/jpeg', inline), leaf('D', 'text/plain', inline)]),
                        h.multipart('related', [leaf('E', 'text/html'), leaf('F', 'image/jpeg')])
                    ]),
                    leaf('G', 'image/jpeg', ['Content-Disposition: attachment']),
                    leaf('H', 'application/x-excel'),
                    h.part(['Content-Type: message/rfc822', id('J')], 'Subject: J\r\n\r\nJ body')
                ]),
                leaf('K', 'text/plain', inline)
            ])
        );
        const blob = await upload(ctx.client, content);
        const res = await parse(ctx.client, [blob], {
            properties: ['bodyStructure', 'textBody', 'htmlBody', 'attachments', 'hasAttachment', 'preview'],
            bodyProperties: ['partId', 'type', 'header:X-Body-Id', 'subParts']
        });
        const email = res.parsed[blob];
        const names = list => list.map(part => part['header:X-Body-Id'].trim());
        expect(names(email.textBody)).to.deep.equal(['A', 'B', 'C', 'D', 'K']);
        expect(names(email.htmlBody)).to.deep.equal(['A', 'E', 'K']);
        expect(names(email.attachments)).to.deep.equal(['C', 'F', 'G', 'H', 'J']);
        expect(email.hasAttachment).to.be.true;
        expect(email.preview).to.be.a('string');
        expect(email.preview.length).to.be.at.most(128);
        for (const part of h.allParts(email.bodyStructure)) {
            if (part.type.startsWith('multipart/')) {
                expect(part.partId).to.equal(null);
            }
        }
    });

    describe('nested messages', () => {
        const png = crypto.randomBytes(300);
        const innermost = embedded('innermost subject', 'deepest body');
        const level1 = h
            .top(
                ['From: level1@example.com', 'To: rcpt@example.com', 'Subject: level one', 'MIME-Version: 1.0'],
                h.multipart('mixed', [
                    h.text('level one body'),
                    h.base64(['Content-Type: image/png; name="pic.png"', 'Content-Disposition: attachment; filename="pic.png"'], png),
                    rfc822(innermost)
                ])
            )
            .toString('binary');
        const message = () => outer([h.text('top body'), rfc822(level1)]);

        async function check(blob) {
            const res = await parse(ctx.client, [blob], { properties: ['attachments', 'bodyStructure'] });
            const email = res.parsed[blob];
            for (const part of h.leaves(email.bodyStructure)) {
                expect(part.blobId, `blobId of ${part.partId}`).to.be.a('string');
            }
            const image = email.attachments.find(part => part.type === 'image/png');
            const downloaded = await h.download(ctx.client, image.blobId);
            expect(Buffer.compare(downloaded, png)).to.equal(0);
            expect(downloaded.length).to.equal(image.size);
            const second = email.attachments.find(part => part.type === 'message/rfc822');
            const deeper = await parse(ctx.client, [second.blobId], { properties: ['subject'] });
            expect(deeper.parsed[second.blobId].subject).to.equal('innermost subject');
        }

        scenario('EPAR-019', async () => {
            const id = await store(ctx, message());
            await check(await attachmentBlob(ctx, id, part => part.type === 'message/rfc822'));
            // the same through an upload: the parts get blob ids inside the upload
            const uploaded = await upload(ctx.client, message());
            const top = await parse(ctx.client, [uploaded], { properties: ['attachments'] });
            await check(top.parsed[uploaded].attachments.find(part => part.type === 'message/rfc822').blobId);
        });
    });

    scenario('EPAR-020', async () => {
        const id = await store(ctx, simpleMessage());
        const root = id.slice(1);
        const missing = ['invalid', `Bu${new seed.ObjectId().toString()}`, `Bp${new seed.ObjectId().toString()}_1`, `Bp${root}_9`];
        const res = await parse(ctx.client, missing);
        expect(res.notFound).to.have.members(missing);
        expect(res.notFound).to.have.length(4);
        expect(res.parsed).to.equal(null);
        expect(res.notParsable).to.equal(null);
    });

    scenario('EPAR-021', async () => {
        const other = await h.newUser();
        const uploaded = await upload(other.client, simpleMessage());
        const id = await store(other, outer([h.text('mine'), rfc822(embedded('private'))]));
        const email = await h.getOne(other.client, id, { properties: ['blobId', 'attachments'] });
        const blobs = [uploaded, email.blobId, email.attachments[0].blobId];
        const res = await parse(ctx.client, blobs);
        expect(res.notFound).to.have.members(blobs);
        expect(res.parsed).to.equal(null);
        expect(res.notParsable).to.equal(null);
    });

    scenario('EPAR-022', async () => {
        const random = crypto.randomBytes(1024);
        random[0] = 0;
        random[100] = 0;
        const blobs = [
            await upload(ctx.client, h.PNG, 'image/png'),
            await upload(ctx.client, random, 'application/octet-stream'),
            await upload(ctx.client, '', 'message/rfc822')
        ];
        const id = await store(
            ctx,
            h.mime(h.multipart('mixed', [h.text('pdf inside'), h.attachment('application/pdf', 'doc.pdf', '%PDF-1.4\r\nnot a message')]))
        );
        blobs.push(await attachmentBlob(ctx, id, part => part.type === 'application/pdf'));
        const res = await parse(ctx.client, blobs);
        expect(res.notParsable).to.have.members(blobs);
        expect(res.notParsable).to.have.length(4);
        expect(res.parsed).to.equal(null);
        expect(res.notFound).to.equal(null);
    });

    scenario('EPAR-023', async () => {
        const blob = await upload(ctx.client, Buffer.from('To: foo@bar.local\nSubject: test\n\nlenient body\n'));
        const res = await parse(ctx.client, [blob], { fetchAllBodyValues: true });
        expect(res.notParsable).to.equal(null);
        const email = res.parsed[blob];
        expect(email.from).to.equal(null);
        expect(email.sentAt).to.equal(null);
        expect(email.to).to.deep.equal([{ name: null, email: 'foo@bar.local' }]);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('lenient body\n');
    });

    scenario('EPAR-024', async () => {
        const content = Buffer.from(
            [
                'From: Jürgen Größe <jürgen@bücher.example>',
                'To: 日本 <用户@例子.广告>',
                'Subject: Grüße aus Köln ☕',
                'Message-ID: <eai@example.com>',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'body'
            ].join('\r\n'),
            'utf8'
        );
        const blob = await upload(ctx.client, content, 'message/global');
        const res = await parse(ctx.client, [blob], { properties: ['subject', 'from', 'to', 'header:Subject'] });
        const email = res.parsed[blob];
        expect(email.subject).to.equal('Grüße aus Köln ☕');
        expect(email['header:Subject']).to.equal(' Grüße aus Köln ☕');
        expect(email.from).to.deep.equal([{ name: 'Jürgen Größe', email: 'jürgen@bücher.example' }]);
        expect(email.to).to.deep.equal([{ name: '日本', email: '用户@例子.广告' }]);
        expect(JSON.stringify(email)).to.not.include('�');
    });

    scenario('EPAR-025', async () => {
        const v = await upload(ctx.client, simpleMessage());
        const p = await upload(ctx.client, h.PNG, 'image/png');
        const u = `Bu${new seed.ObjectId().toString()}`;
        const res = await parse(ctx.client, [v, p, u, v], { properties: ['subject'] });
        expect(Object.keys(res.parsed)).to.deep.equal([v]);
        expect(res.notParsable).to.deep.equal([p]);
        expect(res.notFound).to.deep.equal([u]);
    });

    scenario('EPAR-026', async () => {
        const res = await parse(ctx.client, []);
        expect(res).to.deep.equal({ accountId: ctx.client.accountId, parsed: null, notParsable: null, notFound: null });
        expect(await parseError(ctx.client, { blobIds: null })).to.equal('invalidArguments');
        expect(await parseError(ctx.client, {})).to.equal('invalidArguments');
    });

    describe('with a small maxObjectsInGet', () => {
        let instance;
        const N = 5;
        before(async () => {
            instance = await startInstance({ limits: Object.assign({}, config.jmap.limits, { maxObjectsInGet: N }) });
        });
        after(async () => {
            await stopInstance(instance.app);
        });

        scenario('EPAR-027', async () => {
            const client = jmap.forUser(ctx.user);
            const session = await client.raw(`${instance.url}/jmap/session`);
            expect(session.json.capabilities[jmap.URN.core].maxObjectsInGet).to.equal(N);
            client.accountId = ctx.client.accountId;
            const blobs = [];
            for (let i = 0; i <= N; i++) {
                blobs.push(await upload(ctx.client, simpleMessage([`X-Index: ${i}`])));
            }
            const call = async ids => {
                const res = await client.raw(`${instance.url}/jmap/api/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        using: [jmap.URN.core, jmap.URN.mail],
                        methodCalls: [['Email/parse', { accountId: client.accountId, blobIds: ids, properties: ['subject'] }, 'c0']]
                    })
                });
                return res.json.methodResponses[0];
            };
            const [name, ok] = await call(blobs.slice(0, N));
            expect(name).to.equal('Email/parse');
            expect(Object.keys(ok.parsed)).to.have.length(N);
            const [errorName, error] = await call(blobs);
            expect(errorName).to.equal('error');
            expect(error.type).to.equal('requestTooLarge');
        });
    });

    scenario('EPAR-028', async () => {
        const session = await ctx.client.session();
        const max = session.capabilities[jmap.URN.core].maxSizeUpload;
        // base64 grows the content by 4/3 plus line breaks: this attachment makes the message just under the limit
        const attachment = crypto.randomBytes(Math.floor(((max - 4096) * 3) / 4 / 78) * 76);
        const content = h.mime(h.multipart('mixed', [h.text('short text'), h.base64(['Content-Type: application/octet-stream; name="big.bin"'], attachment)]));
        expect(content.length).to.be.below(max);
        expect(content.length).to.be.above(max * 0.95);
        const blob = await upload(ctx.client, content, 'message/rfc822');
        const res = await parse(ctx.client, [blob], { properties: ['subject', 'bodyStructure', 'bodyValues'], fetchAllBodyValues: true });
        const email = res.parsed[blob];
        const big = email.bodyStructure.subParts[1];
        expect(big.size).to.equal(attachment.length);
        expect(Object.values(email.bodyValues).map(entry => entry.value)).to.deep.equal(['short text']);
        expect(JSON.stringify(res).length).to.be.below(10000);
    });

    scenario('EPAR-029', async () => {
        const fresh = await h.newUser();
        await store(fresh, simpleMessage());
        const before = async () => {
            const [[, get], [, query], [, mailboxes]] = await fresh.client.call([
                ['Email/get', { accountId: fresh.client.accountId, ids: [] }, 'g'],
                ['Email/query', { accountId: fresh.client.accountId, calculateTotal: true }, 'q'],
                ['Mailbox/get', { accountId: fresh.client.accountId, ids: null }, 'm']
            ]);
            const user = await api('GET', `/users/${fresh.user.id}`);
            return { state: get.state, total: query.total, mailboxes: mailboxes.list, used: user.limits.quota.used };
        };
        const snapshot = await before();
        const blob = await upload(fresh.client, simpleMessage());
        const res = await parse(fresh.client, [blob]);
        expect(res.parsed).to.have.all.keys(blob);
        expect(await before()).to.deep.equal(snapshot);
        const downloaded = await fresh.client.raw(`/jmap/download/${fresh.client.accountId}/${blob}/m.eml`);
        expect(downloaded.status).to.equal(200);
    });

    describe('expired uploads', () => {
        let storage;
        before(async () => {
            const db = await connect();
            storage = new StorageHandler({ database: db.database, users: db.users, gridfs: db.gridfs });
        });

        scenario('EPAR-030', async () => {
            const blob = await upload(ctx.client, simpleMessage());
            const db = await seed.db();
            await db
                .collection('storage.files')
                .updateOne({ _id: new seed.ObjectId(blob.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() - 1000) } });
            await storage.removeExpiredUploads();
            const res = await parse(ctx.client, [blob]);
            expect(res.notFound).to.deep.equal([blob]);
            expect(res.parsed).to.equal(null);
        });
    });

    scenario('EPAR-032', async () => {
        const using = [jmap.URN.core, jmap.URN.mail, jmap.URN.blob];
        const [[, uploaded]] = await ctx.client.call(
            [['Blob/upload', { accountId: ctx.client.accountId, create: { b1: { data: [{ 'data:asText': simpleMessage().toString() }] } } }, 'u']],
            using
        );
        const blobId = uploaded.created.b1.id;
        expect(blobId).to.be.a('string');
        const res = await parse(ctx.client, [blobId], { properties: ['subject', 'bodyStructure'] });
        expect(Object.keys(res.parsed)).to.deep.equal([blobId]);
        expect(res.parsed[blobId].subject).to.equal('Parse me');
        expect(res.parsed[blobId].bodyStructure.type).to.equal('text/plain');
    });

    scenario('EPAR-031', async () => {
        expect(await parseError(ctx.client, { accountId: 'uffffffffffffffffffffffff', blobIds: [] })).to.equal('accountNotFound');
        expect(await parseError(ctx.client, { blobIds: [] }, [jmap.URN.core])).to.equal('unknownMethod');
    });
});
