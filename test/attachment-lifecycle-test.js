/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Reference counting of stored attachments against a real MongoDB. Every test uses its own GridFS bucket,
// so nothing here depends on or disturbs the shared test database state.

const crypto = require('crypto');
const { expect } = require('chai');
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');

function attachment(body, magic) {
    return { body: Buffer.from(body), contentType: 'application/octet-stream', transferEncoding: '7bit', magic };
}

describe('Attachment reference counting', function () {
    this.timeout(30000);

    let storage;
    let bucket;

    before(async function () {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
    });

    beforeEach(function () {
        bucket = `attlife${crypto.randomBytes(4).toString('hex')}`;
        storage = new AttachmentStorage({ gridfs: db.gridfs, redis: db.redis, options: { type: 'gridstore', bucket } });
    });

    afterEach(async function () {
        await db.gridfs
            .collection(`${bucket}.files`)
            .drop()
            .catch(() => false);
        await db.gridfs
            .collection(`${bucket}.chunks`)
            .drop()
            .catch(() => false);
    });

    function create(body, magic) {
        return new Promise((resolve, reject) => storage.create(attachment(body, magic), (err, id) => (err ? reject(err) : resolve(id))));
    }

    async function counters(id) {
        let data = await storage.get(id);
        return { c: data.count, m: data.metadata.m };
    }

    it('counts every occurrence of a repeated attachment when copying and expiring a message', async function () {
        // a message that holds the same file twice takes two references when it is stored
        let magic = 77;
        let first = await create('same file attached twice', magic);
        let second = await create('same file attached twice', magic);
        expect(second.equals(first)).to.be.true;
        expect(await counters(first)).to.deep.equal({ c: 2, m: 2 * magic });

        // COPY takes a reference for every entry of the attachment map, as storing did
        await storage.updateMany([first, second], 1, magic);
        expect(await counters(first)).to.deep.equal({ c: 4, m: 4 * magic });

        // deleting the original releases its two references, the copy still holds two
        await storage.deleteManyAsync([first, second], magic);
        expect(await counters(first)).to.deep.equal({ c: 2, m: 2 * magic });

        // expiring the copy releases the rest
        await storage.updateMany([first, second], -1, -magic);
        expect(await counters(first)).to.deep.equal({ c: 0, m: 0 });
    });

    it('updates distinct attachments with their own multiplicity', async function () {
        let magic = 5;
        let a = await create('attachment a', magic);
        let b = await create('attachment b', magic);
        await create('attachment b', magic);

        await storage.updateMany([a, b, b], 1, magic);
        expect(await counters(a)).to.deep.equal({ c: 2, m: 2 * magic });
        expect(await counters(b)).to.deep.equal({ c: 4, m: 4 * magic });
    });
});
