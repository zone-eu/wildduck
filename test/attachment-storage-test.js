'use strict';

const { expect } = require('chai');
const AttachmentCatalog = require('../lib/attachments/catalog');
const AttachmentLock = require('../lib/attachments/attachment-lock');
const AttachmentStorage = require('../lib/attachment-storage');

describe('Attachment catalog and locking', () => {
    const id = Buffer.alloc(32, 0xab);

    it('does not claim an orphan refreshed between the age check and the update', async () => {
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
        const old = { _id: id, metadata: { c: 0, m: 0, cu: new Date(0) } };
        const fresh = { ...old, metadata: { ...old.metadata, cu: new Date() } };
        const files = {
            async findOne() {
                return old;
            },
            async findOneAndUpdate(query) {
                // Another reference was added and removed just before this atomic update.
                const eligible =
                    !query.$or ||
                    query.$or.some(condition => {
                        if (condition['metadata.cu']?.$lt) {
                            return fresh.metadata.cu < condition['metadata.cu'].$lt;
                        }
                        return condition['metadata.cu'] === null ? fresh.metadata.cu === null : fresh.metadata.storage?.state === 'deleting';
                    });
                return { value: eligible ? fresh : null };
            }
        };
        const catalog = new AttachmentCatalog({ collection: () => files }, 'attachments');
        expect(await catalog.claimOrphan(id, cutoff)).to.equal(null);
    });

    it('uses the same orphan eligibility rules for scanning and claiming', async () => {
        let scannedQuery;
        let claimedQuery;
        const file = { _id: id, metadata: { c: 0, m: 0, storage: { state: 'deleting' } } };
        const files = {
            find(query) {
                scannedQuery = query;
                return { toArray: async () => [file] };
            },
            async findOneAndUpdate(query) {
                claimedQuery = query;
                return { value: file };
            }
        };
        const catalog = new AttachmentCatalog({ collection: () => files }, 'attachments');
        const { candidates, cutoff } = await catalog.findOrphans();
        expect(candidates).to.deep.equal([file]);
        expect(await catalog.claimOrphan(id, cutoff)).to.equal(file);
        expect(claimedQuery).to.deep.equal({ _id: id, ...scannedQuery });
        expect(claimedQuery.$or).to.deep.include({ 'metadata.storage.state': 'deleting' });
    });

    it('rejects an expired lease even before the renewal timer runs, and releases it', async () => {
        const lock = Object.create(AttachmentLock.prototype);
        let released = false;
        lock.lock = {
            waitAcquireLock: async () => ({ success: true }),
            releaseLock: async () => {
                released = true;
            }
        };
        const originalNow = Date.now;
        try {
            await lock.run(id, async assertOwned => {
                const future = originalNow() + 3 * 60 * 1000;
                Date.now = () => future;
                expect(assertOwned).to.throw('Lost attachment lock');
            });
        } finally {
            Date.now = originalNow;
        }
        expect(released).to.equal(true);
    });

    it('checks lock ownership before adding a reference to an existing attachment', async () => {
        const storage = Object.create(AttachmentStorage.prototype);
        let incremented = false;
        storage.catalog = {
            find: async () => ({ length: 6, metadata: {} }),
            increment: async () => {
                incremented = true;
            }
        };
        storage.lock = {
            run: async (attachmentId, operation) =>
                operation(() => {
                    throw new Error('Lost attachment lock');
                })
        };
        const err = await new Promise(resolve => storage.create({ body: Buffer.from('abcdef'), magic: 17 }, resolve));
        expect(err.message).to.equal('Lost attachment lock');
        expect(incremented).to.equal(false);
    });

    it('validates S3 locator lengths consistently for lookups, reads and deduplication', async () => {
        const storage = Object.create(AttachmentStorage.prototype);
        const file = { length: 6, metadata: { storage: { version: 1, backend: 's3', bucket: 'test', key: 'key', length: 5 } } };
        storage.s3 = {};
        storage.catalog = { get: async () => file, find: async () => file };
        storage.lock = { run: async (attachmentId, operation) => operation(() => {}) };
        try {
            await storage.get(id);
            throw new Error('Expected lookup failure');
        } catch (err) {
            expect(err.message).to.equal('S3 attachment metadata length mismatch');
        }
        expect(() => storage.createReadStream(id, file)).to.throw('S3 attachment metadata length mismatch');
        const err = await new Promise(resolve => storage.create({ body: Buffer.from('abcdef'), magic: 17 }, resolve));
        expect(err.message).to.equal('S3 attachment metadata length mismatch');
    });
});
