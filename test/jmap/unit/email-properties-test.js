/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const Indexer = require('../../../imap-core/lib/indexer/indexer');
const { bodyStructure, pickPart } = require('../../../lib/jmap/email-body');
const { resolveProperties, bodyArguments } = require('../../../lib/jmap/email-model');

const indexer = new Indexer();
const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const tree = raw => indexer.parseMimeTree(Buffer.from(raw.replace(/\n/g, '\r\n')));

// multipart/mixed > multipart/alternative > text parts, three levels of subParts
const NESTED =
    'Content-Type: multipart/mixed; boundary=a\n\n--a\nContent-Type: multipart/alternative; boundary=b\n\n' +
    '--b\nContent-Type: text/plain\n\nplain\n--b\nContent-Type: text/html\n\n<p>html</p>\n--b--\n--a--\n';

const copies = (value, count) => new Array(count).fill(value);

describe('JMAP Email property lists (NV-21)', () => {
    it('renders 1000 copies of subParts like one copy, in linear time', () => {
        const root = bodyStructure(tree(NESTED), ROOT);
        const once = pickPart(root, ['partId', 'type', 'subParts']);

        const started = Date.now();
        const body = bodyArguments({ bodyProperties: ['partId', 'type', ...copies('subParts', 1000)] });
        const repeated = pickPart(root, body.bodyProperties);
        expect(Date.now() - started).to.be.below(200);

        expect(repeated).to.deep.equal(once);
        expect(body.bodyProperties).to.deep.equal(['partId', 'type', 'subParts']);
        expect(body.partProperties).to.deep.equal(['partId', 'type', 'subParts']);
    });

    it('deduplicates properties and header properties', () => {
        const resolved = resolveProperties(['subject', ...copies('header:X-Test:asText', 1000), 'subject', 'id']);
        expect(resolved.properties).to.deep.equal(['id', 'subject', 'header:X-Test:asText']);
        expect(resolved.headers).to.have.length(1);
    });

    it('deduplicates properties without the id (Email/parse)', () => {
        const resolved = resolveProperties(['subject', 'subject', 'header:From', 'header:From'], { withId: false });
        expect(resolved.properties).to.deep.equal(['subject', 'header:From']);
        expect(resolved.headers).to.have.length(1);
    });
});
