'use strict';

const crypto = require('crypto');
const { GridFSBucket, ObjectId } = require('mongodb');
const { pipeline } = require('stream/promises');
const config = require('@zone-eu/wild-config');
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');

const flagNames = new Set(['migrate', 'dry-run', 'verify-only']);
const valueNames = new Set([
    'prefix',
    'limit',
    'batch',
    'concurrency',
    'throttle-ms',
    'gridfs-bucket',
    's3-bucket',
    's3-prefix',
    's3-endpoint',
    'config'
]);
const flags = new Set();
const values = {};
let argumentError;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(args[index]);
    if (!match || (!flagNames.has(match[1]) && !valueNames.has(match[1])) || flags.has(`--${match[1]}`) || Object.hasOwn(values, match[1])) {
        argumentError = `Unexpected or duplicate argument: ${args[index]}`;
        break;
    }
    const [, name, inlineValue] = match;
    if (flagNames.has(name)) {
        if (inlineValue !== undefined) {
            argumentError = `--${name} does not take a value`;
            break;
        }
        flags.add(`--${name}`);
    } else {
        const value = inlineValue === undefined ? args[++index] : inlineValue;
        if (!value || value.startsWith('--')) {
            argumentError = `Missing value for --${name}`;
            break;
        }
        values[name] = value;
    }
}
const mode = ['--migrate', '--dry-run', '--verify-only'].filter(flag => flags.has(flag));
const limit = Number(values.limit || 0);
const batch = Number(values.batch || 1000);
const concurrency = Number(values.concurrency || 2);
const throttleMs = Number(values['throttle-ms'] || 0);
const prefix = values.prefix || '';
const s3Config = {
    ...(config.attachments?.s3 || {}),
    ...(values['s3-bucket'] ? { bucket: values['s3-bucket'] } : {}),
    ...(values['s3-prefix'] ? { prefix: values['s3-prefix'] } : {}),
    ...(values['s3-endpoint'] ? { endpoint: values['s3-endpoint'], forcePathStyle: true } : {})
};

if (
    argumentError ||
    mode.length !== 1 ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 10000 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    !Number.isInteger(throttleMs) ||
    throttleMs < 0 ||
    !/^[0-9a-f]{0,4}$/.test(prefix)
) {
    if (argumentError) {
        process.stderr.write(`${argumentError}\n`);
    }
    process.stderr.write(
        'Usage: node scripts/migrate-attachments-to-gridfs.js (--dry-run|--migrate|--verify-only) [--prefix=0..ffff] [--limit=N] [--batch=1..10000] [--concurrency=1..32] [--throttle-ms=N] [--gridfs-bucket=NAME] [--s3-bucket=NAME --s3-prefix=NAME --s3-endpoint=URL]\n'
    );
    process.exit(2);
}

const stats = { scanned: 0, migrated: 0, verified: 0, skipped: 0, failed: 0 };

async function hashStream(stream) {
    const hash = crypto.createHash('sha256');
    let length = 0;
    for await (const chunk of stream) {
        hash.update(chunk);
        length += chunk.length;
    }
    return { length, checksum: hash.digest() };
}

async function main() {
    const verifyOnly = flags.has('--verify-only');
    if (!verifyOnly && (!s3Config.bucket || !s3Config.prefix)) {
        throw new Error('Configure attachments.s3.bucket and attachments.s3.prefix on this process first');
    }
    await db.connect();
    const bucketName = values['gridfs-bucket'] || config.attachments.bucket || 'attachments';
    const writeConcern = { w: config.attachments.writeConcern || 'majority' };
    const storage = new AttachmentStorage({
        gridfs: db.gridfs,
        redis: db.redis,
        // Verification deliberately constructs a reader with no S3 configuration.
        options: { ...config.attachments, type: 'gridstore', bucket: bucketName, s3: verifyOnly ? {} : s3Config }
    });
    const bucket = storage.gridstore.gridstore;
    const files = db.gridfs.collection(`${bucketName}.files`);
    const chunks = db.gridfs.collection(`${bucketName}.chunks`);
    if (flags.has('--migrate')) {
        await chunks.createIndex({ files_id: 1, n: 1 }, { unique: true });
    }
    // Staging must not introduce temporary records into the live attachment catalog.
    const staging = new GridFSBucket(db.gridfs, { bucketName: `${bucketName}.restore`, writeConcern });
    const stagedChunks = db.gridfs.collection(`${bucketName}.restore.chunks`);
    const stagedFiles = db.gridfs.collection(`${bucketName}.restore.files`);
    const query = verifyOnly ? {} : { 'metadata.storage.backend': 's3' };
    if (prefix) {
        const low = Buffer.alloc(32);
        const high = Buffer.alloc(32, 0xff);
        Buffer.from(prefix.padEnd(4, '0'), 'hex').copy(low);
        Buffer.from(prefix.padEnd(4, 'f'), 'hex').copy(high);
        query._id = { $gte: low, $lte: high };
    }

    async function check(stream, length, checksum, label) {
        const actual = await hashStream(stream);
        if (actual.length !== length || !checksum || !actual.checksum.equals(Buffer.from(checksum, 'base64'))) {
            throw new Error(`${label} payload mismatch or missing checksum`);
        }
        return actual;
    }

    async function processFile(file) {
        const id = file._id;
        if (flags.has('--dry-run')) {
            stats.skipped++;
            return;
        }
        await storage.lock.run(id, async assertOwned => {
            const current = await files.findOne({ _id: id });
            if (!current || (!verifyOnly && current.metadata?.storage?.backend !== 's3')) {
                stats.skipped++;
                return;
            }
            storage.backend(current.metadata, current.length);
            let checksum = current.metadata.fileContentHash;
            if (verifyOnly) {
                await check(bucket.openDownloadStream(id), current.length, checksum, 'GridFS');
                stats.verified++;
                return;
            }
            const location = current.metadata.storage;
            if (!Number.isSafeInteger(current.chunkSize) || current.chunkSize <= 0) {
                throw new Error('Invalid GridFS chunk size');
            }
            if (!checksum) {
                // Legacy migrations may have retained chunks but no recorded payload checksum.
                let retained;
                try {
                    retained = await hashStream(bucket.openDownloadStream(id));
                } catch (err) {
                    throw new Error(`Cannot establish missing checksum from retained GridFS payload: ${err.message}`);
                }
                if (retained.length !== current.length) {
                    throw new Error('Cannot establish missing checksum: retained GridFS payload length mismatch');
                }
                checksum = retained.checksum.toString('base64');
            }
            const temporaryId = new ObjectId();
            try {
                await pipeline(
                    storage.s3.openRange(location, current.length, 0, current.length),
                    staging.openUploadStreamWithId(temporaryId, id.toString('hex'), { chunkSizeBytes: current.chunkSize })
                );
                await check(staging.openDownloadStream(temporaryId), current.length, checksum, 'S3');
                assertOwned();
                // The S3 locator remains authoritative throughout replacement. A failed or interrupted
                // copy can be retried; neither partial chunks nor an unverified payload become readable.
                await chunks.deleteMany({ files_id: id }, { writeConcern });
                const cursor = stagedChunks.find({ files_id: temporaryId }).sort({ n: 1 });
                try {
                    for await (const chunk of cursor) {
                        assertOwned();
                        await chunks.insertOne({ ...chunk, _id: new ObjectId(), files_id: id }, { writeConcern });
                    }
                } finally {
                    await cursor.close();
                }
                await check(bucket.openDownloadStream(id), current.length, checksum, 'GridFS');
                assertOwned();
                const result = await files.updateOne(
                    { _id: id, 'metadata.storage': location },
                    { $unset: { 'metadata.storage': '' }, $set: { 'metadata.fileContentHash': checksum } },
                    { writeConcern }
                );
                if (!result.matchedCount) {
                    throw new Error('Migration cutover lost');
                }
                stats.migrated++;
            } finally {
                // Only this run's staging id is removed, even if the attachment lock was lost.
                await stagedChunks.deleteMany({ files_id: temporaryId }, { writeConcern });
                await stagedFiles.deleteOne({ _id: temporaryId }, { writeConcern });
            }
        });
    }

    const active = new Set();
    try {
        // pages of ids instead of one cursor: working through a large store takes far longer than a server
        // keeps an idle cursor open
        let last = null;
        let page;
        do {
            const pageQuery = last ? { ...query, _id: { ...(query._id || {}), $gt: last } } : query;
            // never more than --limit still allows, and no query at all once it is reached (limit 0 means none)
            const size = limit ? Math.min(batch, limit - stats.scanned) : batch;
            if (size <= 0) {
                break;
            }
            page = await files
                .find(pageQuery, { projection: { _id: 1 } })
                .sort({ _id: 1 })
                .limit(size)
                .toArray();
            for (const file of page) {
                stats.scanned++;
                const task = processFile(file)
                    .catch(err => {
                        stats.failed++;
                        process.stderr.write(`${file._id.toString('hex')}: ${err.message}\n`);
                    })
                    .finally(() => active.delete(task));
                active.add(task);
                if (active.size >= concurrency) {
                    await Promise.race(active);
                }
                if (throttleMs) {
                    await new Promise(resolve => setTimeout(resolve, throttleMs));
                }
                if (stats.scanned % 1000 === 0) {
                    process.stdout.write(`${JSON.stringify(stats)}\n`);
                }
                last = file._id;
            }
        } while (page.length === batch);
    } finally {
        // never exit with restores or cutovers half done, also when listing the next page failed
        await Promise.all(active);
    }
    process.stdout.write(`${JSON.stringify(stats)}\n`);
    if (stats.failed) {
        process.exitCode = 1;
    }
}

main()
    .catch(err => {
        process.stderr.write(`${err.stack || err.message}\n`);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
