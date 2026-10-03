'use strict';

const GridFSBucket = require('mongodb').GridFSBucket;
const RedFour = require('ioredfour');
const errors = require('../errors');
const log = require('npmlog');
const crypto = require('crypto');
const prepareAttachment = require('./prepare-attachment');
const { getReadOptions, createOutputStream, pipeAttachment } = require('./attachment-stream');
const FileHashCalculatorStream = require('../filehash-stream');

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

    create(attachment, hash, callback) {
        hash = Buffer.from(hash, 'hex');
        let returned = false;

        let id = hash;
        const { body, metadata } = prepareAttachment(attachment, this.decodeBase64);

        if (isNaN(metadata.m) || typeof metadata.m !== 'number') {
            errors.notify(new Error('Invalid magic "' + metadata.m + '" for ' + id));
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
                        fileHashCalculator.end(body);
                    });
                }
            );
        };

        tryStore();
    }

    createReadStream(id, attachmentData, options) {
        options = options || {};

        const { streamOptions, encoderOptions, outputLength } = getReadOptions(attachmentData, options);

        log.silly(
            'GridStore',
            'STREAM id=%s src_len=%s src_start=%s src_end=%s dst_start=%s dst_end=%s',
            id.toString('hex'),
            attachmentData && attachmentData.length,
            streamOptions.start,
            streamOptions.end,
            options.startFrom,
            options.startFrom + options.maxLength
        );

        const input = this.gridstore.openDownloadStream(id, streamOptions);
        const output = createOutputStream(outputLength);
        output._options = { options, streamOptions };
        pipeAttachment(input, output, encoderOptions);
        return output;
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
