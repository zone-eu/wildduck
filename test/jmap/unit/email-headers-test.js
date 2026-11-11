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
        expect(h.asText(' =?UTF-8?Q?t=C3=B6=C3=B6?= world\r\n  folded ')).to.equal('töö world  folded');
        expect(h.asText(' plain')).to.equal('plain');
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
});
