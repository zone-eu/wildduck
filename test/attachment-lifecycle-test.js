/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Reference counting and garbage collection of stored attachments against a real MongoDB, and against S3
// when S3_TEST_ENDPOINT points to one (Moto in the test setup). Every test uses its own GridFS bucket and S3
// prefix, so nothing here depends on or disturbs the shared test database state.

const crypto = require('crypto');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');
const { emptyBucket, collect, objectExists, ageChunks } = require('./attachment-s3-helpers');

const endpoint = process.env.S3_TEST_ENDPOINT;
const DAY = 24 * 3600 * 1000;

// a tombstone is stale by the age of its id
async function ageTombstones(trash) {
    for (let tombstone of await trash.find().toArray()) {
        await trash.deleteOne({ _id: tombstone._id });
        await trash.insertOne({ ...tombstone, _id: ObjectId.createFromTime(Math.floor((Date.now() - DAY) / 1000)) });
    }
}

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

describe('Attachment garbage collection', function () {
    this.timeout(30000);

    let s3Client;
    let s3Bucket;

    before(async function () {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
        if (endpoint) {
            s3Bucket = `wildduck-gc-${crypto.randomBytes(5).toString('hex')}`;
            s3Client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
            await s3Client.send(new CreateBucketCommand({ Bucket: s3Bucket }));
        }
    });

    after(async function () {
        if (s3Client) {
            await emptyBucket(s3Client, s3Bucket);
            s3Client.destroy();
        }
    });

    for (const type of ['gridstore', 's3']) {
        (type === 's3' && !endpoint ? describe.skip : describe)(`with ${type} as the write backend`, function () {
            let storage;
            let bucket;
            let files;
            let chunks;

            beforeEach(async function () {
                bucket = `attgc${crypto.randomBytes(4).toString('hex')}`;
                files = db.gridfs.collection(`${bucket}.files`);
                chunks = db.gridfs.collection(`${bucket}.chunks`);
                await files.createIndex({ 'metadata.c': 1, 'metadata.m': 1, 'metadata.cu': 1 }, { name: 'related_attachments_cu' });
                storage = new AttachmentStorage({
                    gridfs: db.gridfs,
                    redis: db.redis,
                    s3Client,
                    options: { type, bucket, ...(endpoint ? { s3: { bucket: s3Bucket, prefix: bucket } } : {}) }
                });
            });

            afterEach(async function () {
                for (const suffix of ['files', 'chunks', 'trash']) {
                    await db.gridfs
                        .collection(`${bucket}.${suffix}`)
                        .drop()
                        .catch(() => false);
                }
            });

            function create(body, magic) {
                return new Promise((resolve, reject) => storage.create(attachment(body, magic), (err, id) => (err ? reject(err) : resolve(id))));
            }

            // an attachment that lost its last reference a day ago, uploaded at least that long ago
            async function orphan(body) {
                let id = await create(body, 3);
                await storage.deleteAsync(id, 3);
                await files.updateOne({ _id: id }, { $set: { 'metadata.cu': new Date(Date.now() - DAY - 1000) } });
                await ageChunks(chunks, id, new Date(Date.now() - DAY));
                return await files.findOne({ _id: id });
            }

            async function payloadExists(file) {
                if (file.metadata.storage) {
                    return await objectExists(s3Client, s3Bucket, file.metadata.storage.key);
                }
                return (await chunks.countDocuments({ files_id: file._id })) > 0;
            }

            async function read(id) {
                return (await collect(storage.createReadStream(id, await storage.get(id)))).toString();
            }

            it('collects an old orphan and its payload', async function () {
                let file = await orphan('collect me');
                expect(await payloadExists(file)).to.be.true;
                expect(await storage.deleteOrphanedAsync()).to.equal(1);
                expect(await files.countDocuments({ _id: file._id })).to.equal(0);
                expect(await payloadExists(file)).to.be.false;
                expect(await db.gridfs.collection(`${bucket}.trash`).countDocuments()).to.equal(0);
            });

            it('keeps an orphan that is referenced again before its record is removed', async function () {
                let file = await orphan('referenced again');
                let removeOrphan = storage.catalog.removeOrphan.bind(storage.catalog);
                storage.catalog.removeOrphan = async (...args) => {
                    // a message with the same attachment arrives between the scan and the removal
                    await create('referenced again', 9);
                    return await removeOrphan(...args);
                };
                expect(await storage.deleteOrphanedAsync()).to.equal(0);
                expect((await files.findOne({ _id: file._id })).metadata.c).to.equal(1);
                expect(await payloadExists(file)).to.be.true;
                expect(await read(file._id)).to.equal('referenced again');
            });

            it('never blocks delivery and keeps the copy stored while the old one is being collected', async function () {
                let file = await orphan('stored again');
                let removeOrphan = storage.catalog.removeOrphan.bind(storage.catalog);
                storage.catalog.removeOrphan = async (...args) => {
                    let removed = await removeOrphan(...args);
                    // the record is gone, the payload not yet: a new message stores the attachment again
                    await create('stored again', 9);
                    return removed;
                };
                expect(await storage.deleteOrphanedAsync()).to.equal(1);
                let stored = await files.findOne({ _id: file._id });
                expect(stored.metadata.c).to.equal(1);
                expect(await payloadExists(stored)).to.be.true;
                expect(await read(file._id)).to.equal('stored again');
                if (file.metadata.storage) {
                    expect(stored.metadata.storage.key).to.not.equal(file.metadata.storage.key);
                    expect(await objectExists(s3Client, s3Bucket, file.metadata.storage.key)).to.be.false;
                }
            });

            it('keeps an orphan whose payload was migrated between the scan and the removal', async function () {
                let file = await orphan('migrated meanwhile');
                let removeOrphan = storage.catalog.removeOrphan.bind(storage.catalog);
                storage.catalog.removeOrphan = async (id, key) => {
                    await files.updateOne({ _id: id }, { $set: { 'metadata.storage.key': 'moved' } });
                    return await removeOrphan(id, key);
                };
                expect(await storage.deleteOrphanedAsync()).to.equal(0);
                expect(await files.countDocuments({ _id: file._id })).to.equal(1);
            });

            it('deletes the payload later when the collection stops after removing the record', async function () {
                let file = await orphan('interrupted collection');
                let releasePayload = storage.releasePayload.bind(storage);
                storage.releasePayload = async () => {
                    throw new Error('process stopped');
                };
                expect(await storage.deleteOrphanedAsync()).to.equal(0);
                expect(await files.countDocuments({ _id: file._id })).to.equal(0);
                expect(await payloadExists(file)).to.be.true;

                storage.releasePayload = releasePayload;
                let trash = db.gridfs.collection(`${bucket}.trash`);
                await ageTombstones(trash);
                await storage.deleteOrphanedAsync();
                expect(await payloadExists(file)).to.be.false;
                expect(await trash.countDocuments()).to.equal(0);
            });

            it('keeps the payload of an attachment stored again before a stale tombstone is swept', async function () {
                await orphan('stored after the stop');
                storage.releasePayload = async () => {
                    throw new Error('process stopped');
                };
                await storage.deleteOrphanedAsync();
                delete storage.releasePayload;

                let id = await create('stored after the stop', 4);
                // the new copy is old enough by now that only the record protects it
                await ageChunks(chunks, id, new Date(Date.now() - DAY));
                await ageTombstones(db.gridfs.collection(`${bucket}.trash`));
                await storage.deleteOrphanedAsync();
                expect(await read(id)).to.equal('stored after the stop');
            });

            if (type === 's3') {
                it('deletes the object later when S3 fails after the record was removed', async function () {
                    let file = await orphan('s3 is down');
                    let deletePayload = storage.s3.deletePayload.bind(storage.s3);
                    storage.s3.deletePayload = async () => {
                        throw new Error('S3 unavailable');
                    };
                    expect(await storage.deleteOrphanedAsync()).to.equal(0);
                    expect(await files.countDocuments({ _id: file._id })).to.equal(0);
                    let trash = db.gridfs.collection(`${bucket}.trash`);
                    expect(await trash.countDocuments({ key: file.metadata.storage.key })).to.equal(1);

                    // a young tombstone may belong to a collection that is still running
                    storage.s3.deletePayload = deletePayload;
                    await storage.deleteOrphanedAsync();
                    expect(await objectExists(s3Client, s3Bucket, file.metadata.storage.key)).to.be.true;

                    await ageTombstones(trash);
                    await storage.deleteOrphanedAsync();
                    expect(await objectExists(s3Client, s3Bucket, file.metadata.storage.key)).to.be.false;
                    expect(await trash.countDocuments()).to.equal(0);
                });

                it('leaves S3 alone for the rest of a pass after an S3 failure', async function () {
                    let first = await orphan('first orphan');
                    let second = await orphan('second orphan');
                    let attempts = 0;
                    storage.s3.deletePayload = async () => {
                        attempts++;
                        throw new Error('S3 unavailable');
                    };
                    expect(await storage.deleteOrphanedAsync()).to.equal(0);
                    expect(attempts).to.equal(1);
                    // one record is gone with a tombstone for its object, the other one was not touched
                    expect(await files.countDocuments({ _id: { $in: [first._id, second._id] } })).to.equal(1);
                    expect(await db.gridfs.collection(`${bucket}.trash`).countDocuments()).to.equal(1);
                });

                it('keeps the object when the collection stopped before removing the record', async function () {
                    let id = await create('still referenced', 5);
                    let file = await files.findOne({ _id: id });
                    let trash = db.gridfs.collection(`${bucket}.trash`);
                    await storage.catalog.addTombstone(id, file.metadata.storage);
                    await ageTombstones(trash);
                    await storage.deleteOrphanedAsync();
                    expect(await trash.countDocuments()).to.equal(0);
                    expect(await objectExists(s3Client, s3Bucket, file.metadata.storage.key)).to.be.true;
                    expect(await read(id)).to.equal('still referenced');
                });
            }
        });
    }
});
