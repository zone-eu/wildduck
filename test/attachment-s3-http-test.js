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
