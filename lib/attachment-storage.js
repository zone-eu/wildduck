'use strict';

const GridstoreStorage = require('./attachments/gridstore-storage.js');
const S3Storage = require('./attachments/s3-storage.js');
const RadosStorage = require('./attachments/rados-storage.js');
const AttachmentLock = require('./attachments/attachment-lock.js');
const AttachmentCatalog = require('./attachments/catalog.js');
const { storedLength } = require('./attachments/base64-codec.js');
const crypto = require('crypto');
const log = require('npmlog');

const CHUNK_SIZE = 64 * 1024; // chunk size for calculating hashes

// backends that keep each payload as write-once objects outside MongoDB, by `metadata.storage.backend`
const OBJECT_BACKENDS = ['s3', 'rados'];

/**
 * Backend of the payload a tombstone describes. S3 tombstones predate the backend field and are
 * recognized by their key
 */
function tombstoneBackend(tombstone) {
    return tombstone.backend || (tombstone.key ? 's3' : null);
}

class AttachmentStorage {
    constructor(options) {
        this.options = options || {};

        this.type = (this.options.options && this.options.options.type) || 'gridstore';
        if (!['gridstore', ...OBJECT_BACKENDS].includes(this.type)) {
            throw new Error(`Unknown attachment storage type: ${this.type}`);
        }
        this.gridstore = new GridstoreStorage(this.options);
        this.s3 =
            this.type === 's3' || (this.options.options && this.options.options.s3 && this.options.options.s3.bucket) ? new S3Storage(this.options) : null;
        this.rados =
            this.type === 'rados' || (this.options.options && this.options.options.rados && this.options.options.rados.clusters)
                ? new RadosStorage(this.options)
                : null;
        if (this.type === 'rados' && !this.rados.targets.length) {
            throw new Error('RADOS attachments require at least one target with a weight in rados.placement');
        }
        // payloads smaller than this stay in GridFS when an object store is the type: object stores handle
        // masses of tiny objects poorly, GridFS keeps a small payload in one chunk next to its record
        this.minObjectSize = Number((this.options.options && this.options.options.minObjectSize) || 0);
        if (!Number.isSafeInteger(this.minObjectSize) || this.minObjectSize < 0) {
            throw new Error('attachments.minObjectSize must be a number of bytes');
        }
        // object stores this process reaches, by backend name
        this.objectStores = { s3: this.s3, rados: this.rados };
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
            // decided before any lock is taken, as GridFS and the object stores lock an attachment under the same name
            if (
                this.type === 'gridstore' ||
                (this.minObjectSize > 0 && storedLength(attachment, { decodeBase64: this.objectStores[this.type].decodeBase64 }) < this.minObjectSize)
            ) {
                return this.gridstore.create(attachment, hash, callback);
            }
            this.createObject(attachment, Buffer.from(hash, 'hex')).then(result => callback(null, ...result), callback);
        });
    }

    /**
     * Stores an attachment with an object store (S3 or RADOS) as the preferred backend. A known
     * attachment, wherever its payload is, only gets a reference: one atomic update and no lock. A new one
     * is uploaded under its lock, so many messages carrying it at the same time upload it once
     *
     * @returns {Array} `[id, fileContentHash]`
     */
    async createObject(attachment, id) {
        const reference = async () => {
            const file = await this.catalog.increment(id, attachment.magic);
            return file && [id, file.metadata.fileContentHash];
        };
        const known = await reference();
        if (known) {
            return known;
        }
        // a storage failure fails the store, the delivery is retried later
        return await this.lock.run(id, async () => (await reference()) || (await this.uploadObject(attachment, id, reference)));
    }

    async uploadObject(attachment, id, reference) {
        const store = this.objectStores[this.type];
        const prepared = store.prepare(attachment);
        // a verbatim body was already hashed for its id
        const checksum = prepared.body === attachment.body ? id : crypto.createHash('sha256').update(prepared.body).digest();
        const fileContentHash = checksum.toString('base64');
        try {
            await store.store(id, prepared.body, prepared.body.length, checksum, async location => {
                await this.catalog.insert(id, {
                    length: prepared.body.length,
                    contentType: attachment.contentType,
                    metadata: { ...prepared.metadata, fileContentHash, storage: { version: 1, backend: this.type, ...location } }
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
        const backend = this.backend(attachmentData.metadata, attachmentData.length);
        return backend === 'gridfs'
            ? this.gridstore.createReadStream(id, attachmentData, options)
            : this.objectStores[backend].createReadStream(id, attachmentData, options);
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
        if (location.backend === 'rados' && RadosStorage.prototype.validLocation(location)) {
            if (!this.rados) {
                throw new Error('RADOS attachment exists but RADOS access is not configured');
            }
            if (!this.rados.reaches(location)) {
                throw new Error(`RADOS attachment is stored in pool ${location.pool} of cluster ${location.fsid}, which this process does not use`);
            }
            if (length !== undefined && location.length !== length) {
                throw new Error('RADOS attachment metadata length mismatch');
            }
            return 'rados';
        }
        throw new Error('Invalid attachment storage metadata');
    }

    /**
     * Deletes attachments that no message has referenced for a while. The record goes first, with a
     * condition that it is still unreferenced, so a message stored at the same time either finds the record
     * and keeps it, or misses it and stores a new copy that the payload deletion can not touch: GridFS only
     * deletes chunks that are older than any new upload, S3 and RADOS delete the write-once objects of the old copy.
     * A tombstone written before the record is removed makes sure the payload is deleted even when this
     * process stops or the storage fails in between.
     *
     * @returns {Number} Number of collected attachments
     */
    async deleteOrphanedAsync() {
        // after one failure of an object store (S3, or one RADOS cluster) the rest of the pass leaves that store alone,
        // instead of piling up tombstones
        const pass = { failed: new Set(), refusals: new Map() };
        await this.sweepTombstones(pass);
        let deleted = 0;
        // records this pass can not collect are left out, so they do not take up the batch
        const skipBackends = OBJECT_BACKENDS.filter(backend => !this.objectStores[backend] || (backend === 's3' && pass.failed.has('s3')));
        const radosClusters = this.rados ? [...this.rados.byFsid.keys()].filter(fsid => !pass.failed.has(`rados:${fsid}`)) : null;
        for (const candidate of await this.catalog.findOrphans({ skipBackends, radosClusters })) {
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
        const backend = this.backend(candidate.metadata, candidate.length);
        const location = backend !== 'gridfs' ? candidate.metadata.storage : null;
        if (location && pass.failed.has(this.objectStores[backend].domain(location))) {
            return false;
        }
        const tombstone = await this.catalog.addTombstone(candidate._id, location);
        if (!(await this.catalog.removeOrphan(candidate._id, location))) {
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
            const backend = tombstoneBackend(tombstone);
            const store = backend && this.objectStores[backend];
            // left for a process that reaches the payload, or for a pass after the outage
            if (backend && (!store || (store.reaches && !store.reaches(tombstone)) || pass.failed.has(store.domain(tombstone)))) {
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
        const backend = tombstoneBackend(tombstone);
        const store = backend && this.objectStores[backend];
        if (tombstone.key && !(storage && storage.backend === backend && store.sameObject(storage, tombstone))) {
            const domain = store.domain(tombstone);
            try {
                await store.deletePayload(tombstone);
                pass.refusals.delete(domain);
            } catch (err) {
                if (store.isMissing(err)) {
                    // already gone
                    if (err.name === 'NoSuchBucket') {
                        log.warn('AttachmentStorage', 'Bucket %s of attachment %s does not exist', tombstone.bucket, tombstone.attachment.toString('hex'));
                    }
                } else {
                    // a refusal (access denied) may concern one object, a few in a row most likely concern all of them
                    const outage = store.isOutage(err);
                    const refusals = (pass.refusals.get(domain) || 0) + 1;
                    pass.refusals.set(domain, refusals);
                    if (outage || refusals >= 3) {
                        pass.failed.add(domain);
                    }
                    err.refused = !outage;
                    throw err;
                }
            }
        }
        // old chunks of the attachment go too, whatever stored it: those of a GridFS record, of a record migrated
        // to an object store, or left by an upload that stopped before the attachment came back in one. Chunks of
        // a live GridFS record may be older than an hour, so they only go when the record does not use them
        if (!record || (storage && OBJECT_BACKENDS.includes(storage.backend) && !storage.migratedAt)) {
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
