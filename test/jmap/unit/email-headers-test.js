/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const h = require('../../../lib/jmap/email-headers');

describe('JMAP header forms', () => {
    it('parses header property names', () => {
        expect(h.parseHeaderProperty('header:Subject')).to.deep.equal({ field: 'Subject', form: 'asRaw', all: false });
        expect(h.parseHeaderProperty('header:From:asAddresses:all')).to.deep.equal({ field: 'From', form: 'asAddresses', all: true });
        expect(h.parseHeaderProperty('header:X-Foo:asText')).to.deep.equal({ field: 'X-Foo', form: 'asText', all: false });
        expect(h.parseHeaderProperty('header:From:asNonsense')).to.be.null;
        expect(h.parseHeaderProperty('header::asRaw')).to.be.null;
        expect(h.parseHeaderProperty('subject')).to.be.null;
    });

    it('allows forms per field as RFC 8621 4.1.2 lists them', () => {
        expect(h.formAllowed('From', 'asAddresses')).to.be.true;
        expect(h.formAllowed('Subject', 'asAddresses')).to.be.false;
        expect(h.formAllowed('Subject', 'asText')).to.be.true;
        expect(h.formAllowed('From', 'asText')).to.be.false;
        expect(h.formAllowed('Date', 'asDate')).to.be.true;
        expect(h.formAllowed('Message-ID', 'asMessageIds')).to.be.true;
        expect(h.formAllowed('List-Unsubscribe', 'asURLs')).to.be.true;
        expect(h.formAllowed('X-Custom', 'asAddresses')).to.be.true;
        expect(h.formAllowed('Content-Type', 'asText')).to.be.true;
        expect(h.formAllowed('Subject', 'asDate')).to.be.false;
        expect(h.formAllowed('Content-Type', 'asRaw')).to.be.true;
    });

    it('produces the Text form', () => {
        expect(h.asText(' =?UTF-8?Q?t=C3=B6=C3=B6?= world\r\n  folded ')).to.equal('töö world  folded ');
        expect(h.asText(' plain')).to.equal('plain');
    });

    it('decodes RFC 2047 encoded words strictly', () => {
        expect(h.decodeWords('=?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=')).to.equal('ab');
        expect(h.decodeWords('=?ISO-8859-1?Q?a?= b')).to.equal('a b');
        expect(h.decodeWords('=?UTF-8?Q?smile_=F0?=\r\n =?UTF-8?Q?=9F=98=80?=')).to.equal('smile \u{1F600}');
        expect(h.decodeWords('=?x-unknown?Q?abc?= tail')).to.equal('=?x-unknown?Q?abc?= tail');
        expect(h.decodeWords('foo=?UTF-8?Q?bar?=baz')).to.equal('foo=?UTF-8?Q?bar?=baz');
        expect(h.decodeWords('=?UTF-8?Q?a=00b=07c?=')).to.equal('abc');
        expect(h.decodeWords('=?UTF-8?Q?x=FFy?=')).to.equal('x\uFFFDy');
        expect(h.decodeWords('=?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=')).to.equal('こんにちは');
    });

    it('produces Addresses and GroupedAddresses', () => {
        expect(h.asAddresses(' "Jane, Doe" <jane@example.com>, bob@example.com')).to.deep.equal([
            { name: 'Jane, Doe', email: 'jane@example.com' },
            { name: null, email: 'bob@example.com' }
        ]);
        expect(h.asAddresses(' =?UTF-8?B?w6TDtg==?= <a@example.com>')).to.deep.equal([{ name: 'äö', email: 'a@example.com' }]);
        expect(h.asGroupedAddresses(' Team: a@example.com, b@example.com;, c@example.com')).to.deep.equal([
            {
                name: 'Team',
                addresses: [
                    { name: null, email: 'a@example.com' },
                    { name: null, email: 'b@example.com' }
                ]
            },
            { name: null, addresses: [{ name: null, email: 'c@example.com' }] }
        ]);
        expect(h.asAddresses(' Team: a@example.com;')).to.deep.equal([{ name: null, email: 'a@example.com' }]);
    });

    it('produces MessageIds', () => {
        expect(h.asMessageIds(' <a@b>\r\n <c@d>')).to.deep.equal(['a@b', 'c@d']);
        expect(h.asMessageIds(' bare@id.example')).to.deep.equal(['bare@id.example']);
        expect(h.asMessageIds(' not an id')).to.be.null;
    });

    it('produces Date keeping the zone offset', () => {
        expect(h.asDate(' Wed, 11 Nov 2026 15:35:22 +0200')).to.equal('2026-11-11T15:35:22+02:00');
        expect(h.asDate(' 1 Jan 2026 00:00:00 +0000')).to.equal('2026-01-01T00:00:00Z');
        expect(h.asDate(' Mon, 2 Mar 26 10:00 -0530 (comment)')).to.equal('2026-03-02T10:00:00-05:30');
        expect(h.asDate(' Tue, 3 Feb 2026 10:00:00 EST')).to.equal('2026-02-03T10:00:00-05:00');
        expect(h.asDate(' yesterday')).to.be.null;
    });

    it('produces URLs', () => {
        expect(h.asURLs(' <mailto:list@example.com?subject=unsubscribe>, <https://example.com/u>')).to.deep.equal([
            'mailto:list@example.com?subject=unsubscribe',
            'https://example.com/u'
        ]);
        expect(h.asURLs(' none')).to.be.null;
    });

    it('reads header fields from a node and picks the last instance or all of them', () => {
        const node = { header: ['Received: one', 'Received: two', 'Subject: =?UTF-8?Q?s=C3=B5num?=', Buffer.from('X-Utf: töö').toString('binary')] };
        const fields = h.headerFields(node);
        expect(fields.map(field => field.name)).to.deep.equal(['Received', 'Received', 'Subject', 'X-Utf']);
        expect(h.headerValue(fields, h.parseHeaderProperty('header:received'))).to.equal(' two');
        expect(h.headerValue(fields, h.parseHeaderProperty('header:Received:all'))).to.deep.equal([' one', ' two']);
        expect(h.headerValue(fields, h.parseHeaderProperty('header:Subject:asText'))).to.equal('sõnum');
        expect(h.headerValue(fields, h.parseHeaderProperty('header:X-Utf:asText'))).to.equal('töö');
        expect(h.headerValue(fields, h.parseHeaderProperty('header:Missing'))).to.be.null;
        expect(h.headerValue(fields, h.parseHeaderProperty('header:Missing:all'))).to.deep.equal([]);
    });

    it('strips Date comments in one pass, nested and unclosed ones too', () => {
        expect(h.asDate('Tue, 10 Nov 2026 10:00:00 +0200 (EET)')).to.equal('2026-11-10T10:00:00+02:00');
        expect(h.asDate('Tue, (a (nested) comment) 10 Nov 2026 10:00:00 +0200')).to.equal('2026-11-10T10:00:00+02:00');
        expect(h.asDate('Tue, 10 Nov 2026 10:00:00 +0200 (unclosed')).to.equal('2026-11-10T10:00:00+02:00');
        const started = Date.now();
        expect(h.asDate('('.repeat(160000))).to.equal(null);
        // the quadratic versions took seconds to minutes at this size; the bound leaves room for a slow CI runner
        expect(Date.now() - started).to.be.below(2500);
    });
});

describe('JMAP header forms, edge cases', () => {
    it('reads the last instance of a field for every convenience property', () => {
        const fields = h.headerFields({
            header: [
                'Message-ID: <a@x>',
                'Message-ID: <b@x>',
                'In-Reply-To: <a@x>',
                'In-Reply-To: <b@x>',
                'References: <a@x>',
                'References: <b@x>',
                'Sender: a@x',
                'Sender: b@x',
                'From: a@x',
                'From: b@x',
                'To: a@x',
                'To: b@x',
                'Cc: a@x',
                'Cc: b@x',
                'Bcc: a@x',
                'Bcc: b@x',
                'Reply-To: a@x',
                'Reply-To: b@x',
                'Subject: a',
                'Subject: b',
                'Date: Mon, 1 Jan 2024 00:00:00 +0000',
                'Date: Tue, 2 Jan 2024 00:00:00 +0000'
            ]
        });
        const expected = {
            messageId: ['b@x'],
            inReplyTo: ['b@x'],
            references: ['b@x'],
            sender: [{ name: null, email: 'b@x' }],
            from: [{ name: null, email: 'b@x' }],
            to: [{ name: null, email: 'b@x' }],
            cc: [{ name: null, email: 'b@x' }],
            bcc: [{ name: null, email: 'b@x' }],
            replyTo: [{ name: null, email: 'b@x' }],
            subject: 'b',
            sentAt: '2024-01-02T00:00:00Z'
        };
        expect(Object.keys(h.CONVENIENCE).sort()).to.deep.equal(Object.keys(expected).sort());
        for (const [property, value] of Object.entries(expected)) {
            expect(h.headerValue(fields, h.CONVENIENCE[property]), property).to.deep.equal(value);
        }
    });

    it('skips header lines without a field name', () => {
        expect(h.headerFields({ header: [': no name', 'A: b'] })).to.deep.equal([{ name: 'A', value: ' b' }]);
    });

    it('decodes only encoded words that stand alone', () => {
        expect(h.decodeWords('x=?utf-8?Q?a?= y')).to.equal('x=?utf-8?Q?a?= y');
        expect(h.decodeWords('x =?utf-8?Q?a?=y')).to.equal('x =?utf-8?Q?a?=y');
    });

    it('keeps text between encoded words and drops white space between words of other charsets', () => {
        expect(h.decodeWords('=?utf-8?Q?a?= x =?utf-8?Q?b?=')).to.equal('a x b');
        expect(h.decodeWords('=?utf-8?Q?a?= =?iso-8859-1?Q?b?=')).to.equal('ab');
    });

    it('reads two and three digit years like RFC 5322 4.3', () => {
        expect(h.asDate('1 Jan 49 00:00 +0000')).to.equal('2049-01-01T00:00:00Z');
        expect(h.asDate('1 Jan 50 00:00 +0000')).to.equal('1950-01-01T00:00:00Z');
        expect(h.asDate('1 Jan 999 00:00 +0000')).to.equal('2899-01-01T00:00:00Z');
        expect(h.asDate('1 Jan 1000 00:00 +0000')).to.equal('1000-01-01T00:00:00Z');
    });
});
