'use strict';

const { GridFSBucket, ObjectId } = require('mongodb');
const RedFour = require('ioredfour');
const errors = require('../errors');
const log = require('npmlog');
const crypto = require('crypto');
const { prepareStoredBody, createReadWindow } = require('./base64-codec');

/**
 * The magic number of a message is what pairs attachment reference counts with messages; a missing one
 * is a programming error worth reporting
 */
function checkMagic(magic, id) {
    if (isNaN(magic) || typeof magic !== 'number') {
        errors.notify(new Error('Invalid magic "' + magic + '" for ' + id));
    }
}

// chunks of an attachment record that was collected are at least a day old, chunks of a new upload are not.
// Chunk ids carry the clock of the uploading host, which is assumed to be less than this much behind
const STALE_CHUNK_AGE = 3600 * 1000;

const LOCK_TTL = 2 * 60 * 1000;
// an upload finishes well within the lock ttl, so chunks without a record that are older than this (with
// some room for clock differences) were left by an upload that stopped. Younger ones may belong to a live
// upload by a version that does not lock small attachments; they are kept, and the store fails after its
// retries until they are claimed by a record or old enough. Such an upload starting in the same second as
// a retrying writer can still lose its chunks, so all writers should run a version that locks
const ABANDONED_CHUNK_AGE = 5 * 60 * 1000;

/**
 * ObjectId with the given time and nothing else, for comparing chunk ids with a point in time
 */
function idAt(time) {
    return ObjectId.createFromTime(Math.floor(time / 1000));
}

class GridstoreStorage {
    constructor(options) {
        this.bucketName = (options.options && options.options.bucket) || 'attachments';
        this.decodeBase64 = (options.options && options.options.decodeBase64) || false;

        this.lock = new RedFour({
            redis: options.redis,
            namespace: 'wildduck'
        });

        this.gridfs = options.gridfs;
        this.gridstore = new GridFSBucket(this.gridfs, {
            bucketName: this.bucketName,
            chunkSizeBytes: 255 * 1024,
            writeConcern: { w: (options.options && options.options.writeConcern) || 'majority' }
        });
    }

    create(attachment, hash, callback) {
        let id = Buffer.from(hash, 'hex');
        let returned = false;

        checkMagic(attachment.magic, id);

        // the bytes written to the store (the body itself, or its decoded form when that can be
        // re-encoded byte for byte) and their metadata. Only needed when the attachment is new, so the
        // proof and the content hash are not paid for on a duplicate
        let stored;
        let prepare = () => {
            if (!stored) {
                stored = prepareStoredBody(attachment, { decodeBase64: this.decodeBase64 });
                Object.assign(stored.metadata, {
                    m: attachment.magic,
                    c: 1,
                    cu: new Date(),
                    // hash of the stored bytes, for clients that want to identify the file
                    // a verbatim body was already hashed for its id
                    fileContentHash: stored.data === attachment.body ? id.toString('base64') : crypto.createHash('sha256').update(stored.data).digest('base64')
                });
            }
            return stored;
        };

        let lockId = 'gs.' + id.toString('base64');
        let storeLock;
        // when the lease runs out unless a renewal moves it; a failed renewal ends it at once, and a stalled process
        // must not trust a lease it no longer has
        let lockExpires = 0;
        let renewTimer;
        let lostLock = () => storeLock && Date.now() >= lockExpires;
        // set when this call first starts uploading, chunks created since then may be its own leftovers
        let uploadStarted;

        let attachmentCallback = (...args) => {
            let lock = storeLock;
            // unset variable to prevent double releasing
            storeLock = false;
            clearInterval(renewTimer);

            const finish = () => {
                if (returned) {
                    // might be already finished if retrying after delay
                    return;
                }
                returned = true;
                callback(...args);
            };

            if (!lock) {
                return finish();
            }
            log.silly('GridStore', 'UNLOCK lock=%s', lockId);
            this.lock.releaseLock(lock, finish);
        };

        // the dedup probe and, on a miss, the upload; retried on a race
        let tryStore;

        // A new attachment is uploaded under its lock, so no two processes upload the same attachment at
        // the same time, and chunks without a files record are always left over: by an earlier attempt of
        // this upload, or by an upload or deletion that did not finish. NB! Setting lock ttl too high has a
        // downside that restarting the process would still keep the lock and thus anyone trying to store the
        // message would have to wait
        let acquireLock = done => {
            if (storeLock) {
                return done();
            }

            // a holder that renews its lock for a stuck upload must not keep every other delivery of this
            // attachment waiting forever: give up after a lock's lifetime, the store is retried later
            this.lock.waitAcquireLock(lockId, LOCK_TTL, LOCK_TTL, (err, lock) => {
                if (!err && !lock.success) {
                    err = new Error('Failed to get lock');
                }
                if (err) {
                    return attachmentCallback(err);
                }

                storeLock = lock;
                log.silly('GridStore', 'LOCK lock=%s', lockId);
                // a slow upload keeps the lock, so nobody else treats its chunks as leftovers
                lockExpires = Date.now() + LOCK_TTL;
                renewTimer = setInterval(() => {
                    let renewalStarted = Date.now();
                    this.lock.extendLock(lock, LOCK_TTL).then(
                        result => {
                            lockExpires = result.success && lockExpires ? renewalStarted + LOCK_TTL : 0;
                        },
                        () => {
                            lockExpires = 0;
                        }
                    );
                }, LOCK_TTL / 4);
                renewTimer.unref();
                return tryStore(); // start from over, the attachment may have been stored meanwhile
            });
        };

        let tryCount = 0;

        // an upload error is most probably a collision with chunks left behind, which are removed before the
        // next attempt. If another process stored the attachment meanwhile, its record stays and the next
        // attempt adds a reference to it
        let onStoreError = err => {
            if (returned) {
                return;
            }

            if (tryCount++ >= 20 || lostLock()) {
                // without the lock other processes may be uploading, their chunks are not ours to remove
                return attachmentCallback(err);
            }

            setTimeout(
                () => {
                    if (returned) {
                        return;
                    }
                    if (lostLock()) {
                        // lost while the retry waited: another process may hold the lock and be uploading now
                        return attachmentCallback(err);
                    }
                    this.cleanupGarbage(
                        id,
                        uploadStarted,
                        () => !lostLock(),
                        cleanupErr => {
                            if (lostLock()) {
                                // lost during the cleanup: the next attempt would upload without the lock
                                return attachmentCallback(err);
                            }
                            if (cleanupErr) {
                                // the next attempt runs into the same chunks and tries again
                                log.error('GridStore', 'Failed to remove leftover chunks of %s: %s', id.toString('hex'), cleanupErr.message);
                            }
                            tryStore();
                        }
                    );
                },
                10 + 100 * Math.random()
            );
        };

        tryStore = () => {
            if (returned) {
                // might be already finished if retrying after delay
                return;
            }

            this.gridfs.collection(this.bucketName + '.files').findOneAndUpdate(
                {
                    _id: id
                },
                {
                    $inc: {
                        'metadata.c': 1,
                        'metadata.m': attachment.magic
                    },
                    $set: {
                        'metadata.cu': new Date()
                    }
                },
                {
                    returnDocument: 'after'
                },
                (err, result) => {
                    if (err) {
                        return attachmentCallback(err);
                    }

                    if (result && result.value) {
                        // already exists
                        return attachmentCallback(null, id, result.value.metadata.fileContentHash);
                    }

                    acquireLock(() => {
                        // try to insert it
                        let store;
                        let metadata;
                        try {
                            let prepared = prepare();
                            metadata = prepared.metadata;
                            uploadStarted = uploadStarted || Date.now();
                            store = this.gridstore.openUploadStreamWithId(id, null, {
                                contentType: attachment.contentType,
                                metadata
                            });
                            store.once('error', onStoreError);
                            store.once('finish', () => attachmentCallback(null, id, metadata.fileContentHash));
                            store.end(prepared.data);
                        } catch (err) {
                            // releases the lock and stops renewing it
                            attachmentCallback(err);
                        }
                    });
                }
            );
        };

        tryStore();
    }

    /**
     * Streams a byte range of an attachment body as it appeared in the message
     *
     * @param {Buffer} id Attachment id (hash)
     * @param {Object} attachmentData Result of get()
     * @param {Object} [options] `{ startFrom, maxLength }` window relative to the body start, whole body when omitted
     * @returns {Readable}
     */
    createReadStream(id, attachmentData, options) {
        return createReadWindow(
            (start, end) => {
                let stream = this.gridstore.openDownloadStream(id, { start, end });
                // the driver closes its cursor on abort() only, a destroyed download would keep it open on the
                // server until it times out
                if (typeof stream.abort === 'function') {
                    stream._destroy = (err, done) => {
                        stream.abort().then(
                            () => done(err),
                            () => done(err)
                        );
                    };
                }
                return stream;
            },
            attachmentData,
            options
        );
    }

    /**
     * Deletes the chunks of an attachment whose record is already gone. A message stored since then may
     * have uploaded the same attachment again under the same id; its chunks are new, so only chunks older
     * than an hour are deleted, which every chunk of a record old enough to be collected is
     *
     * @param {Buffer} id Attachment id
     */
    async deletePayload(id) {
        return await this.gridfs.collection(this.bucketName + '.chunks').deleteMany({ files_id: id, _id: { $lt: idAt(Date.now() - STALE_CHUNK_AGE) } });
    }

    /**
     * Removes chunks that have no files record and can not belong to a live upload: chunks old enough to be
     * abandoned, and chunks created since `uploadStarted` by the caller, which holds the lock of the
     * attachment, so they are its own
     *
     * @param {Buffer} id Attachment id
     * @param {Number} uploadStarted When the caller started its first upload attempt
     * @param {Function} owned Returns false once the caller lost the lock, then nothing is removed
     * @param {Function} next Called with `(err, deletedCount)`
     */
    cleanupGarbage(id, uploadStarted, owned, next) {
        this.gridfs.collection(this.bucketName + '.files').findOne({ _id: id }, { projection: { _id: true } }, (err, file) => {
            if (err) {
                return next(err);
            }
            if (file || !owned()) {
                // attachment entry exists, or the lock was lost meanwhile: do nothing
                return next(null, 0);
            }

            this.gridfs.collection(this.bucketName + '.chunks').deleteMany(
                {
                    files_id: id,
                    // own chunks carry the clock of this host, so they are not older than uploadStarted (to the second)
                    $or: [{ _id: { $lt: idAt(Date.now() - ABANDONED_CHUNK_AGE) } }, { _id: { $gte: idAt(uploadStarted) } }]
                },
                (err, info) => {
                    if (err) {
                        return next(err);
                    }
                    next(null, info.deletedCount);
                }
            );
        });
    }
}

module.exports = GridstoreStorage;
