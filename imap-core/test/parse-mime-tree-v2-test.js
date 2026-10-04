/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

// Structure recorded by the versioned parser (TREE_VERSION 2) that the v1 parser lost: the epilogue of
// a multipart, whether a part has a body section at all, transport padding on delimiters, a multipart
// that never closes, and the canonical final line break.

const chai = require('chai');
const expect = chai.expect;
const parseMimeTree = require('../lib/indexer/parse-mime-tree');
const { cases } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const parse = name => parseMimeTree(cases['synthetic:' + name].source);

describe('MIME tree v2 structure', function () {
    it('marks every parsed root with the tree version', function () {
        let tree = parse('attached_rfc822');
        expect(tree.v).to.equal(parseMimeTree.TREE_VERSION);
        expect(tree.v).to.equal(2);
        // embedded messages are parsed with the same parser and carry it too
        expect(tree.childNodes[1].message.v).to.equal(2);
        // nodes do not
        expect(tree.childNodes[0].v).to.be.undefined;
    });

    it('keeps the epilogue after the close delimiter instead of in the preamble', function () {
        let tree = parse('epilogue');
        expect(tree.body.toString('binary')).to.equal('');
        expect(tree.epilogue.toString('binary')).to.equal('\r\nThis is the epilogue.\r\n');
        expect(tree.unterminated).to.be.undefined;
    });

    it('records a blank line after the close delimiter as an empty epilogue line', function () {
        // the line break that ends the close delimiter line, then the empty line with its own
        let tree = parse('epilogue_blank');
        expect(tree.epilogue.toString('binary')).to.equal('\r\n\r\n');
    });

    it('does not record an epilogue when nothing follows the close delimiter', function () {
        let tree = parse('nested_tight');
        // the inner multipart is closed and immediately followed by the outer delimiter
        expect(tree.childNodes[0].epilogue).to.be.undefined;
        // the outer multipart ends with the final line break
        expect(tree.epilogue.toString('binary')).to.equal('\r\n');
    });

    it('records the blank line between an inner close delimiter and the outer delimiter', function () {
        let tree = parse('nested_blank');
        expect(tree.childNodes[0].epilogue.toString('binary')).to.equal('\r\n');
    });

    it('stores the preamble verbatim, including a lone blank line', function () {
        expect(parse('preamble').body.toString('binary')).to.equal('preamble\r\n');
        expect(parse('preamble_blank_line').body.toString('binary')).to.equal('\r\n');
        expect(parse('nested_blank').body.toString('binary')).to.equal('');
    });

    it('tells a part without a body section from a part with an empty body', function () {
        let blank = parse('empty_part_blank');
        expect(blank.childNodes[0].hasBody).to.be.undefined;
        expect(blank.childNodes[0].size).to.equal(0);

        let noblank = parse('empty_part_noblank');
        expect(noblank.childNodes[0].hasBody).to.equal(false);
        expect(noblank.childNodes[0].size).to.equal(0);

        // the common case is not stored
        expect(blank.childNodes[1].hasBody).to.be.undefined;
        expect(blank.hasBody).to.be.undefined;
    });

    it('tells a header-only message with a separator line from one without', function () {
        expect(parse('header_only').hasBody).to.be.undefined;
        expect(parse('header_only').size).to.equal(0);
        expect(parse('header_only_nosep').hasBody).to.equal(false);
    });

    it('accepts a delimiter directly after the header lines as a bare part', function () {
        let tree = parse('bare_part');
        expect(tree.childNodes.length).to.equal(2);
        expect(tree.childNodes[0].header).to.deep.equal(['Content-Type: text/plain']);
        expect(tree.childNodes[0].hasBody).to.equal(false);
        // the line break that ended its last header line is the one before the delimiter
        expect(tree.childNodes[0].bare).to.equal(true);
        expect(tree.childNodes[1].body.toString('binary')).to.equal('p2');
        expect(tree.childNodes[1].bare).to.be.undefined;

        let empty = parse('empty_bare_part');
        expect(empty.childNodes.length).to.equal(2);
        expect(empty.childNodes[0].header).to.deep.equal([]);
        expect(empty.childNodes[0].hasBody).to.equal(false);
        expect(empty.childNodes[0].bare).to.equal(true);
    });

    it('keeps the line break of a preamble that is followed by the close delimiter', function () {
        let tree = parse('preamble_then_close');
        expect(tree.childNodes).to.be.undefined;
        expect(tree.unterminated).to.be.undefined;
        expect(tree.body.toString('binary')).to.equal('pre\r\n');
    });

    it('treats delimiter lines after the close delimiter as epilogue text', function () {
        let tree = parse('delimiters_in_epilogue');
        expect(tree.childNodes.length).to.equal(1);
        expect(tree.epilogue.toString('binary')).to.equal('\r\n--b\r\nagain\r\n--b--\r\n');
    });

    it('ends an inner multipart whose close delimiter was lost at the enclosing delimiter', function () {
        let tree = parseMimeTree(
            Buffer.from(
                'Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\nContent-Type: multipart/alternative; boundary="i"\r\n\r\n--i\r\nContent-Type: text/plain\r\n\r\ntext\r\n--o\r\nContent-Type: application/pdf\r\n\r\nPDF\r\n--o--\r\n',
                'binary'
            )
        );
        expect(tree.childNodes.length).to.equal(2);
        let inner = tree.childNodes[0];
        expect(inner.unterminated).to.equal(true);
        expect(inner.childNodes.length).to.equal(1);
        expect(inner.childNodes[0].body.toString('binary')).to.equal('text');
        expect(tree.childNodes[1].body.toString('binary')).to.equal('PDF');
        expect(tree.unterminated).to.be.undefined;
    });

    it('treats a bare CR as content', function () {
        let tree = parse('bare_cr');
        expect(tree.body.toString('binary')).to.equal('l1\rstill l1\r\nl2\r\n');
        expect(tree.lineCount).to.equal(2);
    });

    it('accepts transport padding on delimiters and records it', function () {
        let tree = parse('transport_padding');
        expect(tree.childNodes.length).to.equal(1);
        expect(tree.childNodes[0].pad).to.equal('  ');
        expect(tree.closePad).to.equal(' ');
        expect(tree.childNodes[0].body.toString('binary')).to.equal('p1');
        // absent when there is none
        expect(parse('preamble').childNodes[0].pad).to.be.undefined;
        expect(parse('preamble').closePad).to.be.undefined;
    });

    it('does not treat a line that merely starts with the boundary as a delimiter', function () {
        let tree = parseMimeTree(Buffer.from('Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n--bx\r\n--b-x\r\n--b--\r\n', 'binary'));
        expect(tree.childNodes.length).to.equal(1);
        expect(tree.childNodes[0].body.toString('binary')).to.equal('--bx\r\n--b-x');
    });

    it('marks a multipart that never closes', function () {
        let tree = parse('missing_close');
        expect(tree.unterminated).to.equal(true);
        expect(tree.epilogue).to.be.undefined;
        // the last part runs to the end of the message and keeps its final line break
        expect(tree.childNodes[0].body.toString('binary')).to.equal('p1\r\n');
    });

    it('keeps a multipart whose boundary never appears as a plain body', function () {
        let tree = parse('boundary_never_appears');
        expect(tree.unterminated).to.equal(true);
        expect(tree.childNodes).to.be.undefined;
        expect(tree.body.toString('binary')).to.equal('body\r\n');
    });

    it('completes a message that does not end with a line break', function () {
        let tree = parse('text_no_final_crlf');
        expect(tree.body.toString('binary')).to.equal('l1\r\nl2\r\nl3\r\n');
        expect(tree.lineCount).to.equal(3);
    });

    it('parses Message/RFC822 parts whatever the case of the type and encoding', function () {
        let tree = parse('attached_rfc822_upper');
        let part = tree.childNodes[1];
        expect(part.message).to.exist;
        expect(part.message.parsedHeader.subject).to.equal('inner subj');
        // the line break after the embedded body belongs to the delimiter that follows it, so the
        // embedded message is not completed with one (RFC 2046 5.1.1)
        expect(part.message.body.toString('binary')).to.equal('inner body');
        expect(part.message.lineCount).to.equal(0);
    });

    it('keeps an embedded message without a body section as such', function () {
        let tree = parseMimeTree(
            Buffer.from('Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: message/rfc822\r\n\r\nFrom: a@b.c\r\nSubject: s\r\n--b--\r\n', 'binary')
        );
        let message = tree.childNodes[0].message;
        expect(message.hasBody).to.equal(false);
        expect(message.size).to.equal(0);
    });

    it('does not parse a message/rfc822 part with a non identity encoding', function () {
        let tree = parseMimeTree(
            Buffer.from(
                'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: message/rfc822\r\nContent-Transfer-Encoding: base64\r\n\r\nRnJvbTogYUBiLmMNCg0KYm9keQ0K\r\n--b--\r\n',
                'binary'
            )
        );
        expect(tree.childNodes[0].message).to.be.undefined;
    });

    it('defaults header-less digest parts to message/rfc822', function () {
        let tree = parse('digest');
        let part = tree.childNodes[0];
        expect(part.header).to.deep.equal([]);
        expect(part.parsedHeader['content-type'].value).to.equal('message/rfc822');
        expect(part.message).to.exist;
        expect(part.message.parsedHeader.subject).to.equal('inner');

        let mixed = parse('headerless_part');
        expect(mixed.childNodes[0].parsedHeader['content-type'].value).to.equal('text/plain');
    });

    it('parses a top-level message/rfc822 message', function () {
        let tree = parse('root_rfc822');
        expect(tree.message).to.exist;
        expect(tree.message.childNodes.length).to.equal(2);
    });
});
