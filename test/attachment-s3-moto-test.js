/* eslint no-invalid-this: 0, no-unused-expressions: 0 */
/* global before, after */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
    S3Client,
    CreateBucketCommand,
    HeadObjectCommand,
    PutObjectCommand,
    DeleteBucketCommand,
    DeleteObjectCommand,
    ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const AttachmentStorage = require('../lib/attachment-storage');
const db = require('../lib/db');
const { ageChunks } = require('./attachment-s3-helpers');

const endpoint = process.env.S3_TEST_ENDPOINT;
const execFileAsync = promisify(execFile);

async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

(endpoint ? describe : describe.skip)('S3 attachment integration', function () {
    this.timeout(30000);
    let client;
    let storage;
    let gridstore;
    let bucketName;
    let collectionName;

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
        const nonce = crypto.randomBytes(5).toString('hex');
        bucketName = `wildduck-att-${nonce}`;
        collectionName = `att_test_${nonce}`;
        client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
        await client.send(new CreateBucketCommand({ Bucket: bucketName }));
        await db.gridfs
            .collection(`${collectionName}.files`)
            .createIndex({ 'metadata.c': 1, 'metadata.m': 1, 'metadata.cu': 1 }, { name: 'related_attachments_cu' });
        const s3 = { bucket: bucketName, prefix: `test-${nonce}`, region: 'us-east-1', endpoint, forcePathStyle: true };
        const common = { gridfs: db.gridfs, redis: db.redis, s3Client: client };
        storage = new AttachmentStorage({ ...common, options: { type: 's3', bucket: collectionName, decodeBase64: true, s3 } });
        gridstore = new AttachmentStorage({ ...common, options: { type: 'gridstore', bucket: collectionName, decodeBase64: true, s3 } });
    });

    after(async () => {
        if (collectionName) {
            await db.gridfs
                .collection(`${collectionName}.files`)
                .drop()
                .catch(() => false);
            await db.gridfs
                .collection(`${collectionName}.chunks`)
                .drop()
                .catch(() => false);
        }
        if (bucketName) {
            const listed = await client.send(new ListObjectsV2Command({ Bucket: bucketName })).catch(() => ({ Contents: [] }));
            for (const object of listed.Contents || []) {
                await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: object.Key }));
            }
            await client.send(new DeleteBucketCommand({ Bucket: bucketName })).catch(() => false);
        }
    });

    function create(target, attachment) {
        return new Promise((resolve, reject) => target.create(attachment, (err, id, fileHash) => (err ? reject(err) : resolve({ id, fileHash }))));
    }

    it('writes S3, deduplicates, reads from both modes, and collects the orphan', async () => {
        const attachment = { body: Buffer.from('YWJj\r\nZGVm'), transferEncoding: 'base64', lineCount: 2, contentType: 'application/octet-stream', magic: 17 };
        const first = await create(storage, attachment);
        const second = await create(gridstore, { ...attachment, magic: 23 });
        expect(second.id.equals(first.id)).to.equal(true);
        const file = await db.gridfs.collection(`${collectionName}.files`).findOne({ _id: first.id });
        expect(file.metadata.storage.backend).to.equal('s3');
        expect(file.metadata.c).to.equal(2);
        expect(file.metadata.m).to.equal(40);
        expect(first.fileHash).to.equal(crypto.createHash('sha256').update('abcdef').digest('base64'));
        expect(await db.gridfs.collection(`${collectionName}.chunks`).countDocuments({ files_id: first.id })).to.equal(0);
        const data = await gridstore.get(first.id);
        expect((await collect(storage.createReadStream(first.id, data))).toString()).to.equal('YWJj\r\nZGVm');
        expect((await collect(gridstore.createReadStream(first.id, data, { startFrom: 4, maxLength: 4 }))).toString()).to.equal('\r\nZG');
        await storage.updateMany([first.id], 1, 29);
        const copied = await db.gridfs.collection(`${collectionName}.files`).findOne({ _id: first.id });
        expect(copied.metadata.c).to.equal(3);
        expect(copied.metadata.m).to.equal(69);
        await storage.deleteAsync(first.id, 29);
        await gridstore.deleteAsync(first.id, 23);
        await storage.deleteAsync(first.id, 17);
        await db.gridfs.collection(`${collectionName}.files`).updateOne({ _id: first.id }, { $set: { 'metadata.cu': new Date(0) } });
        expect(await storage.deleteOrphanedAsync()).to.equal(1);
        expect(await db.gridfs.collection(`${collectionName}.files`).countDocuments({ _id: first.id })).to.equal(0);
        try {
            await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: file.metadata.storage.key }));
            throw new Error('Expected deleted object');
        } catch (err) {
            expect(err.$metadata?.httpStatusCode).to.equal(404);
        }
    });

    it('keeps a GridFS payload readable when new writes prefer S3', async () => {
        const attachment = { body: Buffer.from('gridfs legacy payload'), transferEncoding: '8bit', lineCount: 1, contentType: 'text/plain', magic: 31 };
        const created = await create(gridstore, attachment);
        const data = await storage.get(created.id);
        expect(data.metadata.storage).to.not.exist;
        expect((await collect(storage.createReadStream(created.id, data))).toString()).to.equal(attachment.body.toString());
        const duplicate = await create(storage, { ...attachment, magic: 37 });
        expect(duplicate.id.equals(created.id)).to.equal(true);
        expect(await db.gridfs.collection(`${collectionName}.chunks`).countDocuments({ files_id: created.id })).to.be.above(0);
        await gridstore.deleteAsync(created.id, 31);
        await storage.deleteAsync(created.id, 37);
        await db.gridfs.collection(`${collectionName}.files`).updateOne({ _id: created.id }, { $set: { 'metadata.cu': new Date(0) } });
        await ageChunks(db.gridfs.collection(`${collectionName}.chunks`), created.id);
        expect(await gridstore.deleteOrphanedAsync()).to.equal(1);
        expect(await db.gridfs.collection(`${collectionName}.files`).countDocuments({ _id: created.id })).to.equal(0);
        expect(await db.gridfs.collection(`${collectionName}.chunks`).countDocuments({ files_id: created.id })).to.equal(0);
    });

    it('stores quoted-printable bytes without changing their MIME representation', async () => {
        const attachment = {
            body: Buffer.from('hello=20world=0D=0A'),
            transferEncoding: 'quoted-printable',
            lineCount: 1,
            contentType: 'text/plain',
            magic: 43
        };
        const created = await create(storage, attachment);
        const data = await storage.get(created.id);
        expect(data.metadata.decoded).to.not.exist;
        expect((await collect(storage.createReadStream(created.id, data))).equals(attachment.body)).to.equal(true);
        expect((await collect(storage.createReadStream(created.id, data, { startFrom: 5, maxLength: 6 }))).toString()).to.equal('=20wor');
    });

    it('migrates GridFS bytes, verifies them, and removes old chunks explicitly', async () => {
        const attachment = {
            body: Buffer.from('bWlncmF0ZWQgYnl0ZXM='),
            transferEncoding: 'base64',
            lineCount: 1,
            contentType: 'application/octet-stream',
            magic: 41
        };
        const created = await create(gridstore, attachment);
        const before = await db.gridfs.collection(`${collectionName}.files`).findOne({ _id: created.id });
        expect(before.metadata.storage).to.not.exist;
        const baseArgs = [
            path.resolve(__dirname, '../scripts/migrate-attachments-to-s3.js'),
            `--prefix=${created.id.toString('hex').slice(0, 4)}`,
            '--limit=1',
            `--gridfs-bucket=${collectionName}`,
            `--s3-bucket=${bucketName}`,
            `--s3-prefix=${storePrefix()}`,
            `--s3-endpoint=${endpoint}`
        ];
        const env = { ...process.env, NODE_ENV: 'test', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1' };
        for (const mode of ['--migrate', '--verify-only', '--cleanup-chunks']) {
            const args = mode === '--cleanup-chunks' ? [...baseArgs, mode, '--yes', '--grace-hours=0'] : [...baseArgs, mode];
            const result = await execFileAsync(process.execPath, args, { env, timeout: 30000 });
            expect(result.stdout).to.include(mode === '--migrate' ? '"migrated":1' : mode === '--verify-only' ? '"verified":1' : '"cleaned":1');
        }
        const after = await db.gridfs.collection(`${collectionName}.files`).findOne({ _id: created.id });
        expect(after.metadata.storage.backend).to.equal('s3');
        expect(after.metadata.c).to.equal(before.metadata.c);
        expect(after.metadata.m).to.equal(before.metadata.m);
        expect(await db.gridfs.collection(`${collectionName}.chunks`).countDocuments({ files_id: created.id })).to.equal(0);
        const data = await storage.get(created.id);
        expect((await collect(storage.createReadStream(created.id, data))).toString()).to.equal(attachment.body.toString());

        const orphanId = crypto.createHash('sha256').update('unreferenced-final').digest();
        const orphanKey = storage.s3.key(orphanId, '0123456789abcdef');
        await client.send(new PutObjectCommand({ Bucket: bucketName, Key: orphanKey, Body: Buffer.from('orphan') }));
        const orphanArgs = baseArgs.map(arg => (arg.startsWith('--prefix=') ? `--prefix=${orphanId.toString('hex').slice(0, 4)}` : arg));
        const removed = await execFileAsync(process.execPath, [...orphanArgs, '--cleanup-unreferenced-s3', '--yes', '--grace-hours=0'], {
            env,
            timeout: 30000
        });
        expect(removed.stdout).to.include('"unreferencedCleaned":1');
        try {
            await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: orphanKey }));
            throw new Error('Expected deleted unreferenced object');
        } catch (err) {
            expect(err.$metadata?.httpStatusCode).to.equal(404);
        }
    });

    function storePrefix() {
        return storage.s3.prefix;
    }
});
