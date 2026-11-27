/* eslint no-unused-expressions: 0 */
'use strict';

// Pure parts of Email/import and Email/parse: the "is this a message" rule, parsing a blob into a
// message document, and the checks of an EmailImport object that need no lookup.

const { expect } = require('chai');
const Indexer = require('../../../imap-core/lib/indexer/indexer');
const MessageHandler = require('../../../lib/message-handler');
const { looksLikeMessage, parseMessage, headerBlock } = require('../../../lib/jmap/parsed-message');
const { checkImport } = require('../../../lib/jmap/types/email-import');

const messageHandler = { indexer: new Indexer({}), createIntro: MessageHandler.prototype.createIntro };

const errorOf = fn => {
    try {
        fn();
    } catch (err) {
        return err.toSetError();
    }
    throw new Error('did not throw');
};

describe('JMAP parsed messages', () => {
    it('tells messages from other blobs', () => {
        expect(looksLikeMessage(Buffer.from('Subject: x\r\n\r\nbody'))).to.be.true;
        expect(looksLikeMessage(Buffer.from('To: a@b.c\nSubject: lf only\n\nbody\n'))).to.be.true;
        expect(looksLikeMessage(Buffer.from('X-Only-Header: yes'))).to.be.true;
        expect(looksLikeMessage(Buffer.alloc(0))).to.be.false;
        expect(looksLikeMessage(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))).to.be.false;
        expect(looksLikeMessage(Buffer.from('just some text\r\nwithout headers\r\n'))).to.be.false;
        expect(looksLikeMessage(Buffer.from('\r\nbody only'))).to.be.false;
        expect(looksLikeMessage(Buffer.from('From sender@example.com Mon Jan  1 00:00:00 2020\r\nSubject: mbox\r\n\r\n'))).to.be.false;
        expect(looksLikeMessage(Buffer.from('Subject: a \0 nul\r\n\r\nbody'))).to.be.false;
        // a NUL in the body is the body's business
        expect(looksLikeMessage(Buffer.from('Subject: ok\r\n\r\nbody \0 nul'))).to.be.true;
    });

    it('finds the header block', () => {
        expect(headerBlock(Buffer.from('A: 1\r\nB: 2\r\n\r\nbody\n\nmore')).toString()).to.equal('A: 1\r\nB: 2');
        expect(headerBlock(Buffer.from('A: 1\nB: 2\n\nbody')).toString()).to.equal('A: 1\nB: 2');
        expect(headerBlock(Buffer.from('A: 1')).toString()).to.equal('A: 1');
    });

    it('parses a blob into a message document with its summary', () => {
        const raw = Buffer.from(
            [
                'Subject: summary',
                'Content-Type: multipart/mixed; boundary="b"',
                '',
                '--b',
                'Content-Type: text/plain',
                '',
                'Hello there, this is the preview.',
                '--b',
                'Content-Type: application/pdf; name="a.pdf"',
                'Content-Disposition: attachment; filename="a.pdf"',
                'Content-Transfer-Encoding: base64',
                '',
                Buffer.from('%PDF-1.4').toString('base64'),
                '--b--',
                ''
            ].join('\r\n')
        );
        const doc = parseMessage(messageHandler, raw);
        expect(doc.size).to.equal(raw.length);
        expect(doc.ha).to.be.true;
        expect(doc.intro).to.equal('Hello there, this is the preview.');
        // the bodies stay in the tree for body values and part blobs
        expect(doc.mimeTree.childNodes[1].body.toString()).to.equal(Buffer.from('%PDF-1.4').toString('base64'));
        expect(doc.mimeTree.childNodes[1].attachmentId).to.be.undefined;
    });

    it('parses the content of a message/rfc822 part without completing its last line', () => {
        const raw = Buffer.from('Subject: inner\r\n\r\nno line break at the end');
        expect(parseMessage(messageHandler, raw, { embedded: true }).mimeTree.body.toString()).to.equal('no line break at the end');
        expect(parseMessage(messageHandler, raw).mimeTree.body.toString()).to.equal('no line break at the end\r\n');
    });

    it('leaves out the summary when it is not asked for', () => {
        const doc = parseMessage(messageHandler, Buffer.from('Subject: x\r\n\r\nbody'), { summary: false });
        expect(doc).to.have.keys(['mimeTree', 'size']);
    });
});

describe('JMAP EmailImport checks', () => {
    const valid = { blobId: 'Bu0123456789abcdef01234567', mailboxIds: { F0123456789abcdef01234567: true } };

    it('checks an EmailImport object', () => {
        const checked = checkImport(Object.assign({ receivedAt: '2018-03-04T05:06:07Z', keywords: { $seen: true } }, valid));
        expect(checked.receivedAt.toISOString()).to.equal('2018-03-04T05:06:07.000Z');
        expect(checkImport(valid).receivedAt).to.equal(null);
        expect(checkImport(Object.assign({ receivedAt: '2018-03-04T05:06:07.250Z' }, valid)).receivedAt.getTime()).to.equal(Date.UTC(2018, 2, 4, 5, 6, 7, 250));
    });

    it('names the offending property', () => {
        const cases = [
            [{ mailboxIds: valid.mailboxIds }, ['blobId']],
            [Object.assign({ subject: 'x' }, valid), ['subject']],
            [Object.assign({}, valid, { receivedAt: '2018-03-04T05:06:07+01:00' }), ['receivedAt']],
            [Object.assign({}, valid, { receivedAt: '2018-02-30T05:06:07Z' }), ['receivedAt']],
            [Object.assign({}, valid, { receivedAt: 5 }), ['receivedAt']]
        ];
        for (const [object, properties] of cases) {
            expect(
                errorOf(() => checkImport(object)),
                JSON.stringify(object)
            ).to.deep.include({ type: 'invalidProperties', properties });
        }
    });
});
