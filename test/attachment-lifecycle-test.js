/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Reference counting and garbage collection of stored attachments against a real MongoDB, and against S3
// when S3_TEST_ENDPOINT points to one (Moto in the test setup). Every test uses its own GridFS bucket and S3
// prefix, so nothing here depends on or disturbs the shared test database state.

const crypto = require('crypto');
const { expect } = require('chai');
const { S3Client, CreateBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');
const Indexer = require('../imap-core/lib/indexer/indexer');
const { emptyBucket, collect, objectExists, ageChunks, objectIdAt, createAttachmentIndexes } = require('./attachment-s3-helpers');

const endpoint = process.env.S3_TEST_ENDPOINT;
const DAY = 24 * 3600 * 1000;

function dayOldId() {
    return objectIdAt(new Date(Date.now() - DAY));
}

// a tombstone is stale by the age of its id
async function ageTombstones(trash) {
    for (let tombstone of await trash.find().toArray()) {
        await trash.deleteOne({ _id: tombstone._id });
        await trash.insertOne({ ...tombstone, _id: dayOldId() });
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
                await createAttachmentIndexes(db.gridfs, bucket);
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

            function create(body, magic, target = storage) {
                return new Promise((resolve, reject) => target.create(attachment(body, magic), (err, id) => (err ? reject(err) : resolve(id))));
            }

            // an attachment that lost its last reference a day ago, uploaded at least that long ago
            async function orphan(body, target = storage) {
                let id = await create(body, 3, target);
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

            it('collects GridFS orphans in a process without S3 settings while S3 orphans are older', async function () {
                let noS3 = new AttachmentStorage({ gridfs: db.gridfs, redis: db.redis, options: { type: 'gridstore', bucket } });
                // more S3 orphans than one pass looks at, all older than the GridFS one
                await files.insertMany(
                    Array.from({ length: 1001 }, (unused, i) => ({
                        _id: crypto.createHash('sha256').update(`s3 orphan ${i}`).digest(),
                        length: 1,
                        metadata: { c: 0, m: 0, cu: new Date(0), storage: { version: 1, backend: 's3', bucket: 'b', key: `k${i}`, length: 1 } }
                    }))
                );
                let file = await orphan('gridfs orphan', noS3);
                expect(await noS3.deleteOrphanedAsync()).to.equal(1);
                expect(await files.countDocuments({ _id: file._id })).to.equal(0);
            });

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

            it('adds a reference to a known attachment without taking a lock', async function () {
                let id = await create('known attachment', 2);
                let locks = 0;
                let countLock = target => {
                    let original = target.lock.waitAcquireLock.bind(target.lock);
                    target.lock.waitAcquireLock = (...args) => {
                        locks++;
                        return original(...args);
                    };
                };
                countLock(storage.gridstore);
                countLock(storage.lock);
                expect((await create('known attachment', 3)).equals(id)).to.be.true;
                expect(locks).to.equal(0);
                expect((await files.findOne({ _id: id })).metadata.c).to.equal(2);
            });

            it('serves a placeholder of the right size when a stored payload is missing', async function () {
                let logged = [];
                let indexer = new Indexer({ attachmentStorage: storage, loggelf: entry => logged.push(entry._mail_action) });
                let payload = crypto.randomBytes(3000).toString('base64').replace(/.{76}/g, '$&\r\n');
                let source = Buffer.from(
                    'From: a@example.com\r\nTo: b@example.com\r\nSubject: missing\r\nMIME-Version: 1.0\r\n' +
                        'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n' +
                        '--b\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
                        payload +
                        '\r\n--b--\r\n'
                );
                let tree = indexer.parseMimeTree(source);
                let maildata = indexer.getMaildata(tree);
                await new Promise((resolve, reject) => indexer.storeNodeBodies(maildata, tree, err => (err ? reject(err) : resolve())));
                let id = Object.values(tree.attachmentMap)[0];
                expect((await collect(indexer.rebuild(tree).value)).equals(source)).to.be.true;

                // the record stays, the payload is gone
                let file = await files.findOne({ _id: id });
                if (file.metadata.storage) {
                    await storage.s3.deletePayload(file.metadata.storage);
                } else {
                    await chunks.deleteMany({ files_id: id });
                }
                let rebuilt = await collect(indexer.rebuild(tree).value);
                expect(rebuilt.length).to.equal(source.length);
                expect(rebuilt.toString().startsWith(source.toString().slice(0, source.indexOf(payload)))).to.be.true;
                // a GridFS download without chunks ends early instead of failing, so it is padded as a length mismatch
                expect(logged).to.include(file.metadata.storage ? 'attachment_missing' : 'attachment_length_mismatch');

                // a rebuild that is stored or sent fails instead of keeping the placeholder
                let error = await collect(indexer.rebuild(tree, false, { strict: true }).value).catch(err => err);
                expect(error.code).to.equal('AttachmentMissing');
            });

            if (type === 'gridstore') {
                const CHUNK = 255 * 1024;

                const storesExactly = async (body, magic) => {
                    let id = await create(body, magic);
                    expect((await collect(storage.createReadStream(id, await storage.get(id)))).equals(body)).to.be.true;
                    expect(await chunks.countDocuments({ files_id: id })).to.equal(Math.ceil(body.length / CHUNK));
                    return id;
                };

                for (let [description, leftoverId] of [
                    ['an upload that stopped a day ago', dayOldId],
                    ['an upload that stopped ten minutes ago', () => objectIdAt(new Date(Date.now() - 10 * 60 * 1000))]
                ]) {
                    it(`stores a large attachment over chunks left by ${description}`, async function () {
                        let body = crypto.randomBytes(3 * CHUNK + 1000);
                        let id = crypto.createHash('sha256').update(body).digest();
                        await chunks.insertMany([0, 1].map(n => ({ _id: leftoverId(), files_id: id, n, data: Buffer.from('leftover') })));
                        await storesExactly(body, 1);
                    });
                }

                it('waits for a live upload by a writer that does not lock instead of removing its chunks', async function () {
                    let body = crypto.randomBytes(1000);
                    let id = crypto.createHash('sha256').update(body).digest();
                    // an older version uploads small attachments without the lock: its chunk is in place, its record follows
                    await chunks.insertOne({ _id: objectIdAt(new Date(Date.now() - 2000)), files_id: id, n: 0, data: body });
                    setTimeout(() => {
                        files
                            .insertOne({
                                _id: id,
                                length: body.length,
                                chunkSize: CHUNK,
                                uploadDate: new Date(),
                                contentType: 'application/octet-stream',
                                metadata: { c: 1, m: 5, cu: new Date(), esize: body.length, transferEncoding: '7bit' }
                            })
                            .catch(() => false);
                    }, 300);
                    expect((await create(body, 7)).equals(id)).to.be.true;
                    let file = await files.findOne({ _id: id });
                    expect(file.metadata.c).to.equal(2);
                    expect((await collect(storage.createReadStream(id, await storage.get(id)))).equals(body)).to.be.true;
                });

                it('stores the same new attachment from many concurrent writers over leftover chunks', async function () {
                    this.timeout(120000);
                    for (let round = 0; round < 12; round++) {
                        let body = crypto.randomBytes(round % 2 ? 2 * CHUNK + round : 1000 + round);
                        let id = crypto.createHash('sha256').update(body).digest();
                        if (round % 3) {
                            let leftover = round % 3 === 1 ? dayOldId() : objectIdAt(new Date(Date.now() - 10 * 60 * 1000));
                            await chunks.insertOne({ _id: leftover, files_id: id, n: 0, data: Buffer.from('leftover') });
                        }
                        let ids = await Promise.all(Array.from({ length: 6 }, (unused, writer) => create(body, writer + 1)));
                        expect(ids.every(stored => stored.equals(id))).to.be.true;
                        let file = await files.findOne({ _id: id });
                        expect(file.metadata.c, `round ${round}`).to.equal(6);
                        expect(file.metadata.m, `round ${round}`).to.equal(21);
                        expect((await collect(storage.createReadStream(id, await storage.get(id)))).equals(body), `round ${round}`).to.be.true;
                        expect(await chunks.countDocuments({ files_id: id }), `round ${round}`).to.equal(Math.ceil(body.length / CHUNK));
                    }
                });
            }

            if (type === 's3') {
                it('uploads a new attachment once when many messages carry it at the same time', async function () {
                    let body = crypto.randomBytes(4000);
                    let ids = await Promise.all(Array.from({ length: 8 }, (unused, writer) => create(body, writer + 1)));
                    let file = await files.findOne({ _id: ids[0] });
                    expect(file.metadata.c).to.equal(8);
                    expect(file.metadata.m).to.equal(36);
                    let listed = await s3Client.send(new ListObjectsV2Command({ Bucket: s3Bucket, Prefix: `${bucket}/` }));
                    expect((listed.Contents || []).map(object => object.Key)).to.deep.equal([file.metadata.storage.key]);
                });

                it('adds a reference when a writer that holds no lock stores the attachment first', async function () {
                    let body = Buffer.from('raced by an older writer');
                    let id = crypto.createHash('sha256').update(body).digest();
                    let put = storage.s3.put.bind(storage.s3);
                    let uploaded;
                    storage.s3.put = async (...args) => {
                        uploaded = await put(...args);
                        // an older version stores the same attachment in GridFS without taking the lock
                        await new Promise((resolve, reject) => {
                            let upload = storage.gridstore.gridstore.openUploadStreamWithId(id, null, {
                                contentType: 'application/octet-stream',
                                metadata: { c: 1, m: 4, cu: new Date(), esize: body.length, transferEncoding: '7bit' }
                            });
                            upload.once('error', reject);
                            upload.once('finish', resolve);
                            upload.end(body);
                        });
                        return uploaded;
                    };
                    expect((await create(body, 6)).equals(id)).to.be.true;
                    let file = await files.findOne({ _id: id });
                    expect(file.metadata.storage).to.not.exist;
                    expect(file.metadata.c).to.equal(2);
                    expect(file.metadata.m).to.equal(10);
                    expect(await objectExists(s3Client, s3Bucket, uploaded.key)).to.be.false;
                    expect(await read(id)).to.equal(body.toString());
                });

                it('stores a new attachment in GridFS when the S3 upload fails', async function () {
                    storage.s3.client = {
                        send: async () => {
                            throw Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } });
                        }
                    };
                    let id = await create('stored while S3 is down', 2);
                    let file = await files.findOne({ _id: id });
                    expect(file.metadata.storage).to.not.exist;
                    expect(file.metadata.c).to.equal(1);
                    expect(await chunks.countDocuments({ files_id: id })).to.equal(1);
                    expect(await read(id)).to.equal('stored while S3 is down');
                    // the next message with it only adds a reference
                    await create('stored while S3 is down', 3);
                    expect((await files.findOne({ _id: id })).metadata.c).to.equal(2);
                });

                it('sends new attachments straight to GridFS for a while after an S3 failure', async function () {
                    let client = storage.s3.client;
                    let requests = 0;
                    storage.s3.client = {
                        send: async () => {
                            requests++;
                            throw Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
                        }
                    };
                    await create('first after the failure', 1);
                    await create('second after the failure', 1);
                    expect(requests).to.equal(1);

                    // once the pause is over, S3 is tried again
                    storage.s3.client = client;
                    storage.s3PausedUntil = 0;
                    let id = await create('after the pause', 1);
                    expect((await files.findOne({ _id: id })).metadata.storage.backend).to.equal('s3');
                });

                it('does not fall back to GridFS when the catalog fails after the upload', async function () {
                    let put = storage.s3.put.bind(storage.s3);
                    let uploaded;
                    storage.s3.put = async (...args) => (uploaded = await put(...args));
                    storage.catalog.insert = async () => {
                        throw new Error('not primary');
                    };
                    let error = await create('catalog unavailable', 2).catch(err => err);
                    expect(error.message).to.equal('not primary');
                    expect(await files.countDocuments({})).to.equal(0);
                    expect(await chunks.countDocuments({})).to.equal(0);
                    // the record may or may not have been written, so the uploaded copy is kept
                    expect(await objectExists(s3Client, s3Bucket, uploaded.key)).to.be.true;
                });

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

                it('keeps collecting when S3 refuses to delete one object', async function () {
                    let refused = await orphan('refused delete');
                    let collectable = await orphan('collectable');
                    let deletePayload = storage.s3.deletePayload.bind(storage.s3);
                    storage.s3.deletePayload = async location => {
                        if (location.key === refused.metadata.storage.key) {
                            throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
                        }
                        return await deletePayload(location);
                    };
                    let trash = db.gridfs.collection(`${bucket}.trash`);
                    // the refused one keeps failing pass after pass without holding up anything else, one refusal
                    // does not stop the pass
                    for (let pass = 0; pass < 3; pass++) {
                        await storage.deleteOrphanedAsync();
                        await ageTombstones(trash);
                    }
                    expect(await objectExists(s3Client, s3Bucket, collectable.metadata.storage.key)).to.be.false;
                    expect(await files.countDocuments({ _id: collectable._id })).to.equal(0);
                    expect(await trash.countDocuments({ key: refused.metadata.storage.key })).to.equal(1);
                });

                it('leaves S3 alone for the rest of a pass when deletes keep being refused', async function () {
                    for (let i = 0; i < 5; i++) {
                        await orphan(`refused ${i}`);
                    }
                    let attempts = 0;
                    storage.s3.deletePayload = async () => {
                        attempts++;
                        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
                    };
                    await storage.deleteOrphanedAsync();
                    expect(attempts).to.equal(3);
                });

                it('treats an object in a bucket that no longer exists as deleted', async function () {
                    let file = await orphan('bucket gone');
                    storage.s3.deletePayload = async () => {
                        throw Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
                    };
                    expect(await storage.deleteOrphanedAsync()).to.equal(1);
                    expect(await db.gridfs.collection(`${bucket}.trash`).countDocuments()).to.equal(0);
                    expect(await files.countDocuments({ _id: file._id })).to.equal(0);
                });

                it('deletes GridFS chunks left behind when the attachment comes back as an S3 record', async function () {
                    let gridfsWriter = new AttachmentStorage({ gridfs: db.gridfs, redis: db.redis, options: { type: 'gridstore', bucket } });
                    let id = await create('moved to s3', 3, gridfsWriter);
                    await gridfsWriter.deleteAsync(id, 3);
                    await files.updateOne({ _id: id }, { $set: { 'metadata.cu': new Date(Date.now() - DAY - 1000) } });
                    await ageChunks(chunks, id, new Date(Date.now() - DAY));
                    // the collection stops after removing the record, then the attachment arrives again and goes to S3
                    storage.releasePayload = async () => {
                        throw new Error('process stopped');
                    };
                    await storage.deleteOrphanedAsync();
                    delete storage.releasePayload;
                    await create('moved to s3', 4);
                    await ageTombstones(db.gridfs.collection(`${bucket}.trash`));
                    await storage.deleteOrphanedAsync();
                    expect(await chunks.countDocuments({ files_id: id })).to.equal(0);
                    expect(await read(id)).to.equal('moved to s3');
                });

                it('collects chunks left by a GridFS upload that stopped before the attachment was stored in S3', async function () {
                    let body = Buffer.from('stored in s3 after a stopped gridfs upload');
                    let id = crypto.createHash('sha256').update(body).digest();
                    await chunks.insertOne({ _id: dayOldId(), files_id: id, n: 1, data: Buffer.from('leftover') });
                    await create(body, 2);
                    expect((await files.findOne({ _id: id })).metadata.storage.backend).to.equal('s3');
                    await storage.deleteAsync(id, 2);
                    await files.updateOne({ _id: id }, { $set: { 'metadata.cu': new Date(Date.now() - DAY - 1000) } });
                    expect(await storage.deleteOrphanedAsync()).to.equal(1);
                    expect(await chunks.countDocuments({ files_id: id })).to.equal(0);
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
