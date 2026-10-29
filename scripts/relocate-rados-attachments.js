'use strict';

// Moves RADOS attachment payloads off a cluster or pool, for example to drain a cluster before it is
// retired. Every payload is copied with its checksums checked, the catalog record is pointed at the copy
// only if it still points at the original, and the original is deleted by the attachment collector once
// its tombstone is stale. Needs the RADOS settings of the process (attachments.rados) with both the source
// and the target cluster in rados.clusters.

const config = require('@zone-eu/wild-config');
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');

const flagNames = new Set(['relocate', 'dry-run']);
const valueNames = new Set(['from', 'to', 'limit', 'batch', 'concurrency', 'throttle-ms', 'gridfs-bucket', 'config']);
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
const mode = ['--relocate', '--dry-run'].filter(flag => flags.has(flag));
const limit = Number(values.limit || 0);
const batch = Number(values.batch || 1000);
const concurrency = Number(values.concurrency || 2);
const throttleMs = Number(values['throttle-ms'] || 0);

if (
    argumentError ||
    mode.length !== 1 ||
    !values.from ||
    !/^[^/]+(\/[^/]+)?$/.test(values.from) ||
    (values.to && !/^[^/]+\/[^/]+$/.test(values.to)) ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 10000 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    !Number.isInteger(throttleMs) ||
    throttleMs < 0
) {
    if (argumentError) {
        process.stderr.write(`${argumentError}\n`);
    }
    process.stderr.write(
        'Usage: node scripts/relocate-rados-attachments.js (--dry-run|--relocate) --from=<cluster>[/<pool>] [--to=<cluster>/<pool>] [--limit=N] [--batch=1..10000] [--concurrency=1..32] [--throttle-ms=N] [--gridfs-bucket=NAME]\n' +
            '  <cluster> is a label from attachments.rados.clusters. Without --to, payloads go where the placement puts them,\n' +
            '  skipping their current pool: give the source weight 0 in the placement first.\n'
    );
    process.exit(2);
}

const stats = { scanned: 0, relocated: 0, skipped: 0, failed: 0 };

async function main() {
    await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
    const bucketName = values['gridfs-bucket'] || config.attachments.bucket || 'attachments';
    const storage = new AttachmentStorage({
        gridfs: db.gridfs,
        redis: db.redis,
        options: { ...config.attachments, bucket: bucketName }
    });
    if (!storage.rados) {
        throw new Error('Configure attachments.rados on this process first');
    }
    const [fromLabel, fromPool] = values.from.split('/');
    const source = storage.rados.clusters.get(fromLabel);
    if (!source) {
        throw new Error(`Unknown cluster ${fromLabel}, it is not in attachments.rados.clusters`);
    }
    if (values.to) {
        // fails early on a target that is not configured
        storage.rados.target(values.to);
    }
    const files = db.gridfs.collection(`${bucketName}.files`);
    const query = { 'metadata.storage.backend': 'rados', 'metadata.storage.fsid': source.fsid };
    if (fromPool) {
        query['metadata.storage.pool'] = fromPool;
    }

    async function processFile(file) {
        if (flags.has('--dry-run')) {
            stats.skipped++;
            return;
        }
        const moved = await storage.relocate(file._id, values.to);
        if (moved) {
            stats.relocated++;
        } else {
            stats.skipped++;
        }
    }

    const active = new Set();
    try {
        // pages of ids, as in migrate-attachments-to-s3.js: a relocated record leaves the query, so the next
        // page starts after the last id instead of at an offset
        let last = null;
        let page;
        do {
            const pageQuery = last ? { ...query, _id: { $gt: last } } : query;
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
        await Promise.all(active);
        await storage.rados.close();
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
