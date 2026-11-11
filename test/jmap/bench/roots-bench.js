'use strict';

// Micro benchmark of the phase 0 lookups on a local MongoDB: resolving JMAP Email ids (roots) with
// and without the legacy branch, and reading the journal anchors of a user. Results go to stdout;
// record notable ones in docs/jmap/performance.md.
//
//   node test/jmap/bench/roots-bench.js [mongodb-url]

const { MongoClient, ObjectId } = require('mongodb');
const { resolveRoots } = require('../../../lib/message-roots');
const { journalAnchors } = require('../../../lib/journal-state');

const MESSAGES = Number(process.env.MESSAGES) || 100000;
const ROUNDS = Number(process.env.ROUNDS) || 50;

async function time(label, rounds, fn) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
        const started = process.hrtime.bigint();
        await fn(i);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const at = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))].toFixed(2);
    console.log(`${label.padEnd(44)} p50 ${at(0.5)} ms  p95 ${at(0.95)} ms`);
}

async function main() {
    const client = await MongoClient.connect(process.argv[2] || 'mongodb://127.0.0.1:27017');
    const db = client.db('wildduck-jmap-bench');
    await db.dropDatabase();
    const messages = db.collection('messages');
    await messages.createIndex({ root: 1 }, { name: 'by_root', partialFilterExpression: { root: { $exists: true } } });
    await messages.createIndex({ user: 1, thread: 1 }, { name: 'user_messages_by_thread' });
    await db.collection('journal').createIndex({ user: 1, _id: -1 }, { name: 'user_limit_id_reverse' });

    const user = new ObjectId();
    const mailboxes = Array.from({ length: 20 }, () => new ObjectId());
    const roots = [];
    for (let offset = 0; offset < MESSAGES; offset += 5000) {
        const batch = Array.from({ length: Math.min(5000, MESSAGES - offset) }, (value, i) => {
            const _id = new ObjectId();
            roots.push(_id);
            return { _id, root: _id, user, mailbox: mailboxes[(offset + i) % mailboxes.length], uid: offset + i, thread: user };
        });
        await messages.insertMany(batch);
    }
    await db.collection('journal').insertMany(Array.from({ length: 10000 }, (value, i) => ({ user, command: i % 3 ? 'FETCH' : 'EXISTS', message: roots[i] })));
    console.log(`seeded ${MESSAGES} messages and 10000 journal entries for one user`);

    const pick = n => Array.from({ length: n }, () => roots[Math.floor(Math.random() * roots.length)]);
    for (const n of [50, 500]) {
        await time(`resolveRoots ${n} ids, migrated user`, ROUNDS, () => resolveRoots(messages, user, pick(n), { legacy: false }));
        await time(`resolveRoots ${n} ids, legacy branch`, ROUNDS, () => resolveRoots(messages, user, pick(n)));
    }
    await time('journalAnchors', ROUNDS, () => journalAnchors(db, user));

    await db.dropDatabase();
    await client.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
