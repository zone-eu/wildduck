/* eslint no-unused-expressions: 0 */
'use strict';

// Pure parts of RFC 9404 blobs (lib/jmap/types/blob.js), RFC 9425 quota filters
// (lib/jmap/types/quota.js) and the IMAP OBJECTID ids (lib/object-ids.js).

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { Readable } = require('stream');
const { checkSource, literalSize, readSlice, toBlob } = require('../../../lib/jmap/types/blob');
const { filterOf } = require('../../../lib/jmap/types/quota');
const { objectIds, searchCondition } = require('../../../lib/object-ids');
const imapTools = require('../../../imap-core/lib/imap-tools');

const invalid = fn => {
    try {
        fn();
    } catch (err) {
        return err.type;
    }
    return null;
};

describe('Blob/upload data sources', () => {
    it('accepts exactly one kind of source', () => {
        expect(checkSource({ 'data:asText': 'a' }, 0)).to.deep.include({ kind: 'data:asText', value: 'a' });
        expect(checkSource({ 'data:asBase64': 'YQ==' }, 0)).to.deep.include({ kind: 'data:asBase64' });
        expect(checkSource({ blobId: 'Bu1', offset: 2, length: null }, 0)).to.deep.include({ kind: 'blobId', offset: 2, length: null });
        for (const source of [{}, { 'data:asText': 'a', blobId: 'x' }, { 'data:asHex': '61' }, { 'data:asText': 'a', offset: 1 }, { blobId: 1 }, null, []]) {
            expect(
                invalid(() => checkSource(source, 3)),
                JSON.stringify(source)
            ).to.equal('invalidProperties');
        }
    });

    it('rejects negative or fractional ranges', () => {
        expect(invalid(() => checkSource({ blobId: 'x', offset: -1 }, 0))).to.equal('invalidProperties');
        expect(invalid(() => checkSource({ blobId: 'x', length: 1.5 }, 0))).to.equal('invalidProperties');
    });

    it('accepts only padded base64 without line breaks', () => {
        for (const value of ['', 'YQ==', 'YWI=', 'YWJj', 'aGVsbG8=']) {
            expect(
                invalid(() => checkSource({ 'data:asBase64': value }, 0)),
                value
            ).to.equal(null);
        }
        for (const value of ['not*base64!', 'aGVsbG8=YQ==', 'YQ', 'YW\r\nJj', 'Y===']) {
            expect(
                invalid(() => checkSource({ 'data:asBase64': value }, 0)),
                value
            ).to.equal('invalidProperties');
        }
    });

    it('computes the octet size of literals without decoding', () => {
        expect(literalSize({ kind: 'data:asText', value: 'é€😀' })).to.equal(9);
        for (const text of ['', 'a', 'ab', 'abc', 'abcd']) {
            const value = Buffer.from(text).toString('base64');
            expect(literalSize({ kind: 'data:asBase64', value }), text).to.equal(text.length);
        }
    });
});

describe('Blob/get objects', () => {
    const range = (content, extra = {}) => Object.assign({ content: Buffer.from(content), size: content.length, truncated: false }, extra);

    it('answers data as text when the octets are UTF-8, else as base64 with isEncodingProblem', () => {
        expect(toBlob('b', range('hi'), ['data', 'size'])).to.deep.equal({ id: 'b', 'data:asText': 'hi', size: 2 });
        const bad = range(Buffer.from([0x61, 0x81]));
        expect(toBlob('b', bad, ['data'])).to.deep.equal({ id: 'b', 'data:asBase64': 'YYE=', isEncodingProblem: true });
        expect(toBlob('b', bad, ['data:asText'])).to.deep.equal({ id: 'b', 'data:asText': null, isEncodingProblem: true });
        expect(toBlob('b', bad, ['data:asBase64'])).to.deep.equal({ id: 'b', 'data:asBase64': 'YYE=' });
    });

    it('keeps a byte order mark and flags truncation', () => {
        const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
        expect(toBlob('b', range(bom), ['data:asText'])['data:asText']).to.equal('﻿a');
        expect(toBlob('b', range('a', { truncated: true }), ['data:asText'])).to.deep.equal({ id: 'b', 'data:asText': 'a', isTruncated: true });
    });

    it('answers base64 digests of the range', () => {
        const blob = toBlob('b', range('abc'), ['digest:sha', 'digest:sha-256']);
        expect(blob['digest:sha']).to.equal('qZk+NkcGgWq6PiVxeFDCbJzQ2J0=');
        expect(blob['digest:sha-256']).to.equal('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    });
});

describe('Blob range reads', () => {
    const chunked = chunks => Readable.from(chunks.map(chunk => Buffer.from(chunk)));

    it('keeps only the range, discarding the octets before the offset', async () => {
        const res = await readSlice(chunked(['abcd', 'efgh', 'ijkl']), 5, 4, false);
        expect(res.content.toString()).to.equal('fghi');
        expect(res.more).to.be.true;
        expect(res.size).to.equal(null);
    });

    it('reads on to the end for the size without keeping more than asked', async () => {
        const res = await readSlice(chunked(['abcd', 'efgh', 'ijkl']), 2, 3, true);
        expect(res.content.toString()).to.equal('cde');
        expect(res).to.include({ more: true, size: 12 });
        const none = await readSlice(chunked(['abcd', 'efgh']), 0, 0, true);
        expect(none.content.length).to.equal(0);
        expect(none.size).to.equal(8);
    });

    it('answers what there is when the range reaches past the end', async () => {
        const res = await readSlice(chunked(['abcd', 'ef']), 4, 10, false);
        expect(res.content.toString()).to.equal('ef');
        expect(res).to.include({ more: false, size: 6 });
        const past = await readSlice(chunked(['abcd']), 9, 2, false);
        expect(past.content.length).to.equal(0);
        expect(past).to.include({ more: false, size: 4 });
    });

    it('does not hold the octets before the offset in one buffer', async () => {
        // 64 chunks of 64 KiB, the range is the last 10 octets
        const chunk = Buffer.alloc(65536, 0x61);
        const res = await readSlice(Readable.from(Array.from({ length: 64 }, () => chunk)), 64 * 65536 - 10, 10, false);
        expect(res.content.length).to.equal(10);
        expect(res.content.buffer.byteLength).to.be.at.most(65536);
    });
});

describe('Quota/query filters', () => {
    const quota = { name: 'Mail storage', scope: 'account', resourceType: 'octets', types: ['Email'] };

    it('matches every condition exactly and combines them with AND', () => {
        expect(filterOf(null)(quota)).to.be.true;
        expect(filterOf({ scope: 'account', resourceType: 'octets', type: 'Email', name: 'storage' })(quota)).to.be.true;
        expect(filterOf({ scope: 'account', resourceType: 'count' })(quota)).to.be.false;
        expect(filterOf({ operator: 'OR', conditions: [{ scope: 'domain' }, { type: 'Email' }] })(quota)).to.be.true;
        expect(filterOf({ operator: 'NOT', conditions: [{ scope: 'account' }] })(quota)).to.be.false;
    });

    it('rejects unknown properties, values that are not strings and bad operators', () => {
        for (const filter of [{ nosuch: 1 }, { scope: 42 }, { resourceType: ['octets'] }, { operator: 'XOR', conditions: [] }, []]) {
            expect(
                invalid(() => filterOf(filter)),
                JSON.stringify(filter)
            ).to.equal('invalidArguments');
        }
    });
});

describe('IMAP OBJECTID', () => {
    const root = new ObjectId();
    const thread = new ObjectId();

    it('formats the JMAP ids, using _id for a message without a root', () => {
        expect(objectIds.email({ _id: new ObjectId(), root, thread })).to.equal(`M${root}`);
        expect(objectIds.email({ _id: root })).to.equal(`M${root}`);
        expect(objectIds.thread({ thread })).to.equal(`T${thread}`);
        expect(objectIds.thread({})).to.equal(null);
        expect(objectIds.mailbox(root)).to.equal(`F${root}`);
    });

    it('builds search conditions only from ids of the right kind', () => {
        expect(searchCondition('threadid', `T${thread}`)).to.deep.equal({ thread });
        expect(searchCondition('emailid', `M${root}`)).to.deep.equal({ $or: [{ root }, { _id: root, root: { $exists: false } }] });
        expect(searchCondition('emailid', `T${thread}`)).to.equal(null);
        expect(searchCondition('threadid', 'garbage')).to.equal(null);
    });

    it('answers EMAILID and THREADID as lists, or NIL', () => {
        const query = [{ item: 'emailid' }, { item: 'threadid' }];
        expect(imapTools.getQueryResponse(query, { root, thread }, { objectIds })).to.deep.equal([
            [{ type: 'ATOM', value: `M${root}` }],
            [{ type: 'ATOM', value: `T${thread}` }]
        ]);
        expect(imapTools.getQueryResponse(query, { _id: root }, { objectIds })[1]).to.equal(null);
        expect(imapTools.getQueryResponse(query, { root, thread }, {})).to.deep.equal([null, null]);
    });
});
