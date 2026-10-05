'use strict';

const { expect } = require('chai');
const { Readable, PassThrough } = require('stream');
const {
    GetObjectCommand,
    HeadObjectCommand,
    CopyObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCopyCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');
const S3Storage = require('../lib/attachments/s3-storage');
const GridstoreStorage = require('../lib/attachments/gridstore-storage');
const { prepareStoredBody } = require('../lib/attachments/base64-codec');

function prepareAttachment(attachment, decodeBase64) {
    const { data, metadata } = prepareStoredBody(attachment, { decodeBase64 });
    return { body: data, metadata };
}

async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function mockStore(body, requests) {
    const client = {
        async send(command) {
            if (command instanceof HeadObjectCommand) {
                return { ContentLength: body.length };
            }
            expect(command).to.be.instanceOf(GetObjectCommand);
            const range = command.input.Range;
            requests.push(range);
            const match = range && /^bytes=(\d+)-(\d+)$/.exec(range);
            const start = match ? Number(match[1]) : 0;
            const end = match ? Number(match[2]) + 1 : body.length;
            return {
                Body: Readable.from([body.subarray(start, end)]),
                ContentLength: end - start,
                ContentRange: range ? `bytes ${start}-${end - 1}/${body.length}` : undefined
            };
        }
    };
    return new S3Storage({ options: { decodeBase64: true, s3: { bucket: 'test', prefix: 'test-ns' } }, s3Client: client });
}

describe('S3 attachment payloads', () => {
    const id = Buffer.alloc(32, 0xab);

    it('uses stable hash-sharded object keys', () => {
        const store = mockStore(Buffer.alloc(0), []);
        expect(store.key(id)).to.equal(`test-ns/attachments/v1/ab/ab/${id.toString('hex')}`);
    });

    it('preserves the GridFS decoded-base64 representation', () => {
        const store = mockStore(Buffer.alloc(0), []);
        const prepared = store.prepare({ body: Buffer.from('YWJj\r\nZGVm'), transferEncoding: 'base64', lineCount: 2, magic: 17 });
        expect(prepared.body.toString()).to.equal('abcdef');
        expect(prepared.metadata.decoded).to.equal(true);
        expect(prepared.metadata.lineLen).to.equal(4);
        expect(prepared.metadata.esize).to.equal(10);
    });

    it('decodes base64 followed by a blank line and keeps its size', () => {
        const store = mockStore(Buffer.alloc(0), []);
        const prepared = store.prepare({ body: Buffer.from('YWJj\r\nZGVm\r\n'), transferEncoding: 'base64', lineCount: 3, magic: 17 });
        expect(prepared.body.toString()).to.equal('abcdef');
        expect(prepared.metadata.decoded).to.equal(true);
        expect(prepared.metadata.esize).to.equal(12);
    });

    it('keeps noncanonical base64 as original MIME bytes', () => {
        const store = mockStore(Buffer.alloc(0), []);
        for (const encoded of ['YWJj\r\nZG\r\nVm', 'YWJj\r\nZ GV m', 'YR==', 'YQ', 'YWJj\r\nZGV\u00ed']) {
            const body = Buffer.from(encoded, 'latin1');
            const prepared = store.prepare({ body, transferEncoding: 'base64', lineCount: encoded.split('\r\n').length, magic: 17 });
            expect(prepared.body.equals(body), encoded).to.equal(true);
            expect(prepared.metadata.decoded, encoded).to.equal(undefined);
        }
    });

    it('returns unchanged bytes when decoding is disabled or encoding is quoted-printable', () => {
        const body = Buffer.from('YWJj');
        expect(prepareAttachment({ body, transferEncoding: 'base64' }, false).body).to.equal(body);
        expect(prepareAttachment({ body, transferEncoding: 'quoted-printable' }, true).body).to.equal(body);
    });

    it('returns raw ranges and an empty stream beyond EOF', async () => {
        const body = Buffer.from('abcdef');
        const requests = [];
        const store = mockStore(body, requests);
        const data = { length: body.length, metadata: { storage: { backend: 's3', bucket: 'test', key: store.key(id) } } };
        expect((await collect(store.createReadStream(id, data, { startFrom: 2, maxLength: 3 }))).toString()).to.equal('cde');
        expect((await collect(store.createReadStream(id, data, { startFrom: 20, maxLength: 3 }))).length).to.equal(0);
        expect(requests).to.deep.equal(['bytes=2-4']);
    });

    it('reconstructs folded base64 and partial reads from decoded bytes', async () => {
        const body = Buffer.from('abcdef');
        const store = mockStore(body, []);
        const data = { length: body.length, metadata: { decoded: true, lineLen: 4, storage: { backend: 's3', bucket: 'test', key: store.key(id) } } };
        expect((await collect(store.createReadStream(id, data))).toString()).to.equal('YWJj\r\nZGVm');
        expect((await collect(store.createReadStream(id, data, { startFrom: 4, maxLength: 4 }))).toString()).to.equal('\r\nZG');
        expect((await collect(store.createReadStream(id, data, { startFrom: 100, maxLength: 4 }))).length).to.equal(0);
    });

    it('reconstructs identical full and partial MIME bytes through S3 and GridFS', async () => {
        for (const [lineLen, binaryLength] of [[4, 18], [4, 19], [5, 21], [76, 113], [76, 114], [76, 115]]) {
            const binary = Buffer.alloc(binaryLength, 0xab);
            const encoded = binary.toString('base64').match(new RegExp(`.{1,${lineLen}}`, 'g')).join('\r\n');
            const prepared = prepareAttachment(
                { body: Buffer.from(encoded), transferEncoding: 'base64', lineCount: encoded.split('\r\n').length, magic: 17 },
                true
            );
            expect(prepared.metadata.decoded).to.equal(true);
            const data = { length: prepared.body.length, metadata: { ...prepared.metadata, storage: { backend: 's3', bucket: 'test', key: 'key' } } };
            const s3 = mockStore(prepared.body, []);
            const gridfs = Object.create(GridstoreStorage.prototype);
            gridfs.gridstore = {
                openDownloadStream(attachmentId, { start, end }) {
                    // Split the input to exercise encoder state across chunk boundaries.
                    const body = prepared.body.subarray(start, end);
                    return Readable.from([body.subarray(0, 1), body.subarray(1)]);
                }
            };
            for (const store of [s3, gridfs]) {
                expect((await collect(store.createReadStream(id, data))).toString()).to.equal(encoded);
                for (const startFrom of [0, 1, lineLen - 1, lineLen, lineLen + 1, lineLen + 2, encoded.length - 1, encoded.length, encoded.length + 1]) {
                    for (const maxLength of [1, 2, 3, 4, 7]) {
                        const stream = store.createReadStream(id, data, { startFrom, maxLength });
                        const actual = await collect(stream);
                        const expected = encoded.slice(startFrom, startFrom + maxLength);
                        expect(actual.toString(), `line ${lineLen}, offset ${startFrom}, length ${maxLength}`).to.equal(expected);
                    }
                }
            }
        }
    });

    it('treats maxLength zero as an unlimited read, matching the indexer contract', async () => {
        const body = Buffer.from('abcdef');
        const store = mockStore(body, []);
        const data = { length: body.length, metadata: { storage: { backend: 's3', bucket: 'test', key: 'key' } } };
        expect((await collect(store.createReadStream(id, data, { startFrom: 2, maxLength: 0 }))).toString()).to.equal('cdef');
    });

    it('destroys an S3 response that arrives after the reader was cancelled', async () => {
        const store = mockStore(Buffer.alloc(0), []);
        let respond;
        let signal;
        store.client.send = (command, options) => {
            signal = options.abortSignal;
            return new Promise(resolve => {
                respond = resolve;
            });
        };
        const data = { length: 9, metadata: { decoded: true, lineLen: 4, storage: { backend: 's3', bucket: 'test', key: 'key' } } };
        const output = store.createReadStream(id, data, { maxLength: 3 });
        output.destroy();
        const input = new PassThrough();
        respond({ Body: input, ContentLength: 6, ContentRange: 'bytes 0-5/9' });
        await new Promise(resolve => setImmediate(resolve));
        expect(signal.aborted).to.equal(true);
        expect(input.destroyed).to.equal(true);
    });

    it('propagates S3 body errors through the base64 pipeline', async () => {
        const store = mockStore(Buffer.alloc(0), []);
        const input = new PassThrough();
        store.client.send = async () => ({ Body: input, ContentLength: 6 });
        const data = { length: 6, metadata: { decoded: true, lineLen: 4, storage: { backend: 's3', bucket: 'test', key: 'key' } } };
        const reading = collect(store.createReadStream(id, data));
        await new Promise(resolve => setImmediate(resolve));
        input.destroy(new Error('Interrupted S3 body'));
        try {
            await reading;
            throw new Error('Expected stream failure');
        } catch (err) {
            expect(err.message).to.equal('Interrupted S3 body');
        }
    });

    it('rejects an S3 provider that ignores Range', async () => {
        const body = Buffer.from('abcdef');
        const store = mockStore(body, []);
        store.client.send = async () => ({ Body: Readable.from([body]), ContentLength: body.length });
        const data = { length: body.length, metadata: { storage: { backend: 's3', bucket: 'test', key: store.key(id) } } };
        try {
            await collect(store.createReadStream(id, data, { startFrom: 2, maxLength: 3 }));
            throw new Error('Expected stream failure');
        } catch (err) {
            expect(err.message).to.equal('S3 attachment response range or length mismatch');
        }
    });

    it('propagates a missing S3 object as a stream error', async () => {
        const store = mockStore(Buffer.alloc(0), []);
        store.client.send = async () => {
            const err = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            throw err;
        };
        const data = { length: 5, metadata: { storage: { backend: 's3', bucket: 'test', key: store.key(id) } } };
        try {
            await collect(store.createReadStream(id, data));
            throw new Error('Expected stream failure');
        } catch (err) {
            expect(err.name).to.equal('NoSuchKey');
        }
    });

    it('uses conditional multipart copy above the single-copy limit', async () => {
        const commands = [];
        const client = {
            async send(command) {
                commands.push(command);
                if (command instanceof CreateMultipartUploadCommand) {
                    return { UploadId: 'upload-1' };
                }
                if (command instanceof UploadPartCopyCommand) {
                    return { CopyPartResult: { ETag: `part-${command.input.PartNumber}` } };
                }
                return {};
            }
        };
        const store = new S3Storage({ options: { s3: { bucket: 'test', prefix: 'test-ns' } }, s3Client: client });
        await store.copyStaged('stage', 'destination', 5 * 1024 * 1024 * 1024 + 1, 'checksum');
        expect(commands[0]).to.be.instanceOf(CreateMultipartUploadCommand);
        expect(commands.filter(command => command instanceof UploadPartCopyCommand)).to.have.length(11);
        expect(commands.at(-1)).to.be.instanceOf(CompleteMultipartUploadCommand);
        expect(commands.at(-1).input.IfNoneMatch).to.equal('*');
    });

    it('does not overwrite an existing destination during a single copy', async () => {
        const store = mockStore(Buffer.alloc(0), []);
        store.client.send = async command => {
            expect(command).to.be.instanceOf(CopyObjectCommand);
            expect(command.input.IfNoneMatch).to.equal('*');
            expect(command.input.CopySource).to.equal('test/staging%20file');
            throw Object.assign(new Error('PreconditionFailed'), { $metadata: { httpStatusCode: 412 } });
        };
        await store.copyStaged('staging file', 'key', 10, 'checksum');
    });

    it('aborts a multipart copy when copying a part fails', async () => {
        const store = mockStore(Buffer.alloc(0), []);
        const commands = [];
        store.client.send = async command => {
            commands.push(command);
            if (command instanceof CreateMultipartUploadCommand) {
                return { UploadId: 'upload-1' };
            }
            if (command instanceof UploadPartCopyCommand) {
                throw new Error('Part copy failed');
            }
            return {};
        };
        try {
            await store.copyStaged('stage', 'key', 5 * 1024 * 1024 * 1024 + 1, 'checksum');
            throw new Error('Expected copy failure');
        } catch (err) {
            expect(err.message).to.equal('Part copy failed');
        }
        expect(commands.at(-1)).to.be.instanceOf(AbortMultipartUploadCommand);
        expect(commands.at(-1).input.UploadId).to.equal('upload-1');
    });
});
