/* eslint no-invalid-this: 0 */
/* global before, after */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const http = require('http');
const { S3Client } = require('@aws-sdk/client-s3');
const S3Storage = require('../lib/attachments/s3-storage');

async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

describe('S3 attachment storage over HTTP', function () {
    this.timeout(10000);
    let server;
    let store;
    const objects = new Map();
    const requests = [];

    before(async () => {
        server = http.createServer(async (req, res) => {
            const key = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice('/test-bucket/'.length));
            const existing = objects.get(key);
            if (req.method === 'PUT') {
                const body = await collect(req);
                // S3 rejects an upload whose bytes do not match the announced checksum
                if (req.headers['x-amz-checksum-sha256'] !== crypto.createHash('sha256').update(body).digest('base64')) {
                    res.writeHead(400, { 'Content-Type': 'application/xml' });
                    res.end('<Error><Code>BadDigest</Code></Error>');
                    return;
                }
                objects.set(key, body);
                requests.push(`PUT ${key}`);
                res.writeHead(200, { ETag: '"test"' });
                res.end();
                return;
            }
            if (req.method === 'DELETE') {
                objects.delete(key);
                res.writeHead(204);
                res.end();
                return;
            }
            if (!existing) {
                res.writeHead(404, { 'Content-Type': 'application/xml' });
                res.end('<Error><Code>NoSuchKey</Code></Error>');
                return;
            }
            if (req.method === 'HEAD') {
                res.writeHead(200, { 'Content-Length': existing.length, ETag: '"test"' });
                res.end();
                return;
            }
            if (req.method === 'GET') {
                const range = req.headers.range && /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
                const start = range ? Number(range[1]) : 0;
                const end = range ? Number(range[2]) + 1 : existing.length;
                const body = existing.subarray(start, end);
                res.writeHead(range ? 206 : 200, {
                    'Content-Length': body.length,
                    ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${existing.length}` } : {})
                });
                res.end(body);
            }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${server.address().port}`;
        const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
        store = new S3Storage({ options: { s3: { bucket: 'test-bucket', prefix: 'installation-a' } }, s3Client: client });
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('uploads with one request, reads a range and deletes the object', async () => {
        const body = Buffer.from('message attachment payload');
        const id = crypto.createHash('sha256').update(body).digest();
        const location = await store.put(id, body, body.length, id);
        expect(requests).to.deep.equal([`PUT ${location.key}`]);
        expect(objects.get(location.key).equals(body)).to.equal(true);
        const data = { length: body.length, metadata: { storage: { backend: 's3', ...location } } };
        expect((await collect(store.createReadStream(id, data, { startFrom: 8, maxLength: 10 }))).toString()).to.equal('attachment');
        await store.deletePayload(location);
        expect(objects.has(location.key)).to.equal(false);
    });

    it('fails an upload whose bytes do not match the checksum', async () => {
        const body = Buffer.from('corrupted in transit');
        const id = crypto.createHash('sha256').update('something else').digest();
        let error;
        try {
            await store.put(id, body, body.length, id);
        } catch (err) {
            error = err;
        }
        expect(error && error.name).to.equal('BadDigest');
        expect([...objects.keys()].some(key => key.includes(id.toString('hex')))).to.equal(false);
    });
});

describe('S3 attachment client timeouts and credentials', function () {
    this.timeout(10000);
    let server;
    let endpoint;
    const id = crypto.createHash('sha256').update('stalled').digest();
    const large = crypto.randomBytes(1024 * 1024);

    before(async () => {
        server = http.createServer((req, res) => {
            if (req.method === 'GET') {
                if (req.url.includes('complete')) {
                    res.writeHead(200, { 'Content-Length': large.length });
                    res.end(large);
                    return;
                }
                res.writeHead(200, { 'Content-Length': 10 });
                // headers and the first bytes, then nothing more
                res.write('abc');
                return;
            }
            // read the upload and never answer
            req.resume();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        endpoint = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });

    function storeWith(s3) {
        return new S3Storage({
            options: {
                s3: { bucket: 'test-bucket', prefix: 'timeouts', endpoint, forcePathStyle: true, region: 'us-east-1', maxAttempts: 1, ...s3 }
            }
        });
    }

    it('fails an upload that gets no response', async () => {
        const store = storeWith({ accessKeyId: 'test', secretAccessKey: 'test', requestTimeout: 300 });
        const started = Date.now();
        const error = await store.put(id, Buffer.from('payload'), 7, crypto.createHash('sha256').update('payload').digest()).catch(err => err);
        expect(error.name).to.equal('TimeoutError');
        expect(Date.now() - started).to.be.below(3000);
    });

    it('fails a read whose response body stops arriving', async () => {
        const store = storeWith({ accessKeyId: 'test', secretAccessKey: 'test', readTimeout: 300 });
        const data = { length: 10, metadata: { storage: { backend: 's3', bucket: 'test-bucket', key: 'timeouts/stalled' } } };
        const started = Date.now();
        const error = await collect(store.createReadStream(id, data)).catch(err => err);
        expect(error.name).to.equal('TimeoutError');
        expect(Date.now() - started).to.be.below(3000);
    });

    it('does not fail a read whose reader is slower than the timeout', async () => {
        const store = storeWith({ accessKeyId: 'test', secretAccessKey: 'test', readTimeout: 200 });
        const data = { length: large.length, metadata: { storage: { backend: 's3', bucket: 'test-bucket', key: 'timeouts/complete' } } };
        const stream = store.createReadStream(id, data);
        // nobody reads for longer than the timeout, so the body backs up in the buffers and the socket
        await new Promise(resolve => setTimeout(resolve, 600));
        expect((await collect(stream)).equals(large)).to.equal(true);
    });

    it('releases the connection of a reader that stopped taking data', async () => {
        const store = storeWith({ accessKeyId: 'test', secretAccessKey: 'test', readTimeout: 100, slowReaderTimeout: 400 });
        const data = { length: large.length, metadata: { storage: { backend: 's3', bucket: 'test-bucket', key: 'timeouts/complete' } } };
        const stream = store.createReadStream(id, data);
        // the reader never takes anything
        const error = await new Promise(resolve => {
            stream.once('error', resolve);
            stream.pause();
        });
        expect(error.message).to.match(/Reader took no data/);
    });

    it('gives an upload time for its size on top of the request timeout', async () => {
        const options = [];
        const store = new S3Storage({
            options: { s3: { bucket: 'test', prefix: 'p', requestTimeout: 1000 } },
            s3Client: { send: async (command, opts) => options.push(opts) }
        });
        await store.put(id, Buffer.alloc(0), 64 * 1024 * 1024, id);
        expect(options[0].requestTimeout).to.equal(1000 + 128 * 1000);
    });

    it('uses configured credentials instead of the default provider chain', async () => {
        const store = storeWith({ accessKeyId: 'configured-key', secretAccessKey: 'configured-secret', sessionToken: 'configured-token' });
        const credentials = await store.client.config.credentials();
        expect(credentials).to.include({ accessKeyId: 'configured-key', secretAccessKey: 'configured-secret', sessionToken: 'configured-token' });
    });
});
