'use strict';

const GridFSBucket = require('mongodb').GridFSBucket;
const libbase64 = require('libbase64');
const RedFour = require('ioredfour');
const errors = require('../errors');
const log = require('npmlog');
const crypto = require('crypto');
const base64Offset = require('./base64-offset');
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

        if (FEATURE_DECODE_ATTACHMENTS && attachment.transferEncoding === 'base64' && this.decodeBase64) {
            let lineLen = 0;
            let expectBr = false;
            //find out the length of first line
            for (let i = 0, len = Math.min(1000, attachment.body.length); i < len; i++) {
                let chr = attachment.body[i];
                if (expectBr && chr === 0x0a) {
                    // found line ending
                    break;
                } else if (expectBr) {
                    // unexpected char, do not process
                    lineLen = 0;
                    break;
                } else if (
                    (chr >= 0x30 /*0*/ && chr <= 0x39) /*9*/ ||
                    (chr >= 0x41 /* A */ && chr <= 0x5a) /*Z*/ ||
                    (chr >= 0x61 /* a */ && chr <= 0x7a) /*z*/ ||
                    chr === 0x2b /*+*/ ||
                    chr === 0x2f /*/*/ ||
                    chr === 0x3d /*=*/
                ) {
                    lineLen++;
                } else if (chr === 0x0d) {
                    expectBr = true;
                } else {
                    // unexpected char, do not process
                    lineLen = 0;
                    break;
                }
            }

            if (lineLen && lineLen <= 998) {
                if (attachment.body.length === lineLen && lineLen < 76) {
                    lineLen = 76;
                }

                // check if expected line count matches with attachment line count
                let expectedLineCount = Math.ceil(attachment.body.length / (lineLen + 2));

                // allow 1 line shift
                if (attachment.lineCount >= expectedLineCount - 1 && attachment.lineCount <= expectedLineCount + 1) {
                    metadata.decoded = true;
                    metadata.lineLen = lineLen;
                }
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
                            if (tryCount++ < 5) {
                                if (/\.chunks /.test(err.message)) {
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
                                            if (timestamp && typeof timestamp.getTime === 'function' && timestamp.getTime() >= Date.now() - 5 * 60 * 1000) {
                                                // chunk is newer than 5 minutes, assume race condition and try again after a while
                                                return setTimeout(tryStore, 300 + 200 * Math.random());
                                            }

                                            // partial chunks for a probably deleted message detected, try to clean up
                                            setTimeout(() => {
                                                if (returned) {
                                                    return;
                                                }
                                                this.cleanupGarbage(id, tryStore);
                                            }, 100 + 200 * Math.random());
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

                        if (!metadata.decoded) {
                            fileHashCalculator.pipe(store);
                            fileHashCalculator.end(attachment.body);
                        } else {
                            let decoder = new libbase64.Decoder();
                            decoder.pipe(fileHashCalculator).pipe(store);
                            decoder.once('error', err => {
                                // pass error forward
                                store.emit('error', err);
                            });
                            decoder.end(attachment.body);
                        }
                    });
                }
            );
        };

        tryStore();
    }

    createReadStream(id, attachmentData, options) {
        options = options || {};

        let encoderOptions = {};
        let streamOptions = {};

        if (attachmentData && attachmentData.metadata) {
            encoderOptions.lineLength = attachmentData.metadata.lineLen;

            if (options && attachmentData.metadata.decoded) {
                let offsetOptions = base64Offset(attachmentData.metadata.lineLen, options.startFrom, options.maxLength);
                encoderOptions.skipStartBytes = offsetOptions.base64SkipStartBytes;
                encoderOptions.limitOutputBytes = offsetOptions.base64LimitBytes;
                encoderOptions.startPadding = offsetOptions.base64Padding;

                streamOptions.start = offsetOptions.binaryStartOffset || 0;
                if (offsetOptions.binaryEndOffset) {
                    streamOptions.end = offsetOptions.binaryEndOffset;
                }
            } else if (options && !attachmentData.metadata.decoded) {
                streamOptions.start = options.startFrom || 0;
                if (options.maxLength) {
                    streamOptions.end = streamOptions.start + options.maxLength;
                }
            }

            streamOptions.start = Math.min(
                streamOptions.start ?? 0, // Default to 0 if undefined/null
                attachmentData.length
            );

            streamOptions.end = Math.min(
                streamOptions.end ?? attachmentData.length, // Default to length if undefined/null
                attachmentData.length
            );

            if (streamOptions.start >= attachmentData.length) {
                // If start is at or beyond EOF, set both to EOF
                streamOptions.start = attachmentData.length;
                streamOptions.end = attachmentData.length;
            } else if (streamOptions.start >= streamOptions.end) {
                // If start >= end, clamp start to end (but not beyond file length)
                streamOptions.start = Math.min(streamOptions.end, attachmentData.length);
            }
        }

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

        let stream = this.gridstore.openDownloadStream(id, streamOptions);
        if (attachmentData && attachmentData.metadata.decoded) {
            let encoder = new libbase64.Encoder(encoderOptions);

            stream.once('error', err => {
                // pass error forward
                encoder.emit('error', err);
            });
            stream.pipe(encoder);

            return encoder;
        }

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
