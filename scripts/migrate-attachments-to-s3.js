'use strict';

const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const config = require('@zone-eu/wild-config');
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');

const flagNames = new Set(['migrate', 'dry-run', 'verify-only', 'cleanup-chunks', 'cleanup-staging', 'cleanup-unreferenced-s3', 'yes']);
const valueNames = new Set(['prefix', 'limit', 'concurrency', 'throttle-ms', 'grace-hours', 'gridfs-bucket', 's3-bucket', 's3-prefix', 's3-endpoint', 'config']);
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
const mode = ['--migrate', '--dry-run', '--verify-only', '--cleanup-chunks', '--cleanup-staging', '--cleanup-unreferenced-s3'].filter(flag => flags.has(flag));
const limit = Number(values.limit || 0);
const concurrency = Number(values.concurrency || 2);
const throttleMs = Number(values['throttle-ms'] || 0);
const graceHours = Number(values['grace-hours'] || 24);
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
    ((flags.has('--cleanup-chunks') || flags.has('--cleanup-staging') || flags.has('--cleanup-unreferenced-s3')) && !flags.has('--yes')) ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    !Number.isInteger(throttleMs) ||
    throttleMs < 0 ||
    !Number.isFinite(graceHours) ||
    graceHours < 0 ||
    !/^[0-9a-f]{0,4}$/.test(prefix)
) {
    if (argumentError) {
        process.stderr.write(`${argumentError}\n`);
    }
    process.stderr.write(
        'Usage: node scripts/migrate-attachments-to-s3.js (--dry-run|--migrate|--verify-only|--cleanup-chunks --yes|--cleanup-staging --yes|--cleanup-unreferenced-s3 --yes) [--prefix=0..ffff] [--limit=N] [--concurrency=1..32] [--throttle-ms=N] [--grace-hours=N] [--gridfs-bucket=NAME] [--s3-bucket=NAME --s3-prefix=NAME --s3-endpoint=URL]\n'
    );
    process.exit(2);
}

const stats = { scanned: 0, migrated: 0, verified: 0, cleaned: 0, stagedCleaned: 0, unreferencedCleaned: 0, skipped: 0, failed: 0 };

async function hashStream(stream) {
    const hash = crypto.createHash('sha256');
    let length = 0;
    for await (const chunk of stream) {
        hash.update(chunk);
        length += chunk.length;
    }
    return { length, checksum: hash.digest('hex') };
}

async function main() {
    if (!s3Config.bucket || !s3Config.prefix) {
        throw new Error('Configure attachments.s3.bucket on this process first');
    }
    await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
    const bucketName = values['gridfs-bucket'] || config.attachments.bucket || 'attachments';
    const storage = new AttachmentStorage({
        gridfs: db.gridfs,
        redis: db.redis,
        options: { ...config.attachments, type: 's3', bucket: bucketName, s3: s3Config }
    });
    const s3 = storage.s3;
    const bucket = storage.gridstore.gridstore;
    const files = db.gridfs.collection(`${bucketName}.files`);
    const chunks = db.gridfs.collection(`${bucketName}.chunks`);
    const lock = storage.lock;

    if (flags.has('--cleanup-staging')) {
        const stagePrefix = `${s3.prefix}/attachments/staging/${prefix}`;
        let continuationToken;
        do {
            const page = await s3.client.send(new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: stagePrefix, ContinuationToken: continuationToken }));
            for (const object of page.Contents || []) {
                if (limit && stats.scanned >= limit) {
                    break;
                }
                stats.scanned++;
                const match = new RegExp(`^${s3.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/attachments/staging/([0-9a-f]{64})/[^/]+$`).exec(object.Key);
                if (!match || Date.now() - new Date(object.LastModified).getTime() < graceHours * 3600 * 1000) {
                    stats.skipped++;
                    continue;
                }
                try {
                    await lock.run(Buffer.from(match[1], 'hex'), async assertOwned => {
                        const current = await s3.head(object.Key);
                        if (!current || !current.LastModified || Date.now() - new Date(current.LastModified).getTime() < graceHours * 3600 * 1000) {
                            stats.skipped++;
                            return;
                        }
                        assertOwned();
                        await s3.deletePayload({ bucket: s3.bucket, key: object.Key });
                        stats.stagedCleaned++;
                    });
                } catch (err) {
                    stats.failed++;
                    process.stderr.write(`${object.Key}: ${err.message}\n`);
                }
            }
            continuationToken = page.IsTruncated && (!limit || stats.scanned < limit) ? page.NextContinuationToken : undefined;
        } while (continuationToken);
        process.stdout.write(`${JSON.stringify(stats)}\n`);
        if (stats.failed) {
            process.exitCode = 1;
        }
        return;
    }

    if (flags.has('--cleanup-unreferenced-s3')) {
        const basePrefix = `${s3.prefix}/attachments/v1/`;
        const listPrefix = prefix.length <= 2 ? `${basePrefix}${prefix}` : `${basePrefix}${prefix.slice(0, 2)}/${prefix.slice(2)}`;
        let continuationToken;
        do {
            const page = await s3.client.send(new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: listPrefix, ContinuationToken: continuationToken }));
            for (const object of page.Contents || []) {
                if (limit && stats.scanned >= limit) {
                    break;
                }
                stats.scanned++;
                const parts = object.Key.startsWith(basePrefix) ? object.Key.slice(basePrefix.length).split('/') : [];
                const hex = parts[2];
                if (
                    parts.length !== 3 ||
                    !/^[0-9a-f]{64}$/.test(hex) ||
                    parts[0] !== hex.slice(0, 2) ||
                    parts[1] !== hex.slice(2, 4) ||
                    !hex.startsWith(prefix) ||
                    Date.now() - new Date(object.LastModified).getTime() < graceHours * 3600 * 1000
                ) {
                    stats.skipped++;
                    continue;
                }
                try {
                    await lock.run(Buffer.from(hex, 'hex'), async assertOwned => {
                        const record = await files.findOne({ _id: Buffer.from(hex, 'hex') }, { projection: { 'metadata.storage': 1 } });
                        if (
                            record?.metadata?.storage?.backend === 's3' &&
                            record.metadata.storage.bucket === s3.bucket &&
                            record.metadata.storage.key === object.Key
                        ) {
                            stats.skipped++;
                            return;
                        }
                        const current = await s3.head(object.Key);
                        if (!current || !current.LastModified || Date.now() - new Date(current.LastModified).getTime() < graceHours * 3600 * 1000) {
                            stats.skipped++;
                            return;
                        }
                        assertOwned();
                        await s3.deletePayload({ bucket: s3.bucket, key: object.Key });
                        stats.unreferencedCleaned++;
                    });
                } catch (err) {
                    stats.failed++;
                    process.stderr.write(`${object.Key}: ${err.message}\n`);
                }
            }
            continuationToken = page.IsTruncated && (!limit || stats.scanned < limit) ? page.NextContinuationToken : undefined;
        } while (continuationToken);
        process.stdout.write(`${JSON.stringify(stats)}\n`);
        if (stats.failed) {
            process.exitCode = 1;
        }
        return;
    }
    const query = {};
    if (prefix) {
        const low = Buffer.alloc(32);
        const high = Buffer.alloc(32, 0xff);
        Buffer.from(prefix.padEnd(4, '0'), 'hex').copy(low);
        Buffer.from(prefix.padEnd(4, 'f'), 'hex').copy(high);
        query._id = { $gte: low, $lte: high };
    }
    if (flags.has('--migrate') || flags.has('--dry-run')) {
        query['metadata.storage.backend'] = { $ne: 's3' };
    } else {
        query['metadata.storage.backend'] = 's3';
    }

    async function processFile(file) {
        const id = file._id;
        const hex = id.toString('hex');
        if (flags.has('--dry-run')) {
            stats.skipped++;
            return;
        }
        await lock.run(id, async assertOwned => {
            const current = await files.findOne({ _id: id });
            if (!current || current.metadata?.storage?.state === 'deleting') {
                stats.skipped++;
                return;
            }
            if (flags.has('--migrate')) {
                if (current.metadata?.storage?.backend === 's3') {
                    stats.skipped++;
                    return;
                }
                if (current.metadata?.storage?.backend && current.metadata.storage.backend !== 'gridfs') {
                    throw new Error(`Unknown source backend for ${hex}`);
                }
                const token = crypto.randomUUID();
                const claim = await files.updateOne(
                    { _id: id, 'metadata.storage.backend': { $ne: 's3' }, 'metadata.storage.state': { $ne: 'deleting' } },
                    { $set: { 'metadata.storage': { backend: 'gridfs', migrationToken: token } } }
                );
                if (!claim.matchedCount) {
                    stats.skipped++;
                    return;
                }
                const source = await hashStream(bucket.openDownloadStream(id));
                if (source.length !== current.length) {
                    throw new Error(`GridFS length mismatch for ${hex}`);
                }
                if (current.metadata.fileContentHash && Buffer.from(current.metadata.fileContentHash, 'base64').toString('hex') !== source.checksum) {
                    throw new Error(`GridFS checksum mismatch for ${hex}`);
                }
                const location = await s3.publishStream(id, () => bucket.openDownloadStream(id), source.length, source.checksum);
                await s3.verifyContent(location, source.length, source.checksum);
                assertOwned();
                const result = await files.updateOne(
                    { _id: id, 'metadata.storage.migrationToken': token, 'metadata.storage.backend': 'gridfs' },
                    {
                        $set: {
                            'metadata.storage': { version: 1, backend: 's3', ...location, migratedAt: new Date() },
                            'metadata.fileContentHash': Buffer.from(source.checksum, 'hex').toString('base64')
                        }
                    }
                );
                if (!result.matchedCount) {
                    throw new Error(`Migration cutover lost for ${hex}`);
                }
                stats.migrated++;
                return;
            }

            const location = current.metadata.storage;
            if (location?.backend !== 's3') {
                stats.skipped++;
                return;
            }
            storage.backend(current.metadata, current.length);
            const sourceChunk = await chunks.findOne({ files_id: id }, { projection: { _id: 1 } });
            if (!current.metadata.fileContentHash && !sourceChunk) {
                throw new Error(`Cannot verify S3 payload without a checksum or GridFS chunks for ${hex}`);
            }
            const destination = await hashStream((await s3.client.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }))).Body);
            if (
                destination.length !== current.length ||
                (current.metadata.fileContentHash && destination.checksum !== Buffer.from(current.metadata.fileContentHash, 'base64').toString('hex'))
            ) {
                throw new Error(`S3 payload mismatch for ${hex}`);
            }
            if (sourceChunk) {
                const source = await hashStream(bucket.openDownloadStream(id));
                if (source.length !== destination.length || source.checksum !== destination.checksum) {
                    throw new Error(`GridFS and S3 differ for ${hex}`);
                }
            }
            stats.verified++;
            if (flags.has('--cleanup-chunks') && sourceChunk) {
                const migratedAt = new Date(location.migratedAt).getTime();
                if (!location.migratedAt || !Number.isFinite(migratedAt) || Date.now() - migratedAt < graceHours * 3600 * 1000) {
                    stats.skipped++;
                    return;
                }
                assertOwned();
                if (!current.metadata.fileContentHash) {
                    // Retain the checksum established against GridFS before removing that verification source.
                    await files.updateOne({ _id: id }, { $set: { 'metadata.fileContentHash': Buffer.from(destination.checksum, 'hex').toString('base64') } });
                    assertOwned();
                }
                await chunks.deleteMany({ files_id: id });
                stats.cleaned++;
            }
        });
    }

    const active = new Set();
    const cursor = files.find(query, { projection: { _id: 1 } }).sort({ _id: 1 });
    for await (const file of cursor) {
        if (limit && stats.scanned >= limit) {
            break;
        }
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
    }
    await Promise.all(active);
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
