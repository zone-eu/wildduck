/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const Indexer = require('../lib/indexer/indexer');
const imapHandler = require('../lib/handler/imap-handler');
const { cases } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const indexer = new Indexer();
const parse = source => indexer.parseMimeTree(Buffer.from(source, 'binary'));
// the compiler returns a binary string, read it back as the UTF-8 it carries
const wire = structure => Buffer.from(imapHandler.compiler({ attributes: [structure] }).trim(), 'binary').toString();
const bodystructure = source => wire(indexer.getBodyStructure(parse(source)));
const body = source => wire(indexer.getBody(parse(source)));

describe('BODYSTRUCTURE', function () {
    it('describes a text part with its basic fields, line count and extension data', function () {
        let source = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-ID: <id1>\r\nContent-Description: desc\r\nContent-MD5: md5\r\nContent-Disposition: inline; filename=a.txt\r\nContent-Language: en, et\r\nContent-Location: http://x.y/\r\n\r\nhello\r\nworld\r\n';
        expect(bodystructure(source)).to.equal(
            '("TEXT" "PLAIN" ("CHARSET" "utf-8") "<id1>" "desc" "QUOTED-PRINTABLE" 14 2 "md5" ("INLINE" ("FILENAME" "a.txt")) ("en" "et") "http://x.y/")'
        );
        expect(body(source)).to.equal('("TEXT" "PLAIN" ("CHARSET" "utf-8") "<id1>" "desc" "QUOTED-PRINTABLE" 14 2)');
    });

    it('describes a multipart with its parts, subtype and parameters', function () {
        expect(bodystructure(cases['synthetic:nested_blank'].source)).to.equal(
            '((("TEXT" "PLAIN" NIL NIL NIL "7BIT" 5 0 NIL NIL NIL NIL)("TEXT" "HTML" NIL NIL NIL "7BIT" 11 0 NIL NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "i") NIL NIL NIL)("APPLICATION" "PDF" NIL NIL NIL "7BIT" 3 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "o") NIL NIL NIL)'
        );
        // BODY leaves out every extension field, for a multipart that includes the parameter list
        expect(body(cases['synthetic:nested_blank'].source)).to.equal(
            '((("TEXT" "PLAIN" NIL NIL NIL "7BIT" 5 0)("TEXT" "HTML" NIL NIL NIL "7BIT" 11 0) "ALTERNATIVE")("APPLICATION" "PDF" NIL NIL NIL "7BIT" 3) "MIXED")'
        );
    });

    it('counts the size of a part without the line break that belongs to the delimiter', function () {
        // RFC 2046 5.1.1, and what Dovecot reports
        let tree = parse(cases['synthetic:part_trailing_blank'].source);
        expect(tree.childNodes[0].size).to.equal(4);
        expect(tree.childNodes[0].lineCount).to.equal(1);
        expect(bodystructure(cases['synthetic:part_trailing_blank'].source)).to.include('("TEXT" "PLAIN" NIL NIL NIL "7BIT" 4 1 NIL NIL NIL NIL)');
    });

    it('describes a message/rfc822 part with the envelope, structure and line count of the embedded message', function () {
        let expected =
            '(("TEXT" "PLAIN" NIL NIL NIL "7BIT" 2 0 NIL NIL NIL NIL)("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 50 (NIL "inner subj" ((NIL NIL "inner" "x.y")) ((NIL NIL "inner" "x.y")) ((NIL NIL "inner" "x.y")) NIL NIL NIL NIL NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 0 NIL NIL NIL NIL) 3 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "b") NIL NIL NIL)';
        expect(bodystructure(cases['synthetic:attached_rfc822'].source)).to.equal(expected);
    });

    it('treats the type, subtype and encoding of a message/rfc822 part case insensitively', function () {
        // RFC 2045 5.1 and 6.1
        expect(bodystructure(cases['synthetic:attached_rfc822_upper'].source)).to.include(
            '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 50 (NIL "inner subj" ((NIL NIL "inner" "x.y"))'
        );
    });

    it('describes a top-level message/rfc822 message', function () {
        expect(bodystructure(cases['synthetic:root_rfc822'].source)).to.equal(
            '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 134 (NIL "" NIL NIL NIL NIL NIL NIL NIL NIL) (("TEXT" "PLAIN" NIL NIL NIL "7BIT" 2 0 NIL NIL NIL NIL)("TEXT" "HTML" NIL NIL NIL "7BIT" 9 0 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "x") NIL NIL NIL) 11 NIL NIL NIL NIL)'
        );
    });

    it('describes header-less digest parts as message/rfc822', function () {
        expect(bodystructure(cases['synthetic:digest'].source)).to.include('(("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 39 (NIL "inner" ((NIL NIL "inner" "x.y"))');
    });

    it('describes a multipart without any part with a placeholder part', function () {
        // RFC 3501 9: body-type-mpart = 1*body SP media-subtype
        expect(bodystructure(cases['synthetic:boundary_never_appears'].source)).to.equal(
            '(("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 0 0 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "b") NIL NIL NIL)'
        );
        expect(body(cases['synthetic:boundary_never_appears'].source)).to.equal('(("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 0 0) "MIXED")');
    });

    it('describes a multipart without a boundary parameter with the basic fields', function () {
        expect(bodystructure(cases['synthetic:no_boundary_param'].source)).to.equal('("MULTIPART" "MIXED" NIL NIL NIL "7BIT" 6 NIL NIL NIL NIL)');
    });

    it('keeps a quoted parameter value with a semicolon and drops comments', function () {
        let source = 'Content-Type: text/plain; charset="us-ascii" (comment); name="a;b.txt"\r\nContent-Transfer-Encoding: 7bit (comment)\r\n\r\nhi\r\n';
        expect(bodystructure(source)).to.equal('("TEXT" "PLAIN" ("CHARSET" "us-ascii" "NAME" "a;b.txt") NIL NIL "7BIT" 4 1 NIL NIL NIL NIL)');
    });

    it('decodes RFC 2231 parameters', function () {
        let source = "Content-Type: application/octet-stream; name*=UTF-8''r%C3%A9sum%C3%A9.pdf\r\nContent-Disposition: attachment; filename*0*=UTF-8''r%C3%A9; filename*1*=sum%C3%A9.pdf\r\n\r\nhi\r\n";
        expect(bodystructure(source)).to.equal(
            '("APPLICATION" "OCTET-STREAM" ("NAME" "résumé.pdf") NIL NIL "7BIT" 4 NIL ("ATTACHMENT" ("FILENAME" "résumé.pdf")) NIL NIL)'
        );
    });
});
