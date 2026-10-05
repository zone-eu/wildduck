'use strict';

const log = require('npmlog');
const errors = require('../errors');

const ORPHANED_ATTACHMENTS_DELAY = 24 * 3600 * 1000;
const MAX_ORPHANED_ATTACHMENTS = 1000;

function validateMagic(ids, magic) {
    if (isNaN(magic) || typeof magic !== 'number') {
        errors.notify(new Error('Invalid magic "' + magic + '" for ' + ids));
    }
}

function referenceUpdate(count, magic) {
    return { $inc: { 'metadata.c': count, 'metadata.m': magic }, $set: { 'metadata.cu': new Date() } };
}

function orphanQuery(cutoff) {
    return {
        'metadata.c': 0,
        'metadata.m': 0,
        $or: [{ 'metadata.cu': null }, { 'metadata.cu': { $lt: cutoff } }, { 'metadata.storage.state': 'deleting' }]
    };
}

class AttachmentCatalog {
    constructor(gridfs, bucketName, writeConcern) {
        this.files = gridfs.collection(`${bucketName}.files`);
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

    async increment(id, magic) {
        const file = await this.changeReferences(id, 1, magic);
        if (!file) {
            throw new Error('Attachment is being deleted');
        }
        return file;
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
                    filter: { _id: id, 'metadata.storage.state': { $ne: 'deleting' } },
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
        const result = await this.files.findOneAndUpdate(
            { _id: id, 'metadata.storage.state': { $ne: 'deleting' } },
            referenceUpdate(count, count === -1 ? -magic : magic),
            { returnDocument: 'after' }
        );
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

    async findOrphans() {
        const cutoff = new Date(Date.now() - ORPHANED_ATTACHMENTS_DELAY);
        const candidates = await this.files
            .find(orphanQuery(cutoff), {
                limit: MAX_ORPHANED_ATTACHMENTS,
                hint: 'related_attachments_cu',
                comment: 'List orphaned attachments',
                maxTimeMS: 2 * 60 * 1000
            })
            .toArray();
        return { candidates, cutoff };
    }

    async claimOrphan(id, cutoff) {
        // Recheck counters and age atomically, including changes since the candidate scan.
        const result = await this.files.findOneAndUpdate(
            { _id: id, ...orphanQuery(cutoff) },
            { $set: { 'metadata.storage.state': 'deleting' } },
            { returnDocument: 'after' }
        );
        return result.value;
    }

    async removeOrphan(id) {
        const result = await this.files.deleteOne({ _id: id, 'metadata.c': 0, 'metadata.m': 0, 'metadata.storage.state': 'deleting' });
        return !!result.deletedCount;
    }
}

module.exports = AttachmentCatalog;
