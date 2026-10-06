'use strict';

const { expect } = require('chai');
const AttachmentLock = require('../lib/attachments/attachment-lock');
const AttachmentStorage = require('../lib/attachment-storage');

describe('Attachment storage facade and locking', () => {
    const id = Buffer.alloc(32, 0xab);

    for (const writeConcern of [undefined, 1, 2, 'majority']) {
        it(`inserts S3 catalog entries with ${writeConcern === undefined ? 'majority by default' : `configured w:${writeConcern}`}`, async () => {
            let insertOptions;
            let insertedFile;
            const files = {
                findOneAndUpdate: async () => ({ value: null }),
                async insertOne(file, options) {
                    insertedFile = file;
                    insertOptions = options;
                }
            };
            const redis = {
                duplicate: () => ({ subscribe: async () => {}, on() {} }),
                defineCommand() {}
            };
            const storage = new AttachmentStorage({
                gridfs: { writeConcern: { w: 1 }, collection: () => files },
                redis,
                s3Client: {},
                options: { type: 's3', writeConcern, s3: { bucket: 'test', prefix: 'test' } }
            });
            storage.lock = { run: async (attachmentId, operation) => operation() };
            storage.s3.put = async () => ({ bucket: 'test', key: 'key', length: 6 });

            await new Promise((resolve, reject) => {
                storage.create({ body: Buffer.from('abcdef'), magic: 17 }, err => (err ? reject(err) : resolve()));
            });

            expect(insertedFile.metadata.storage.backend).to.equal('s3');
            expect(insertOptions).to.deep.equal({ writeConcern: { w: writeConcern || 'majority' } });
        });
    }

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

    it('validates S3 locator lengths consistently for lookups and reads', async () => {
        const storage = Object.create(AttachmentStorage.prototype);
        const file = { length: 6, metadata: { storage: { version: 1, backend: 's3', bucket: 'test', key: 'key', length: 5 } } };
        storage.s3 = {};
        storage.catalog = { get: async () => file };
        try {
            await storage.get(id);
            throw new Error('Expected lookup failure');
        } catch (err) {
            expect(err.message).to.equal('S3 attachment metadata length mismatch');
        }
        expect(() => storage.createReadStream(id, file)).to.throw('S3 attachment metadata length mismatch');
    });
});
