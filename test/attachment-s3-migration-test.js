/* eslint no-invalid-this: 0, no-unused-expressions: 0 */
/* global before, after */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const AttachmentStorage = require('../lib/attachment-storage');
const { S3TestEnvironment, collect } = require('./attachment-s3-helpers');

const execFileAsync = promisify(execFile);
const script = path.resolve(__dirname, '../scripts/migrate-attachments-to-s3.js');
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

describe('S3 migration CLI arguments', function () {
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
        ['--cleanup-chunks', '--yes=false'],
        ['--cleanup-chunks'],
        ['--migrate', '--verify-only']
    ]) {
        it(`rejects ${args.join(' ')} before connecting to storage`, async () => {
            const error = await failure(execFileAsync(process.execPath, [script, ...args], { timeout: 5000 }), 2);
            expect(error.stderr).to.include('Usage:');
        });
    }
});

(endpoint ? describe : describe.skip)('S3 migration safeguards (Moto)', function () {
    this.timeout(30000);
    let environment;
    let fixture;
    let storage;
    let files;
    let chunks;
    let collectionName;
    let id;
    let encoded;
    let sequence = 0;

    before(async () => {
        environment = new S3TestEnvironment(endpoint);
        await environment.start();
        fixture = await environment.createServer('gridstore');
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
        encoded = Buffer.from(crypto.randomBytes(123).toString('base64').match(/.{1,76}/g).join('\r\n'));
        id = await new Promise((resolve, reject) =>
            storage.create({ body: encoded, transferEncoding: 'base64', lineCount: 3, contentType: 'application/octet-stream', magic: 41 }, (err, createdId) =>
                err ? reject(err) : resolve(createdId)
            )
        );
    });

    async function run(args, expectedCode = 0) {
        const operation = execFileAsync(
            process.execPath,
            [script, `--gridfs-bucket=${collectionName}`, `--config=${fixture.configPath}`, ...args],
            {
                env: { ...process.env, NODE_ENV: 'test', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1' },
                timeout: 20000
            }
        );
        const result = expectedCode ? await failure(operation, expectedCode) : await operation;
        return { ...result, stats: JSON.parse(result.stdout.trim().split('\n').pop()) };
    }

    async function migrate() {
        expect((await run(['--migrate'])).stats.migrated).to.equal(1);
        return await files.findOne({ _id: id });
    }

    it('honors space-separated cleanup prefixes and leaves other shards intact', async () => {
        const selected = Buffer.alloc(32, 0xaa);
        const excluded = Buffer.alloc(32, 0xbb);
        for (const hash of [selected, excluded]) {
            await environment.client.send(new PutObjectCommand({ Bucket: environment.bucket, Key: storage.s3.key(hash), Body: Buffer.from('orphan') }));
        }
        const result = await run(['--cleanup-unreferenced-s3', '--yes', '--prefix', 'aa', '--grace-hours', '0', '--limit', '1']);
        expect(result.stats.unreferencedCleaned).to.equal(1);
        const error = await failure(environment.client.send(new HeadObjectCommand({ Bucket: environment.bucket, Key: storage.s3.key(selected) })), undefined);
        expect(error.$metadata.httpStatusCode).to.equal(404);
        expect((await environment.client.send(new HeadObjectCommand({ Bucket: environment.bucket, Key: storage.s3.key(excluded) }))).ContentLength).to.equal(6);
    });

    it('honors space-separated migration options, preserves counters and remains verifiable after cleanup', async () => {
        const before = await files.findOne({ _id: id });
        const result = await run(['--migrate', '--prefix', id.toString('hex').slice(0, 4), '--concurrency', '1', '--limit', '1']);
        expect(result.stats.migrated).to.equal(1);
        const after = await files.findOne({ _id: id });
        expect(after.metadata.c).to.equal(before.metadata.c);
        expect(after.metadata.m).to.equal(before.metadata.m);
        expect((await collect(storage.createReadStream(id, await storage.get(id)))).equals(encoded)).to.equal(true);
        expect((await run(['--cleanup-chunks', '--yes', '--grace-hours=0'])).stats.cleaned).to.equal(1);
        expect((await run(['--verify-only'])).stats.verified).to.equal(1);
    });

    for (const [field, value, message] of [
        ['length', -1, 'Invalid attachment storage metadata'],
        ['length', 124, 'S3 attachment metadata length mismatch'],
        ['version', 2, 'Invalid attachment storage metadata'],
        ['bucket', '', 'Invalid attachment storage metadata'],
        ['key', '', 'Invalid attachment storage metadata']
    ]) {
        it(`rejects locator ${field}=${JSON.stringify(value)} during verification and retains GridFS chunks during cleanup`, async () => {
            await migrate();
            await files.updateOne({ _id: id }, { $set: { [`metadata.storage.${field}`]: value } });
            for (const args of [['--verify-only'], ['--cleanup-chunks', '--yes', '--grace-hours=0']]) {
                const result = await run(args, 1);
                expect(result.stderr).to.include(message);
                expect(result.stats.failed).to.equal(1);
                expect(result.stats.verified).to.equal(0);
                expect(result.stats.cleaned).to.equal(0);
                expect(await chunks.countDocuments({ files_id: id })).to.equal(1);
            }
        });
    }

    it('refuses to verify an S3 payload with no checksum or GridFS source', async () => {
        const file = await migrate();
        expect((await run(['--cleanup-chunks', '--yes', '--grace-hours=0'])).stats.cleaned).to.equal(1);
        await files.updateOne({ _id: id }, { $unset: { 'metadata.fileContentHash': '' } });
        await environment.client.send(new PutObjectCommand({ Bucket: environment.bucket, Key: file.metadata.storage.key, Body: Buffer.alloc(file.length, 120) }));
        for (const args of [['--verify-only'], ['--cleanup-chunks', '--yes', '--grace-hours=0']]) {
            const result = await run(args, 1);
            expect(result.stderr).to.include('Cannot verify S3 payload without a checksum or GridFS chunks');
            expect(result.stats.verified).to.equal(0);
        }
    });

    it('rejects same-length corruption using the recorded checksum after GridFS cleanup', async () => {
        const file = await migrate();
        await run(['--cleanup-chunks', '--yes', '--grace-hours=0']);
        await environment.client.send(new PutObjectCommand({ Bucket: environment.bucket, Key: file.metadata.storage.key, Body: Buffer.alloc(file.length, 120) }));
        expect((await run(['--verify-only'], 1)).stderr).to.include('S3 payload mismatch');
    });

    it('checks GridFS when the checksum is absent and persists the trusted checksum before cleanup', async () => {
        const file = await migrate();
        await files.updateOne({ _id: id }, { $unset: { 'metadata.fileContentHash': '' } });
        expect((await run(['--verify-only'])).stats.verified).to.equal(1);
        expect((await files.findOne({ _id: id })).metadata.fileContentHash).to.not.exist;
        expect((await run(['--cleanup-chunks', '--yes', '--grace-hours=0'])).stats.cleaned).to.equal(1);
        expect((await files.findOne({ _id: id })).metadata.fileContentHash).to.equal(file.metadata.fileContentHash);
        expect((await run(['--verify-only'])).stats.verified).to.equal(1);
    });

    it('retains GridFS chunks if S3 differs and no checksum is recorded', async () => {
        const file = await migrate();
        await files.updateOne({ _id: id }, { $unset: { 'metadata.fileContentHash': '' } });
        await environment.client.send(new PutObjectCommand({ Bucket: environment.bucket, Key: file.metadata.storage.key, Body: Buffer.alloc(file.length, 120) }));
        expect((await run(['--cleanup-chunks', '--yes', '--grace-hours=0'], 1)).stderr).to.include('GridFS and S3 differ');
        expect(await chunks.countDocuments({ files_id: id })).to.equal(1);
    });

    it('retains GridFS chunks if the migration timestamp is invalid', async () => {
        await migrate();
        await files.updateOne({ _id: id }, { $set: { 'metadata.storage.migratedAt': 'invalid-date' } });
        expect((await run(['--cleanup-chunks', '--yes', '--grace-hours=0'])).stats.cleaned).to.equal(0);
        expect(await chunks.countDocuments({ files_id: id })).to.equal(1);
    });
});
