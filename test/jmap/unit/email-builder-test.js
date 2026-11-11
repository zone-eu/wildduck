/* eslint no-unused-expressions: 0, no-control-regex: 0 */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const Indexer = require('../../../imap-core/lib/indexer/indexer');
const { planEmail, buildEmail, encodeDate } = require('../../../lib/jmap/email-builder');
const { headerFields, headerValue, parseHeaderProperty } = require('../../../lib/jmap/email-headers');
const { bodyStructure, parseStructure } = require('../../../lib/jmap/email-body');

const indexer = new Indexer();
const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';

async function build(input, blobs) {
    const plan = planEmail(input);
    const raw = await buildEmail(plan, { blobs: new Map(Object.entries(blobs || {})), date: new Date('2026-01-02T03:04:05Z'), hostname: 'example.org' });
    const tree = indexer.parseMimeTree(raw);
    const fields = headerFields(tree);
    return { raw, text: raw.toString(), tree, get: property => headerValue(fields, parseHeaderProperty(property)), structure: bodyStructure(tree, ROOT) };
}

function rejects(input, properties) {
    try {
        planEmail(input);
    } catch (err) {
        expect(err.type).to.equal('invalidProperties');
        if (properties) {
            expect(err.toSetError().properties).to.deep.equal(properties);
        }
        return;
    }
    throw new Error(`expected invalidProperties for ${JSON.stringify(input).slice(0, 200)}`);
}

const headerSection = text => text.slice(0, text.indexOf('\r\n\r\n'));

describe('JMAP email builder', () => {
    it('builds an empty message with the generated headers', async () => {
        const { text, structure } = await build({ mailboxIds: { F: true } });
        const header = headerSection(text);
        expect(header).to.match(/^Date: Fri, 02 Jan 2026 03:04:05 \+0000$/m);
        expect(header).to.match(/^Message-ID: <[0-9a-f-]+@example\.org>$/m);
        expect(header.match(/^MIME-Version: 1\.0$/gm)).to.have.length(1);
        expect(header).to.not.match(/X-Mailer|User-Agent/i);
        expect(structure.type).to.equal('text/plain');
    });

    it('round trips the convenience properties', async () => {
        const input = {
            from: [{ name: 'Jõgi Ämber', email: 'a@example.com' }],
            sender: [{ name: null, email: 's@example.com' }],
            replyTo: [{ name: 'Reply, "Quoted"', email: 'r@example.com' }],
            to: [
                { name: 'To One', email: 't1@example.com' },
                { name: null, email: 't2@example.com' }
            ],
            cc: [{ name: 'Cc', email: 'c@example.com' }],
            bcc: [{ name: 'Bcc', email: 'b@example.com' }],
            subject: 'Tere, ümber maailma',
            sentAt: '2019-05-02T03:15:00+07:00',
            messageId: ['id1@example.com'],
            inReplyTo: ['parent@example.com'],
            references: ['root@example.com', 'parent@example.com']
        };
        const { get, text } = await build(input);
        expect(get('header:From:asAddresses')).to.deep.equal(input.from);
        expect(get('header:Sender:asAddresses')).to.deep.equal(input.sender);
        expect(get('header:Reply-To:asAddresses')).to.deep.equal(input.replyTo);
        expect(get('header:To:asAddresses')).to.deep.equal(input.to);
        expect(get('header:Cc:asAddresses')).to.deep.equal(input.cc);
        expect(get('header:Bcc:asAddresses')).to.deep.equal(input.bcc);
        expect(get('header:Subject:asText')).to.equal(input.subject);
        expect(get('header:Date:asDate')).to.equal(input.sentAt);
        expect(get('header:Date')).to.equal(' Thu, 02 May 2019 03:15:00 +0700');
        expect(get('header:Message-ID:asMessageIds')).to.deep.equal(input.messageId);
        expect(get('header:References:asMessageIds')).to.deep.equal(input.references);
        expect(headerSection(text)).to.match(/^[\x00-\x7f]*$/);
        expect(headerSection(text).match(/^Message-ID:/gim)).to.have.length(1);
    });

    it('writes raw values verbatim and keeps folding', async () => {
        const { get, text } = await build({ 'header:X-Custom': ' some value', 'header:X-Folded': ' a\r\n b', 'header:X-Tab': ' a\tb' });
        expect(text).to.match(/^X-Custom: some value$/m);
        expect(get('header:X-Custom')).to.equal(' some value');
        expect(get('header:X-Folded')).to.equal(' a\r\n b');
        expect(get('header:X-Tab')).to.equal(' a\tb');
    });

    it('creates one field per :all value in order', async () => {
        const { get } = await build({ 'header:X-Tag:all': [' cat', ' dog', ' mouse'] });
        expect(get('header:X-Tag:all')).to.deep.equal([' cat', ' dog', ' mouse']);
        rejects({ 'header:X-Tag': [' cat', ' dog'] }, ['header:X-Tag']);
    });

    it('builds grouped addresses, message ids, dates and URLs', async () => {
        const groups = [
            {
                name: 'Team',
                addresses: [
                    { name: 'A', email: 'a@example.com' },
                    { name: null, email: 'b@example.com' }
                ]
            },
            { name: null, addresses: [{ name: 'C', email: 'c@example.com' }] }
        ];
        const { get, text } = await build({
            'header:Cc:asGroupedAddresses': groups,
            'header:X-Ref:asMessageIds': ['a@b'],
            'header:Resent-Date:asDate': '2020-02-03T04:05:06Z',
            'header:List-Unsubscribe:asURLs': ['mailto:u@example.com', 'https://example.com/u']
        });
        expect(get('header:Cc:asGroupedAddresses')).to.deep.equal(groups);
        expect(text).to.include('X-Ref: <a@b>\r\n');
        expect(text).to.include('List-Unsubscribe: <mailto:u@example.com>, <https://example.com/u>');
        expect(get('header:Resent-Date:asDate')).to.equal('2020-02-03T04:05:06Z');
    });

    it('encodes line breaks in text and names inside the field', async () => {
        const { get, text } = await build({ subject: 'Hi\r\nBcc: evil@example.com', to: [{ name: 'A\r\nBcc: evil@example.com', email: 'a@example.com' }] });
        expect(headerSection(text)).to.not.match(/^Bcc:/im);
        expect(get('header:Subject:asText')).to.equal('Hi\r\nBcc: evil@example.com');
    });

    it('folds long values under the line limit', async () => {
        const subject = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
        const to = Array.from({ length: 60 }, (_, i) => ({ name: `Name ${i}`, email: `user${i}@example.com` }));
        const references = Array.from({ length: 50 }, (_, i) => `ref${i}@example.com`);
        const { get, text } = await build({ subject, to, references, 'header:X-Long': ' ' + 'x'.repeat(900) });
        expect(
            headerSection(text)
                .split('\r\n')
                .every(line => line.length <= 998)
        ).to.be.true;
        expect(get('header:Subject:asText')).to.equal(subject);
        expect(get('header:To:asAddresses')).to.deep.equal(to);
        expect(get('header:References:asMessageIds')).to.deep.equal(references);
        rejects({ 'header:X-Long': ' ' + 'x'.repeat(2000) }, ['header:X-Long']);
    });

    describe('rejects', () => {
        it('a multipart part without sub parts', () => {
            rejects({ bodyStructure: { type: 'multipart/mixed', subParts: [] } }, ['bodyStructure']);
        });

        it('a leaf part without content', () => {
            rejects({ textBody: [{ type: 'text/plain' }] }, ['textBody']);
            rejects({ bodyStructure: { type: 'text/plain' } }, ['bodyStructure']);
        });

        const cases = [
            ['the headers property', { headers: [{ name: 'X', value: ' y' }] }, ['headers']],
            ['server set properties', { id: 'x', size: 5 }, ['id', 'size']],
            ['a forbidden form', { 'header:Subject:asAddresses': [] }, ['header:Subject:asAddresses']],
            ['a forbidden form for From', { 'header:From:asText': 'x' }, ['header:From:asText']],
            ['a wrong JSON type', { 'header:X-Foo': 5 }, ['header:X-Foo']],
            ['a bad date', { 'header:X-Foo:asDate': 'not a date' }, ['header:X-Foo:asDate']],
            ['an unknown form', { 'header:X-Foo:asBogus': 'x' }, ['header:X-Foo:asBogus']],
            ['a name with a space', { 'header:X Foo': ' x' }, ['header:X Foo']],
            ['an empty name', { 'header:': ' x' }, ['header:']],
            ['a non ASCII name', { 'header:X-Foö': ' x' }, ['header:X-Foö']],
            ['a name with CRLF', { 'header:X-A\r\nBcc: evil@example.com': ' x' }, ['header:X-A\r\nBcc: evil@example.com']],
            ['a bare LF', { 'header:X-Test': ' a\nb' }, ['header:X-Test']],
            ['a bare CR', { 'header:X-Test': ' a\rb' }, ['header:X-Test']],
            ['an unfolded CRLF', { 'header:X-Test': ' a\r\nb' }, ['header:X-Test']],
            ['an injected field', { 'header:X-Test': ' a\r\nBcc: evil@example.com' }, ['header:X-Test']],
            ['an injected body', { 'header:X-Test': ' a\r\n\r\ninjected' }, ['header:X-Test']],
            ['a form feed', { 'header:X-Test': ' a\fb' }, ['header:X-Test']],
            ['a NUL', { 'header:X-Test': ' a\x00b' }, ['header:X-Test']],
            ['a NUL in the subject', { subject: 'a\x00b' }, ['subject']],
            ['an address with CRLF', { to: [{ email: 'a@example.com\r\nBcc: evil@example.com' }] }, ['to']],
            ['a top level Content-Type', { 'header:Content-Type': ' text/plain' }, ['header:Content-Type']],
            ['a top level content-transfer-encoding', { 'header:content-transfer-encoding': ' base64' }, ['header:content-transfer-encoding']],
            ['from twice', { from: [], 'header:From': ' a@b' }, ['from', 'header:From']],
            ['subject twice', { subject: 'a', 'header:SUBJECT:asText': 'b' }, ['subject', 'header:SUBJECT:asText']],
            ['a header twice in two forms', { 'header:X-Foo': ' a', 'header:x-foo:asText': 'b' }, ['header:X-Foo', 'header:x-foo:asText']],
            [
                'bodyStructure with textBody',
                { bodyStructure: { type: 'text/plain', partId: 't' }, textBody: [{ partId: 't' }], bodyValues: { t: { value: 'x' } } }
            ],
            ['two text parts', { textBody: [{ partId: 'a' }, { partId: 'b' }], bodyValues: { a: { value: 'x' }, b: { value: 'y' } } }, ['textBody']],
            ['an empty textBody', { textBody: [] }, ['textBody']],
            ['html in textBody', { textBody: [{ partId: 'a', type: 'text/html' }], bodyValues: { a: { value: 'x' } } }, ['textBody']],
            ['text in htmlBody', { htmlBody: [{ partId: 'a', type: 'text/plain' }], bodyValues: { a: { value: 'x' } } }, ['htmlBody']],
            ['a missing body value', { textBody: [{ partId: 'a' }], bodyValues: { b: { value: 'x' } } }, ['textBody']],
            ['no body values', { textBody: [{ partId: 'a' }] }, ['textBody']],
            ['a truncated body value', { textBody: [{ partId: 'a' }], bodyValues: { a: { value: 'x', isTruncated: true } } }, ['bodyValues']],
            ['a body value string', { bodyValues: { a: 'text' } }, ['bodyValues']],
            ['body values as a list', { bodyValues: [] }, ['bodyValues']],
            ['headers on a part', { bodyStructure: { type: 'text/plain', partId: 't', headers: [] }, bodyValues: { t: { value: 'x' } } }, ['bodyStructure']],
            [
                'Content-Transfer-Encoding on a part',
                { textBody: [{ partId: 't', 'header:Content-Transfer-Encoding': ' base64' }], bodyValues: { t: { value: 'x' } } },
                ['textBody']
            ],
            ['type twice on a part', { attachments: [{ blobId: 'B', type: 'text/plain', 'header:Content-Type': ' text/plain' }] }, ['attachments']],
            ['a cid with brackets', { attachments: [{ blobId: 'B', cid: '<a@b>' }] }, ['attachments']],
            ['a type with CRLF', { attachments: [{ blobId: 'B', type: 'text/plain\r\nX-Evil: 1' }] }, ['attachments']],
            ['a name with CRLF', { attachments: [{ blobId: 'B', name: 'a.txt\r\nContent-Type: text/html' }] }, ['attachments']],
            [
                'a header on the Email and the bodyStructure',
                { subject: 'a', bodyStructure: { type: 'text/plain', partId: 't', 'header:Subject': ' b' }, bodyValues: { t: { value: 'x' } } },
                ['bodyStructure']
            ]
        ];
        for (const [title, input, properties] of cases) {
            it(title, () => rejects(input, properties));
        }

        it('a deeply nested bodyStructure', () => {
            let part = { type: 'text/plain', partId: 't' };
            for (let i = 0; i < 200; i++) {
                part = { type: 'multipart/mixed', subParts: [part] };
            }
            rejects({ bodyStructure: part, bodyValues: { t: { value: 'x' } } }, ['bodyStructure']);
        });
    });

    it('builds text and html as multipart/alternative', async () => {
        const { structure } = await build({
            textBody: [{ partId: 't' }],
            htmlBody: [{ partId: 'h' }],
            bodyValues: { t: { value: 'plain' }, h: { value: '<p>html</p>' } }
        });
        expect(structure.type).to.equal('multipart/alternative');
        expect(structure.subParts.map(part => part.type)).to.deep.equal(['text/plain', 'text/html']);
    });

    it('builds an html only message without a wrapper', async () => {
        const { structure } = await build({ htmlBody: [{ partId: 'h' }], bodyValues: { h: { value: '<p>Hi</p>' } } });
        expect(structure).to.include({ type: 'text/html' });
        expect(structure.subParts).to.equal(null);
    });

    it('puts inline parts next to the html and attachments in multipart/mixed', async () => {
        const png = crypto.randomBytes(300);
        const doc = crypto.randomBytes(500);
        const { structure, text } = await build(
            {
                textBody: [{ partId: 't' }],
                htmlBody: [{ partId: 'h' }],
                bodyValues: { t: { value: 'plain' }, h: { value: '<img src="cid:c1">' } },
                attachments: [
                    { blobId: 'IMG', type: 'image/png', cid: 'c1', disposition: 'inline' },
                    { blobId: 'DOC', name: 'Žürich, "Bericht"; 2026.pdf', type: 'application/pdf', disposition: 'attachment' }
                ]
            },
            { IMG: { content: png }, DOC: { content: doc } }
        );
        expect(structure.type).to.equal('multipart/mixed');
        const [alternative, attached] = structure.subParts;
        expect(alternative.type).to.equal('multipart/alternative');
        expect(alternative.subParts[1].type).to.equal('multipart/related');
        expect(alternative.subParts[1].subParts.map(part => part.type)).to.deep.equal(['text/html', 'image/png']);
        expect(alternative.subParts[1].subParts[1]).to.include({ cid: 'c1', disposition: 'inline' });
        expect(attached).to.include({ type: 'application/pdf', name: 'Žürich, "Bericht"; 2026.pdf', disposition: 'attachment' });
        expect(text).to.include('Content-ID: <c1>');
        const parsed = parseStructure(structure);
        expect(parsed.attachments.map(part => part.type)).to.deep.equal(['image/png', 'application/pdf']);
        expect(text.split('\r\n').every(line => line.length <= 998)).to.be.true;
    });

    it('keeps a bodyStructure as given and moves its top headers to the message', async () => {
        const { structure, text, get } = await build(
            {
                bodyStructure: {
                    type: 'multipart/mixed',
                    'header:X-Top': ' yes',
                    subParts: [
                        { type: 'text/plain', partId: 't' },
                        { type: 'application/octet-stream', blobId: 'B', 'header:X-Part-Info': ' abc', 'header:Content-Description:asText': 'desc' }
                    ]
                },
                bodyValues: { t: { value: 'body' } }
            },
            { B: { content: Buffer.from([0, 1, 2, 255]) } }
        );
        expect(structure.subParts.map(part => part.type)).to.deep.equal(['text/plain', 'application/octet-stream']);
        expect(get('header:X-Top')).to.equal(' yes');
        expect(text.match(/X-Top/g)).to.have.length(1);
        expect(text).to.include('X-Part-Info: abc');
        expect(text).to.include('Content-Description: desc');
    });

    it('moves the headers of a single textBody or htmlBody part to the message', async () => {
        for (const property of ['textBody', 'htmlBody']) {
            const { text, get } = await build({
                [property]: [{ partId: 'p', 'header:from': ' Foo <foo@example.org>', 'header:X-Part': ' yes' }],
                bodyValues: { p: { value: 'body' } }
            });
            expect(get('header:From:asAddresses'), property).to.deep.equal([{ name: 'Foo', email: 'foo@example.org' }]);
            expect(get('header:X-Part'), property).to.equal(' yes');
            expect(text.match(/^X-Part:/gm), property).to.have.length(1);
        }
        rejects({ subject: 'a', textBody: [{ partId: 'p', 'header:Subject': ' b' }], bodyValues: { p: { value: 'x' } } }, ['textBody']);
    });

    it('gives a part written from a body value a charset only when it is text', async () => {
        const { structure } = await build({
            textBody: [{ partId: 't' }],
            attachments: [{ partId: 'j', type: 'application/json', disposition: 'attachment', name: 'a.json' }],
            bodyValues: { t: { value: 'text' }, j: { value: '{"a":1}' } }
        });
        expect(structure.subParts.map(part => [part.type, part.charset])).to.deep.equal([
            ['text/plain', 'utf-8'],
            ['application/json', null]
        ]);
    });

    it('defaults the type of an attachment to its blob type or application/octet-stream', async () => {
        const { structure } = await build(
            { attachments: [{ blobId: 'A', name: 'x.png' }, { blobId: 'B' }] },
            { A: { content: Buffer.from('a'), type: 'image/png' }, B: { content: Buffer.from('b') } }
        );
        expect(structure.subParts.map(part => part.type)).to.deep.equal(['image/png', 'application/octet-stream']);
    });

    it('gives the parts of a multipart/digest the type message/rfc822', async () => {
        const message = Buffer.from('Subject: inner\r\n\r\nbody\r\n');
        const { structure } = await build(
            { bodyStructure: { type: 'multipart/digest', subParts: [{ blobId: 'B1' }] } },
            { B1: { content: message, type: null } }
        );
        expect(structure.subParts.map(part => part.type)).to.deep.equal(['message/rfc822']);
    });

    it('writes an attached message with an identity transfer encoding', async () => {
        const attach = async content => {
            const { text } = await build({ attachments: [{ blobId: 'B1', type: 'message/rfc822' }] }, { B1: { content, type: null } });
            return /Content-Type: message\/rfc822[^]*?Content-Transfer-Encoding: (\S+)/i.exec(text)[1];
        };
        expect(await attach(Buffer.from('Subject: a\r\n\r\nascii\r\n'))).to.equal('7bit');
        expect(await attach(Buffer.from('Subject: a\r\n\r\nK\u00f5ik\r\n', 'utf8'))).to.equal('8bit');
        expect(await attach(Buffer.from('Subject: a\r\n\r\nbare\nline\r\n'))).to.equal('binary');
        expect(await attach(Buffer.from('Subject: a\r\n\r\nbare\rcr\r\n'))).to.equal('binary');
        expect(await attach(Buffer.from('Subject: a\r\n\r\nnul\0\r\n'))).to.equal('binary');
        expect(await attach(Buffer.from('Subject: a\r\n\r\nends with cr\r'))).to.equal('binary');
        // a line of 998 octets is the longest allowed one, also as the last line without a line break
        expect(await attach(Buffer.from(`Subject: a\r\n\r\n${'x'.repeat(998)}\r\n${'y'.repeat(998)}`))).to.equal('7bit');
        expect(await attach(Buffer.from(`Subject: a\r\n\r\n${'x'.repeat(999)}\r\n`))).to.equal('binary');
    });

    it('keeps a name without a disposition in the Content-Type only', async () => {
        const { text, structure } = await build(
            { attachments: [{ blobId: 'B1', type: 'application/pdf', name: 'r\u00e9sum\u00e9.pdf' }] },
            {
                B1: { content: Buffer.from('%PDF'), type: null }
            }
        );
        expect(text).to.not.match(/Content-Disposition/i);
        expect(structure.subParts[0]).to.include({ name: 'r\u00e9sum\u00e9.pdf', disposition: null });
    });

    it('writes an address that is not one as typed', async () => {
        const { get } = await build({ to: [{ email: 'not an address' }] });
        expect(get('header:To:asAddresses')).to.deep.equal([{ name: 'not an address', email: '' }]);
        rejects({ to: [{ email: 'a, b <c@d>' }] }, ['to']);
    });

    it('formats dates with their offset', () => {
        expect(encodeDate('2019-05-02T03:15:00+07:00')).to.equal('Thu, 02 May 2019 03:15:00 +0700');
        expect(encodeDate('2020-02-29T23:59:59.123Z')).to.equal('Sat, 29 Feb 2020 23:59:59 +0000');
        expect(encodeDate('2019-02-29T00:00:00Z')).to.equal(null);
        expect(encodeDate('2019-05-02 03:15:00')).to.equal(null);
    });

    it('round trips random text and address values', async () => {
        const alphabet = Array.from('abcXYZ 0123,;:"\\<>()@.ÄöüŽ漢字😀-_');
        const random = length => Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
        for (let round = 0; round < 100; round++) {
            const subject = random(crypto.randomInt(1, 120)).trim() || 'x';
            const name = random(crypto.randomInt(1, 40)).trim() || null;
            const { get } = await build({ subject, from: [{ name, email: 'a@example.com' }] });
            expect(get('header:Subject:asText'), JSON.stringify(subject)).to.equal(subject.normalize('NFC'));
            expect(get('header:From:asAddresses'), JSON.stringify(name)).to.deep.equal([{ name: name && name.normalize('NFC'), email: 'a@example.com' }]);
        }
    });
});
