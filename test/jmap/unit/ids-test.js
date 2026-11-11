/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { formatId, parseId, blobId, parseBlobId, isValidId, PREFIX } = require('../../../lib/jmap/ids');

describe('JMAP ids', () => {
    const oid = new ObjectId();

    it('round trips every id type with its letter prefix', () => {
        for (const type of Object.keys(PREFIX)) {
            const id = formatId(type, oid);
            expect(id[0]).to.equal(PREFIX[type]);
            expect(isValidId(id)).to.be.true;
            expect(parseId(type, id).equals(oid)).to.be.true;
        }
    });

    it('rejects ids of another type, wrong length, upper case hex and non strings', () => {
        expect(parseId('email', formatId('thread', oid))).to.be.null;
        expect(parseId('email', 'M' + oid.toString().slice(1))).to.be.null;
        expect(parseId('email', 'M' + oid.toString().toUpperCase())).to.be.null;
        expect(parseId('email', 'M' + oid.toString() + 'a')).to.be.null;
        expect(parseId('email', { $ne: null })).to.be.null;
        expect(parseId('email', null)).to.be.null;
        expect(parseId('mailbox', '')).to.be.null;
    });

    it('formats and parses blob ids of every kind', () => {
        expect(parseBlobId(blobId.message(oid))).to.deep.equal({ kind: 'message', id: oid });
        expect(parseBlobId(blobId.upload(oid))).to.deep.equal({ kind: 'upload', id: oid });
        const part = parseBlobId(blobId.part(oid, '1.2.3'));
        expect(part.kind).to.equal('part');
        expect(part.part).to.equal('1.2.3');
        expect(part.id.equals(oid)).to.be.true;
        const uploadPart = parseBlobId(blobId.uploadPart(oid, '2.1'));
        expect(uploadPart.kind).to.equal('uploadPart');
        expect(uploadPart.part).to.equal('2.1');
        expect(uploadPart.id.equals(oid)).to.be.true;
        for (const id of [blobId.message(oid), blobId.part(oid, '2'), blobId.upload(oid), blobId.uploadPart(oid, '1.2')]) {
            expect(isValidId(id), id).to.be.true;
        }
    });

    it('rejects malformed blob ids', () => {
        for (const id of [
            'Bx' + oid,
            'Bp' + oid,
            'Bp' + oid + '_',
            'Bp' + oid + '_0',
            'Bp' + oid + '_1--2',
            'Bp' + oid + '_1.2',
            'Bm' + oid + '1',
            'Bv' + oid,
            'Bv' + oid + '_0',
            5,
            null
        ]) {
            expect(parseBlobId(id), String(id)).to.be.null;
        }
    });

    it('validates the RFC 8620 id syntax', () => {
        expect(isValidId('a')).to.be.true;
        expect(isValidId('a'.repeat(255))).to.be.true;
        expect(isValidId('a'.repeat(256))).to.be.false;
        expect(isValidId('')).to.be.false;
        expect(isValidId('a b')).to.be.false;
        expect(isValidId('ä')).to.be.false;
        expect(isValidId(7)).to.be.false;
    });
});
