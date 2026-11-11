/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-get.yaml: bodyStructure, textBody, htmlBody, attachments and the
// EmailBodyPart properties (EGET-104 to EGET-147).

const { expect } = require('chai');
const libqp = require('libqp');
const { scenario, api, accounts, fixtures } = require('../harness');
const {
    newUser,
    append,
    getOne,
    expectInvalid,
    download,
    imapDecodedPart,
    imapFor,
    leaves,
    allParts,
    multipart,
    part,
    mime,
    top,
    raw,
    CRLF,
    text,
    html,
    attachment,
    base64,
    PNG,
    noSubParts,
    ids
} = require('./email-get-helpers');

const STRUCTURE = ['bodyStructure', 'textBody', 'htmlBody', 'attachments'];
const DEFAULT_PART_KEYS = ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location'];

// the X-Body-Id header property of each part in a list
const bodyIds = list => list.map(entry => (entry['header:X-Body-Id:asText'] || '').trim());

/** Leaf parts of an imapflow BODYSTRUCTURE, not descending into embedded messages */
function imapLeaves(node, list = []) {
    if (node.childNodes && !/^message\/(rfc822|global)$/i.test(node.type)) {
        node.childNodes.forEach(child => imapLeaves(child, list));
    } else {
        list.push(node);
    }
    return list;
}

/** Depth of an EmailBodyPart tree */
const depth = entry => 1 + Math.max(0, ...(entry.subParts || []).map(depth));
/** Depth of an imapflow BODYSTRUCTURE, not descending into embedded messages */
const imapDepth = node => 1 + Math.max(0, ...(node.childNodes && !/^message\//i.test(node.type) ? node.childNodes.map(imapDepth) : []));

async function imapStructure(user, uid) {
    const imap = await imapFor(user);
    await imap.mailboxOpen('INBOX');
    const fetched = await imap.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    return fetched.bodyStructure;
}

describe('Email/get body structure (email-get.yaml)', () => {
    let ctx;

    const structureOf = async (content, args = {}) => {
        const { id, uid } = await append(ctx.user, content);
        const email = await getOne(ctx.client, id, Object.assign({ properties: STRUCTURE }, args));
        email.uid = uid;
        return email;
    };

    before(async () => {
        ctx = await newUser();
    });

    scenario('EGET-104', async () => {
        const body = 'A single part plain text message.\r\nSecond line.\r\n';
        const email = await structureOf(mime(text(body)));
        const root = email.bodyStructure;
        expect(root.type).to.equal('text/plain');
        expect(root.charset).to.equal('utf-8');
        expect(root.partId).to.be.a('string');
        expect(root.blobId).to.be.a('string');
        expect(root.size).to.equal(Buffer.byteLength(body));
        expect(noSubParts(root)).to.be.true;
        expect(ids(email.textBody)).to.deep.equal([root.partId]);
        expect(ids(email.htmlBody)).to.deep.equal([root.partId]);
        expect(email.attachments).to.deep.equal([]);
    });

    scenario('EGET-105', async () => {
        const email = await structureOf(mime(multipart('mixed', [text('body'), attachment('application/pdf', 'a.pdf', 'pdf data')])), {
            properties: ['bodyStructure', 'textBody', 'attachments']
        });
        const nonMultipart = [...leaves(email.bodyStructure), ...email.textBody, ...email.attachments];
        for (const entry of nonMultipart) {
            expect(Object.keys(entry)).to.have.members(DEFAULT_PART_KEYS);
            expect(Object.keys(entry)).to.have.length(DEFAULT_PART_KEYS.length);
        }
        expect(Object.keys(email.bodyStructure)).to.have.members([...DEFAULT_PART_KEYS, 'subParts']);
        expect(email.bodyStructure.subParts).to.have.length(2);
    });

    scenario('EGET-106', async () => {
        const email = await structureOf(mime(html('<p>Only HTML</p>')));
        expect(email.bodyStructure.type).to.equal('text/html');
        expect(ids(email.textBody)).to.deep.equal([email.bodyStructure.partId]);
        expect(ids(email.htmlBody)).to.deep.equal([email.bodyStructure.partId]);
        expect(email.attachments).to.deep.equal([]);
    });

    scenario('EGET-107', async () => {
        const email = await structureOf(mime(multipart('alternative', [text('plain'), html('<p>html</p>')])));
        const root = email.bodyStructure;
        expect(root.type).to.equal('multipart/alternative');
        expect(root.partId).to.be.null;
        expect(root.blobId).to.be.null;
        expect(root.subParts).to.have.length(2);
        expect(email.textBody.map(entry => entry.type)).to.deep.equal(['text/plain']);
        expect(email.htmlBody.map(entry => entry.type)).to.deep.equal(['text/html']);
        expect(email.attachments).to.deep.equal([]);
    });

    scenario('EGET-108', async () => {
        const pdf = Buffer.alloc(3000, 7);
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    text('see attached'),
                    base64(['Content-Type: application/pdf', 'Content-Disposition: attachment; filename=report.pdf'], pdf),
                    attachment('text/csv', 'data.csv', 'a,b\r\n1,2')
                ])
            ),
            { properties: [...STRUCTURE, 'hasAttachment'] }
        );
        expect(email.bodyStructure.type).to.equal('multipart/mixed');
        expect(email.bodyStructure.subParts.map(entry => entry.type)).to.deep.equal(['text/plain', 'application/pdf', 'text/csv']);
        expect(ids(email.textBody)).to.deep.equal(['1']);
        expect(ids(email.htmlBody)).to.deep.equal(['1']);
        expect(email.attachments.map(entry => [entry.type, entry.name, entry.disposition])).to.deep.equal([
            ['application/pdf', 'report.pdf', 'attachment'],
            ['text/csv', 'data.csv', 'attachment']
        ]);
        expect(email.attachments[0].size).to.equal(3000);
        expect(email.attachments[1].size).to.equal(8);
        email.attachments.forEach(entry => expect(entry.blobId).to.be.a('string'));
        expect(email.hasAttachment).to.be.true;
    });

    scenario('EGET-109', async () => {
        const email = await structureOf(
            mime(
                multipart('related', [
                    html('<p><img src="cid:logo@x"></p>'),
                    base64(['Content-Type: image/png', 'Content-ID: <logo@x>', 'Content-Disposition: inline'], PNG)
                ])
            ),
            { properties: [...STRUCTURE, 'hasAttachment'] }
        );
        expect(email.htmlBody.map(entry => entry.type)).to.deep.equal(['text/html']);
        expect(email.textBody.map(entry => entry.type)).to.deep.equal(['text/html']);
        expect(email.attachments).to.have.length(1);
        expect(email.attachments[0].cid).to.equal('logo@x');
        expect(email.attachments[0].disposition).to.equal('inline');
        expect(email.hasAttachment).to.be.false;
    });

    scenario('EGET-110', async () => {
        const email = await structureOf(
            mime(
                multipart('alternative', [
                    text('plain version'),
                    multipart('related', [
                        html('<p>rich <img src="cid:img@x"></p>'),
                        base64(['Content-Type: image/png', 'Content-ID: <img@x>', 'Content-Disposition: inline'], PNG)
                    ])
                ])
            ),
            { properties: ['textBody', 'htmlBody', 'attachments', 'bodyValues'], fetchHTMLBodyValues: true }
        );
        expect(email.textBody.map(entry => entry.type)).to.deep.equal(['text/plain']);
        expect(email.htmlBody.map(entry => entry.type)).to.deep.equal(['text/html']);
        expect(email.attachments.map(entry => entry.type)).to.deep.equal(['image/png']);
        expect(Object.keys(email.bodyValues)).to.deep.equal(ids(email.htmlBody));
    });

    const embedded = (inner, headers = ['Content-Type: message/rfc822']) => part(headers, inner);
    const innerMessage = () =>
        top(
            ['From: inner@example.com', 'Subject: inner', 'MIME-Version: 1.0'],
            multipart('mixed', [text('inner text'), attachment('application/zip', 'inner.zip', 'zipdata')])
        ).toString('binary');

    scenario('EGET-111', async () => {
        const inner = innerMessage();
        const email = await structureOf(
            mime(multipart('mixed', [text('outer text'), embedded(inner), text('after', ['Content-Type: text/plain; name="after.txt"'])])),
            {
                properties: [...STRUCTURE, 'hasAttachment']
            }
        );
        const messagePart = email.bodyStructure.subParts[1];
        expect(messagePart.type).to.equal('message/rfc822');
        expect(messagePart.partId).to.equal('2');
        expect(messagePart.blobId).to.be.a('string');
        expect(noSubParts(messagePart)).to.be.true;
        expect(messagePart.size).to.equal(Buffer.byteLength(inner, 'binary'));
        expect(email.bodyStructure.subParts[2].partId).to.equal('3');
        expect(ids(email.attachments)).to.deep.equal(['2', '3']);
        expect(JSON.stringify(email)).to.not.include('inner.zip');
        expect(ids(email.textBody)).to.deep.equal(['1']);
        expect(email.hasAttachment).to.be.true;
    });

    scenario('EGET-112', async () => {
        const innerHeaders = [
            'From: inner@example.com',
            'Subject: Sõnum täpitähtedega',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: 8bit'
        ];
        const inner = Buffer.from([...innerHeaders, '', 'Sisu õäöü'].join(CRLF), 'utf8');
        const encodings = {
            '8bit': inner.toString('binary'),
            base64: inner.toString('base64').replace(/.{76}/g, '$&\r\n'),
            'quoted-printable': libqp.wrap(libqp.encode(inner), 76)
        };
        for (const type of ['message/rfc822', 'message/global']) {
            for (const [encoding, body] of Object.entries(encodings)) {
                const label = `${type} ${encoding}`;
                const content = mime(multipart('mixed', [text('outer'), part([`Content-Type: ${type}`, `Content-Transfer-Encoding: ${encoding}`], body)]));
                const { id, uid } = await append(ctx.user, content);
                const email = await getOne(ctx.client, id, {
                    properties: ['bodyStructure'],
                    bodyProperties: ['partId', 'blobId', 'size', 'type', 'header:content-transfer-encoding:asText', 'subParts']
                });
                const embeddedPart = email.bodyStructure.subParts[1];
                expect(embeddedPart.type, label).to.equal(type);
                expect(noSubParts(embeddedPart), label).to.be.true;
                expect(embeddedPart.size, label).to.equal(inner.length);
                expect(embeddedPart['header:content-transfer-encoding:asText'], label).to.equal(encoding);
                const blob = await download(ctx.client, embeddedPart.blobId);
                expect(blob.equals(inner), label).to.be.true;
                const fromImap = await imapDecodedPart(ctx.user, 'INBOX', uid, '2', encoding);
                expect(fromImap.equals(inner), `${label} BODY[2]`).to.be.true;
            }
        }
    });

    scenario('EGET-113', async () => {
        for (const [protocol, sigType, sigName] of [
            ['application/pgp-signature', 'application/pgp-signature', 'signature.asc'],
            ['application/pkcs7-signature', 'application/pkcs7-signature', 'smime.p7s']
        ]) {
            const email = await structureOf(
                mime(
                    multipart(
                        'signed',
                        [
                            multipart('alternative', [text('signed plain'), html('<p>signed html</p>')]),
                            part([`Content-Type: ${sigType}; name="${sigName}"`], 'SIGNATURE')
                        ],
                        [` protocol="${protocol}"`]
                    ).replace(/"\r\n protocol/, '";\r\n protocol')
                )
            );
            expect(email.bodyStructure.type).to.equal('multipart/signed');
            expect(email.bodyStructure.subParts).to.have.length(2);
            expect(email.textBody.map(entry => entry.type)).to.deep.equal(['text/plain']);
            expect(email.htmlBody.map(entry => entry.type)).to.deep.equal(['text/html']);
            expect(email.attachments.map(entry => [entry.type, entry.name])).to.deep.equal([[sigType, sigName]]);
        }
    });

    scenario('EGET-115', async () => {
        const report = multipart(
            'report',
            [
                text('Delivery failed'),
                part(
                    ['Content-Type: message/delivery-status'],
                    'Reporting-MTA: dns; mx.example.com\r\n\r\nFinal-Recipient: rfc822; x@example.com\r\nAction: failed\r\nStatus: 5.1.1'
                ),
                part(['Content-Type: text/rfc822-headers'], 'From: a@example.com\r\nSubject: original\r\n')
            ],
            [' report-type=delivery-status']
        ).replace(/"\r\n report-type/, '";\r\n report-type');
        const mdn = multipart(
            'report',
            [
                text('Your message was displayed'),
                part(
                    ['Content-Type: message/disposition-notification'],
                    'Reporting-UA: client\r\nFinal-Recipient: rfc822; x@example.com\r\nDisposition: manual-action/MDN-sent-manually; displayed'
                ),
                part(['Content-Type: message/rfc822'], 'From: a@example.com\r\nSubject: original\r\n\r\nbody')
            ],
            [' report-type=disposition-notification']
        ).replace(/"\r\n report-type/, '";\r\n report-type');
        for (const [content, types] of [
            [report, ['message/delivery-status', 'text/rfc822-headers']],
            [mdn, ['message/disposition-notification', 'message/rfc822']]
        ]) {
            const email = await structureOf(mime(content));
            expect(email.bodyStructure.type).to.equal('multipart/report');
            expect(email.bodyStructure.subParts).to.have.length(3);
            email.bodyStructure.subParts.forEach(entry => expect(noSubParts(entry)).to.be.true);
            expect(email.textBody.map(entry => entry.type)).to.deep.equal(['text/plain']);
            expect(email.htmlBody.map(entry => entry.type)).to.deep.equal(['text/plain']);
            expect(email.attachments.map(entry => entry.type)).to.deep.equal(types);
            email.attachments.forEach(entry => expect(noSubParts(entry)).to.be.true);
        }
    });

    scenario('EGET-116', async () => {
        const digestChild = part([], 'From: digest@example.com\r\nSubject: digest item\r\n\r\nDigest body');
        const email = await structureOf(mime(multipart('related', [part([], 'untyped text'), multipart('digest', [digestChild])])), {
            properties: ['bodyStructure', 'attachments']
        });
        const [first, digest] = email.bodyStructure.subParts;
        expect(first.type).to.equal('text/plain');
        expect(first.charset).to.equal('us-ascii');
        const child = digest.subParts[0];
        expect(child.type).to.equal('message/rfc822');
        expect(child.charset).to.be.null;
        expect(noSubParts(child)).to.be.true;
        expect(ids(email.attachments)).to.include(child.partId);
    });

    scenario('EGET-117', async () => {
        const { id } = await append(ctx.user, raw('From: a@example.com', 'To: b@example.com', 'Subject: no mime', '', 'Plain body without MIME headers', ''));
        const email = await getOne(ctx.client, id, { properties: ['bodyStructure', 'textBody', 'bodyValues'], fetchTextBodyValues: true });
        const root = email.bodyStructure;
        expect(root.type).to.equal('text/plain');
        expect(root.charset).to.equal('us-ascii');
        for (const property of ['disposition', 'name', 'cid', 'language', 'location']) {
            expect(root[property], property).to.be.null;
        }
        expect(email.bodyValues[root.partId].value).to.equal('Plain body without MIME headers\n');
    });

    scenario('EGET-118', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: TEXT/Plain (a comment); Charset="UTF-8"; format=flowed'], 'flowed'),
                    part(['Content-Type: Application/PDF;name=a.pdf'], 'pdf'),
                    part(['Content-Type: text/html;\r\n\tcharset=UTF-8'], '<p>folded</p>')
                ])
            ),
            { properties: ['bodyStructure'], bodyProperties: ['type', 'charset', 'header:Content-Type', 'subParts'] }
        );
        const [plain, pdf, folded] = email.bodyStructure.subParts;
        expect(plain.type).to.equal('text/plain');
        expect(pdf.type).to.equal('application/pdf');
        expect(folded.type).to.equal('text/html');
        expect(plain.charset).to.equal('utf-8');
        expect(folded.charset).to.equal('utf-8');
        expect(plain['header:Content-Type']).to.equal(' TEXT/Plain (a comment); Charset="UTF-8"; format=flowed');
        expect(folded['header:Content-Type']).to.equal(' text/html;\r\n\tcharset=UTF-8');
    });

    scenario('EGET-119', async () => {
        const related = await structureOf(mime(multipart('related', [html('<p>x</p>'), part(['Content-Type: image/not/valid'], 'data')])));
        const invalid = related.bodyStructure.subParts[1];
        expect(invalid.type).to.equal('application/octet-stream');
        expect(invalid.charset).to.be.null;
        expect(ids(related.attachments)).to.deep.equal([invalid.partId]);

        const garbage = await structureOf(mime(part(['Content-Type: garbage'], 'data')));
        expect(garbage.bodyStructure.type).to.equal('application/octet-stream');
        expect(garbage.bodyStructure.charset).to.be.null;
        expect(garbage.textBody).to.deep.equal([]);
        expect(ids(garbage.attachments)).to.deep.equal([garbage.bodyStructure.partId]);

        const doubled = await structureOf(mime(part(['Content-Type: text/html; charset=text/plain; charset=utf-8'], '<p>x</p>')));
        expect(doubled.bodyStructure.type).to.equal('text/html');
        expect(doubled.bodyStructure.charset).to.be.a('string');
    });

    // the RFC 8621 4.1.4 example, each leaf tagged with X-Body-Id
    const tagged = (id, headers, body = `part ${id}`) => part([...headers, `X-Body-Id: ${id}`], body);
    const rfcExample = () =>
        mime(
            multipart('mixed', [
                tagged('A', ['Content-Type: text/plain', 'Content-Disposition: inline']),
                multipart('mixed', [
                    multipart('alternative', [
                        multipart('mixed', [
                            tagged('B', ['Content-Type: text/plain', 'Content-Disposition: inline']),
                            tagged('C', ['Content-Type: image/jpeg', 'Content-Disposition: inline']),
                            tagged('D', ['Content-Type: text/plain', 'Content-Disposition: inline'])
                        ]),
                        multipart('related', [tagged('E', ['Content-Type: text/html']), tagged('F', ['Content-Type: image/jpeg'])])
                    ]),
                    tagged('G', ['Content-Type: image/jpeg', 'Content-Disposition: attachment']),
                    tagged('H', ['Content-Type: application/x-excel']),
                    tagged('J', ['Content-Type: message/rfc822'], 'From: j@example.com\r\nSubject: J\r\n\r\nJ body')
                ]),
                tagged('K', ['Content-Type: text/plain', 'Content-Disposition: inline'])
            ])
        );

    scenario('EGET-120', async () => {
        const email = await structureOf(rfcExample(), { bodyProperties: ['partId', 'type', 'disposition', 'header:X-Body-Id:asText', 'subParts'] });
        expect(bodyIds(email.textBody)).to.deep.equal(['A', 'B', 'C', 'D', 'K']);
        expect(bodyIds(email.htmlBody)).to.deep.equal(['A', 'E', 'K']);
        expect(bodyIds(email.attachments)).to.deep.equal(['C', 'F', 'G', 'H', 'J']);
        const shape = entry => (entry.subParts ? { [entry.type]: entry.subParts.map(shape) } : entry['header:X-Body-Id:asText'].trim());
        expect(shape(email.bodyStructure)).to.deep.equal({
            'multipart/mixed': [
                'A',
                {
                    'multipart/mixed': [
                        { 'multipart/alternative': [{ 'multipart/mixed': ['B', 'C', 'D'] }, { 'multipart/related': ['E', 'F'] }] },
                        'G',
                        'H',
                        'J'
                    ]
                },
                'K'
            ]
        });
    });

    scenario('EGET-121', async () => {
        let nested = text('innermost leaf');
        for (let i = 0; i < 20; i++) {
            nested = multipart('mixed', [nested]);
        }
        for (const content of [mime(nested), fixtures.readFixture('mimetorture.eml')]) {
            const email = await structureOf(content, { properties: ['bodyStructure', 'textBody', 'attachments'] });
            const imapTree = await imapStructure(ctx.user, email.uid);
            expect(depth(email.bodyStructure)).to.equal(imapDepth(imapTree));
            const jmapLeaves = leaves(email.bodyStructure);
            const fromImap = imapLeaves(imapTree);
            expect(jmapLeaves.map(entry => entry.type)).to.deep.equal(fromImap.map(node => node.type.toLowerCase()));
            expect(ids(jmapLeaves)).to.deep.equal(fromImap.map(node => node.part || '1'));
        }
        const deep = await structureOf(mime(nested), { properties: ['textBody'] });
        expect(deep.textBody.map(entry => entry.type)).to.deep.equal(['text/plain']);
        expect(deep.textBody[0].partId).to.equal(Array(20).fill('1').join('.'));
    });

    scenario('EGET-122', async () => {
        const boundary = 'truncated-boundary';
        const content = mime(
            [
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                '',
                `--${boundary}`,
                'Content-Type: text/plain',
                '',
                'complete text',
                `--${boundary}`,
                'Content-Type: application/octet-stream',
                '',
                'runs to the end'
            ].join(CRLF)
        );
        const email = await structureOf(content, { properties: ['bodyStructure', 'textBody', 'attachments', 'bodyValues'], fetchTextBodyValues: true });
        expect(leaves(email.bodyStructure).map(entry => entry.type)).to.deep.equal(['text/plain', 'application/octet-stream']);
        expect(email.bodyValues[email.textBody[0].partId].value).to.equal('complete text');
        const tail = await download(ctx.client, email.attachments[0].blobId);
        expect(tail.toString().trim()).to.equal('runs to the end');
    });

    scenario('EGET-123', async () => {
        const contents = [
            mime(['Content-Type: multipart/mixed', '', 'no boundary parameter at all'].join(CRLF)),
            mime(['Content-Type: multipart/mixed; boundary="never-used"', '', 'the declared boundary does not occur', '--other', '', 'x'].join(CRLF)),
            mime(['Content-Type: multipart/mixed; boundary="closing-only"', '', '--closing-only--', ''].join(CRLF))
        ];
        for (const content of contents) {
            const email = await structureOf(content, { properties: [...STRUCTURE, 'preview'] });
            const imapTree = await imapStructure(ctx.user, email.uid);
            for (const property of ['textBody', 'htmlBody', 'attachments']) {
                expect(email[property]).to.be.an('array');
            }
            expect(leaves(email.bodyStructure).length).to.equal(imapLeaves(imapTree).filter(node => !node.childNodes).length);
            for (const leaf of leaves(email.bodyStructure)) {
                expect(leaf.partId).to.be.a('string');
                await download(ctx.client, leaf.blobId);
            }
        }
    });

    scenario('EGET-124', async () => {
        const boundary = 'lf-boundary';
        const content = Buffer.from(
            [
                'From: a@example.com',
                'Subject: bare LF parts',
                `Content-Type: multipart/alternative; boundary="${boundary}"`,
                '',
                [
                    `--${boundary}`,
                    'Content-Type: text/plain',
                    'X-Foo: bar',
                    '',
                    'plain',
                    `--${boundary}`,
                    'Content-Type: text/html',
                    '',
                    '<p>html</p>',
                    `--${boundary}--`,
                    ''
                ].join('\n')
            ].join(CRLF)
        );
        const email = await structureOf(content, {
            properties: ['bodyStructure', 'bodyValues'],
            bodyProperties: ['partId', 'blobId', 'type', 'header:x-foo', 'subParts'],
            fetchAllBodyValues: true
        });
        const [first, second] = email.bodyStructure.subParts;
        expect([first.type, second.type]).to.deep.equal(['text/plain', 'text/html']);
        expect(first['header:x-foo']).to.equal(' bar');
        expect(second['header:x-foo']).to.be.null;

        const fixture = await structureOf(fixtures.readFixture('no_empty_line_between_text_boundary.eml'), { properties: ['bodyStructure'] });
        const imapTree = await imapStructure(ctx.user, fixture.uid);
        expect(leaves(fixture.bodyStructure).map(entry => entry.type)).to.deep.equal(imapLeaves(imapTree).map(node => node.type.toLowerCase()));
    });

    scenario('EGET-125', async () => {
        const email = await structureOf(rfcExample(), { bodyProperties: ['partId', 'blobId', 'type', 'subParts'] });
        const seen = new Map();
        for (const entry of allParts(email.bodyStructure)) {
            if (entry.type.startsWith('multipart/')) {
                expect(entry.partId).to.be.null;
                expect(entry.blobId).to.be.null;
                expect(entry.subParts).to.be.an('array');
            } else {
                expect(entry.partId).to.be.a('string');
                expect(entry.blobId).to.be.a('string');
                expect(noSubParts(entry)).to.be.true;
                expect(seen.has(entry.partId)).to.be.false;
                seen.set(entry.partId, entry.blobId);
            }
        }
        for (const entry of [...email.textBody, ...email.htmlBody, ...email.attachments]) {
            expect(seen.get(entry.partId)).to.equal(entry.blobId);
        }
    });

    scenario('EGET-126', async () => {
        const single = await structureOf(mime(text('single')), { properties: ['bodyStructure'] });
        expect(single.bodyStructure.partId).to.equal('1');

        const email = await structureOf(
            mime(multipart('mixed', [multipart('alternative', [text('plain'), html('<p>html</p>')]), attachment('application/pdf', 'a.pdf', 'pdf data')])),
            {
                properties: ['bodyStructure']
            }
        );
        expect(ids(leaves(email.bodyStructure))).to.deep.equal(['1.1', '1.2', '2']);
        const imap = await imapFor(ctx.user);
        await imap.mailboxOpen('INBOX');
        const fetched = await imap.fetchOne(String(email.uid), { bodyParts: ['1.1', '1.2', '2'] }, { uid: true });
        for (const leaf of leaves(email.bodyStructure)) {
            expect(fetched.bodyParts.get(leaf.partId).equals(await download(ctx.client, leaf.blobId)), leaf.partId).to.be.true;
        }
    });

    scenario('EGET-127', async () => {
        const qpText = 'Tere õhtust!'; // 15 octets in UTF-8
        const binary = Buffer.alloc(1000);
        for (let i = 0; i < binary.length; i++) {
            binary[i] = i % 251;
        }
        const plain = 'seven bit body';
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'], libqp.encode(Buffer.from(qpText))),
                    base64(['Content-Type: application/octet-stream'], binary),
                    part(['Content-Type: text/plain', 'Content-Transfer-Encoding: 7bit'], plain)
                ])
            ),
            { properties: ['bodyStructure', 'size'] }
        );
        const sizes = leaves(email.bodyStructure).map(entry => entry.size);
        expect(sizes).to.deep.equal([Buffer.byteLength(qpText), 1000, plain.length]);
        for (const leaf of leaves(email.bodyStructure)) {
            expect((await download(ctx.client, leaf.blobId)).length).to.equal(leaf.size);
        }
        expect(email.size).to.be.above(sizes.reduce((a, b) => a + b, 0));
    });

    scenario('EGET-128', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    text('body'),
                    part(['Content-Type: application/vnd.ms-excel', 'Content-Disposition: attachment;\r\n filename="f.xls"'], 'xls'),
                    part(['Content-Type: application/octet-stream; name=y.dat'], 'y'),
                    part(['Content-Type: application/octet-stream; name=y.dat', 'Content-Disposition: attachment; filename=z.dat'], 'z'),
                    part(['Content-Type: application/octet-stream', 'Content-Disposition: attachment'], 'none')
                ])
            ),
            { properties: ['attachments'], bodyProperties: ['name', 'type'] }
        );
        expect(email.attachments.map(entry => entry.name)).to.deep.equal(['f.xls', 'y.dat', 'z.dat', null]);
    });

    scenario('EGET-129', async () => {
        const attach = disposition => part(['Content-Type: application/octet-stream', `Content-Disposition: attachment; ${disposition}`], 'data');
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    text('body'),
                    part(['Content-Type: application/octet-stream; name*0=loooo; name*1=ooong; name*2=.name'], 'data'),
                    attach('filename*0="conti";\r\n filename*1="nue"'),
                    attach("filename*=utf-8''%F0%9F%98%80.txt"),
                    attach('filename*0*=utf-8\'\'Caf%C3%A9; filename*1=".doc"'),
                    part(['Content-Type: application/octet-stream; name="=?UTF-8?Q?Caf=C3=A9.doc?="'], 'data'),
                    attach("filename*=iso-8859-1'fr'Caf%E9.doc")
                ])
            ),
            { properties: ['attachments'], bodyProperties: ['name'] }
        );
        const names = email.attachments.map(entry => entry.name);
        expect(names).to.deep.equal(['looooooong.name', 'continue', '\u{1F600}.txt', 'Café.doc', 'Café.doc', 'Café.doc']);
        for (const name of names) {
            expect(name).to.not.match(/\*|%[0-9a-f]{2}|=\?/i);
        }
    });

    scenario('EGET-130', async () => {
        const named = value => part([`Content-Type: application/octet-stream; name=${value}`, 'Content-Disposition: attachment'], 'data');
        const { id, uid } = await append(
            ctx.user,
            mime(
                multipart('mixed', [
                    text('body'),
                    named('=?UTF-8?Q?Caf=C3=A9.doc?='),
                    named(' foo '),
                    named('foo bar'),
                    named(Buffer.from('\u{1F600}.txt').toString('binary')),
                    named('"say \\"hi\\".txt"'),
                    named('""')
                ])
            )
        );
        const email = await getOne(ctx.client, id, { properties: ['attachments'], bodyProperties: ['name'] });
        const names = email.attachments.map(entry => entry.name);
        expect(names).to.deep.equal(['Café.doc', 'foo', 'foo bar', '\u{1F600}.txt', 'say "hi".txt', null]);
        // the REST API listing shows the same names
        const inbox = (await accounts.mailboxes(ctx.user)).INBOX.id;
        const message = await api('GET', `/users/${ctx.user.id}/mailboxes/${inbox}/messages/${uid}`);
        const restNames = (message.attachments || []).map(entry => entry.filename);
        for (const name of names.filter(Boolean)) {
            expect(restNames, name).to.include(name);
        }
    });

    scenario('EGET-131', async () => {
        const content = mime(multipart('mixed', [text('body'), attachment('application/pdf', 'a.pdf', 'pdf')]));
        const { id } = await append(ctx.user, content);
        const first = await getOne(ctx.client, id, { properties: ['bodyStructure', 'textBody', 'attachments'], bodyProperties: ['partId', 'type'] });
        for (const entry of [first.bodyStructure, ...first.textBody, ...first.attachments]) {
            expect(Object.keys(entry)).to.have.members(['partId', 'type']);
        }
        expect(first.bodyStructure.type).to.equal('multipart/mixed');

        const second = await getOne(ctx.client, id, { properties: ['bodyStructure'], bodyProperties: ['partId', 'type', 'subParts'] });
        expect(Object.keys(second.bodyStructure)).to.have.members(['partId', 'type', 'subParts']);
        for (const entry of second.bodyStructure.subParts) {
            expect(Object.keys(entry)).to.have.members(['partId', 'type']);
        }
    });

    scenario('EGET-132', async () => {
        const email = await structureOf(mime(multipart('mixed', [text('body'), attachment('application/pdf', 'a.pdf', 'pdf')])), {
            properties: ['textBody', 'attachments'],
            bodyProperties: []
        });
        expect(email.textBody).to.deep.equal([{}]);
        expect(email.attachments).to.deep.equal([{}]);
    });

    scenario('EGET-133', async () => {
        const { id } = await append(ctx.user, mime(text('body')));
        for (const bodyProperties of [['partId', 'invalid'], ['partId', 'id'], ['imageSize'], ['header:Subject:asDate'], 'partId']) {
            await expectInvalid(ctx.client, { ids: [id], properties: ['bodyStructure'], bodyProperties }, JSON.stringify(bodyProperties));
            await expectInvalid(ctx.client, { ids: [id], properties: ['subject'], bodyProperties }, JSON.stringify(bodyProperties));
        }
    });

    scenario('EGET-134', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: text/plain', 'Content-Transfer-Encoding: 7bit', 'X-Part: one'], 'text'),
                    part(['Content-Type: application/pdf', 'Content-Disposition: attachment; filename=a.pdf', 'X-Dup: first', 'X-Dup: second'], 'pdf')
                ])
            ),
            {
                properties: ['bodyStructure'],
                bodyProperties: [
                    'partId',
                    'headers',
                    'header:X-Part',
                    'header:content-transfer-encoding:asText',
                    'header:X-Dup:all',
                    'header:X-None',
                    'subParts'
                ]
            }
        );
        const root = email.bodyStructure;
        const [textPart, pdfPart] = root.subParts;
        expect(root.headers.map(header => header.name)).to.deep.equal(['From', 'To', 'Subject', 'MIME-Version', 'Content-Type']);
        expect(textPart.headers).to.deep.equal([
            { name: 'Content-Type', value: ' text/plain' },
            { name: 'Content-Transfer-Encoding', value: ' 7bit' },
            { name: 'X-Part', value: ' one' }
        ]);
        expect(pdfPart.headers.map(header => header.name)).to.deep.equal(['Content-Type', 'Content-Disposition', 'X-Dup', 'X-Dup']);
        expect(textPart['header:X-Part']).to.equal(' one');
        expect(root['header:X-Part']).to.be.null;
        expect(pdfPart['header:X-Part']).to.be.null;
        expect(textPart['header:content-transfer-encoding:asText']).to.equal('7bit');
        expect(pdfPart['header:X-Dup:all']).to.deep.equal([' first', ' second']);
        expect(textPart['header:X-Dup:all']).to.deep.equal([]);
        for (const entry of [root, textPart, pdfPart]) {
            expect(entry['header:X-None']).to.be.null;
        }
    });

    scenario('EGET-135', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: text/plain; charset=ISO-8859-15'], 'latin'),
                    part(['Content-Type: text/html'], '<p>html</p>'),
                    part([], 'no type'),
                    part(['Content-Type: application/pdf'], 'pdf'),
                    part(['Content-Type: application/json; charset=utf-8'], '{}'),
                    part(['Content-Type: image/png'], 'png'),
                    multipart('alternative', [text('inner')])
                ])
            ),
            { properties: ['bodyStructure'], bodyProperties: ['type', 'charset', 'subParts'] }
        );
        expect(email.bodyStructure.subParts.map(entry => entry.charset)).to.deep.equal(['iso-8859-15', 'us-ascii', 'us-ascii', null, 'utf-8', null, null]);
        expect(email.bodyStructure.charset).to.be.null;
    });

    scenario('EGET-136', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: text/plain', 'Content-Disposition: ATTACHMENT; filename=a.txt'], 'a'),
                    part(['Content-Type: text/plain', 'Content-Disposition: inline (comment)'], 'b'),
                    part(['Content-Type: text/plain'], 'c'),
                    part(['Content-Type: text/plain', 'Content-Disposition: weird; x=y'], 'd')
                ])
            ),
            { properties: ['bodyStructure'], bodyProperties: ['disposition', 'name', 'subParts'] }
        );
        expect(email.bodyStructure.subParts.map(entry => entry.disposition)).to.deep.equal(['attachment', 'inline', null, 'weird']);
    });

    scenario('EGET-137', async () => {
        const image = cid => part(['Content-Type: image/png', `Content-Id: ${cid}`], 'png');
        const email = await structureOf(
            mime(multipart('mixed', [text('no cid'), image('<1234567890@local>'), image('<1234567890>'), image('1234567890'), image(' <a@b> (comment)')])),
            { properties: ['bodyStructure'], bodyProperties: ['partId', 'cid', 'subParts'] }
        );
        expect(email.bodyStructure.subParts.map(entry => entry.cid)).to.deep.equal([null, '1234567890@local', '1234567890', '1234567890', 'a@b']);
    });

    scenario('EGET-138', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: text/plain', 'Content-Language: en-US, de (German), fr', 'Content-Location: https://example.com/img/logo.png'], 'a'),
                    part(['Content-Type: text/plain', 'Content-Language: et', 'Content-Location: https://example.com/img/\r\n folded.png'], 'b'),
                    part(['Content-Type: text/plain'], 'c')
                ])
            ),
            { properties: ['bodyStructure'], bodyProperties: ['language', 'location', 'subParts'] }
        );
        const [a, b, c] = email.bodyStructure.subParts;
        expect(a.language).to.deep.equal(['en-US', 'de', 'fr']);
        expect(b.language).to.deep.equal(['et']);
        expect(c.language).to.be.null;
        expect(a.location).to.equal('https://example.com/img/logo.png');
        expect(b.location).to.equal('https://example.com/img/folded.png');
        expect(c.location).to.be.null;
    });

    scenario('EGET-139', async () => {
        const body = 'This is a test email.\r\n';
        const { id } = await append(
            ctx.user,
            raw('From: a@example.com', 'Subject: unknown encoding', 'Content-Type: text/plain', 'Content-Transfer-Encoding: foobar', '', body)
        );
        const email = await getOne(ctx.client, id, { properties: ['bodyStructure', 'bodyValues'], fetchAllBodyValues: true });
        const blob = await download(ctx.client, email.bodyStructure.blobId);
        expect(blob.toString()).to.equal(body);
        expect(email.bodyStructure.size).to.equal(blob.length);
        const value = email.bodyValues[email.bodyStructure.partId];
        expect(value.isEncodingProblem).to.be.true;
        expect(value.value).to.equal('This is a test email.\n');
    });

    scenario('EGET-140', async () => {
        const args = { properties: ['textBody', 'htmlBody', 'attachments', 'bodyValues'], fetchTextBodyValues: true, fetchHTMLBodyValues: true };
        const first = await structureOf(mime(multipart('alternative', [html('<p>only html</p>')])), args);
        expect(ids(first.textBody)).to.deep.equal(['1']);
        expect(ids(first.htmlBody)).to.deep.equal(['1']);
        expect(Object.keys(first.bodyValues)).to.deep.equal(['1']);

        const second = await structureOf(mime(multipart('alternative', [text('only plain')])), args);
        expect(ids(second.textBody)).to.deep.equal(['1']);
        expect(ids(second.htmlBody)).to.deep.equal(['1']);
        expect(Object.keys(second.bodyValues)).to.deep.equal(['1']);

        const third = await structureOf(
            mime(multipart('mixed', [multipart('alternative', [html('<p>html</p>')]), attachment('application/pdf', 'a.pdf', 'pdf')])),
            args
        );
        expect(ids(third.textBody)).to.deep.equal(['1.1']);
        expect(ids(third.htmlBody)).to.deep.equal(['1.1']);
        expect(ids(third.attachments)).to.deep.equal(['2']);
        expect(Object.keys(third.bodyValues)).to.deep.equal(['1.1']);
    });

    scenario('EGET-141', async () => {
        for (const content of [
            mime(part(['Content-Type: application/zip'], 'PK zip bytes')),
            mime(part(['Content-Type: text/plain', 'Content-Disposition: attachment; filename=notes.txt'], 'notes'))
        ]) {
            const { id } = await append(ctx.user, content);
            const email = await getOne(ctx.client, id);
            expect(email.textBody).to.deep.equal([]);
            expect(email.htmlBody).to.deep.equal([]);
            expect(ids(email.attachments)).to.deep.equal(['1']);
            expect(email.hasAttachment).to.be.true;
            expect(email.preview).to.be.a('string');
            if (content.includes('application/zip')) {
                expect(email.preview).to.equal('');
            }
        }
    });

    scenario('EGET-142', async () => {
        const email = await structureOf(mime(multipart('mixed', [text('main body'), text('-- \r\nlist footer')])), {
            properties: ['textBody', 'htmlBody', 'attachments', 'bodyValues'],
            fetchTextBodyValues: true
        });
        expect(ids(email.textBody)).to.deep.equal(['1', '2']);
        expect(ids(email.htmlBody)).to.deep.equal(['1', '2']);
        expect(email.attachments).to.deep.equal([]);
        expect(Object.keys(email.bodyValues)).to.have.members(['1', '2']);
    });

    scenario('EGET-143', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    text('body'),
                    part(['Content-Type: text/plain; name=log.txt'], 'log'),
                    part(['Content-Type: text/html', 'Content-Disposition: attachment'], '<p>attached html</p>')
                ])
            ),
            { properties: ['textBody', 'htmlBody', 'attachments'] }
        );
        expect(ids(email.textBody)).to.deep.equal(['1']);
        expect(ids(email.htmlBody)).to.deep.equal(['1']);
        expect(ids(email.attachments)).to.deep.equal(['2', '3']);
        expect(email.attachments[0].name).to.equal('log.txt');
    });

    scenario('EGET-144', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    text('text'),
                    part(['Content-Type: image/jpeg', 'Content-Disposition: inline; filename=photo.jpg'], 'jpeg'),
                    part(['Content-Type: audio/mpeg'], 'mp3'),
                    part(['Content-Type: video/mp4', 'Content-Disposition: attachment; filename=clip.mp4'], 'mp4')
                ])
            ),
            { properties: ['textBody', 'htmlBody', 'attachments', 'hasAttachment'] }
        );
        expect(ids(email.textBody)).to.deep.equal(['1', '2', '3']);
        expect(ids(email.htmlBody)).to.deep.equal(['1', '2', '3']);
        expect(ids(email.attachments)).to.deep.equal(['4']);
        expect(email.hasAttachment).to.be.true;
    });

    scenario('EGET-145', async () => {
        const email = await structureOf(
            mime(
                multipart('alternative', [
                    multipart('mixed', [text('B'), part(['Content-Type: image/jpeg', 'Content-Disposition: inline'], 'C'), text('D')]),
                    html('<p>E</p>')
                ])
            ),
            { properties: ['textBody', 'htmlBody', 'attachments'] }
        );
        expect(ids(email.textBody)).to.deep.equal(['1.1', '1.2', '1.3']);
        expect(ids(email.htmlBody)).to.deep.equal(['2']);
        expect(ids(email.attachments)).to.deep.equal(['1.2']);
    });

    scenario('EGET-146', async () => {
        const args = { properties: ['textBody', 'htmlBody', 'attachments', 'bodyStructure', 'bodyValues'], fetchAllBodyValues: true };
        const first = await structureOf(
            mime(
                multipart('mixed', [
                    text('plain'),
                    part(['Content-Type: text/calendar'], 'BEGIN:VCALENDAR'),
                    part(['Content-Type: text/x-markdown'], '# heading')
                ])
            ),
            args
        );
        expect(ids(first.textBody)).to.deep.equal(['1']);
        expect(ids(first.attachments)).to.deep.equal(['2', '3']);
        expect(Object.keys(first.bodyValues)).to.have.members(['1', '2', '3']);

        const second = await structureOf(mime(part(['Content-Type: text/x-markdown'], '# only markdown\r\n')), args);
        expect(second.textBody).to.deep.equal([]);
        expect(second.htmlBody).to.deep.equal([]);
        expect(ids(second.attachments)).to.deep.equal(['1']);
        expect(second.bodyValues['1']).to.deep.equal({ value: '# only markdown\n', isEncodingProblem: false, isTruncated: false });
    });

    scenario('EGET-147', async () => {
        const email = await structureOf(
            mime(
                multipart('mixed', [
                    text('text'),
                    multipart('mixed', [attachment('application/pdf', 'pdf1.pdf', '1'), multipart('mixed', [attachment('application/pdf', 'pdf2.pdf', '2')])]),
                    attachment('application/pdf', 'pdf3.pdf', '3'),
                    part(['Content-Type: message/rfc822'], 'From: m@example.com\r\nSubject: m\r\n\r\nbody')
                ])
            ),
            { properties: ['attachments'], bodyProperties: ['partId', 'type', 'name', 'subParts'] }
        );
        expect(email.attachments.map(entry => entry.name || entry.type)).to.deep.equal(['pdf1.pdf', 'pdf2.pdf', 'pdf3.pdf', 'message/rfc822']);
        for (const entry of email.attachments) {
            expect(entry.type.startsWith('multipart/')).to.be.false;
            expect(noSubParts(entry)).to.be.true;
        }
    });
});
