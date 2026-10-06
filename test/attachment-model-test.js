/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0, no-await-in-loop: 0, no-use-before-define: 0 */
/* globals before: false, after: false */
'use strict';

// Model-based randomized test of the attachment store.
//
// A seeded random sequence of operations (store messages with attachments, copy, delete, expire, collect
// garbage, read) runs against the real storage, MongoDB and S3 (when S3_TEST_ENDPOINT is set), and an
// in-memory model says what must be true after every step: each referenced attachment reads back byte for
// byte, its counters match the references, nothing referenced is ever collected, and once every message is
// gone and enough time has passed, nothing is left behind. Faults are injected along the way: S3 refusing
// uploads (the message is then not stored) and deletes, the collector stopping between any two of its steps, uploads leaving chunks behind,
// and messages arriving, being copied or deleted, or a second process collecting while a collection runs.
//
// A failure prints the seed and the step; ATTACHMENT_MODEL_SEED=<seed> replays it. ATTACHMENT_MODEL_RUNS and
// ATTACHMENT_MODEL_STEPS make the run longer.

const crypto = require('crypto');
const { expect } = require('chai');
const { S3Client, CreateBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');
const { emptyBucket, collect, objectIdAt, prng, seedFrom, createAttachmentIndexes } = require('./attachment-s3-helpers');

const endpoint = process.env.S3_TEST_ENDPOINT;
const RUNS = Number(process.env.ATTACHMENT_MODEL_RUNS) || 3;
const STEPS = Number(process.env.ATTACHMENT_MODEL_STEPS) || 120;
const FIXED_SEED = process.env.ATTACHMENT_MODEL_SEED ? seedFrom('ATTACHMENT_MODEL_SEED') : null;
const DAY = 24 * 3600 * 1000;
const CHUNK = 255 * 1024;

function wrap(text, width) {
    return text.replace(new RegExp(`.{1,${width}}`, 'g'), '$&\r\n').replace(/\r\n$/, '');
}

// attachment bodies of every kind the store treats differently
function makePayloads(random) {
    let payloads = [];
    let add = (kind, transferEncoding, body) => payloads.push({ kind, transferEncoding, body, id: crypto.createHash('sha256').update(body).digest() });
    for (let i = 0; i < 10; i++) {
        let size = random.pick([0, 1, 2, 3, 57, 1000, 4096, 70 * 1024, 2 * CHUNK + 7]);
        let raw = random.bytes(size);
        let width = random.pick([76, 72, 64]);
        let base64 = wrap(raw.toString('base64'), width);
        add('canonical base64', 'base64', Buffer.from(base64 || 'AA=='));
        add('base64 and a blank line', 'base64', Buffer.from((base64 || 'AA==') + '\r\n'));
        // uneven wrapping can not be reproduced by the encoder, so it is stored as it is
        add('uneven base64', 'base64', Buffer.from(wrap(raw.toString('base64'), width + 3).replace(/\r\n/, '\r\n\r\n') || 'QQ'));
        add('7bit', '7bit', Buffer.from(raw.toString('hex').slice(0, Math.max(size, 1))));
        add(
            'quoted-printable',
            'quoted-printable',
            Buffer.from(raw.toString('latin1').replace(/[^ -<>-~]/g, c => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) + 'x')
        );
    }
    // identical bodies arrive under different kinds of messages, which is what deduplication is for
    return payloads;
}

describe('Attachment store model', function () {
    this.timeout(30 * 60 * 1000);

    let s3Client;
    let s3Bucket;

    before(async function () {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
        if (endpoint) {
            s3Bucket = `wildduck-model-${crypto.randomBytes(5).toString('hex')}`;
            s3Client = new S3Client({
                region: 'us-east-1',
                endpoint,
                forcePathStyle: true,
                credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test' }
            });
            await s3Client.send(new CreateBucketCommand({ Bucket: s3Bucket }));
        }
    });

    after(async function () {
        if (s3Client) {
            await emptyBucket(s3Client, s3Bucket);
            s3Client.destroy();
        }
    });

    let seeds = FIXED_SEED !== null ? [FIXED_SEED] : Array.from({ length: RUNS }, () => crypto.randomInt(2 ** 31));
    for (let seed of seeds) {
        it(`keeps every invariant through ${STEPS} random steps (seed ${seed})`, async function () {
            await runModel(seed);
        });
    }

    async function runModel(seed) {
        let random = prng(seed);
        let bucket = `model${crypto.randomBytes(4).toString('hex')}`;
        let files = db.gridfs.collection(`${bucket}.files`);
        let chunks = db.gridfs.collection(`${bucket}.chunks`);
        let trash = db.gridfs.collection(`${bucket}.trash`);
        await createAttachmentIndexes(db.gridfs, bucket);

        let options = type => ({ type, bucket, decodeBase64: true, ...(endpoint ? { s3: { bucket: s3Bucket, prefix: bucket } } : {}) });
        let writers = [new AttachmentStorage({ gridfs: db.gridfs, redis: db.redis, options: options('gridstore'), s3Client })];
        if (endpoint) {
            writers.push(new AttachmentStorage({ gridfs: db.gridfs, redis: db.redis, options: options('s3'), s3Client }));
        }
        let reader = writers[writers.length - 1];

        let payloads = makePayloads(random);
        let byId = new Map(payloads.map(payload => [payload.id.toString('hex'), payload]));
        // message id -> { magic, ids }: the references a stored message holds, one per attachment
        let messages = new Map();
        let nextMessage = 0;
        // attachments whose leftover chunks nothing can remove: the store that met them failed and the attachment
        // was not stored since. Without a record the collector does not know about them, like on master
        let stranded = new Set();
        let step = 0;
        let log = [];

        let context = () => `seed ${seed}, step ${step}: ${log.slice(-6).join(' | ')}`;

        // faults: the next operation of a kind fails
        let faults = { s3Put: 0, s3Delete: 0, addTombstone: 0, removeOrphan: 0, releasePayload: 0 };
        for (let writer of writers) {
            if (writer.s3) {
                let put = writer.s3.put.bind(writer.s3);
                writer.s3.put = async (...args) => {
                    if (faults.s3Put > 0) {
                        faults.s3Put--;
                        throw Object.assign(new Error('injected S3 upload failure'), { $metadata: { httpStatusCode: random.pick([503, 403]) } });
                    }
                    return await put(...args);
                };
                let deletePayload = writer.s3.deletePayload.bind(writer.s3);
                writer.s3.deletePayload = async (...args) => {
                    if (faults.s3Delete > 0) {
                        faults.s3Delete--;
                        throw Object.assign(new Error('injected S3 delete failure'), { $metadata: { httpStatusCode: 503 } });
                    }
                    return await deletePayload(...args);
                };
            }
            let addTombstone = writer.catalog.addTombstone.bind(writer.catalog);
            writer.catalog.addTombstone = async (...args) => {
                let tombstone = await addTombstone(...args);
                if (faults.addTombstone > 0) {
                    // the collector stops with a tombstone written and the record still there
                    faults.addTombstone--;
                    throw new Error('injected stop after the tombstone');
                }
                return tombstone;
            };
            let removeOrphan = writer.catalog.removeOrphan.bind(writer.catalog);
            writer.catalog.removeOrphan = async (...args) => {
                let removed = await removeOrphan(...args);
                if (faults.removeOrphan > 0) {
                    // the collector stops right after removing the record
                    faults.removeOrphan--;
                    throw new Error('injected stop after record removal');
                }
                return removed;
            };
            let releasePayload = writer.releasePayload.bind(writer);
            writer.releasePayload = async (...args) => {
                if (faults.releasePayload > 0) {
                    faults.releasePayload--;
                    throw new Error('injected stop before payload deletion');
                }
                return await releasePayload(...args);
            };
        }

        let references = () => {
            let counts = new Map();
            for (let message of messages.values()) {
                for (let id of message.ids) {
                    let hex = id.toString('hex');
                    let entry = counts.get(hex) || { c: 0, m: 0 };
                    entry.c++;
                    entry.m += message.magic;
                    counts.set(hex, entry);
                }
            }
            return counts;
        };

        let create = (writer, payload, magic) =>
            new Promise((resolve, reject) =>
                writer.create(
                    { body: payload.body, contentType: 'application/octet-stream', transferEncoding: payload.transferEncoding, lineCount: 1, magic },
                    (err, id) => {
                        if (err) {
                            return reject(err);
                        }
                        // stored again, the collector removes the leftovers along with the record
                        stranded.delete(id.toString('hex'));
                        resolve(id);
                    }
                )
            );

        let operations = {
            async store() {
                let writer = random.pick(writers);
                let magic = random.int(1, 0xffff);
                let count = random.int(1, 4);
                let picked = Array.from({ length: count }, () => random.pick(payloads));
                if (random.chance(0.2)) {
                    // the same file twice in one message
                    picked.push(picked[0]);
                }
                if (writer.s3 && random.chance(0.15)) {
                    faults.s3Put = 1;
                }
                let leftover;
                if (random.chance(0.1)) {
                    // an upload of the first one stopped ten minutes ago and left a chunk behind
                    leftover = picked[0];
                    if (!(await files.findOne({ _id: leftover.id }))) {
                        await chunks.insertOne({
                            _id: objectIdAt(new Date(Date.now() - 10 * 60 * 1000)),
                            files_id: leftover.id,
                            n: 1,
                            data: Buffer.from('leftover')
                        });
                    }
                }
                // attachments of a message are stored one after the other, like storeNodeBodies() does
                let ids = [];
                try {
                    for (let payload of picked) {
                        let id = await create(writer, payload, magic);
                        expect(id.equals(payload.id), context()).to.be.true;
                        ids.push(id);
                    }
                } catch (err) {
                    if (!/injected S3 upload failure/.test(err.message)) {
                        throw err;
                    }
                    // the message is not stored: like the message handler, release what it already took
                    faults.s3Put = 0;
                    await writer.deleteManyAsync(ids, magic);
                    if (leftover && !(await files.findOne({ _id: leftover.id }))) {
                        stranded.add(leftover.id.toString('hex'));
                    }
                    return `store ${writer.type} failed on S3`;
                }
                faults.s3Put = 0;
                messages.set(nextMessage++, { magic, ids });
                return `store ${writer.type} ${picked.map(p => p.kind).join(',')}`;
            },

            async storeConcurrently() {
                // several messages with the same new attachments at the same time
                let payload = random.pick(payloads);
                let stored = await Promise.all(
                    Array.from({ length: random.int(2, 5) }, async () => {
                        let magic = random.int(1, 0xffff);
                        let id = await create(random.pick(writers), payload, magic);
                        return { magic, ids: [id] };
                    })
                );
                for (let message of stored) {
                    messages.set(nextMessage++, message);
                }
                return `store ${stored.length} at once ${payload.kind}`;
            },

            async copy() {
                if (!messages.size) {
                    return 'copy nothing';
                }
                let source = messages.get(random.pick([...messages.keys()]));
                await reader.updateMany(source.ids, 1, source.magic);
                messages.set(nextMessage++, { magic: source.magic, ids: [...source.ids] });
                return 'copy';
            },

            async remove() {
                if (!messages.size) {
                    return 'delete nothing';
                }
                let key = random.pick([...messages.keys()]);
                let message = messages.get(key);
                messages.delete(key);
                if (random.chance(0.5)) {
                    await reader.deleteManyAsync(message.ids, message.magic);
                    return 'delete';
                }
                // expired messages are released through updateMany
                await reader.updateMany(message.ids, -1, -message.magic);
                return 'expire';
            },

            async collect() {
                await passTime();
                let collector = random.pick(writers);
                if (random.chance(0.3)) {
                    let kinds = ['addTombstone', 'removeOrphan', 'releasePayload'].concat(collector.s3 ? ['s3Delete'] : []);
                    faults[random.pick(kinds)] = 1;
                }
                let work = [collector.deleteOrphanedAsync()];
                let concurrent = [];
                // other things that happen while a collection runs
                if (random.chance(0.3)) {
                    // a message with a payload that may be collected right now arrives meanwhile
                    work.push(operations.storeConcurrently());
                    concurrent.push('store');
                }
                if (random.chance(0.2)) {
                    // another process collects at the same time
                    work.push(random.pick(writers).deleteOrphanedAsync());
                    concurrent.push('collect');
                }
                for (let name of ['copy', 'remove']) {
                    if (random.chance(0.2)) {
                        work.push(operations[name]());
                        concurrent.push(name);
                    }
                }
                await Promise.all(work);
                faults.addTombstone = faults.removeOrphan = faults.releasePayload = faults.s3Delete = 0;
                return `collect with ${collector.type}${concurrent.length ? ' while ' + concurrent.join(',') : ''}`;
            },

            async read() {
                let live = [...references().keys()];
                if (!live.length) {
                    return 'read nothing';
                }
                let hex = random.pick(live);
                await expectReadable(hex, true);
                return `read ${byId.get(hex).kind}`;
            }
        };

        // everything idle gets older than the collector waits for; new uploads during a collection stay new
        let passTime = async () => {
            let old = new Date(Date.now() - DAY - 1000);
            let orphans = await files.find({ 'metadata.c': 0, 'metadata.m': 0 }).toArray();
            await files.updateMany({ 'metadata.c': 0, 'metadata.m': 0 }, { $set: { 'metadata.cu': old } });
            for (let chunk of await chunks.find({ files_id: { $in: orphans.map(file => file._id) } }).toArray()) {
                await chunks.deleteOne({ _id: chunk._id });
                await chunks.insertOne({ ...chunk, _id: objectIdAt(old) });
            }
            // chunks without a record are leftovers of collections and uploads that stopped
            let recorded = new Set((await files.find({}, { projection: { _id: true } }).toArray()).map(file => file._id.toString('hex')));
            for (let chunk of await chunks.find({}).toArray()) {
                if (!recorded.has(Buffer.from(chunk.files_id.buffer || chunk.files_id).toString('hex'))) {
                    await chunks.deleteOne({ _id: chunk._id });
                    await chunks.insertOne({ ...chunk, _id: objectIdAt(old) });
                }
            }
            for (let tombstone of await trash.find({}).toArray()) {
                await trash.deleteOne({ _id: tombstone._id });
                await trash.insertOne({ ...tombstone, _id: objectIdAt(old) });
            }
        };

        let expectReadable = async (hex, windows) => {
            let payload = byId.get(hex);
            let data = await reader.get(payload.id);
            let whole = await collect(reader.createReadStream(payload.id, data));
            expect(whole.equals(payload.body), `${payload.kind} reads back (${context()})`).to.be.true;
            if (windows) {
                for (let i = 0; i < 3; i++) {
                    let startFrom = random.int(0, payload.body.length);
                    let maxLength = random.int(1, 300);
                    let part = await collect(reader.createReadStream(payload.id, data, { startFrom, maxLength }));
                    expect(part.equals(payload.body.subarray(startFrom, startFrom + maxLength)), `${payload.kind} <${startFrom}.${maxLength}> (${context()})`)
                        .to.be.true;
                }
            }
        };

        let checkInvariants = async () => {
            let expected = references();
            for (let [hex, counts] of expected) {
                let file = await files.findOne({ _id: Buffer.from(hex, 'hex') });
                expect(file, `referenced ${byId.get(hex).kind} has a record (${context()})`).to.exist;
                expect({ c: file.metadata.c, m: file.metadata.m }, `counters of ${byId.get(hex).kind} (${context()})`).to.deep.equal(counts);
                // and its payload is all there
                await expectReadable(hex, false);
            }
            for (let file of await files.find({}).toArray()) {
                if (!expected.has(file._id.toString('hex'))) {
                    expect({ c: file.metadata.c, m: file.metadata.m }, `unreferenced record (${context()})`).to.deep.equal({ c: 0, m: 0 });
                }
            }
        };

        let weighted = [
            ['store', 6],
            ['storeConcurrently', 2],
            ['copy', 2],
            ['remove', 4],
            ['collect', 2],
            ['read', 3]
        ].flatMap(([name, weight]) => Array(weight).fill(name));

        try {
            for (step = 1; step <= STEPS; step++) {
                let name = random.pick(weighted);
                if (process.env.ATTACHMENT_MODEL_DEBUG) {
                    console.log(`step ${step}: ${name}`); // eslint-disable-line no-console
                }
                log.push(await operations[name]());
                if (process.env.ATTACHMENT_MODEL_DEBUG) {
                    console.log(`  ${log[log.length - 1]}`); // eslint-disable-line no-console
                }
                await checkInvariants();
            }
            await checkInvariants();
            for (let hex of references().keys()) {
                await expectReadable(hex, false);
            }

            // every message goes, time passes, the collector runs without faults until nothing is left
            for (let [key, message] of messages) {
                await reader.deleteManyAsync(message.ids, message.magic);
                messages.delete(key);
            }
            for (let pass = 0; pass < 4; pass++) {
                await passTime();
                for (let writer of writers) {
                    await writer.deleteOrphanedAsync();
                }
            }
            expect(await files.countDocuments({}), `records left (${context()})`).to.equal(0);
            let leftChunks = (await chunks.find({}, { projection: { data: false } }).toArray()).filter(
                chunk => !stranded.has(Buffer.from(chunk.files_id.buffer || chunk.files_id).toString('hex'))
            );
            if (leftChunks.length && process.env.ATTACHMENT_MODEL_DEBUG) {
                for (let chunk of leftChunks) {
                    let hex = Buffer.from(chunk.files_id.buffer || chunk.files_id).toString('hex');
                    console.log('left chunk', chunk.n, chunk._id.getTimestamp(), byId.get(hex) && byId.get(hex).kind, (byId.get(hex) || {}).body?.length);
                }
                console.log(log.join('\n'));
            }
            expect(leftChunks.length, `chunks left (${context()})`).to.equal(0);
            expect(await trash.countDocuments({}), `tombstones left (${context()})`).to.equal(0);
            if (s3Client) {
                let listed = await s3Client.send(new ListObjectsV2Command({ Bucket: s3Bucket, Prefix: `${bucket}/` }));
                expect(
                    (listed.Contents || []).map(object => object.Key),
                    `S3 objects left (${context()})`
                ).to.deep.equal([]);
            }
        } catch (err) {
            // a seed replays the sequence of operations; how operations that run at the same time interleave
            // depends on timing and may need a few runs to show again
            err.message = `${err.message}\nReplay with ATTACHMENT_MODEL_SEED=${seed} ATTACHMENT_MODEL_STEPS=${STEPS}`;
            throw err;
        } finally {
            if (process.env.ATTACHMENT_MODEL_DEBUG) {
                console.log(`kept ${bucket} for inspection`); // eslint-disable-line no-console
                return; // eslint-disable-line no-unsafe-finally
            }
            for (let suffix of ['files', 'chunks', 'trash']) {
                await db.gridfs
                    .collection(`${bucket}.${suffix}`)
                    .drop()
                    .catch(() => false);
            }
        }
    }
});
