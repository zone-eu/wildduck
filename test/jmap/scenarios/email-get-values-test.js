/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-get.yaml: bodyValues, preview, hasAttachment, part blobs and agreement with
// IMAP on parts (EGET-114, EGET-148 to EGET-182) and wildduck.yaml WDX-003.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const libqp = require('libqp');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, clock } = require('../harness');
const {
    newUser,
    append,
    get,
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
    raw,
    text,
    html,
    attachment,
    base64,
    PNG,
    ids
} = require('./email-get-helpers');

const ALL_VALUES = { properties: ['bodyStructure', 'bodyValues'], fetchAllBodyValues: true };
const values = email => Object.values(email.bodyValues);
// a single text part inside a multipart, so the part has no trailing line break of the message
const wrapped = entity => mime(multipart('mixed', [entity]));
const qp = (type, charset, bytes) =>
    part([`Content-Type: ${type}; charset=${charset}`, 'Content-Transfer-Encoding: quoted-printable'], libqp.wrap(libqp.encode(bytes), 76));
const b64 = (type, charset, bytes) => base64([`Content-Type: ${type}; charset=${charset}`], bytes);
const KEY_DIR = path.join(__dirname, '..', '..', 'fixtures');

/** Leaf nodes of an imapflow BODYSTRUCTURE in order, not descending into embedded messages */
function imapNodes(node, list = [], level = 0) {
    list.push({ node, level });
    if (node.childNodes && !/^message\//i.test(node.type)) {
        node.childNodes.forEach(child => imapNodes(child, list, level + 1));
    }
    return list;
}

/** Every part of an EmailBodyPart tree with its depth */
function jmapNodes(entry, list = [], level = 0) {
    list.push({ entry, level });
    (entry.subParts || []).forEach(sub => jmapNodes(sub, list, level + 1));
    return list;
}

async function imapFetch(user, uid, query) {
    const imap = await imapFor(user);
    await imap.mailboxOpen('INBOX');
    return imap.fetchOne(String(uid), query, { uid: true });
}

describe('Email/get bodyValues (email-get.yaml)', () => {
    let ctx;
    // mixed [alternative [P, H], csv attachment T]
    let threeParts;

    before(async () => {
        ctx = await newUser();
        threeParts = (
            await append(
                ctx.user,
                mime(multipart('mixed', [multipart('alternative', [text('Plain text P'), html('<p>HTML H</p>')]), attachment('text/csv', 't.csv', 'a,b')]))
            )
        ).id;
    });

    const valuesOf = async (content, args) => getOne(ctx.client, (await append(ctx.user, content)).id, Object.assign({}, ALL_VALUES, args));

    scenario('EGET-148', async () => {
        const { id } = await append(ctx.user, mime(multipart('alternative', [text('plain'), html('<p>html</p>')])));
        const plain = await getOne(ctx.client, id, { properties: ['bodyValues', 'textBody', 'htmlBody'] });
        expect(plain.bodyValues).to.deep.equal({});
        const explicit = await getOne(ctx.client, id, {
            properties: ['bodyValues', 'textBody', 'htmlBody'],
            fetchTextBodyValues: false,
            fetchHTMLBodyValues: false,
            fetchAllBodyValues: false
        });
        expect(explicit.bodyValues).to.deep.equal({});
    });

    scenario('EGET-149', async () => {
        const email = await getOne(ctx.client, threeParts, { properties: ['textBody', 'htmlBody', 'bodyValues'], fetchTextBodyValues: true });
        expect(email.bodyValues).to.deep.equal({ 1.1: { value: 'Plain text P', isEncodingProblem: false, isTruncated: false } });
    });

    scenario('EGET-150', async () => {
        const email = await getOne(ctx.client, threeParts, { properties: ['textBody', 'htmlBody', 'bodyValues'], fetchHTMLBodyValues: true });
        expect(email.bodyValues).to.deep.equal({ 1.2: { value: '<p>HTML H</p>', isEncodingProblem: false, isTruncated: false } });
    });

    scenario('EGET-151', async () => {
        const args = { properties: ['textBody', 'htmlBody', 'bodyValues'], fetchTextBodyValues: true, fetchHTMLBodyValues: true };
        const email = await getOne(ctx.client, threeParts, args);
        expect(Object.keys(email.bodyValues)).to.have.members(['1.1', '1.2']);
        const single = await getOne(ctx.client, (await append(ctx.user, mime(text('single')))).id, args);
        expect(Object.keys(single.bodyValues)).to.deep.equal(['1']);
    });

    scenario('EGET-152', async () => {
        const email = await valuesOf(
            mime(
                multipart('mixed', [
                    multipart('alternative', [text('P'), html('<p>H</p>')]),
                    attachment('text/csv', 't.csv', 'T'),
                    base64(['Content-Type: image/png'], PNG),
                    part(['Content-Type: message/rfc822'], 'From: m@example.com\r\nSubject: M\r\nContent-Type: text/plain\r\n\r\nembedded text')
                ])
            )
        );
        expect(Object.keys(email.bodyValues)).to.have.members(['1.1', '1.2', '2']);
        const partIds = allParts(email.bodyStructure).map(entry => entry.partId);
        Object.keys(email.bodyValues).forEach(key => expect(partIds).to.include(key));
    });

    scenario('EGET-153', async () => {
        const { id } = await append(ctx.user, mime(text('the text')));
        const first = await getOne(ctx.client, id, { properties: ['subject'], fetchAllBodyValues: true });
        expect(first).to.not.have.property('bodyValues');
        const second = await getOne(ctx.client, id, { properties: ['bodyValues'], fetchTextBodyValues: true });
        expect(Object.keys(second.bodyValues)).to.deep.equal(['1']);
    });

    scenario('EGET-154', async () => {
        const { id } = await append(ctx.user, mime(text('the text')));
        for (const maxBodyValueBytes of [-5, 1.5, 'cat', '1', true, {}, []]) {
            await expectInvalid(
                ctx.client,
                { ids: [id], properties: ['bodyValues'], fetchAllBodyValues: true, maxBodyValueBytes },
                JSON.stringify(maxBodyValueBytes)
            );
        }
        for (const flag of ['yes', 1]) {
            await expectInvalid(ctx.client, { ids: [id], properties: ['bodyValues'], fetchTextBodyValues: flag }, JSON.stringify(flag));
        }
    });

    scenario('EGET-155', async () => {
        const plain =
            'Tere! Väga pikk rida, mis tuleb pehmete reavahetustega murda, et see mahuks seitsmekümne kuue märgi sisse ja ikka õigesti tagasi tuleks. Ümber.';
        const rich = '<p>Häid pühi, 😀</p>';
        const email = await valuesOf(mime(multipart('mixed', [qp('text/plain', 'utf-8', Buffer.from(plain)), b64('text/html', 'utf-8', Buffer.from(rich))])));
        expect(email.bodyValues['1']).to.deep.equal({ value: plain, isEncodingProblem: false, isTruncated: false });
        expect(email.bodyValues['2']).to.deep.equal({ value: rich, isEncodingProblem: false, isTruncated: false });
    });

    scenario('EGET-156', async () => {
        const japanese = Buffer.from('1b244224332473244b2441244f1b2842', 'hex'); // こんにちは in ISO-2022-JP
        const cases = [
            ['iso-8859-1', iconv.encode('Jürgen läheb', 'latin1'), 'Jürgen läheb'],
            ['windows-1252', iconv.encode('Hind 5 €', 'windows-1252'), 'Hind 5 €'],
            ['koi8-r', iconv.encode('Привет мир', 'koi8-r'), 'Привет мир'],
            ['iso-2022-jp', japanese, 'こんにちは', 'qp'],
            ['iso-2022-jp', japanese, 'こんにちは', '7bit'],
            ['shift_jis', iconv.encode('こんにちは', 'shift_jis'), 'こんにちは'],
            ['euc-kr', iconv.encode('안녕하세요', 'euc-kr'), '안녕하세요'],
            ['gb18030', iconv.encode('你好世界', 'gb18030'), '你好世界'],
            ['utf-16', Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('UTF-16 tekst õ', 'utf-16le')]), 'UTF-16 tekst õ']
        ];
        for (const [charset, bytes, expected, encoding] of cases) {
            let entity;
            if (encoding === '7bit') {
                entity = part([`Content-Type: text/plain; charset=${charset}`, 'Content-Transfer-Encoding: 7bit'], bytes.toString('binary'));
            } else if (encoding === 'qp') {
                entity = qp('text/plain', charset, bytes);
            } else {
                entity = b64('text/plain', charset, bytes);
            }
            const { id } = await append(ctx.user, wrapped(entity));
            const email = await getOne(ctx.client, id, { properties: ['bodyValues', 'preview', 'bodyStructure'], fetchAllBodyValues: true });
            const label = `${charset} ${encoding || 'base64'}`;
            expect(email.bodyValues['1'], label).to.deep.equal({ value: expected, isEncodingProblem: false, isTruncated: false });
            expect(email.preview, label).to.equal(expected);
            const leaf = email.bodyStructure.subParts[0];
            expect(leaf.charset, label).to.equal(charset);
            expect((await download(ctx.client, leaf.blobId)).equals(bytes), label).to.be.true;
        }
    });

    scenario('EGET-157', async () => {
        const email = await valuesOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: text/plain', 'Content-Transfer-Encoding: quoted-printable'], 'one\r\ntwo\r\nthree'),
                    b64('text/plain', 'utf-8', Buffer.from('first\r\nsecond\rthird\r\n'))
                ])
            )
        );
        expect(email.bodyValues['1'].value).to.equal('one\ntwo\nthree');
        expect(email.bodyValues['2'].value).to.not.include('\r\n');
        expect(email.bodyValues['2'].value).to.equal('first\nsecond\rthird\n');
        expect(email.bodyStructure.subParts[0].size).to.equal(15);
    });

    scenario('EGET-158', async () => {
        const email = await valuesOf(
            mime(
                multipart('mixed', [
                    part(['Content-Type: text/plain; charset=us-ascii'], 'hello'),
                    part(['Content-Type: text/plain; charset=x-jmts-unknown'], 'world')
                ])
            )
        );
        expect(email.bodyValues['1']).to.deep.equal({ value: 'hello', isEncodingProblem: false, isTruncated: false });
        expect(email.bodyValues['2'].isEncodingProblem).to.be.true;
        expect(email.bodyValues['2'].value).to.be.a('string').that.includes('world');
    });

    scenario('EGET-159', async () => {
        const parts = [
            part(['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], Buffer.from([0x61, 0xc3, 0x28, 0x62]).toString('binary')),
            part(['Content-Type: text/plain; charset=us-ascii', 'Content-Transfer-Encoding: 8bit'], Buffer.from('caf\xe9', 'latin1').toString('binary')),
            b64('text/plain', 'utf-32', Buffer.from([0xff, 0xff, 0xff, 0xff, 0x61, 0x00]))
        ];
        for (const entity of parts) {
            const { id } = await append(ctx.user, wrapped(entity));
            const res = await get(ctx.client, id, { properties: ['textBody', 'bodyValues', 'preview'], fetchTextBodyValues: true });
            const email = res.list[0];
            const [value] = values(email);
            expect(value.isEncodingProblem, entity.slice(0, 40)).to.be.true;
            expect(value.value).to.be.a('string');
            expect(value.value.includes('�') || value.value === 'café').to.be.true;
            expect(email.preview).to.be.a('string');
        }
    });

    scenario('EGET-160', async () => {
        const content = 'Smile \u{1F600} and a real � replacement character';
        const email = await valuesOf(wrapped(b64('text/plain', 'utf-8', Buffer.from(content))));
        expect(email.bodyValues['1']).to.deep.equal({ value: content, isEncodingProblem: false, isTruncated: false });
    });

    scenario('EGET-161', async () => {
        const first = await valuesOf(
            raw(
                'From: a@example.com',
                'Subject: charset as encoding',
                'Content-Type: text/plain',
                'Content-Transfer-Encoding: UTF-8',
                '',
                'This is a test.',
                ''
            )
        );
        expect(values(first)[0].value).to.equal('This is a test.\n');

        const second = await valuesOf(wrapped(part(['Content-Type: text/html', 'Content-Transfer-Encoding: quoted-printable'], '<p>hello=00 world</p>')));
        const value = second.bodyValues['1'];
        expect(value.value).to.not.include('\0');
        expect(JSON.stringify(value)).to.not.include('\\u0000');
        expect(value.value).to.equal('<p>hello world</p>');
        expect(value.isEncodingProblem).to.be.true;
    });

    scenario('EGET-162', async () => {
        const long = 'abcdefghij'.repeat(100);
        const { id: longId } = await append(ctx.user, wrapped(text(long)));
        const { id: shortId } = await append(ctx.user, wrapped(text('0123456789')));
        const at = async maxBodyValueBytes => {
            const args = Object.assign({ properties: ['bodyValues'], fetchAllBodyValues: true }, maxBodyValueBytes === undefined ? {} : { maxBodyValueBytes });
            const res = await get(ctx.client, [longId, shortId], args);
            return res.list.map(email => email.bodyValues['1']);
        };
        const [truncated, short] = await at(100);
        expect(truncated).to.deep.equal({ value: long.slice(0, 100), isEncodingProblem: false, isTruncated: true });
        expect(short).to.deep.equal({ value: '0123456789', isEncodingProblem: false, isTruncated: false });
        for (const limit of [1000, 1001, 0, undefined]) {
            const [complete] = await at(limit);
            expect(complete, String(limit)).to.deep.equal({ value: long, isEncodingProblem: false, isTruncated: false });
        }
    });

    scenario('EGET-163', async () => {
        const mixedWidth = 'हéa'; // 3, 2 and 1 octets
        const emoji = '\u{1F600}abc';
        const { id: first } = await append(ctx.user, wrapped(text(mixedWidth)));
        const { id: second } = await append(ctx.user, wrapped(text(emoji)));
        const valueAt = async (id, maxBodyValueBytes) =>
            (await getOne(ctx.client, id, { properties: ['bodyValues'], fetchAllBodyValues: true, maxBodyValueBytes })).bodyValues['1'];
        const expectedFirst = ['', '', 'ह', 'ह', 'हé', mixedWidth];
        for (let limit = 1; limit <= 6; limit++) {
            const value = await valueAt(first, limit);
            expect(value.value, `limit ${limit}`).to.equal(expectedFirst[limit - 1]);
            expect(value.isTruncated, `limit ${limit}`).to.equal(limit < 6);
            expect(Buffer.byteLength(value.value)).to.be.at.most(limit);
        }
        for (let limit = 1; limit <= 4; limit++) {
            const value = await valueAt(second, limit);
            expect(value.value, `emoji limit ${limit}`).to.equal(limit < 4 ? '' : '\u{1F600}');
            expect(value.isTruncated).to.be.true;
        }
    });

    scenario('EGET-164', async () => {
        const latin = 'é'.repeat(50);
        const lines = 'aaaaa\r\n'.repeat(10); // 70 octets with CRLF, 60 with LF
        const email = await valuesOf(mime(multipart('mixed', [b64('text/plain', 'iso-8859-1', iconv.encode(latin, 'latin1')), text(lines)])), {
            maxBodyValueBytes: 60
        });
        expect(email.bodyValues['1']).to.deep.equal({ value: 'é'.repeat(30), isEncodingProblem: false, isTruncated: true });
        expect(email.bodyValues['2']).to.deep.equal({ value: 'aaaaa\n'.repeat(10), isEncodingProblem: false, isTruncated: false });
    });

    scenario('EGET-165', async () => {
        const markup = '<p>Hello <a href="https://example.com/a/long/link">link</a> world</p>';
        const limit = markup.indexOf('example');
        const { id } = await append(ctx.user, wrapped(html(markup)));
        const email = await getOne(ctx.client, id, { properties: ['bodyValues'], fetchHTMLBodyValues: true, maxBodyValueBytes: limit });
        const value = email.bodyValues['1'];
        expect(value.isTruncated).to.be.true;
        expect(Buffer.byteLength(value.value)).to.be.at.most(limit);
        expect(value.value).to.equal('<p>Hello ');
        expect(value.value.lastIndexOf('<')).to.be.below(value.value.lastIndexOf('>') + 1);
    });

    scenario('EGET-166', async function () {
        this.timeout(60000); // eslint-disable-line no-invalid-this
        const line = 'The quick brown fox jumps over the lazy dog 0123456789.\r\n';
        const large = line.repeat(Math.ceil((400 * 1024) / line.length));
        const medium = line.repeat(Math.ceil((100 * 1024) / line.length));
        const { id: largeId } = await append(ctx.user, wrapped(text(large)));
        const { id: mediumId } = await append(ctx.user, wrapped(text(medium)));
        const full = await get(ctx.client, [largeId, mediumId], { properties: ['bodyValues', 'preview'], fetchTextBodyValues: true });
        const [largeEmail, mediumEmail] = [largeId, mediumId].map(id => full.list.find(email => email.id === id));
        expect(largeEmail.bodyValues['1'].value).to.equal(large.replace(/\r\n/g, '\n'));
        expect(largeEmail.bodyValues['1'].isTruncated).to.be.false;
        expect(mediumEmail.bodyValues['1'].value).to.equal(medium.replace(/\r\n/g, '\n'));
        const limited = await get(ctx.client, [largeId, mediumId], {
            properties: ['bodyValues', 'preview'],
            fetchTextBodyValues: true,
            maxBodyValueBytes: 1024
        });
        for (const email of limited.list) {
            expect(Buffer.byteLength(email.bodyValues['1'].value)).to.equal(1024);
            expect(email.bodyValues['1'].isTruncated).to.be.true;
            expect(email.preview).to.be.a('string').that.is.not.empty;
        }
    });
});

describe('Email/get hasAttachment and preview (email-get.yaml)', () => {
    let ctx;

    before(async () => {
        ctx = await newUser();
    });

    const previewOf = async content => (await getOne(ctx.client, (await append(ctx.user, content)).id, { properties: ['preview'] })).preview;

    scenario('EGET-167', async () => {
        const contents = [
            mime(text('plain')),
            mime(multipart('alternative', [text('plain'), html('<p>html</p>')])),
            mime(
                multipart('related', [
                    html('<p><img src="cid:logo@x"></p>'),
                    base64(['Content-Type: image/png', 'Content-ID: <logo@x>', 'Content-Disposition: inline'], PNG)
                ])
            )
        ];
        for (const [i, content] of contents.entries()) {
            const email = await getOne(ctx.client, (await append(ctx.user, content)).id, { properties: ['hasAttachment', 'attachments'] });
            expect(email.hasAttachment, `message ${i}`).to.equal(false);
            if (i === 2) {
                expect(email.attachments.map(entry => entry.type)).to.deep.equal(['image/png']);
            }
        }
    });

    scenario('EGET-168', async () => {
        const { user, client } = await newUser();
        const contents = {
            pdf: mime(
                multipart('mixed', [
                    text('pdf'),
                    base64(['Content-Type: application/pdf', 'Content-Disposition: attachment; filename=a.pdf'], Buffer.alloc(100, 1))
                ])
            ),
            jpeg: mime(multipart('mixed', [text('before'), base64(['Content-Type: image/jpeg; name=photo.jpg'], Buffer.alloc(100, 2)), text('after')])),
            message: mime(multipart('mixed', [text('forwarded'), part(['Content-Type: message/rfc822'], 'From: x@example.com\r\nSubject: fwd\r\n\r\nbody')])),
            octet: mime(multipart('mixed', [text('octets'), base64(['Content-Type: application/octet-stream'], Buffer.alloc(100, 3))])),
            plain: mime(text('no attachment'))
        };
        const stored = {};
        for (const [key, content] of Object.entries(contents)) {
            stored[key] = await append(user, content);
        }
        const res = await get(
            client,
            Object.values(stored).map(entry => entry.id),
            { properties: ['hasAttachment'] }
        );
        const flags = Object.fromEntries(Object.entries(stored).map(([key, entry]) => [key, res.list.find(email => email.id === entry.id).hasAttachment]));
        expect(flags.pdf).to.be.true;
        expect(flags.message).to.be.true;
        expect(flags.octet).to.be.true;
        expect(flags.plain).to.be.false;

        const query = await client.method('Email/query', { filter: { hasAttachment: true } });
        const expected = Object.entries(stored)
            .filter(([key]) => flags[key])
            .map(([, entry]) => entry.id);
        expect(query.ids).to.have.members(expected);
        expect(query.ids).to.have.length(expected.length);

        const inbox = (await accounts.mailboxes(user)).INBOX.id;
        const listing = await api('GET', `/users/${user.id}/mailboxes/${inbox}/messages?limit=50`);
        for (const [key, entry] of Object.entries(stored)) {
            const message = listing.results.find(item => item.id === entry.uid);
            expect(!!message.attachments, key).to.equal(flags[key]);
        }
    });

    scenario('EGET-169', async () => {
        expect(await previewOf(mime(text('A plain text email.\r\n')))).to.equal('A plain text email.');
    });

    scenario('EGET-170', async () => {
        const words = Array.from({ length: 1000 }, (entry, i) => `word${i}`).join(' ');
        const emoji = '\u{1F600}'.repeat(200);
        // the last body puts the 128 character cut inside a surrogate pair
        for (const body of [words, emoji, `a${emoji}`]) {
            const { id, uid } = await append(ctx.user, mime(text(body)));
            const { preview } = await getOne(ctx.client, id, { properties: ['preview'] });
            const cut = preview.replace(/…$/, '');
            expect(cut.length).to.be.at.most(128);
            expect(body.startsWith(cut)).to.be.true;
            // never ends inside a surrogate pair
            expect(/[\ud800-\udbff]$/.test(cut)).to.be.false;
            const inbox = (await accounts.mailboxes(ctx.user)).INBOX.id;
            const listing = await api('GET', `/users/${ctx.user.id}/mailboxes/${inbox}/messages?limit=250`);
            expect(listing.results.find(item => item.id === uid).intro).to.equal(preview);
        }
    });

    scenario('EGET-171', async () => {
        const preview = await previewOf(mime(text('\r\n\r\n  \tFirst line\r\nsecond\t\tline   with    spaces\r\n\r\nthird\r\n')));
        expect(preview).to.equal('First line second line with spaces third');
        expect(preview).to.not.match(/[\r\n\t]|\s{2}|^\s|\s$/);
    });

    scenario('EGET-172', async () => {
        const preview = await previewOf(
            mime(
                html(
                    '<html><head><style>p { color: red; }</style><script>var secret = 1;</script></head><body><!-- hidden comment -->hello<br><p>world</p>!&nbsp;Tom &amp; Jerry</body></html>'
                )
            )
        );
        expect(preview).to.match(/^hello world !?/);
        expect(preview).to.include('&');
        expect(preview).to.include('Tom & Jerry');
        expect(preview).to.not.match(/[<>]|color|secret|hidden comment|&amp;|&nbsp;/);
        expect(preview).to.not.match(/\s{2}/);
    });

    scenario('EGET-173', async () => {
        const contents = [
            raw('From: a@example.com', 'Subject: empty', '', ''),
            mime(base64(['Content-Type: application/pdf'], Buffer.alloc(200, 9))),
            mime(
                multipart(
                    'encrypted',
                    [
                        part(['Content-Type: application/pgp-encrypted'], 'Version: 1'),
                        part(['Content-Type: application/octet-stream'], '-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----')
                    ],
                    [' protocol="application/pgp-encrypted"']
                ).replace(/"\r\n protocol/, '";\r\n protocol')
            )
        ];
        for (const content of contents) {
            expect(await previewOf(content)).to.equal('');
        }
    });

    scenario('EGET-174', async () => {
        const japanese = Buffer.from('1b244224332473244b2441244f1b2842', 'hex');
        expect(await previewOf(mime(b64('text/plain', 'iso-2022-jp', japanese)))).to.equal('こんにちは');
        const accented = 'Café crème brûlée €5';
        const preview = await previewOf(mime(qp('text/plain', 'windows-1252', iconv.encode(accented, 'windows-1252'))));
        expect(preview).to.equal(accented);
        expect(preview).to.not.match(/[=][0-9A-F]{2}/);
        expect(preview).to.not.include(String.fromCharCode(27));
    });
});

describe('Email/get part blobs and IMAP agreement (email-get.yaml)', () => {
    let ctx;

    before(async () => {
        ctx = await newUser();
    });

    scenario('EGET-175', async () => {
        const latinText = Buffer.from('Õhtu\r\nsöök\r\n', 'utf8').toString('utf8');
        const latinBytes = iconv.encode(latinText, 'latin1');
        const csv = 'a,b\r\n1,2';
        const { id } = await append(
            ctx.user,
            mime(
                multipart('mixed', [
                    qp('text/plain', 'iso-8859-1', latinBytes),
                    base64(['Content-Type: image/png', 'Content-Disposition: attachment; filename=i.png'], PNG),
                    attachment('text/csv', 'd.csv', csv)
                ])
            )
        );
        const email = await getOne(ctx.client, id, { properties: ['bodyStructure', 'attachments'] });
        const [first, second, third] = email.bodyStructure.subParts;
        const expected = [latinBytes, PNG, Buffer.from(csv)];
        for (const [i, leaf] of [first, second, third].entries()) {
            const blob = await download(ctx.client, leaf.blobId);
            expect(blob.equals(expected[i]), leaf.partId).to.be.true;
            expect(blob.length).to.equal(leaf.size);
        }
    });

    scenario('EGET-176', async () => {
        const { user, client } = await newUser();
        await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
        const { id, uid } = await append(
            user,
            mime(multipart('mixed', [multipart('alternative', [text('plain'), html('<p>html</p>')]), attachment('application/pdf', 'a.pdf', 'pdf')]))
        );
        const before = await getOne(client, id, { properties: ['blobId', 'bodyStructure'] });
        const imap = await imapFor(user);
        await imap.mailboxOpen('INBOX');
        await imap.messageMove(String(uid), 'Archive', { uid: true });
        const after = await getOne(client, id, { properties: ['blobId', 'bodyStructure'] });
        expect(after.blobId).to.equal(before.blobId);
        expect(leaves(after.bodyStructure).map(entry => entry.blobId)).to.deep.equal(leaves(before.bodyStructure).map(entry => entry.blobId));
        const partBlobs = leaves(after.bodyStructure).map(entry => entry.blobId);
        for (const blobId of [after.blobId, ...partBlobs]) {
            expect(blobId).to.match(/^[A-Za-z0-9_-]+$/);
        }
        expect(new Set(partBlobs).size).to.equal(partBlobs.length);
        const prefix = blobId => blobId.slice(0, 2);
        expect(new Set(partBlobs.map(prefix)).size).to.equal(1);
        expect(prefix(after.blobId)).to.not.equal(prefix(partBlobs[0]));
    });

    scenario('EGET-177', async () => {
        const inner = 'From: inner@example.com\r\nSubject: embedded\r\nContent-Type: text/plain\r\n\r\nEmbedded body\r\n';
        const { id } = await append(
            ctx.user,
            mime(
                multipart('mixed', [
                    text('outer'),
                    part(['Content-Type: message/rfc822', 'Content-Transfer-Encoding: base64'], Buffer.from(inner).toString('base64'))
                ])
            )
        );
        const email = await getOne(ctx.client, id, { properties: ['attachments'] });
        expect(email.attachments).to.have.length(1);
        const blob = await download(ctx.client, email.attachments[0].blobId);
        expect(blob.toString()).to.equal(inner);
        expect(blob.toString().startsWith('From: inner@example.com')).to.be.true;
        expect(blob.length).to.equal(email.attachments[0].size);
    });

    scenario('EGET-178', async () => {
        const names = ['simple.eml', 'nodemailer.eml', 'fix1.eml', 'fix3.eml', 'fix4.eml', 'append.eml', 'mimetorture.eml', 'multipart-2.eml'];
        for (const name of names) {
            const { id, uid } = await append(ctx.user, fixtures.readFixture(name));
            const email = await getOne(ctx.client, id, {
                properties: ['bodyStructure'],
                bodyProperties: ['partId', 'type', 'name', 'cid', 'disposition', 'subParts']
            });
            const fetched = await imapFetch(ctx.user, uid, { bodyStructure: true });
            const jmap = jmapNodes(email.bodyStructure);
            const imap = imapNodes(fetched.bodyStructure);
            expect(
                jmap.map(entry => entry.level),
                name
            ).to.deep.equal(imap.map(entry => entry.level));
            jmap.forEach(({ entry }, i) => {
                const node = imap[i].node;
                const label = `${name} part ${node.part || '1'}`;
                expect(entry.type, label).to.equal(node.type.toLowerCase());
                expect(entry.cid, label).to.equal(node.id ? node.id.replace(/^<|>$/g, '') : null);
                expect(entry.disposition, label).to.equal(node.disposition ? node.disposition.toLowerCase() : null);
                if (!entry.subParts) {
                    expect(entry.partId, label).to.equal(node.part || '1');
                }
            });
        }
    });

    scenario('EGET-179', async () => {
        const content = mime(
            multipart('mixed', [
                qp(
                    'text/plain',
                    'utf-8',
                    Buffer.from('Quoted-printable sisu õäöü, piisavalt pikk rida, et pehme reavahetus tekiks seitsmekümne kuue märgi järel.')
                ),
                base64(['Content-Type: application/octet-stream'], crypto.randomBytes(2000)),
                part(['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], Buffer.from('Kaheksabitine sisu õäöü').toString('binary'))
            ])
        );
        const { id, uid } = await append(ctx.user, content);
        const email = await getOne(ctx.client, id, {
            properties: ['blobId', 'bodyStructure'],
            bodyProperties: ['partId', 'blobId', 'header:Content-Transfer-Encoding:asText', 'subParts']
        });
        for (const leaf of leaves(email.bodyStructure)) {
            const fromImap = await imapDecodedPart(ctx.user, 'INBOX', uid, leaf.partId, leaf['header:Content-Transfer-Encoding:asText']);
            expect((await download(ctx.client, leaf.blobId)).equals(fromImap), leaf.partId).to.be.true;
        }
        const whole = await imapFetch(ctx.user, uid, { source: true });
        expect((await download(ctx.client, email.blobId)).equals(whole.source)).to.be.true;
    });

    scenario('EGET-181', async function () {
        this.timeout(180000); // eslint-disable-line no-invalid-this
        const { user, client } = await newUser();
        const big = crypto.randomBytes(18 * 1024 * 1024);
        const { id } = await append(
            user,
            mime(
                multipart('mixed', [
                    text('Short text part'),
                    base64(['Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename=big.bin'], big)
                ])
            )
        );
        const { id: smallId } = await append(user, mime(text('small message')));
        const fast = [
            'id',
            'blobId',
            'threadId',
            'mailboxIds',
            'keywords',
            'size',
            'receivedAt',
            'messageId',
            'inReplyTo',
            'sender',
            'from',
            'to',
            'cc',
            'bcc',
            'replyTo',
            'subject',
            'sentAt',
            'hasAttachment',
            'preview'
        ];
        const timed = async (emailId, args) => {
            const started = process.hrtime.bigint();
            const email = await getOne(client, emailId, args);
            return { email, ms: Number(process.hrtime.bigint() - started) / 1e6 };
        };
        await timed(smallId, { properties: fast });
        const small = await timed(smallId, { properties: fast });
        const large = await timed(id, { properties: fast });
        expect(large.email.size).to.be.above(big.length);
        expect(large.ms).to.be.below(Math.max(small.ms * 5, 300));

        const full = await getOne(client, id, { properties: ['bodyStructure', 'bodyValues'], fetchAllBodyValues: true });
        const attachmentPart = full.bodyStructure.subParts[1];
        expect(attachmentPart.size).to.equal(big.length);
        expect(Object.values(full.bodyValues).map(value => value.value)).to.deep.equal(['Short text part']);
    });

    scenario('EGET-182', async () => {
        const parts = [text('two hundred attachments')];
        for (let i = 0; i < 200; i++) {
            parts.push(attachment('application/octet-stream', `file${i}.bin`, `content ${i}`));
        }
        const { id } = await append(ctx.user, mime(multipart('mixed', parts)));
        const email = await getOne(ctx.client, id, { properties: ['bodyStructure', 'attachments', 'hasAttachment'] });
        expect(email.bodyStructure.subParts).to.have.length(201);
        expect(email.attachments).to.have.length(200);
        expect(email.attachments.map(entry => entry.name)).to.deep.equal(Array.from({ length: 200 }, (entry, i) => `file${i}.bin`));
        expect(new Set(ids(email.attachments)).size).to.equal(200);
        expect(new Set(email.attachments.map(entry => entry.blobId)).size).to.equal(200);
        expect(email.hasAttachment).to.be.true;
    });
});

describe('Email/get of encrypted messages (email-get.yaml, wildduck.yaml)', () => {
    const PROPERTIES = ['bodyStructure', 'textBody', 'htmlBody', 'attachments', 'preview', 'bodyValues'];

    // an encrypted user, a message delivered to it over LMTP, the Email and its IMAP BODYSTRUCTURE
    async function encryptedDelivery() {
        const { user, client } = await newUser({ pubKey: fs.readFileSync(path.join(KEY_DIR, 'user2-public.key'), 'utf8'), encryptMessages: true });
        const secret = `Secret plaintext ${crypto.randomBytes(4).toString('hex')}`;
        await seed.deliver(user.address, mime(multipart('alternative', [text(secret), html(`<p>${secret}</p>`)])));
        const [id] = await clock.waitFor(async () => {
            const res = await client.method('Email/query', {});
            return res.ids.length && res.ids;
        });
        const email = await getOne(client, id, { properties: PROPERTIES, fetchAllBodyValues: true });
        const db = await seed.db();
        const doc = await db
            .collection('messages')
            .findOne({ user: new seed.ObjectId(user.id), root: new seed.ObjectId(id.slice(1)) }, { projection: { uid: true } });
        const fetched = await imapFetch(user, doc.uid, { bodyStructure: true });
        return { email, secret, imapTree: fetched.bodyStructure };
    }

    function expectStoredEncrypted({ email, secret, imapTree }) {
        expect(email.bodyStructure.type).to.equal('multipart/encrypted');
        expect(imapTree.type.toLowerCase()).to.equal('multipart/encrypted');
        expect(leaves(email.bodyStructure).map(entry => entry.type)).to.deep.equal(imapTree.childNodes.map(node => node.type.toLowerCase()));
        expect(email.textBody).to.deep.equal([]);
        expect(email.htmlBody).to.deep.equal([]);
        expect(email.attachments.map(entry => entry.type)).to.deep.equal(leaves(email.bodyStructure).map(entry => entry.type));
        expect(email.bodyValues).to.deep.equal({});
        expect(JSON.stringify(email)).to.not.include(secret);
    }

    scenario('EGET-114', async () => {
        const { user, client } = await newUser();
        const pgp = mime(
            multipart(
                'encrypted',
                [
                    part(['Content-Type: application/pgp-encrypted'], 'Version: 1'),
                    part(['Content-Type: application/octet-stream; name=encrypted.asc'], '-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----')
                ],
                [' protocol="application/pgp-encrypted"']
            ).replace(/"\r\n protocol/, '";\r\n protocol')
        );
        const { id, uid } = await append(user, pgp);
        const email = await getOne(client, id, { properties: PROPERTIES, fetchAllBodyValues: true });
        const fetched = await imapFetch(user, uid, { bodyStructure: true });
        expectStoredEncrypted({ email, secret: 'no plaintext', imapTree: fetched.bodyStructure });
        expect(email.preview).to.equal('');

        expectStoredEncrypted(await encryptedDelivery());
    });

    scenario('WDX-003', async () => {
        const delivered = await encryptedDelivery();
        expectStoredEncrypted(delivered);
        expect(delivered.email.preview).to.not.include(delivered.secret);
    });
});
