/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

// FETCH item resolution from stored message documents (imap-tools getQueryResponse)

const chai = require('chai');
const expect = chai.expect;
const imapTools = require('../lib/imap-tools');
const Indexer = require('../lib/indexer/indexer');
const { cases } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const libmime = require('libmime');

const indexer = new Indexer();

describe('getQueryResponse', function () {
    it('casts list values stored for In-Reply-To and Message-ID to strings', function () {
        let message = {
            envelope: ['date', Buffer.from('subject'), null, null, null, null, null, null, ['<a@b>', '<c@d>'], ['<3@4>']]
        };
        let values = imapTools.getQueryResponse([{ item: 'envelope' }], message, { acceptUTF8Enabled: true });
        expect(values[0][8]).to.equal('<c@d>');
        expect(values[0][9]).to.equal('<3@4>');
    });

    it('downgrades a non-ASCII subject and names without UTF8=ACCEPT and sends them raw with it', function () {
        let tree = indexer.parseMimeTree(Buffer.from('Subject: Tõivu\r\nFrom: Jüri <juri@näide.ee>\r\n\r\nbody\r\n', 'utf8'));
        let message = () => ({ envelope: indexer.getEnvelope(tree) });

        let plain = imapTools.getQueryResponse([{ item: 'envelope' }], message(), { acceptUTF8Enabled: false })[0];
        expect(plain[1]).to.equal('=?UTF-8?Q?T=C3=B5ivu?=');
        expect(plain[2][0][0]).to.equal('=?UTF-8?Q?J=C3=BCri?=');
        expect(plain[2][0][3]).to.equal('xn--nide-loa.ee');
        expect(JSON.stringify(plain)).to.match(/^[\u0020-\u007e]+$/);

        let utf8 = imapTools.getQueryResponse([{ item: 'envelope' }], message(), { acceptUTF8Enabled: true })[0];
        expect(utf8[1].toString()).to.equal('Tõivu');
        expect(utf8[2][0][0].toString()).to.equal('Jüri');
        expect(utf8[2][0][3].toString()).to.equal('näide.ee');
    });

    it('encodes non-ASCII strings in BODYSTRUCTURE without UTF8=ACCEPT', function () {
        // RFC 6855 3: the server must not send UTF-8 in quoted strings unless enabled
        let tree = indexer.parseMimeTree(
            Buffer.from('Content-Type: application/octet-stream; name="fail õ.bin"\r\nContent-Description: Kirjeldus õ\r\n\r\nxx\r\n', 'utf8')
        );
        let message = () => ({ bodystructure: indexer.getBodyStructure(tree) });
        let ascii = /^[\u0020-\u007e]+$/;

        let plain = imapTools.getQueryResponse([{ item: 'bodystructure' }], message(), { acceptUTF8Enabled: false })[0];
        expect(plain[2][1]).to.match(ascii);
        expect(libmime.decodeWords(plain[2][1])).to.equal('fail õ.bin');
        expect(plain[4]).to.match(ascii);
        expect(libmime.decodeWords(plain[4])).to.equal('Kirjeldus õ');

        let utf8 = imapTools.getQueryResponse([{ item: 'bodystructure' }], message(), { acceptUTF8Enabled: true })[0];
        expect(utf8[2][1].toString()).to.equal('fail õ.bin');
        expect(utf8[4]).to.equal('Kirjeldus õ');
    });

    it('handles parameter values stored as MongoDB Binary', function () {
        let binary = { buffer: Buffer.from('fail õ.bin') };
        let message = { bodystructure: ['APPLICATION', 'OCTET-STREAM', ['NAME', binary], null, null, '7BIT', 2, null, null, null, null] };
        let plain = imapTools.getQueryResponse([{ item: 'bodystructure' }], message, { acceptUTF8Enabled: false })[0];
        expect(plain[2][1]).to.match(/^[\u0020-\u007e]+$/);
        expect(libmime.decodeWords(plain[2][1])).to.equal('fail õ.bin');
    });

    it('takes RFC822.SIZE from the stored size and computes it from the tree otherwise', function () {
        let raw = cases['synthetic:nested_blank'].source;
        expect(imapTools.getQueryResponse([{ item: 'rfc822.size' }], { size: 4242, raw }, {})[0]).to.equal(4242);
        expect(imapTools.getQueryResponse([{ item: 'rfc822.size' }], { raw }, {})[0]).to.equal(raw.length);
    });
});
