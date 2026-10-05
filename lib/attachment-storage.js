'use strict';

const GridstoreStorage = require('./attachments/gridstore-storage.js');
const S3Storage = require('./attachments/s3-storage.js');
const AttachmentLock = require('./attachments/attachment-lock.js');
const AttachmentCatalog = require('./attachments/catalog.js');
const crypto = require('crypto');
const log = require('npmlog');

const CHUNK_SIZE = 64 * 1024; // chunk size for calculating hashes

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
            const id = Buffer.from(hash, 'hex');
            this.lock
                .run(id, async assertOwned => {
                    const existing = await this.catalog.find(id);
                    if (existing) {
                        // Do not add a reference when this process cannot resolve the stored backend.
                        this.backend(existing.metadata, existing.length);
                        assertOwned();
                        if (await this.catalog.increment(id, attachment.magic)) {
                            return [id];
                        }
                        // collected since find(), store a new copy
                    }
                    if (this.type === 'gridstore') {
                        assertOwned();
                        return await new Promise((resolve, reject) => {
                            this.gridstore.create(attachment, hash, (createErr, createdId, fileContentHash) =>
                                createErr ? reject(createErr) : resolve([createdId, fileContentHash])
                            );
                        });
                    }
                    const prepared = this.s3.prepare(attachment);
                    // a verbatim body was already hashed for its id
                    const checksum = prepared.body === attachment.body ? id : crypto.createHash('sha256').update(prepared.body).digest();
                    const fileContentHash = checksum.toString('base64');
                    await this.s3.store(id, prepared.body, prepared.body.length, checksum, async location => {
                        await this.catalog.insert(id, {
                            length: prepared.body.length,
                            contentType: attachment.contentType,
                            metadata: { ...prepared.metadata, fileContentHash, storage: { version: 1, backend: 's3', ...location } }
                        });
                        return true;
                    });
                    return [id, fileContentHash];
                })
                .then(result => callback(null, ...result), callback);
        });
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
        const pass = { s3Failed: false };
        await this.sweepTombstones(pass);
        let deleted = 0;
        for (const candidate of await this.catalog.findOrphans()) {
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
        if (tombstone.key && !(record && record.metadata.storage && record.metadata.storage.key === tombstone.key)) {
            try {
                await this.s3.deletePayload(tombstone);
            } catch (err) {
                pass.s3Failed = true;
                throw err;
            }
        }
        // chunks of a live record may be older than an hour, only a missing record lets chunks go
        if (tombstone.chunks && !record) {
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
