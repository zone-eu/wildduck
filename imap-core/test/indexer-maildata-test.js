/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

// getMaildata(): the text and html stored for search and preview, and the split of attachment bodies
// out of the tree. The differential suite pins it against the previous implementation; these tests
// state the rules directly.

const chai = require('chai');
const expect = chai.expect;
const Indexer = require('../lib/indexer/indexer');
const MemoryAttachmentStorage = require('./fixtures/memory-attachment-storage');
const { materialize } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const indexer = new Indexer();
const maildata = lines => {
    let tree = indexer.parseMimeTree(Buffer.from(lines.join('\r\n'), 'binary'));
    return { tree, data: indexer.getMaildata(tree) };
};

describe('getMaildata', function () {
    it('keeps a plain text body in the tree and derives html from it', function () {
        let { tree, data } = maildata(['Content-Type: text/plain; charset=utf-8', '', 'Hello', '', 'second <paragraph>', '']);
        expect(data.text).to.equal('Hello\r\n\r\nsecond <paragraph>');
        expect(data.html).to.deep.equal(['<p>Hello</p><p>second &lt;paragraph&gt;</p>']);
        expect(data.attachments).to.deep.equal([]);
        expect(data.nodes).to.deep.equal([]);
        expect(tree.attachmentId).to.be.undefined;
        expect(data.magic).to.be.within(0, 0xffff);
    });

    it('derives text from html outside alternatives and keeps both inside one', function () {
        let single = maildata(['Content-Type: text/html', '', '<p>Hi <b>there</b></p>', '']).data;
        expect(single.html).to.deep.equal(['<p>Hi <b>there</b></p>']);
        expect(single.text).to.equal('Hi there');

        let alternative = maildata([
            'Content-Type: multipart/alternative; boundary=b',
            '',
            '--b',
            'Content-Type: text/plain',
            '',
            'plain version',
            '--b',
            'Content-Type: text/html',
            '',
            '<p>html version</p>',
            '--b--',
            ''
        ]).data;
        expect(alternative.text).to.equal('plain version');
        expect(alternative.html).to.deep.equal(['<p>html version</p>']);
    });

    it('decodes transfer encodings, charsets and format=flowed', function () {
        expect(maildata(['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', 'VMO1aXZ1', '']).data.text).to.equal('Tõivu');
        expect(maildata(['Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'T=F5ivu', '']).data.text).to.equal('Tõivu');
        expect(maildata(['Content-Type: text/plain; format=flowed', '', 'one ', 'line', '']).data.text).to.equal('one line');
        expect(maildata(['Content-Type: text/plain; format=flowed; delsp=yes', '', 'one', 'line', '']).data.text).to.equal('one\nline');
        expect(maildata(['Content-Type: text/plain; format=flowed; delsp=yes', '', 'joi ', 'ned', '']).data.text).to.equal('joined');
    });

    it('moves attachments out of the tree and lists them', function () {
        let { tree, data } = maildata([
            'Content-Type: multipart/related; boundary=b',
            '',
            '--b',
            'Content-Type: text/html',
            '',
            '<img src="cid:img1@x">',
            '--b',
            'Content-Type: image/png; name="pic.png"',
            'Content-Transfer-Encoding: base64',
            'Content-ID: <img1@x>',
            '',
            'iVBORw0KGgo=',
            '--b',
            'Content-Type: application/pdf',
            'Content-Disposition: attachment; filename="=?UTF-8?Q?r=C3=A9sum=C3=A9.pdf?="',
            '',
            'PDF',
            '--b--',
            ''
        ]);
        expect(data.attachments.map(a => [a.id, a.filename, a.contentType, a.disposition, a.cid, a.related, a.transferEncoding])).to.deep.equal([
            ['ATT00001', 'pic.png', 'image/png', false, '<img1@x>', true, 'base64'],
            ['ATT00002', 'résumé.pdf', 'application/pdf', 'attachment', null, true, '7bit']
        ]);
        // links to inline images point at the stored attachment
        expect(data.html).to.deep.equal(['<img src="attachment:ATT00001">']);
        expect(data.nodes.map(node => [node.attachmentId, node.body.toString()])).to.deep.equal([
            ['ATT00001', 'iVBORw0KGgo='],
            ['ATT00002', 'PDF']
        ]);
        expect(tree.childNodes[1].body).to.equal(false);
        expect(tree.childNodes[1].attachmentId).to.equal('ATT00001');
        expect(tree.childNodes[0].attachmentId).to.be.undefined;
    });

    it('gives an attachment without a name a random one with the right extension', function () {
        let { data } = maildata(['Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: application/pdf', '', 'PDF', '--b--', '']);
        expect(data.attachments[0].filename).to.match(/^[0-9a-f]{8}\.pdf$/);
    });

    it('moves inline text above the size limit to the storage without listing it', function () {
        let big = 'x'.repeat(76) + '\r\n';
        let { tree, data } = maildata(['Content-Type: text/plain', '', big.repeat(Math.ceil((300 * 1024) / big.length) + 10)]);
        expect(data.nodes.length).to.equal(1);
        expect(data.attachments).to.deep.equal([]);
        expect(tree.attachmentId).to.equal('ATT00001');
        expect(data.text.length).to.be.above(300 * 1024);
    });

    it('keeps inline text up to the size limit in the tree', function () {
        let limit = 300 * 1024;
        let text = size => maildata(['Content-Type: text/plain', '', 'x'.repeat(size - 2), '']);
        // the body of a single part message ends with the final line break, so size - 2 + 2 bytes
        expect(text(limit).tree.size).to.equal(limit);
        expect(text(limit).data.nodes.length).to.equal(0);
        expect(text(limit + 1).data.nodes.length).to.equal(1);
    });

    it('converts html to text only below the parse limit', function () {
        let limit = 2 * 1024 * 1024;
        // a body of exactly `size` bytes: the html and the final line break the parser completes
        let html = size => {
            let body = ('<p>start</p>' + 'word '.repeat(Math.ceil(size / 5))).slice(0, size - 2);
            let { tree, data } = maildata(['Content-Type: text/html', '', body]);
            expect(tree.size).to.equal(size);
            return data;
        };
        expect(html(limit - 1).text.startsWith('start')).to.be.true;
        expect(html(limit).text).to.equal('');
    });

    it('records the stored size and content hash of each attachment', async function () {
        let storing = new Indexer({ attachmentStorage: new MemoryAttachmentStorage() });
        let tree = storing.parseMimeTree(
            Buffer.from(
                [
                    'Content-Type: multipart/mixed; boundary=b',
                    '',
                    '--b',
                    'Content-Type: application/pdf',
                    '',
                    'P'.repeat(10),
                    '--b',
                    'Content-Type: application/zip',
                    '',
                    'Z'.repeat(30),
                    '--b--',
                    ''
                ].join('\r\n'),
                'binary'
            )
        );
        let data = storing.getMaildata(tree);
        await new Promise((resolve, reject) => storing.storeNodeBodies(data, tree, err => (err ? reject(err) : resolve())));
        expect(data.attachments.map(a => [a.id, a.size, a.fileContentHash])).to.deep.equal([
            ['ATT00001', 10, 'test-content-hash'],
            ['ATT00002', 30, 'test-content-hash']
        ]);
        expect(Object.keys(tree.attachmentMap)).to.deep.equal(['ATT00001', 'ATT00002']);
    });

    it('can store the same maildata for several recipients', async function () {
        // the filter handler extracts once and stores the result for every recipient of a delivery
        let storage = new MemoryAttachmentStorage();
        let storing = new Indexer({ attachmentStorage: storage });
        let source = Buffer.from(['Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: application/pdf', '', 'PDF', '--b--', ''].join('\r\n'), 'binary');
        let tree = storing.parseMimeTree(source);
        let data = storing.getMaildata(tree);
        for (let recipient = 0; recipient < 3; recipient++) {
            let copy = JSON.parse(JSON.stringify(tree), (key, value) => (value && value.type === 'Buffer' ? Buffer.from(value.data) : value));
            await new Promise((resolve, reject) => storing.storeNodeBodies(data, copy, err => (err ? reject(err) : resolve())));
            let { bytes } = await materialize(storing.getContents(copy, false));
            expect(bytes.equals(source), `recipient ${recipient}`).to.be.true;
        }
        expect([...storage.files.values()][0].count).to.equal(3);
    });

    it('indexes the parts of an attached message', function () {
        let { data } = maildata([
            'Content-Type: multipart/mixed; boundary=b',
            '',
            '--b',
            'Content-Type: message/rfc822',
            '',
            'Content-Type: multipart/mixed; boundary=i',
            '',
            '--i',
            'Content-Type: text/plain',
            '',
            'inner text',
            '--i',
            'Content-Type: application/zip',
            '',
            'ZIP',
            '--i--',
            '--b--',
            ''
        ]);
        expect(data.text).to.equal('inner text');
        // the attached message is stored as one body, its attachment as well
        expect(data.attachments.map(a => a.contentType)).to.deep.equal(['message/rfc822', 'application/zip']);
    });
});
