/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const createEnvelope = require('../lib/indexer/create-envelope');
const parseMimeTree = require('../lib/indexer/parse-mime-tree');

chai.config.includeStack = true;

// header lines are UTF-8 on the wire (RFC 6532)
const envelopeOf = headers => createEnvelope(parseMimeTree(Buffer.from(headers.join('\r\n') + '\r\n\r\nbody\r\n', 'utf8')).parsedHeader);
const addr = (name, user, domain) => [name ? Buffer.from(name) : null, null, user ? Buffer.from(user) : null, domain ? Buffer.from(domain) : null];

describe('ENVELOPE', function () {
    it('lists the fields in RFC 3501 7.4.2 order', function () {
        let envelope = envelopeOf([
            'Date: Thu, 15 May 2014 13:53:30 +0000',
            'Subject: hello',
            'From: Andris <andris@kreata.ee>',
            'Sender: sender@kreata.ee',
            'Reply-To: reply@kreata.ee',
            'To: to@example.com',
            'Cc: cc@example.com',
            'Bcc: bcc@example.com',
            'In-Reply-To: <parent@example.com>',
            'Message-ID: <msg@example.com>'
        ]);
        expect(envelope).to.deep.equal([
            'Thu, 15 May 2014 13:53:30 +0000',
            Buffer.from('hello'),
            [addr('Andris', 'andris', 'kreata.ee')],
            [addr(null, 'sender', 'kreata.ee')],
            [addr(null, 'reply', 'kreata.ee')],
            [addr(null, 'to', 'example.com')],
            [addr(null, 'cc', 'example.com')],
            [addr(null, 'bcc', 'example.com')],
            '<parent@example.com>',
            '<msg@example.com>'
        ]);
    });

    it('keeps a raw UTF-8 subject intact', function () {
        // RFC 6532 3.1: unstructured header fields may hold UTF-8 as is
        expect(envelopeOf(['Subject: Tõivu'])[1].toString()).to.equal('Tõivu');
        expect(envelopeOf(['Subject: 中文主题'])[1].toString()).to.equal('中文主题');
    });

    it('decodes an encoded-word subject', function () {
        expect(envelopeOf(['Subject: =?UTF-8?Q?T=C3=B5ivu?='])[1].toString()).to.equal('Tõivu');
    });

    it('returns the last of several Date headers as a string', function () {
        let envelope = envelopeOf(['Date: Thu, 15 May 2014 13:53:30 +0000', 'Date: Fri, 16 May 2014 13:53:30 +0000']);
        expect(envelope[0]).to.equal('Fri, 16 May 2014 13:53:30 +0000');

        // trees stored before the parser reduced the value hold a list
        expect(createEnvelope({ date: ['Thu, 15 May 2014 13:53:30 +0000', 'Fri, 16 May 2014 13:53:30 +0000'] })[0]).to.equal('Fri, 16 May 2014 13:53:30 +0000');
    });

    it('defaults Sender and Reply-To to From and uses NIL for absent lists', function () {
        let envelope = envelopeOf(['From: a@b.c']);
        expect(envelope[2]).to.deep.equal([addr(null, 'a', 'b.c')]);
        expect(envelope[3]).to.deep.equal([addr(null, 'a', 'b.c')]);
        expect(envelope[4]).to.deep.equal([addr(null, 'a', 'b.c')]);
        expect(envelope[5]).to.be.null;
        expect(envelope[6]).to.be.null;
        expect(envelope[7]).to.be.null;
        expect(envelope[8]).to.be.null;
        expect(envelope[9]).to.be.null;

        let noFrom = envelopeOf(['To: a@b.c']);
        expect(noFrom[2]).to.be.null;
        expect(noFrom[3]).to.be.null;
        expect(noFrom[4]).to.be.null;
    });

    it('encodes group syntax with start and end markers', function () {
        let envelope = envelopeOf(['To: Friends: a@b.c, Dee <d@e.f>;, x@y.z']);
        expect(envelope[5]).to.deep.equal([[null, null, Buffer.from('Friends'), null], addr(null, 'a', 'b.c'), addr('Dee', 'd', 'e.f'), [null, null, null, null], addr(null, 'x', 'y.z')]);
    });

    it('never emits a NIL host for an address without a domain', function () {
        // RFC 3501 7.4.2: a NIL host marks a group, so a bare local token gets a placeholder host
        let envelope = envelopeOf(['To: localuser']);
        expect(envelope[5]).to.deep.equal([[null, null, Buffer.from('localuser'), Buffer.from('MISSING_DOMAIN')]]);
    });

    it('returns IDN hosts as unicode and leaves the response encoder to downgrade', function () {
        let envelope = envelopeOf(['From: a@xn--mnchen-3ya.de']);
        expect(envelope[2]).to.deep.equal([addr(null, 'a', 'münchen.de')]);
    });
});
