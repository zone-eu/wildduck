/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// The failure paths of the attachment store that the scenario and model tests do not reach on their own:
// locks that can not be taken or are lost, uploads that keep failing, the database failing in between, and
// the callback forms other parts of WildDuck use. Renewal timers are driven by hand instead of waiting for
// them.

const crypto = require('crypto');
const { expect } = require('chai');
const { Writable } = require('stream');
const { ObjectId } = require('mongodb');
const db = require('../lib/db');
const errors = require('../lib/errors');
const AttachmentStorage = require('../lib/attachment-storage');
const AttachmentLock = require('../lib/attachments/attachment-lock');
const S3Storage = require('../lib/attachments/s3-storage');
const { createAttachmentIndexes } = require('./attachment-s3-helpers');

// replaces setInterval while `operation` runs and hands back the callbacks it was given
async function captureIntervals(operation) {
    let original = global.setInterval;
    let captured = [];
    global.setInterval = fn => {
        captured.push(fn);
        return { unref() {}, ref() {}, [Symbol.toPrimitive]: () => 0 };
    };
    try {
        return { result: await operation(captured), captured };
    } finally {
        global.setInterval = original;
    }
}

function failingUpload(err) {
    // an upload stream that fails when it is ended, like a chunk insert that fails
    return new Writable({
        write(chunk, encoding, done) {
            done();
        },
        final(done) {
            done(err);
        }
    });
}

describe('Attachment store failure paths', function () {
    this.timeout(30000);

    let bucket;
    let storage;

    before(async function () {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
    });

    beforeEach(async function () {
        bucket = `attfail${crypto.randomBytes(4).toString('hex')}`;
        await createAttachmentIndexes(db.gridfs, bucket);
        storage = new AttachmentStorage({ gridfs: db.gridfs, redis: db.redis, options: { type: 'gridstore', bucket } });
    });

    afterEach(async function () {
        for (let suffix of ['files', 'chunks', 'trash']) {
            await db.gridfs
                .collection(`${bucket}.${suffix}`)
                .drop()
                .catch(() => false);
        }
    });

    function create(target, body, magic = 1) {
        return new Promise((resolve, reject) =>
            target.create({ body: Buffer.from(body), contentType: 'text/plain', transferEncoding: '7bit', magic }, (err, id) =>
                err ? reject(err) : resolve(id)
            )
        );
    }

    describe('storage facade', function () {
        it('refuses an unknown backend type', function () {
            expect(() => new AttachmentStorage({ gridfs: db.gridfs, redis: db.redis, options: { type: 'tape', bucket } })).to.throw(
                'Unknown attachment storage type'
            );
        });

        it('fails a body it can not hash', async function () {
            let error = await new Promise(resolve => storage.create({ body: 12345, magic: 1 }, resolve));
            expect(error).to.be.an('error');
        });

        it('offers the callback forms used by message deletion, expiry and the collector', async function () {
            let id = await create(storage, 'callback forms', 3);
            let updated = await new Promise((resolve, reject) => storage.updateMany([id], 1, 3, (err, result) => (err ? reject(err) : resolve(result))));
            expect(updated.matchedCount).to.equal(1);
            expect(await new Promise((resolve, reject) => storage.delete(id, 3, (err, result) => (err ? reject(err) : resolve(result))))).to.be.true;
            expect(await new Promise((resolve, reject) => storage.deleteOrphaned((err, count) => (err ? reject(err) : resolve(count))))).to.equal(0);
            expect((await storage.get(id)).count).to.equal(1);
        });

        it('reports a missing attachment as FileNotFound', async function () {
            let error = await storage.get(crypto.randomBytes(32)).catch(err => err);
            expect(error.code).to.equal('FileNotFound');
            expect(error.responseCode).to.equal(404);
        });

        it('refuses to read an S3 record in a process without S3 settings, and leaves its tombstone alone', async function () {
            let id = crypto.randomBytes(32);
            let location = { version: 1, backend: 's3', bucket: 'b', key: 'k', length: 1 };
            await db.gridfs.collection(`${bucket}.files`).insertOne({ _id: id, length: 1, metadata: { c: 1, m: 1, storage: location } });
            expect((await storage.get(id).catch(err => err)).message).to.equal('S3 attachment exists but S3 access is not configured');
            await storage.catalog.addTombstone(id, location);
            let trash = db.gridfs.collection(`${bucket}.trash`);
            let tombstone = await trash.findOne({});
            await trash.deleteOne({ _id: tombstone._id });
            await trash.insertOne({ ...tombstone, _id: ObjectId.createFromTime(0) });
            await storage.deleteOrphanedAsync();
            expect(await trash.countDocuments()).to.equal(1);
        });
    });

    describe('catalog', function () {
        it('takes no action for an empty list of references', async function () {
            expect(await storage.updateMany([], 1, 1)).to.deep.equal({ matchedCount: 0, modifiedCount: 0 });
        });

        it('updates what exists when some references point to missing records', async function () {
            let id = await create(storage, 'partly missing', 2);
            let result = await storage.updateMany([id, crypto.randomBytes(32)], 1, 2);
            expect(result.matchedCount).to.equal(1);
            expect((await storage.get(id)).count).to.equal(2);
        });

        it('reports a magic number that is not a number', async function () {
            let notify = errors.notify;
            let reported = [];
            errors.notify = err => reported.push(err.message);
            try {
                let id = await create(storage, 'bad magic', 1);
                await storage.updateMany([id], 1, 'not a number');
            } finally {
                errors.notify = notify;
            }
            expect(reported.some(message => message.includes('Invalid magic'))).to.be.true;
        });
    });

    describe('GridFS store', function () {
        it('fails when the lock for a new upload can not be taken in time', async function () {
            let waited;
            storage.gridstore.lock.waitAcquireLock = (id, ttl, wait, callback) => {
                waited = wait;
                callback(null, { success: false });
            };
            expect((await create(storage, 'no lock').catch(err => err)).message).to.equal('Failed to get lock');
            // a limited wait, not forever
            expect(waited).to.be.a('number').above(0);
        });

        it('fails when the database fails the reference update', async function () {
            let collection = storage.gridstore.gridfs.collection.bind(storage.gridstore.gridfs);
            storage.gridstore.gridfs = {
                collection: name => {
                    let target = collection(name);
                    return name.endsWith('.files')
                        ? {
                              ...target,
                              findOneAndUpdate: async () => {
                                  throw new Error('not primary');
                              }
                          }
                        : target;
                }
            };
            expect((await create(storage, 'database down').catch(err => err)).message).to.equal('not primary');
        });

        it('gives up on an upload that keeps failing, and releases its lock', async function () {
            let attempts = 0;
            storage.gridstore.gridstore.openUploadStreamWithId = () => {
                attempts++;
                return failingUpload(new Error('chunk insert failed'));
            };
            expect((await create(storage, 'keeps failing').catch(err => err)).message).to.equal('chunk insert failed');
            // it retried, then gave up
            expect(attempts).to.be.above(2);
            // the lock is free again: a working upload of the same attachment goes through
            delete storage.gridstore.gridstore.openUploadStreamWithId;
            expect(await create(storage, 'keeps failing')).to.be.instanceOf(Buffer);
        });

        it('retries after failing to remove leftover chunks', async function () {
            let attempts = 0;
            let upload = storage.gridstore.gridstore.openUploadStreamWithId.bind(storage.gridstore.gridstore);
            storage.gridstore.gridstore.openUploadStreamWithId = (...args) => (++attempts === 1 ? failingUpload(new Error('collision')) : upload(...args));
            let cleanup = storage.gridstore.cleanupGarbage.bind(storage.gridstore);
            let cleanups = 0;
            storage.gridstore.cleanupGarbage = (id, started, owned, next) =>
                ++cleanups === 1 ? next(new Error('cleanup failed')) : cleanup(id, started, owned, next);
            let id = await create(storage, 'cleanup fails once');
            expect(attempts).to.equal(2);
            expect((await storage.get(id)).count).to.equal(1);
        });

        it('does not remove anything after losing the lock of an upload', async function () {
            let cleanups = 0;
            storage.gridstore.cleanupGarbage = (id, started, owned, next) => {
                cleanups++;
                next();
            };
            storage.gridstore.lock.extendLock = () => Promise.resolve({ success: false });
            let { result } = await captureIntervals(async captured => {
                storage.gridstore.gridstore.openUploadStreamWithId = () => {
                    // the upload is slow: the lock is renewed, and the renewal says it is gone
                    expect(captured).to.have.length(1);
                    captured[0]();
                    return failingUpload(new Error('upload failed'));
                };
                return await create(storage, 'lost the lock').catch(err => err);
            });
            expect(result.message).to.equal('upload failed');
            expect(cleanups).to.equal(0);
        });

        it('does not remove anything when the lock is lost while a retry waits', async function () {
            let cleanups = 0;
            storage.gridstore.cleanupGarbage = (id, started, owned, next) => {
                cleanups++;
                next();
            };
            let renewal = { success: true };
            storage.gridstore.lock.extendLock = () => Promise.resolve(renewal);
            let { result } = await captureIntervals(async captured => {
                storage.gridstore.gridstore.openUploadStreamWithId = () => {
                    // the upload fails while the lock is still held, then the lease is lost before the retry runs
                    let upload = failingUpload(new Error('upload failed'));
                    upload.once('error', () => {
                        renewal = { success: false };
                        captured[0]();
                    });
                    return upload;
                };
                return await create(storage, 'lost the lock while waiting').catch(err => err);
            });
            expect(result.message).to.equal('upload failed');
            expect(cleanups).to.equal(0);
        });

        it('does not trust a lease that ran out while the process was stalled', async function () {
            let cleanups = 0;
            storage.gridstore.cleanupGarbage = (id, started, owned, next) => {
                cleanups++;
                next();
            };
            let now = Date.now;
            try {
                storage.gridstore.gridstore.openUploadStreamWithId = () => {
                    // the process stalls longer than the lease lasts, no renewal ran meanwhile
                    let later = now() + 3 * 60 * 1000;
                    Date.now = () => later;
                    return failingUpload(new Error('upload failed'));
                };
                expect((await create(storage, 'stalled past the lease').catch(err => err)).message).to.equal('upload failed');
            } finally {
                Date.now = now;
            }
            expect(cleanups).to.equal(0);
        });

        it('releases the lock when preparing the upload throws', async function () {
            storage.gridstore.gridstore.openUploadStreamWithId = () => {
                throw new Error('cannot open upload');
            };
            expect((await create(storage, 'throws').catch(err => err)).message).to.equal('cannot open upload');
            // the lock is free again: a working upload of the same attachment goes through
            delete storage.gridstore.gridstore.openUploadStreamWithId;
            expect(await create(storage, 'throws')).to.be.instanceOf(Buffer);
        });

        it('passes database errors of the leftover cleanup on', async function () {
            let collection = storage.gridstore.gridfs.collection.bind(storage.gridstore.gridfs);
            let failOn = '.files';
            storage.gridstore.gridfs = {
                collection: name => {
                    let target = collection(name);
                    if (!name.endsWith(failOn)) {
                        return target;
                    }
                    return failOn === '.files'
                        ? {
                              findOne: async () => {
                                  throw new Error('files unavailable');
                              }
                          }
                        : {
                              deleteMany: async () => {
                                  throw new Error('chunks unavailable');
                              }
                          };
                }
            };
            let id = crypto.randomBytes(32);
            expect((await new Promise(resolve => storage.gridstore.cleanupGarbage(id, Date.now(), () => true, resolve))).message).to.equal('files unavailable');
            failOn = '.chunks';
            expect((await new Promise(resolve => storage.gridstore.cleanupGarbage(id, Date.now(), () => true, resolve))).message).to.equal(
                'chunks unavailable'
            );
        });
    });

    describe('attachment lock', function () {
        it('fails when the lock can not be taken in time', async function () {
            let lock = new AttachmentLock(db.redis);
            lock.lock = { waitAcquireLock: async () => ({ success: false }) };
            expect((await lock.run(crypto.randomBytes(32), async () => true).catch(err => err)).message).to.match(/Timed out acquiring attachment lock/);
        });

        it('renews the lease while the operation runs and notices when it is lost', async function () {
            let lock = new AttachmentLock(db.redis);
            let renewals = [{ success: true }, { success: false }];
            let released = false;
            lock.lock = {
                waitAcquireLock: async () => ({ success: true }),
                extendLock: async () => renewals.shift(),
                releaseLock: async () => {
                    released = true;
                    throw new Error('redis gone');
                }
            };
            let { result } = await captureIntervals(captured =>
                lock.run(crypto.randomBytes(32), async assertOwned => {
                    await captured[0]();
                    assertOwned();
                    await captured[0]();
                    return assertOwned;
                })
            );
            expect(result).to.throw('Lost attachment lock');
            // a failed release is logged, not thrown
            expect(released).to.be.true;
        });

        it('counts a renewal error as a lost lease', async function () {
            let lock = new AttachmentLock(db.redis);
            lock.lock = {
                waitAcquireLock: async () => ({ success: true }),
                extendLock: async () => {
                    throw new Error('redis gone');
                },
                releaseLock: async () => true
            };
            let { result } = await captureIntervals(captured =>
                lock.run(crypto.randomBytes(32), async assertOwned => {
                    await captured[0]();
                    return assertOwned;
                })
            );
            expect(result).to.throw('Lost attachment lock');
        });
    });

    describe('S3 store', function () {
        it('requires a bucket and a prefix', function () {
            expect(() => new S3Storage({ options: { s3: { bucket: 'b' } } })).to.throw('s3.bucket and a nonempty s3.prefix');
        });

        it('refuses to read with a broken locator', function () {
            let s3 = new S3Storage({ options: { s3: { bucket: 'b', prefix: 'p' } }, s3Client: {} });
            expect(() => s3.createReadStream(crypto.randomBytes(32), { length: 1, metadata: { storage: { backend: 's3', bucket: 'b' } } })).to.throw(
                'Invalid S3 attachment locator'
            );
        });
    });
});
