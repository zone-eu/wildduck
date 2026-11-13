'use strict';

// Read only measurements for the JMAP rollout decisions (docs/jmap/implementation-plan.md, work
// package 0.13): journal growth, the share of messages without a root or with a shared root, index
// sizes, and the cost of lookups by root. Run it against mongos with a read only user:
//
//   MONGO_URI='mongodb://...' DB_NAME=wildduck node scripts/jmap/measure-production.js > measurements.json
//
// Every query is bounded: samples use $sample, counts use _id ranges of the last hour, and the
// lookups probe a fixed number of roots. Nothing is written.

const { MongoClient, ObjectId } = require('mongodb');

const SAMPLE = Number(process.env.SAMPLE) || 20000;
const LOOKUPS = Number(process.env.LOOKUPS) || 200;
const READ = { readPreference: 'secondaryPreferred', maxTimeMS: 120000 };

// Through mongos, $collStats answers one document per shard of a sharded collection: the sizes are summed
async function collectionStats(db, name) {
    const perShard = await db
        .collection(name)
        .aggregate([{ $collStats: { storageStats: {} } }], READ)
        .toArray()
        .catch(() => []);
    if (!perShard.length) {
        return null;
    }
    const total = { shards: perShard.length, count: 0, size: 0, totalIndexSize: 0, indexSizes: {} };
    for (const { storageStats: storage } of perShard) {
        total.count += Number(storage.count);
        total.size += Number(storage.size);
        total.totalIndexSize += Number(storage.totalIndexSize);
        for (const [index, size] of Object.entries(storage.indexSizes || {})) {
            total.indexSizes[index] = (total.indexSizes[index] || 0) + Number(size);
        }
    }
    return total;
}

// journal entries written in the last hour, from the ObjectId time of _id
async function journalPerHour(db) {
    const since = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3600);
    const perHour = await db.collection('journal').countDocuments({ _id: { $gte: since } }, READ);
    const [ttl] = (await db.collection('journal').indexes()).filter(index => index.name === 'journal_autoexpire');
    return { perHour, perDayEstimate: perHour * 24, currentTtlSeconds: ttl && ttl.expireAfterSeconds };
}

async function rootSample(db, hasByRoot) {
    const docs = await db
        .collection('messages')
        .aggregate([{ $sample: { size: SAMPLE } }, { $project: { _id: true, root: true, user: true } }], READ)
        .toArray();
    const withRoot = docs.filter(doc => doc.root);
    const moved = withRoot.filter(doc => !doc.root.equals(doc._id)).length;
    // shared roots among a sample of roots: how many documents carry each root. Without the by_root index
    // each probe would scan a user's messages on every shard, so the probes are skipped
    const probe = hasByRoot ? withRoot.slice(0, LOOKUPS) : [];
    let shared = 0;
    const timings = [];
    for (const doc of probe) {
        const started = process.hrtime.bigint();
        const count = await db.collection('messages').countDocuments({ user: doc.user, root: doc.root }, READ);
        timings.push(Number(process.hrtime.bigint() - started) / 1e6);
        shared += count > 1 ? 1 : 0;
    }
    timings.sort((a, b) => a - b);
    const pct = p => (timings.length ? Math.round(timings[Math.min(timings.length - 1, Math.floor(timings.length * p))] * 10) / 10 : null);
    return {
        sampled: docs.length,
        withoutRoot: docs.length - withRoot.length,
        rootDiffersFromId: moved,
        probedRoots: probe.length,
        sharedRoots: shared,
        lookupMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) }
    };
}

async function main() {
    const client = await MongoClient.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017');
    const db = client.db(process.env.DB_NAME || 'wildduck');
    try {
        const indexNames = (await db.collection('messages').indexes()).map(index => index.name);
        const result = {
            measuredAt: new Date().toISOString(),
            collections: {
                messages: await collectionStats(db, 'messages'),
                archived: await collectionStats(db, 'archived'),
                journal: await collectionStats(db, 'journal')
            },
            journal: await journalPerHour(db),
            hasByRootIndex: indexNames.includes('by_root'),
            roots: await rootSample(db, indexNames.includes('by_root'))
        };
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
        await client.close();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
