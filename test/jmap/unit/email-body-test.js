/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const Indexer = require('../../../imap-core/lib/indexer/indexer');
const { bodyStructure, parseStructure, pickPart, truncateUtf8 } = require('../../../lib/jmap/email-body');

const indexer = new Indexer();
const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const tree = raw => indexer.parseMimeTree(Buffer.from(raw.replace(/\n/g, '\r\n')));
const ids = parts => parts.map(part => part.partId);

describe('JMAP body structure', () => {
    it('describes a single part message as part 1', () => {
        const root = bodyStructure(tree('Subject: x\nContent-Type: text/plain; charset=UTF-8\n\nhello\n'), ROOT);
        expect(root).to.include({ partId: '1', type: 'text/plain', charset: 'utf-8', subParts: null });
        expect(root.blobId).to.equal(`Bp${ROOT}_1`);
        expect(parseStructure(root)).to.deep.include({ textBody: [root], htmlBody: [root], attachments: [] });
    });

    it('defaults to text/plain and us-ascii', () => {
        const root = bodyStructure(tree('Subject: x\n\nhello\n'), ROOT);
        expect(root).to.include({ type: 'text/plain', charset: 'us-ascii', disposition: null, name: null });
    });

    it('splits multipart/alternative into text and html bodies', () => {
        const raw =
            'Content-Type: multipart/alternative; boundary=b\n\n--b\nContent-Type: text/plain\n\nplain\n--b\nContent-Type: text/html\n\n<p>html</p>\n--b--\n';
        const root = bodyStructure(tree(raw), ROOT);
        expect(root).to.include({ partId: null, blobId: null, type: 'multipart/alternative' });
        expect(ids(root.subParts)).to.deep.equal(['1', '2']);
        const { textBody, htmlBody, attachments } = parseStructure(root);
        expect(ids(textBody)).to.deep.equal(['1']);
        expect(ids(htmlBody)).to.deep.equal(['2']);
        expect(attachments).to.deep.equal([]);
    });

    it('treats inline images of multipart/related and attached files per RFC 8621 4.1.4', () => {
        const raw = [
            'Content-Type: multipart/mixed; boundary=m',
            '',
            '--m',
            'Content-Type: multipart/related; boundary=r',
            '',
            '--r',
            'Content-Type: text/html',
            '',
            '<img src="cid:logo">',
            '--r',
            'Content-Type: image/png',
            'Content-ID: <logo>',
            'Content-Transfer-Encoding: base64',
            '',
            'iVBORw0KGgo=',
            '--r--',
            '--m',
            'Content-Type: application/pdf; name="report.pdf"',
            "Content-Disposition: attachment; filename*=UTF-8''r%C3%A4port.pdf",
            'Content-Transfer-Encoding: base64',
            '',
            'JVBERi0xLjQ=',
            '--m--',
            ''
        ].join('\n');
        const root = bodyStructure(tree(raw), ROOT);
        const { textBody, htmlBody, attachments } = parseStructure(root);
        expect(ids(htmlBody)).to.deep.equal(['1.1']);
        expect(ids(textBody)).to.deep.equal(['1.1']);
        expect(ids(attachments)).to.deep.equal(['1.2', '2']);
        expect(attachments[0]).to.include({ cid: 'logo', type: 'image/png' });
        expect(attachments[1]).to.include({ name: 'räport.pdf', disposition: 'attachment', type: 'application/pdf', size: 8 });
    });

    it('does not descend into message/rfc822 parts', () => {
        const raw =
            'Content-Type: multipart/mixed; boundary=m\n\n--m\nContent-Type: text/plain\n\nsee attached\n--m\nContent-Type: message/rfc822\n\nSubject: inner\n\ninner body\n--m--\n';
        const root = bodyStructure(tree(raw), ROOT);
        expect(root.subParts[1]).to.include({ partId: '2', type: 'message/rfc822', subParts: null });
        expect(ids(parseStructure(root).attachments)).to.deep.equal(['2']);
    });

    it('defaults parts of a digest to message/rfc822', () => {
        const raw = 'Content-Type: multipart/digest; boundary=d\n\n--d\n\nSubject: one\n\nfirst\n--d--\n';
        const root = bodyStructure(tree(raw), ROOT);
        expect(root.subParts[0].type).to.equal('message/rfc822');
    });

    it('picks requested properties, also deep into subParts', () => {
        const raw = 'Content-Type: multipart/alternative; boundary=b\n\n--b\nContent-Type: text/plain\n\nplain\n--b--\n';
        const picked = pickPart(bodyStructure(tree(raw), ROOT), ['type', 'subParts']);
        expect(picked).to.deep.equal({ type: 'multipart/alternative', subParts: [{ type: 'text/plain', subParts: null }] });
    });

    it('truncates on a UTF-8 character boundary', () => {
        expect(truncateUtf8('aäb', 2)).to.equal('a');
        expect(truncateUtf8('aäb', 3)).to.equal('aä');
        expect(truncateUtf8('😀x', 3)).to.equal('');
        expect(truncateUtf8('😀x', 4)).to.equal('😀');
        expect(truncateUtf8('abc', 10)).to.equal('abc');
    });
});
