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
const { ageChunks, createAttachmentIndexes } = require('./attachment-s3-helpers');

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
        await createAttachmentIndexes(db.gridfs, collectionName);
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

    describe('minObjectSize', () => {
        const files = () => db.gridfs.collection(`${collectionName}.files`);
        const chunks = () => db.gridfs.collection(`${collectionName}.chunks`);

        function sizedStorage(options) {
            return new AttachmentStorage({ ...storage.options, options: { ...storage.options.options, ...options } });
        }

        function binaryAttachment(body, magic = 5) {
            return { body, transferEncoding: 'binary', lineCount: 1, contentType: 'application/octet-stream', magic };
        }

        function base64Attachment(binary) {
            const encoded = binary
                .toString('base64')
                .match(/.{1,76}/g)
                .join('\r\n');
            return { body: Buffer.from(encoded), transferEncoding: 'base64', contentType: 'application/octet-stream', magic: 5 };
        }

        async function readBack(target, id) {
            return await collect(target.createReadStream(id, await target.get(id)));
        }

        it('keeps payloads below the threshold in GridFS and stores the rest in S3', async () => {
            const sized = sizedStorage({ minObjectSize: 1000 });
            const small = crypto.randomBytes(999);
            const large = crypto.randomBytes(1000);
            const smallId = (await create(sized, binaryAttachment(small))).id;
            const largeId = (await create(sized, binaryAttachment(large))).id;

            expect((await files().findOne({ _id: smallId })).metadata.storage).to.be.undefined;
            expect(await chunks().countDocuments({ files_id: smallId })).to.equal(1);
            const file = await files().findOne({ _id: largeId });
            expect(file.metadata.storage).to.deep.include({ backend: 's3', length: 1000 });
            expect(await chunks().countDocuments({ files_id: largeId })).to.equal(0);
            await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: file.metadata.storage.key }));
            expect((await readBack(sized, smallId)).equals(small)).to.be.true;
            expect((await readBack(sized, largeId)).equals(large)).to.be.true;
        });

        it('measures the decoded payload of a base64 body', async () => {
            const sized = sizedStorage({ minObjectSize: 1000 });
            // 1350 encoded bytes that decode to 999, and a body that decodes to exactly the threshold
            const below = base64Attachment(crypto.randomBytes(999));
            const at = base64Attachment(crypto.randomBytes(1000));
            expect(below.body.length).to.be.above(1000);
            const belowId = (await create(sized, below)).id;
            const atId = (await create(sized, at)).id;

            const belowFile = await files().findOne({ _id: belowId });
            expect(belowFile.metadata.storage).to.be.undefined;
            expect(belowFile.length).to.equal(999);
            expect((await files().findOne({ _id: atId })).metadata.storage).to.deep.include({ backend: 's3', length: 1000 });
            expect((await readBack(sized, belowId)).equals(below.body)).to.be.true;
            expect((await readBack(sized, atId)).equals(at.body)).to.be.true;
        });

        it('adds a reference to a copy stored on the other side of the threshold', async () => {
            const body = crypto.randomBytes(500);
            const { id } = await create(storage, binaryAttachment(body));
            await create(sizedStorage({ minObjectSize: 1000 }), binaryAttachment(body, 7));

            const file = await files().findOne({ _id: id });
            expect(file.metadata.c).to.equal(2);
            expect(file.metadata.m).to.equal(12);
            expect(file.metadata.storage.backend).to.equal('s3');
            expect(await chunks().countDocuments({ files_id: id })).to.equal(0);
        });

        it('accepts the threshold as a string and refuses anything but a byte count', () => {
            expect(sizedStorage({ minObjectSize: '262144' }).minObjectSize).to.equal(262144);
            expect(sizedStorage({}).minObjectSize).to.equal(0);
            expect(() => sizedStorage({ minObjectSize: '256k' })).to.throw(/minObjectSize/);
            expect(() => sizedStorage({ minObjectSize: -1 })).to.throw(/minObjectSize/);
        });
    });
});
