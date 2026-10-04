'use strict';

const GridFSBucket = require('mongodb').GridFSBucket;
const RedFour = require('ioredfour');
const errors = require('../errors');
const log = require('npmlog');
const crypto = require('crypto');
const { inspectBase64, createReadWindow } = require('./base64-codec');

const ORPHANED_ATTACHMENTS_DELAY = 24 * 3600 * 1000;
const MAX_ORPHANED_ATTACHMENTS = 1000;

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

    async get(attachmentId) {
        let attachmentData = await this.gridfs.collection(this.bucketName + '.files').findOne({
            _id: attachmentId
        });

        if (!attachmentData) {
            const err = new Error('This attachment does not exist');
            err.responseCode = 404;
            err.code = 'FileNotFound';
            throw err;
        }

        return {
            contentType: attachmentData.contentType,
            transferEncoding: attachmentData.metadata.transferEncoding,
            length: attachmentData.length,
            count: attachmentData.metadata.c,
            hash: attachmentData._id,
            metadata: attachmentData.metadata
        };
    }

    create(attachment, hash, callback) {
        let id = Buffer.from(hash, 'hex');
        let returned = false;

        let metadata = {
            m: attachment.magic,
            c: 1,
            cu: new Date(),
            esize: attachment.body.length,
            transferEncoding: attachment.transferEncoding
        };

        if (isNaN(metadata.m) || typeof metadata.m !== 'number') {
            errors.notify(new Error('Invalid magic "' + metadata.m + '" for ' + id));
        }

        // the bytes written to the store: the body itself, or its decoded form when that can be
        // re-encoded byte for byte
        let storedBody = attachment.body;

        if (attachment.transferEncoding === 'base64' && this.decodeBase64) {
            let base64 = inspectBase64(attachment.body);
            if (base64) {
                metadata.decoded = true;
                metadata.lineLen = base64.lineLen;
                storedBody = base64.data;
            }
        }

        // hash of the stored bytes, for clients that want to identify the file
        let fileContentHash = crypto.createHash('sha256').update(storedBody).digest('base64');
        metadata.fileContentHash = fileContentHash;

        let instance = crypto.randomBytes(8).toString('hex');
        let lockId = 'gs.' + id.toString('base64');
        let storeLock;

        let attachmentCallback = (...args) => {
            const finalizeCallback = () => {
                if (returned) {
                    // might be already finished if retrying after delay
                    return;
                }
                returned = true;
                callback(...args);
            };

            if (storeLock) {
                log.silly('GridStore', '[%s] UNLOCK lock=%s status=%s', instance, lockId, storeLock.success ? 'locked' : 'empty');

                let lock = storeLock;
                // unset variable to prevent double releasing
                storeLock = false;

                if (lock.success) {
                    return this.lock.releaseLock(lock, finalizeCallback);
                }
                return finalizeCallback();
            }

            finalizeCallback();
        };

        let tryCount = 0;
        let tryStore = () => {
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
                        return attachmentCallback(null, result.value._id, result.value.metadata && result.value.metadata.fileContentHash);
                    }

                    let checkLock = done => {
                        if (storeLock) {
                            // continue processing, we have a lock
                            return done();
                        }

                        if (storedBody.length < 255 * 1024) {
                            // a single chunk attachment, no need for locking
                            return done();
                        }

                        // Try to get a lock
                        // Using locks is required to prevent multiple messages storing the same large attachment at
                        // the same time.
                        // NB! Setting lock ttl too high has a downside that restarting the process would still keep
                        // the lock and thus anyone trying to store the message would have to wait
                        this.lock.waitAcquireLock(lockId, 2 * 60 * 1000 /* Lock expires after 3min if not released */, false, (err, lock) => {
                            if (!err && !lock.success) {
                                err = new Error('Failed to get lock');
                            }
                            if (err) {
                                if (returned) {
                                    return;
                                }
                                return attachmentCallback(err);
                            }

                            storeLock = lock;
                            log.silly('GridStore', '[%s] LOCK lock=%s status=%s', instance, lockId, storeLock.success ? 'locked' : 'empty');
                            return tryStore(); // start from over
                        });
                    };

                    checkLock(() => {
                        // try to insert it
                        let store = this.gridstore.openUploadStreamWithId(id, null, {
                            contentType: attachment.contentType,
                            metadata
                        });

                        store.once('error', err => {
                            if (returned) {
                                return;
                            }
                            // most probably a race condition, try again
                            if (tryCount++ < 20) {
                                if (err.code === 11000 || /\.chunks /.test(err.message)) {
                                    // Partial chunks detected. Might be because of:
                                    // * another process is inserting the same attachment and thus no "files" entry yet (should not happened though due to locking)
                                    // * previously deleted attachment that has not been properly removed

                                    // Load data for an existing chunk to see the age of it
                                    return this.gridfs.collection(this.bucketName + '.chunks').findOne(
                                        {
                                            files_id: id
                                        },
                                        {
                                            projection: {
                                                _id: true
                                            }
                                        },
                                        (err, data) => {
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
                                        }
                                    );
                                } else {
                                    return setTimeout(tryStore, 10);
                                }
                            } else {
                                attachmentCallback(err);
                            }
                        });

                        store.once('finish', () => attachmentCallback(null, id, fileContentHash));
                        store.end(storedBody);
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

    delete(id, magic, callback) {
        if (isNaN(magic) || typeof magic !== 'number') {
            errors.notify(new Error('Invalid magic "' + magic + '" for ' + id));
        }
        this.gridfs.collection(this.bucketName + '.files').findOneAndUpdate(
            {
                _id: id
            },
            {
                $inc: {
                    'metadata.c': -1,
                    'metadata.m': -magic
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
                    return callback(err);
                }

                if (!result || !result.value) {
                    return callback(null, false);
                }

                // attachments are not deleted here: deleteOrphaned() removes them after a delay, which
                // gives a message that arrives in the meantime the chance to reuse the entry
                return callback(null, true);
            }
        );
    }

    update(ids, count, magic, callback) {
        if (isNaN(magic) || typeof magic !== 'number') {
            errors.notify(new Error('Invalid magic "' + magic + '" for ' + ids));
        }
        // update attachments
        return this.gridfs.collection(this.bucketName + '.files').updateMany(
            {
                _id: Array.isArray(ids)
                    ? {
                          $in: ids
                      }
                    : ids
            },
            {
                $inc: {
                    'metadata.c': count,
                    'metadata.m': magic
                },
                $set: {
                    'metadata.cu': new Date()
                }
            },
            {
                multi: true,
                writeConcern: 1
            },
            callback
        );
    }

    deleteOrphaned(callback) {
        // NB! scattered query
        let cursor = this.gridfs.collection(this.bucketName + '.files').find(
            {
                'metadata.c': 0,
                'metadata.m': 0,
                $or: [
                    {
                        'metadata.cu': null
                    },
                    {
                        'metadata.cu': {
                            $lt: new Date(Date.now() - ORPHANED_ATTACHMENTS_DELAY)
                        }
                    }
                ]
            },
            {
                hint: 'related_attachments_cu',
                comment: 'List orphaned attachments',
                maxTimeMS: 2 * 60 * 1000,
                limit: MAX_ORPHANED_ATTACHMENTS
            }
        );

        let deleted = 0;
        let processNext = () => {
            cursor.next((err, attachment) => {
                if (err) {
                    return callback(err);
                }
                if (!attachment) {
                    return cursor.close(() => {
                        // delete all attachments that do not have any active links to message objects
                        callback(null, deleted);
                    });
                }

                if (attachment.metadata && attachment.metadata.c) {
                    // skip
                    return processNext();
                }

                // delete file entry first
                this.gridfs.collection(this.bucketName + '.files').deleteOne(
                    {
                        _id: attachment._id,
                        // make sure that we do not delete a message that is already re-used
                        'metadata.c': 0,
                        'metadata.m': 0
                    },
                    err => {
                        if (err) {
                            return processNext();
                        }

                        // delete data chunks
                        // a failure here leaves orphaned chunks behind, which is tolerable
                        this.gridfs.collection(this.bucketName + '.chunks').deleteMany({ files_id: attachment._id }, () => {
                            deleted++;
                            processNext();
                        });
                    }
                );
            });
        };

        processNext();
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
