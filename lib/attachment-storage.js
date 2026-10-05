'use strict';

const GridstoreStorage = require('./attachments/gridstore-storage.js');
const S3Storage = require('./attachments/s3-storage.js');
const AttachmentLock = require('./attachments/attachment-lock.js');
const AttachmentCatalog = require('./attachments/catalog.js');
const crypto = require('crypto');
const log = require('npmlog');
const metrics = require('./metrics');

const CHUNK_SIZE = 64 * 1024; // chunk size for calculating hashes
// after an S3 upload fails, new attachments go to GridFS for this long
const S3_PAUSE = 30 * 1000;

/**
 * True for an S3 failure that may go away by itself (no response, a timeout, a server error, throttling),
 * false when S3 refused the request (access denied, missing bucket, bad request), which needs fixing
 */
function isS3Outage(err) {
    const status = err.$metadata && err.$metadata.httpStatusCode;
    return !(status >= 400 && status < 500 && status !== 429);
}

class AttachmentStorage {
    constructor(options) {
        this.options = options || {};

        this.type = (this.options.options && this.options.options.type) || 'gridstore';
        if (!['gridstore', 's3'].includes(this.type)) {
            throw new Error(`Unknown attachment storage type: ${this.type}`);
        }
        this.gridstore = new GridstoreStorage(this.options);
        this.s3 =
            this.type === 's3' || (this.options.options && this.options.options.s3 && this.options.options.s3.bucket) ? new S3Storage(this.options) : null;
        this.catalog = new AttachmentCatalog(this.gridstore.gridfs, this.gridstore.bucketName, this.options.options && this.options.options.writeConcern);
        this.lock = new AttachmentLock(this.options.redis);
        this.s3PausedUntil = 0;
    }

    async get(attachmentId) {
        const data = await this.catalog.get(attachmentId);
        this.backend(data.metadata, data.length);
        return data;
    }

    create(attachment, callback) {
        this.calculateHash(attachment.body, (err, hash) => {
            if (err) {
                return callback(err);
            }
            if (this.type === 'gridstore') {
                return this.gridstore.create(attachment, hash, callback);
            }
            this.createS3(attachment, Buffer.from(hash, 'hex')).then(result => callback(null, ...result), callback);
        });
    }

    /**
     * Stores an attachment with S3 as the preferred backend. A known attachment, wherever its payload is,
     * only gets a reference: one atomic update and no lock. A new one is uploaded under its lock, so many
     * messages carrying it at the same time upload it once
     *
     * @returns {Array} `[id, fileContentHash]`
     */
    async createS3(attachment, id) {
        const reference = async () => {
            const file = await this.catalog.increment(id, attachment.magic);
            return file && [id, file.metadata.fileContentHash];
        };
        const known = await reference();
        if (known) {
            return known;
        }
        if (Date.now() < this.s3PausedUntil) {
            // S3 failed a moment ago, do not make every message wait for it to fail again
            return await this.createGridFS(attachment, id);
        }
        const attempt = { uploading: false, uploaded: false };
        try {
            return await this.lock.run(id, async () => (await reference()) || (await this.uploadS3(attachment, id, reference, attempt)));
        } catch (err) {
            if (!attempt.uploading || attempt.uploaded) {
                // not an S3 failure, or the record may have been stored
                throw err;
            }
            // the record says where the payload is, so this one attachment can live in GridFS, and mail keeps
            // flowing while S3 is down. The migration script moves it later. A request S3 refused (access denied,
            // missing bucket, checksum mismatch) is a configuration problem rather than an outage
            const reason = isS3Outage(err) ? 'unavailable' : 'rejected';
            log[reason === 'rejected' ? 'error' : 'warn'](
                'AttachmentStorage',
                'S3 upload %s for %s, storing in GridFS: %s',
                reason,
                id.toString('hex'),
                err.message
            );
            metrics.recordAttachmentFallback(reason);
            this.s3PausedUntil = Date.now() + S3_PAUSE;
            return await this.createGridFS(attachment, id);
        }
    }

    createGridFS(attachment, id) {
        return new Promise((resolve, reject) =>
            this.gridstore.create(attachment, id.toString('hex'), (err, storedId, fileContentHash) =>
                err ? reject(err) : resolve([storedId, fileContentHash])
            )
        );
    }

    async uploadS3(attachment, id, reference, attempt) {
        const prepared = this.s3.prepare(attachment);
        // a verbatim body was already hashed for its id
        const checksum = prepared.body === attachment.body ? id : crypto.createHash('sha256').update(prepared.body).digest();
        const fileContentHash = checksum.toString('base64');
        attempt.uploading = true;
        try {
            await this.s3.store(id, prepared.body, prepared.body.length, checksum, async location => {
                attempt.uploaded = true;
                await this.catalog.insert(id, {
                    length: prepared.body.length,
                    contentType: attachment.contentType,
                    metadata: { ...prepared.metadata, fileContentHash, storage: { version: 1, backend: 's3', ...location } }
                });
                return true;
            });
        } catch (err) {
            // a writer that holds no lock (an older version, or one that lost its lease) stored it meanwhile
            const stored = err.code === 11000 && (await reference());
            if (stored) {
                return stored;
            }
            throw err;
        }
        return [id, fileContentHash];
    }

    createReadStream(id, attachmentData, options) {
        return this.backend(attachmentData.metadata, attachmentData.length) === 's3'
            ? this.s3.createReadStream(id, attachmentData, options)
            : this.gridstore.createReadStream(id, attachmentData, options);
    }

    updateMany(ids, count, magic, callback) {
        const operation = this.catalog.updateMany(ids, count, magic);
        if (typeof callback === 'function') {
            operation.then(result => callback(null, result), callback);
            return;
        }
        return operation;
    }

    async deleteManyAsync(ids, magic) {
        const deletePromises = ids.map(id => this.deleteAsync(id, magic));
        await Promise.all(deletePromises);
        return true;
    }

    async deleteAsync(id, magic) {
        return await this.catalog.decrement(id, magic);
    }

    delete(id, magic, callback) {
        this.catalog.decrement(id, magic).then(result => callback(null, result), callback);
    }

    deleteOrphaned(callback) {
        this.deleteOrphanedAsync().then(count => callback(null, count), callback);
    }

    backend(metadata, length) {
        const location = metadata && metadata.storage;
        if (!location || !location.backend || location.backend === 'gridfs') {
            return 'gridfs';
        }
        if (
            location.backend === 's3' &&
            location.version === 1 &&
            typeof location.bucket === 'string' &&
            location.bucket &&
            typeof location.key === 'string' &&
            location.key &&
            Number.isSafeInteger(location.length) &&
            location.length >= 0
        ) {
            if (!this.s3) {
                throw new Error('S3 attachment exists but S3 access is not configured');
            }
            if (length !== undefined && location.length !== length) {
                throw new Error('S3 attachment metadata length mismatch');
            }
            return 's3';
        }
        throw new Error('Invalid attachment storage metadata');
    }

    /**
     * Deletes attachments that no message has referenced for a while. The record goes first, with a
     * condition that it is still unreferenced, so a message stored at the same time either finds the record
     * and keeps it, or misses it and stores a new copy that the payload deletion can not touch: GridFS only
     * deletes chunks that are older than any new upload, S3 deletes the one write-once key of the old copy.
     * A tombstone written before the record is removed makes sure the payload is deleted even when this
     * process stops or the storage fails in between.
     *
     * @returns {Number} Number of collected attachments
     */
    async deleteOrphanedAsync() {
        // after one S3 failure the rest of the pass leaves S3 alone, instead of piling up tombstones
        const pass = { s3Failed: false, refusals: 0 };
        await this.sweepTombstones(pass);
        let deleted = 0;
        // S3 records this pass can not collect are left out, so they do not take up the batch
        for (const candidate of await this.catalog.findOrphans({ skipS3: !this.s3 || pass.s3Failed })) {
            try {
                if (await this.collectOrphan(candidate, pass)) {
                    deleted++;
                }
            } catch (err) {
                // Leave failures for the next pass. They must not stop other candidates.
                log.error('AttachmentStorage', 'Failed to delete orphan %s: %s', candidate._id.toString('hex'), err.message);
            }
        }
        return deleted;
    }

    async collectOrphan(candidate, pass) {
        // throws for a record this process can not resolve, which is then left alone
        const location = this.backend(candidate.metadata, candidate.length) === 's3' ? candidate.metadata.storage : null;
        if (location && pass.s3Failed) {
            return false;
        }
        const tombstone = await this.catalog.addTombstone(candidate._id, location);
        if (!(await this.catalog.removeOrphan(candidate._id, location && location.key))) {
            await this.catalog.removeTombstone(tombstone);
            return false;
        }
        await this.releasePayload(tombstone, null, pass);
        return true;
    }

    /**
     * Finishes collections that stopped between writing a tombstone and deleting the payload
     */
    async sweepTombstones(pass) {
        for (const tombstone of await this.catalog.findStaleTombstones()) {
            if (tombstone.key && (pass.s3Failed || !this.s3)) {
                continue;
            }
            try {
                // the collection may have stopped before removing the record, or the attachment was stored again
                await this.releasePayload(tombstone, await this.catalog.find(tombstone.attachment), pass);
            } catch (err) {
                log.error('AttachmentStorage', 'Failed to delete payload of %s: %s', tombstone.attachment.toString('hex'), err.message);
                if (err.refused) {
                    // retry it after the others
                    await this.catalog.requeueTombstone(tombstone).catch(() => false);
                }
            }
        }
    }

    /**
     * Deletes what a tombstone describes, except what the current record of the attachment uses
     *
     * @param {Object} tombstone From addTombstone()
     * @param {Object|null} record Current catalog record of the attachment
     * @param {Object} pass State of the collection pass
     */
    async releasePayload(tombstone, record, pass) {
        const storage = record && record.metadata.storage;
        if (tombstone.key && !(storage && storage.key === tombstone.key)) {
            try {
                await this.s3.deletePayload(tombstone);
                pass.refusals = 0;
            } catch (err) {
                if (['NoSuchBucket', 'NoSuchKey', 'NotFound'].includes(err.name)) {
                    // already gone
                    if (err.name === 'NoSuchBucket') {
                        log.warn('AttachmentStorage', 'Bucket %s of attachment %s does not exist', tombstone.bucket, tombstone.attachment.toString('hex'));
                    }
                } else {
                    // a refusal (access denied) may concern one object, a few in a row most likely concern all of them
                    if (isS3Outage(err) || ++pass.refusals >= 3) {
                        pass.s3Failed = true;
                    }
                    err.refused = !isS3Outage(err);
                    throw err;
                }
            }
        }
        // old chunks of the attachment go too, whatever stored it: those of a GridFS record, of a record migrated
        // to S3, or left by an upload that stopped before the attachment came back in S3. Chunks of a live GridFS
        // record may be older than an hour, so they only go when the record does not use them
        if (!record || (storage && storage.backend === 's3' && !storage.migratedAt)) {
            await this.gridstore.deletePayload(tombstone.attachment);
        }
        await this.catalog.removeTombstone(tombstone);
    }

    calculateHash(input, callback) {
        let algo = 'sha256';

        let hash = crypto.createHash(algo);

        let chunkPos = 0;
        let nextChunk = () => {
            try {
                if (chunkPos >= input.length) {
                    let result = hash.digest('hex');
                    return callback(null, result);
                }

                if (!chunkPos && CHUNK_SIZE >= input.length) {
                    // fits all
                    hash.update(input);
                } else if (chunkPos + CHUNK_SIZE >= input.length) {
                    // final chunk
                    hash.update(input.slice(chunkPos));
                } else {
                    // middle chunk
                    hash.update(input.slice(chunkPos, chunkPos + CHUNK_SIZE));
                }

                chunkPos += CHUNK_SIZE;
                return setImmediate(nextChunk);
            } catch (E) {
                return callback(E);
            }
        };

        setImmediate(nextChunk);
    }
}

module.exports = AttachmentStorage;
