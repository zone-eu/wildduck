'use strict';

const GridFSBucket = require('mongodb').GridFSBucket;
const RedFour = require('ioredfour');
const errors = require('../errors');
const log = require('npmlog');
const crypto = require('crypto');
const { inspectBase64, createEncodedStream } = require('./base64-codec');
const FileHashCalculatorStream = require('../filehash-stream');

// Set to false to disable base64 decoding feature
const FEATURE_DECODE_ATTACHMENTS = true;

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

    updateFileWithContentHashMetadata(args, hash, calculatedFileContentHash, callback) {
        this.gridfs.collection(this.bucketName + '.files').findOneAndUpdate(
            {
                _id: hash
            },
            {
                $set: {
                    'metadata.fileContentHash': calculatedFileContentHash
                }
            },
            {
                returnDocument: 'after'
            },
            () => callback(...args) // do not really care about error here. If error then highly likely the file has not been uploaded either
        );
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
        hash = Buffer.from(hash, 'hex');
        let returned = false;

        let id = hash;
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

        Object.keys(attachment.metadata || {}).forEach(key => {
            if (!(key in attachment.metadata)) {
                metadata[key] = attachment.metadata[key];
            }
        });

        // the bytes written to the store: the body itself, or its decoded form when that can be
        // re-encoded byte for byte
        let storedBody = attachment.body;

        if (FEATURE_DECODE_ATTACHMENTS && attachment.transferEncoding === 'base64' && this.decodeBase64) {
            let base64 = inspectBase64(attachment.body);
            if (base64) {
                metadata.decoded = true;
                metadata.lineLen = base64.lineLen;
                storedBody = base64.data;
            }
        }

        let instance = crypto.randomBytes(8).toString('hex');
        let lockId = 'gs.' + hash.toString('base64');
        let storeLock;

        let attachmentCallback = (...args) => {
            // store finished uploading, add the hash of the file contents to file metadata
            let calculatedFileContentHash;

            if (args.length > 2) {
                calculatedFileContentHash = args[2];
            }

            const finalizeCallback = () => {
                if (returned) {
                    // might be already finished if retrying after delay
                    return;
                }

                returned = true;
                if (calculatedFileContentHash) {
                    this.updateFileWithContentHashMetadata(args, hash, calculatedFileContentHash, callback);
                    return;
                }

                callback(...args);
            };

            if (storeLock) {
                log.silly('GridStore', '[%s] UNLOCK lock=%s status=%s', instance, lockId, storeLock.success ? 'locked' : 'empty');

                if (storeLock.success) {
                    // lock acquired
                    this.lock.releaseLock(storeLock, finalizeCallback);
                }

                if (!storeLock.success) {
                    // lock was not acquired
                    finalizeCallback();
                }

                // unset variable to prevent double releasing
                storeLock = false;
                return;
            }

            finalizeCallback();
        };

        let tryCount = 0;
        let tryStore = () => {
            if (returned) {
                // might be already finished if retrying after delay
                return;
            }

            let fileHashCalculator = new FileHashCalculatorStream();

            this.gridfs.collection(this.bucketName + '.files').findOneAndUpdate(
                {
                    _id: hash
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
                        return attachmentCallback(null, result.value._id);
                    }

                    let checkLock = done => {
                        if (storeLock) {
                            // continue processing, we have a lock
                            return done();
                        }

                        if (attachment.body.length < 255 * 1024) {
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
                                            files_id: hash
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

                        store.once('finish', () => attachmentCallback(null, id, fileHashCalculator.hash));

                        fileHashCalculator.pipe(store);
                        fileHashCalculator.end(storedBody);
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
        options = options || {};

        let metadata = (attachmentData && attachmentData.metadata) || {};
        let length = Number(attachmentData && attachmentData.length) || 0;

        if (metadata.decoded) {
            // base64 body stored decoded: re-encode the window the caller asked for
            return createEncodedStream((start, end) => this.gridstore.openDownloadStream(id, { start, end }), { length, lineLen: metadata.lineLen, esize: metadata.esize }, options);
        }

        let streamOptions = {};
        if (options.startFrom || options.maxLength) {
            streamOptions.start = Math.min(Math.max(Number(options.startFrom) || 0, 0), length);
            streamOptions.end = options.maxLength ? Math.min(streamOptions.start + Number(options.maxLength), length) : length;
        }

        log.silly(
            'GridStore',
            'STREAM id=%s src_len=%s src_start=%s src_end=%s dst_start=%s dst_end=%s',
            id.toString('hex'),
            length,
            streamOptions.start,
            streamOptions.end,
            options.startFrom,
            (options.startFrom || 0) + (options.maxLength || 0)
        );

        let stream = this.gridstore.openDownloadStream(id, streamOptions);
        stream._options = { options, streamOptions };

        return stream;
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

                /*
            // disabled as it is preferred that attachments are not deleted immediately but
            // after a while by a cleanup process. This gives the opportunity to reuse the
            // attachment

            if (result.value.metadata.c === 0 && result.value.metadata.m === 0) {
                return this.gridstore.delete(id, err => {
                    if (err) {
                        return callback(err);
                    }
                    callback(null, 1);
                });
            }
            */

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

                if (!attachment || (attachment.metadata && attachment.metadata.c)) {
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
                        this.gridfs.collection(this.bucketName + '.chunks').deleteMany(
                            {
                                files_id: attachment._id
                            },
                            err => {
                                if (err) {
                                    // ignore as we don't really care if we have orphans or not
                                }

                                deleted++;
                                processNext();
                            }
                        );
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
