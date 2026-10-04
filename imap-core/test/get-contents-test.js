/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

// BODY[section] selectors (RFC 3501 6.4.5): HEADER, TEXT, MIME, HEADER.FIELDS, HEADER.FIELDS.NOT and
// part numbers, including the nested numbers of message/rfc822 parts

const chai = require('chai');
const expect = chai.expect;
const Indexer = require('../lib/indexer/indexer');
const { cases, materialize } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const indexer = new Indexer();
const parse = name => indexer.parseMimeTree(cases['synthetic:' + name].source);

async function section(tree, selector) {
    let result = indexer.getContents(tree, selector);
    let { bytes } = await materialize(result);
    return bytes.toString('binary');
}

describe('BODY[section]', function () {
    it('returns the header with its blank line', async function () {
        let tree = indexer.parseMimeTree(Buffer.from('From: a@b.c\r\nSubject: s\r\n\tfolded\r\n\r\nbody\r\n', 'binary'));
        expect(await section(tree, { type: 'header' })).to.equal('From: a@b.c\r\nSubject: s\r\n\tfolded\r\n\r\n');
    });

    it('filters header fields case insensitively and keeps folded lines whole', async function () {
        let tree = indexer.parseMimeTree(Buffer.from('From: a@b.c\r\nSubject: s\r\n\tfolded\r\nTo: t@b.c\r\n\r\nbody\r\n', 'binary'));
        expect(await section(tree, { type: 'header.fields', headers: ['subject'] })).to.equal('Subject: s\r\n\tfolded\r\n\r\n');
        expect(await section(tree, { type: 'header.fields.not', headers: ['subject'] })).to.equal('From: a@b.c\r\nTo: t@b.c\r\n\r\n');
        expect(await section(tree, { type: 'header.fields', headers: [] })).to.equal('\r\n\r\n');
    });

    it('returns the body text without the header', async function () {
        expect(await section(parse('text_final_crlf'), { type: 'text' })).to.equal('l1\r\nl2\r\nl3\r\n');
        expect(await section(parse('nested_blank'), { path: '', type: 'text' })).to.equal(
            cases['synthetic:nested_blank'].expected.toString('binary').split('\r\n\r\n').slice(1).join('\r\n\r\n')
        );
    });

    it('returns parts, their MIME headers and nested parts', async function () {
        let tree = parse('nested_blank');
        expect(await section(tree, { path: '1', type: 'mime' })).to.equal('Content-Type: multipart/alternative; boundary="i"\r\n\r\n');
        expect(await section(tree, { path: '1.1', type: '' })).to.equal('plain');
        expect(await section(tree, { path: '1.2', type: '' })).to.equal('<p>html</p>');
        expect(await section(tree, { path: '2', type: '' })).to.equal('PDF');
        expect(await section(tree, { path: '3', type: '' })).to.equal('');
        expect(await section(tree, { path: '1.3', type: '' })).to.equal('');
    });

    it('addresses the embedded message of a message/rfc822 part', async function () {
        let tree = parse('attached_rfc822');
        expect(await section(tree, { path: '2', type: '' })).to.equal('From: inner@x.y\r\nSubject: inner subj\r\n\r\ninner body');
        expect(await section(tree, { path: '2', type: 'header' })).to.equal('From: inner@x.y\r\nSubject: inner subj\r\n\r\n');
        expect(await section(tree, { path: '2', type: 'text' })).to.equal('inner body');
        expect(await section(tree, { path: '2', type: 'mime' })).to.equal('Content-Type: message/rfc822\r\n\r\n');
    });

    it('filters the header of the embedded message for n.HEADER.FIELDS', async function () {
        let tree = parse('attached_rfc822');
        expect(await section(tree, { path: '2', type: 'header.fields', headers: ['subject'] })).to.equal('Subject: inner subj\r\n\r\n');
        expect(await section(tree, { path: '2', type: 'header.fields.not', headers: ['subject'] })).to.equal('From: inner@x.y\r\n\r\n');
        // a part that is not a message has no RFC 822 header to filter
        expect(await section(tree, { path: '1', type: 'header.fields', headers: ['subject'] })).to.equal('');
    });

    it('numbers the parts of a top-level message/rfc822 message under part 1', async function () {
        let tree = parse('root_rfc822');
        let embedded = 'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\np1\r\n--x\r\nContent-Type: text/html\r\n\r\n<p>p2</p>\r\n--x--\r\n';
        expect(await section(tree, { path: '1', type: '' })).to.equal(embedded);
        expect(await section(tree, { path: '1', type: 'header' })).to.equal('Content-Type: multipart/mixed; boundary="x"\r\n\r\n');
        expect(await section(tree, { path: '1', type: 'text' })).to.equal(embedded.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
        expect(await section(tree, { path: '1.1', type: '' })).to.equal('p1');
        expect(await section(tree, { path: '1.2', type: '' })).to.equal('<p>p2</p>');
        expect(await section(tree, { path: '2', type: '' })).to.equal('');
        expect(await section(tree, { path: '1.3', type: '' })).to.equal('');
    });

    it('numbers the placeholder part of a multipart without parts like BODYSTRUCTURE does', async function () {
        // BODYSTRUCTURE announces an empty text/plain part 1, so BODY[1] is empty and not the preamble
        let tree = parse('boundary_never_appears');
        expect(await section(tree, { path: '1', type: '' })).to.equal('');
        expect(await section(tree, { path: '1', type: 'mime' })).to.equal('Content-Type: text/plain; charset=us-ascii\r\n\r\n');
        expect(await section(tree, { path: '2', type: '' })).to.equal('');
    });

    it('treats part 1 of a non-multipart message as the message body', async function () {
        let tree = parse('text_final_crlf');
        expect(await section(tree, { path: '1', type: '' })).to.equal('l1\r\nl2\r\nl3\r\n');
        expect(await section(tree, { path: '2', type: '' })).to.equal('');
        expect(await section(tree, { path: '1.1', type: '' })).to.equal('');
    });
});
