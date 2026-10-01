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

    before(async () => {
        server = http.createServer(async (req, res) => {
            const key = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice('/test-bucket/'.length));
            const existing = objects.get(key);
            if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
                const source = decodeURIComponent(req.headers['x-amz-copy-source']).replace(/^\/?test-bucket\//, '');
                const sourceObject = objects.get(source);
                if (!sourceObject) {
                    res.writeHead(404);
                    res.end('<Error><Code>NoSuchKey</Code></Error>');
                    return;
                }
                if (existing && req.headers['if-none-match'] === '*') {
                    res.writeHead(412);
                    res.end('<Error><Code>PreconditionFailed</Code></Error>');
                    return;
                }
                objects.set(key, sourceObject);
                res.writeHead(200, { 'Content-Type': 'application/xml' });
                res.end('<CopyObjectResult><ETag>"test"</ETag><LastModified>2025-01-01T00:00:00Z</LastModified></CopyObjectResult>');
                return;
            }
            if (req.method === 'PUT') {
                const body = await collect(req);
                objects.set(key, { body, sha256: req.headers['x-amz-meta-sha256'] });
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
                res.writeHead(200, { 'Content-Length': existing.body.length, 'x-amz-meta-sha256': existing.sha256, ETag: '"test"' });
                res.end();
                return;
            }
            if (req.method === 'GET') {
                const range = req.headers.range && /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
                const start = range ? Number(range[1]) : 0;
                const end = range ? Number(range[2]) + 1 : existing.body.length;
                const body = existing.body.subarray(start, end);
                res.writeHead(range ? 206 : 200, {
                    'Content-Length': body.length,
                    ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${existing.body.length}` } : {})
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

    it('publishes, verifies, reads a range, reuses, and deletes an object', async () => {
        const body = Buffer.from('message attachment payload');
        const id = crypto.createHash('sha256').update(body).digest();
        const checksum = id.toString('hex');
        const location = await store.publish(id, body, checksum);
        await store.verifyContent(location, body.length, checksum);
        expect(objects.size).to.equal(1);
        expect(await store.publish(id, body, checksum)).to.deep.equal(location);
        expect(objects.size).to.equal(1);
        const data = { length: body.length, metadata: { storage: { backend: 's3', ...location } } };
        expect((await collect(store.createReadStream(id, data, { startFrom: 8, maxLength: 10 }))).toString()).to.equal('attachment');
        await store.deletePayload(location);
        expect(objects.size).to.equal(0);
    });
});
