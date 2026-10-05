'use strict';

const GridFSBucket = require('mongodb').GridFSBucket;
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

        let instance = crypto.randomBytes(8).toString('hex');
        let lockId = 'gs.' + id.toString('base64');
        let storeLock;

        let attachmentCallback = (...args) => {
            let lock = storeLock;
            // unset variable to prevent double releasing
            storeLock = false;

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
            log.silly('GridStore', '[%s] UNLOCK lock=%s', instance, lockId);
            this.lock.releaseLock(lock, finish);
        };

        // the dedup probe and, on a miss, the upload; retried on a race
        let tryStore;

        // Using locks is required to prevent multiple processes storing the same large attachment at
        // the same time. A single chunk attachment needs none. NB! Setting lock ttl too high has a
        // downside that restarting the process would still keep the lock and thus anyone trying to
        // store the message would have to wait
        let acquireLockIfLarge = done => {
            if (storeLock || prepare().data.length < 255 * 1024) {
                return done();
            }

            this.lock.waitAcquireLock(lockId, 2 * 60 * 1000 /* Lock expires after 2min if not released */, false, (err, lock) => {
                if (!err && !lock.success) {
                    err = new Error('Failed to get lock');
                }
                if (err) {
                    return attachmentCallback(err);
                }

                storeLock = lock;
                log.silly('GridStore', '[%s] LOCK lock=%s', instance, lockId);
                return tryStore(); // start from over
            });
        };

        let tryCount = 0;

        // an upload error is most probably a race with another process storing the same attachment, or
        // chunks left behind by an attachment that was deleted while being stored
        let onStoreError = err => {
            if (returned) {
                return;
            }

            if (tryCount++ >= 20) {
                return attachmentCallback(err);
            }

            if (err.code !== 11000 && !/\.chunks /.test(err.message)) {
                return setTimeout(tryStore, 10);
            }

            // Partial chunks detected. Might be because of:
            // * another process is inserting the same attachment and thus no "files" entry yet (should not happened though due to locking)
            // * previously deleted attachment that has not been properly removed

            // Load data for an existing chunk to see the age of it
            this.gridfs.collection(this.bucketName + '.chunks').findOne({ files_id: id }, { projection: { _id: true } }, (err, data) => {
                if (err) {
                    // whatever
                    return setTimeout(tryStore, 100 + 200 * Math.random());
                }

                if (!data || !data._id) {
                    // try again, no chunks found
                    return setTimeout(tryStore, 10);
                }

                // Check how old is the previous chunk
                let timestamp = data._id.getTimestamp();
                if (timestamp && typeof timestamp.getTime === 'function' && timestamp.getTime() >= Date.now() - 30 * 60 * 1000) {
                    // chunk is newer than 30 minutes, assume race condition and try again after a while
                    return setTimeout(tryStore, 300 + 200 * Math.random());
                }

                // partial chunks for a probably deleted message detected, try to clean up
                setTimeout(
                    () => {
                        if (returned) {
                            return;
                        }
                        this.cleanupGarbage(id, tryStore);
                    },
                    100 + 200 * Math.random()
                );
            });
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
                        return attachmentCallback(null, result.value._id, result.value.metadata.fileContentHash);
                    }

                    acquireLockIfLarge(() => {
                        // try to insert it
                        let { data, metadata } = prepare();
                        let store = this.gridstore.openUploadStreamWithId(id, null, {
                            contentType: attachment.contentType,
                            metadata
                        });

                        store.once('error', onStoreError);
                        store.once('finish', () => attachmentCallback(null, id, metadata.fileContentHash));
                        store.end(data);
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
        return createReadWindow((start, end) => this.gridstore.openDownloadStream(id, { start, end }), attachmentData, options);
    }

    async deletePayload(id) {
        return await this.gridfs.collection(this.bucketName + '.chunks').deleteMany({ files_id: id });
    }

    cleanupGarbage(id, next) {
        this.gridfs.collection(this.bucketName + '.files').findOne(
            {
                _id: id
            },
            (err, file) => {
                if (err) {
                    return next(err);
                }
                if (file) {
                    // attachment entry exists, do nothing
                    return next(null, false);
                }

                // orphaned attachment, delete data chunks
                this.gridfs.collection(this.bucketName + '.chunks').deleteMany(
                    {
                        files_id: id
                    },
                    (err, info) => {
                        if (err) {
                            return next(err);
                        }
                        next(null, info.deletedCount);
                    }
                );
            }
        );
    }
}

module.exports = GridstoreStorage;
