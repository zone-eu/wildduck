/* eslint no-invalid-this: 0, no-unused-expressions: 0 */
/* global before, after */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ObjectId } = require('mongodb');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const AttachmentStorage = require('../lib/attachment-storage');
const { S3TestEnvironment, collect, createAttachmentIndexes } = require('./attachment-s3-helpers');

const execFileAsync = promisify(execFile);
const script = path.resolve(__dirname, '../scripts/migrate-attachments-to-gridfs.js');
const endpoint = process.env.S3_TEST_ENDPOINT;

async function failure(operation, code) {
    let error;
    try {
        await operation;
    } catch (err) {
        error = err;
    }
    expect(error, 'Expected the command to fail').to.exist;
    expect(error.code).to.equal(code);
    return error;
}

describe('GridFS migration CLI arguments', function () {
    this.timeout(10000);

    for (const args of [
        ['--dry-run', '--prefx=aa'],
        ['--dry-run', 'aa'],
        ['--dry-run', '--prefix'],
        ['--dry-run', '--prefix', '--limit=1'],
        ['--dry-run', '--prefix='],
        ['--dry-run', '--limit='],
        ['--dry-run', '--prefix=aa', '--prefix=bb'],
        ['--dry-run', '--limit=1', '--limit', '2'],
        ['--dry-run=true'],
        ['--migrate', '--verify-only'],
        ['--dry-run', '--batch=0']
    ]) {
        it(`rejects ${args.join(' ')} before connecting to storage`, async () => {
            const error = await failure(execFileAsync(process.execPath, [script, ...args], { timeout: 5000 }), 2);
            expect(error.stderr).to.include('Usage:');
        });
    }
});

describe('GridFS verification without S3 settings', function () {
    this.timeout(10000);

    it('refuses a migration without S3 configuration', async () => {
        const error = await failure(execFileAsync(process.execPath, [script, '--dry-run'], { env: { ...process.env, NODE_ENV: 'test' }, timeout: 8000 }), 1);
        expect(error.stderr).to.match(/S3/i);
    });
});

(endpoint ? describe : describe.skip)('S3 to GridFS migration safeguards (Moto)', function () {
    this.timeout(30000);
    let environment;
    let fixture;
    let storage;
    let files;
    let chunks;
    let id;
    let encoded;
    let collectionName;
    let sequence = 0;

    before(async () => {
        environment = new S3TestEnvironment(endpoint);
        await environment.start();
        fixture = await environment.createServer('s3');
    });

    after(async () => {
        await environment?.close();
    });

    beforeEach(async () => {
        collectionName = `migration_${++sequence}`;
        storage = new AttachmentStorage({
            gridfs: fixture.database,
            redis: environment.redis,
            s3Client: environment.client,
            options: { ...fixture.storage.options.options, bucket: collectionName }
        });
        files = fixture.database.collection(`${collectionName}.files`);
        chunks = fixture.database.collection(`${collectionName}.chunks`);
        await createAttachmentIndexes(fixture.database, collectionName);
        encoded = Buffer.from(
            crypto
                .randomBytes(123)
                .toString('base64')
                .match(/.{1,76}/g)
                .join('\r\n')
        );
        id = await new Promise((resolve, reject) =>
            storage.create({ body: encoded, transferEncoding: 'base64', lineCount: 3, contentType: 'application/octet-stream', magic: 41 }, (err, createdId) =>
                err ? reject(err) : resolve(createdId)
            )
        );
    });

    async function run(args, expectedCode = 0, configPath = fixture.configPath, includeS3Options = true) {
        const s3Options = includeS3Options ? [`--s3-bucket=${environment.bucket}`, `--s3-prefix=${fixture.databaseName}`, `--s3-endpoint=${endpoint}`] : [];
        const operation = execFileAsync(process.execPath, [script, `--gridfs-bucket=${collectionName}`, ...s3Options, `--config=${configPath}`, ...args], {
            env: { ...process.env, NODE_ENV: 'test', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1' },
            timeout: 20000
        });
        const result = expectedCode ? await failure(operation, expectedCode) : await operation;
        return { ...result, stats: JSON.parse(result.stdout.trim().split('\n').pop()) };
    }

    async function writeGridfsOnlyConfig() {
        const noS3ConfigPath = `${fixture.configPath}.${collectionName}.gridfs-only.json`;
        const settings = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'));
        delete settings.attachments.s3;
        await fs.writeFile(noS3ConfigPath, JSON.stringify(settings));
        return noS3ConfigPath;
    }

    function createAttachment(body, transferEncoding = '7bit', magic = 43) {
        return new Promise((resolve, reject) =>
            storage.create({ body, transferEncoding, contentType: 'application/octet-stream', magic }, (err, createdId) =>
                err ? reject(err) : resolve(createdId)
            )
        );
    }

    it('makes no changes in dry-run mode and retries an already migrated record as a no-op', async () => {
        const before = await files.findOne({ _id: id });
        const dryRun = await run(['--dry-run', '--throttle-ms=1']);
        expect(dryRun.stats).to.include({ scanned: 1, migrated: 0 });
        expect(await files.findOne({ _id: id })).to.deep.equal(before);

        const first = await run(['--migrate', '--concurrency=1', '--limit=1']);
        expect(first.stats.migrated).to.equal(1);
        const migrated = await files.findOne({ _id: id });
        expect(migrated.metadata.storage).to.not.exist;
        expect(migrated.metadata.c).to.equal(before.metadata.c);
        expect(migrated.metadata.m).to.equal(before.metadata.m);
        expect(migrated._id).to.deep.equal(before._id);
        const retry = await run(['--migrate']);
        expect(retry.stats.migrated).to.equal(0);
        expect((await files.findOne({ _id: id }))._id).to.deep.equal(before._id);
    });

    it('verifies without S3 configuration and can be read byte-for-byte by GridFS-only storage', async () => {
        await run(['--migrate', '--prefix', id.toString('hex').slice(0, 4)]);
        const noS3ConfigPath = await writeGridfsOnlyConfig();
        try {
            const verified = await run(['--verify-only', '--batch=2'], 0, noS3ConfigPath, false);
            expect(verified.stats.verified).to.equal(1);
        } finally {
            await fs.unlink(noS3ConfigPath);
        }

        const gridfsOnly = new AttachmentStorage({
            gridfs: fixture.database,
            redis: environment.redis,
            options: { type: 'gridstore', bucket: collectionName, decodeBase64: true }
        });
        const file = await gridfsOnly.get(id);
        expect((await collect(gridfsOnly.createReadStream(id, file))).equals(encoded)).to.equal(true);
    });

    it('rejects verify-only when an S3-backed record remains, without S3 flags or config', async () => {
        const noS3ConfigPath = await writeGridfsOnlyConfig();
        try {
            const result = await run(['--verify-only'], 1, noS3ConfigPath, false);
            expect(result.stderr).to.match(/S3|backend|locator/i);
            expect(result.stats.failed).to.be.greaterThan(0);
        } finally {
            await fs.unlink(noS3ConfigPath);
        }
    });

    it('copies multi-chunk payloads exactly and replaces garbage chunks from an interrupted prior copy', async () => {
        encoded = Buffer.from(
            crypto
                .randomBytes(600 * 1024)
                .toString('base64')
                .match(/.{1,76}/g)
                .join('\r\n')
        );
        id = await new Promise((resolve, reject) =>
            storage.create(
                {
                    body: encoded,
                    transferEncoding: 'base64',
                    lineCount: encoded.toString('binary').split('\r\n').length,
                    contentType: 'application/octet-stream',
                    magic: 42
                },
                (err, createdId) => (err ? reject(err) : resolve(createdId))
            )
        );
        const file = await files.findOne({ _id: id });
        expect(file.chunkSize).to.be.greaterThan(0);
        expect(file.length).to.be.greaterThan(file.chunkSize * 2);
        await chunks.insertOne({ _id: new ObjectId(), files_id: id, n: 0, data: Buffer.from('partial-copy') });

        const result = await run(['--migrate', '--prefix', id.toString('hex').slice(0, 4)]);
        expect(result.stats.migrated).to.equal(1);
        const after = await files.findOne({ _id: id });
        expect(after.metadata.storage).to.not.exist;
        expect(await chunks.countDocuments({ files_id: id })).to.equal(Math.ceil(file.length / file.chunkSize));
        const gridfsOnly = new AttachmentStorage({
            gridfs: fixture.database,
            redis: environment.redis,
            options: { type: 'gridstore', bucket: collectionName, decodeBase64: true }
        });
        expect((await collect(gridfsOnly.createReadStream(id, await gridfsOnly.get(id)))).equals(encoded)).to.equal(true);
    });

    it('refuses an S3 copy with no checksum when no GridFS payload was retained', async () => {
        const original = await files.findOne({ _id: id });
        await files.updateOne({ _id: id }, { $unset: { 'metadata.fileContentHash': '' } });
        const result = await run(['--migrate'], 1);
        expect(result.stderr, result.stderr).to.match(/not found|no file|checksum|payload/i);
        const after = await files.findOne({ _id: id });
        expect(after.metadata.storage).to.deep.equal(original.metadata.storage);
        expect(after.metadata.fileContentHash).to.not.exist;
        expect(await chunks.countDocuments({ files_id: id })).to.equal(0);
    });

    it('uses retained GridFS chunks to establish a missing checksum before migration', async () => {
        const original = await files.findOne({ _id: id });
        await run(['--migrate']);
        await files.updateOne({ _id: id }, { $set: { 'metadata.storage': original.metadata.storage }, $unset: { 'metadata.fileContentHash': '' } });
        expect(await chunks.countDocuments({ files_id: id })).to.be.greaterThan(0);

        const result = await run(['--migrate']);
        expect(result.stats.migrated).to.equal(1);
        const after = await files.findOne({ _id: id });
        expect(after.metadata.storage).to.not.exist;
        expect(after.metadata.fileContentHash).to.be.a('string');
        expect((await collect(storage.createReadStream(id, await storage.get(id)))).equals(encoded)).to.equal(true);
    });

    it('detects same-length GridFS corruption during verify-only', async () => {
        await run(['--migrate']);
        const chunk = await chunks.findOne({ files_id: id });
        const corrupted = Buffer.alloc(chunk.data.value().length, 0x7a);
        await chunks.updateOne({ _id: chunk._id }, { $set: { data: corrupted } });
        const noS3ConfigPath = await writeGridfsOnlyConfig();
        try {
            const result = await run(['--verify-only'], 1, noS3ConfigPath, false);
            expect(result.stderr).to.match(/mismatch/i);
            expect(result.stats.failed).to.equal(1);
            expect(result.stats.verified).to.equal(0);
        } finally {
            await fs.unlink(noS3ConfigPath);
        }
    });

    it('verifies a GridFS record stored without a checksum by its length', async () => {
        await run(['--migrate']);
        const legacy = await createAttachment(Buffer.from('stored before checksums were recorded'), '7bit', 44);
        await run(['--migrate']);
        await files.updateOne({ _id: legacy }, { $unset: { 'metadata.fileContentHash': '' } });
        const noS3ConfigPath = await writeGridfsOnlyConfig();
        try {
            const verified = await run(['--verify-only'], 0, noS3ConfigPath, false);
            expect(verified.stats).to.include({ verified: 2, failed: 0 });

            await chunks.deleteMany({ files_id: legacy });
            const result = await run(['--verify-only'], 1, noS3ConfigPath, false);
            expect(result.stats).to.include({ verified: 1, failed: 1 });
        } finally {
            await fs.unlink(noS3ConfigPath);
        }
    });

    it('paginates beyond batch size and stops exactly at the requested limit', async () => {
        for (let index = 0; index < 4; index++) {
            await createAttachment(Buffer.from(`pagination attachment ${index}`), '7bit', 50 + index);
        }
        expect(await files.countDocuments({ 'metadata.storage.backend': 's3' })).to.equal(5);

        const limited = await run(['--migrate', '--batch=2', '--limit=4']);
        expect(limited.stats).to.include({ scanned: 4, migrated: 4, failed: 0 });
        expect(await files.countDocuments({ 'metadata.storage.backend': 's3' })).to.equal(1);

        const remainder = await run(['--migrate', '--batch=2']);
        expect(remainder.stats).to.include({ scanned: 1, migrated: 1, failed: 0 });
        expect(await files.countDocuments({ 'metadata.storage.backend': 's3' })).to.equal(0);
    });

    it('migrates a native zero-length S3 object into an empty GridFS payload', async () => {
        id = await createAttachment(Buffer.alloc(0), '7bit', 99);
        const file = await files.findOne({ _id: id });
        expect(file.length).to.equal(0);

        const result = await run(['--migrate', '--prefix', id.toString('hex').slice(0, 4)]);
        expect(result.stats.migrated).to.equal(1);
        const after = await files.findOne({ _id: id });
        expect(after.metadata.storage).to.not.exist;
        expect(after.length).to.equal(0);
        expect(await chunks.countDocuments({ files_id: id })).to.equal(0);
        const gridfsOnly = new AttachmentStorage({
            gridfs: fixture.database,
            redis: environment.redis,
            options: { type: 'gridstore', bucket: collectionName }
        });
        expect((await collect(gridfsOnly.createReadStream(id, await gridfsOnly.get(id)))).length).to.equal(0);
    });

    it('retains the S3 locator and leaves GridFS unchanged if a source object is corrupt', async () => {
        const original = await files.findOne({ _id: id });
        await environment.client.send(
            new PutObjectCommand({
                Bucket: original.metadata.storage.bucket,
                Key: original.metadata.storage.key,
                Body: Buffer.alloc(original.length, 0x5a)
            })
        );
        const result = await run(['--migrate'], 1);
        expect(result.stderr).to.match(/mismatch|checksum|corrupt/i);
        const after = await files.findOne({ _id: id });
        expect(after.metadata.storage).to.deep.equal(original.metadata.storage);
        expect(await chunks.countDocuments({ files_id: id })).to.equal(0);
    });
});
