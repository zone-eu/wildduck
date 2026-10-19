'use strict';

const log = require('npmlog');
const { ObjectId } = require('mongodb');
const errors = require('../errors');

const ORPHANED_ATTACHMENTS_DELAY = 24 * 3600 * 1000;
const MAX_ORPHANED_ATTACHMENTS = 1000;
// a tombstone younger than this may belong to a collection that is still running
const TOMBSTONE_DELAY = 10 * 60 * 1000;

function validateMagic(ids, magic) {
    if (isNaN(magic) || typeof magic !== 'number') {
        errors.notify(new Error('Invalid magic "' + magic + '" for ' + ids));
    }
}

function referenceUpdate(count, magic) {
    return { $inc: { 'metadata.c': count, 'metadata.m': magic }, $set: { 'metadata.cu': new Date() } };
}

function orphanQuery() {
    return {
        'metadata.c': 0,
        'metadata.m': 0,
        $or: [{ 'metadata.cu': null }, { 'metadata.cu': { $lt: new Date(Date.now() - ORPHANED_ATTACHMENTS_DELAY) } }]
    };
}

class AttachmentCatalog {
    constructor(gridfs, bucketName, writeConcern) {
        this.files = gridfs.collection(`${bucketName}.files`);
        // payloads whose catalog record is being or has been removed, until the payload is deleted too
        this.trash = gridfs.collection(`${bucketName}.trash`);
        this.writeConcern = { w: writeConcern || 'majority' };
    }

    async find(id) {
        return await this.files.findOne({ _id: id });
    }

    async get(id) {
        const file = await this.find(id);
        if (!file) {
            const err = new Error('This attachment does not exist');
            err.responseCode = 404;
            err.code = 'FileNotFound';
            throw err;
        }
        return {
            contentType: file.contentType,
            transferEncoding: file.metadata.transferEncoding,
            length: file.length,
            count: file.metadata.c,
            hash: file._id,
            metadata: file.metadata
        };
    }

    /**
     * Adds a reference to an existing record
     *
     * @returns {Object|null} The updated record, or null when there is no record (any more)
     */
    async increment(id, magic) {
        return await this.changeReferences(id, 1, magic);
    }

    async updateMany(ids, count, magic) {
        validateMagic(ids, magic);
        // A message holds one reference per attachment map entry, so a file attached twice holds two
        const occurrences = new Map();
        for (const id of [].concat(ids)) {
            const hex = id.toString('hex');
            const entry = occurrences.get(hex) || { id, times: 0 };
            entry.times++;
            occurrences.set(hex, entry);
        }
        if (!occurrences.size) {
            return { matchedCount: 0, modifiedCount: 0 };
        }
        const result = await this.files.bulkWrite(
            [...occurrences.values()].map(({ id, times }) => ({
                updateOne: {
                    filter: { _id: id },
                    update: referenceUpdate(count * times, magic * times)
                }
            })),
            { ordered: false }
        );
        if (result.matchedCount !== occurrences.size) {
            log.warn('AttachmentCatalog', 'Updated %s of %s attachment references', result.matchedCount, occurrences.size);
        }
        return result;
    }

    async decrement(id, magic) {
        return !!(await this.changeReferences(id, -1, magic));
    }

    async changeReferences(id, count, magic) {
        validateMagic(id, magic);
        const result = await this.files.findOneAndUpdate({ _id: id }, referenceUpdate(count, count === -1 ? -magic : magic), {
            returnDocument: 'after',
            projection: { 'metadata.fileContentHash': true }
        });
        return result.value;
    }

    async insert(id, file) {
        validateMagic(id, file.metadata.m);
        await this.files.insertOne(
            {
                _id: id,
                length: file.length,
                chunkSize: 255 * 1024,
                uploadDate: new Date(),
                contentType: file.contentType,
                metadata: file.metadata
            },
            { writeConcern: this.writeConcern }
        );
    }

    async findOrphans(options) {
        const query = orphanQuery();
        if (options && options.skipS3) {
            query['metadata.storage.backend'] = { $ne: 's3' };
        }
        return await this.files
            .find(query, {
                limit: MAX_ORPHANED_ATTACHMENTS,
                hint: 'related_attachments_cu',
                comment: 'List orphaned attachments',
                maxTimeMS: 2 * 60 * 1000
            })
            .toArray();
    }

    /**
     * Deletes the record of an orphaned attachment if it is still unreferenced, old enough and stores its
     * payload where the caller expects. A reference added since the candidate scan, or a migration that moved
     * the payload, keeps the record
     *
     * @param {Buffer} id Attachment id
     * @param {String} [key] S3 key of the payload, or nothing for a GridFS payload
     * @returns {Boolean} True when the record was deleted
     */
    async removeOrphan(id, key) {
        const result = await this.files.deleteOne({
            _id: id,
            ...orphanQuery(),
            'metadata.storage.key': key || { $exists: false }
        });
        return !!result.deletedCount;
    }

    /**
     * Records that the payload of an attachment is about to lose its record, so it is deleted later if the
     * collection stops halfway
     *
     * @param {Buffer} id Attachment id
     * @param {Object|null} location S3 locator, or null for a GridFS payload
     * @returns {Object} The tombstone
     */
    async addTombstone(id, location) {
        const tombstone = {
            _id: new ObjectId(),
            attachment: id,
            ...(location ? { bucket: location.bucket, key: location.key } : {})
        };
        await this.trash.insertOne(tombstone);
        return tombstone;
    }

    async removeTombstone(tombstone) {
        await this.trash.deleteOne({ _id: tombstone._id });
    }

    /**
     * Moves a tombstone that can not be processed to the end of the queue, so it does not hold up the others
     */
    async requeueTombstone(tombstone) {
        await this.trash.insertOne({ ...tombstone, _id: new ObjectId() });
        await this.removeTombstone(tombstone);
    }

    /**
     * Tombstones left behind by a collection that stopped or failed before deleting the payload, oldest first
     */
    async findStaleTombstones() {
        return await this.trash
            .find({ _id: { $lt: ObjectId.createFromTime(Math.floor((Date.now() - TOMBSTONE_DELAY) / 1000)) } }, { limit: MAX_ORPHANED_ATTACHMENTS })
            .sort({ _id: 1 })
            .toArray();
    }

    /**
     * True when the record of this attachment points to this S3 object. A key is written once, so the key
     * alone identifies the object
     */
    async references(id, key) {
        return !!(await this.files.findOne({ _id: id, 'metadata.storage.key': key }, { projection: { _id: true } }));
    }
}

module.exports = AttachmentCatalog;
