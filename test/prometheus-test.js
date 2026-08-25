/* eslint no-invalid-this: 0 */

'use strict';

const http = require('http');
const https = require('https');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const prometheus = require('../prometheus');
const metrics = require('../lib/metrics');

const expect = chai.expect;

function startServer(options) {
    return new Promise((resolve, reject) => {
        prometheus.start(options, (err, server) => {
            if (err) {
                return reject(err);
            }
            resolve(server);
        });
    });
}

function closeServer(server) {
    if (!server) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
    });
}

function request(server, options) {
    options = options || {};
    let secure = options.secure === true;
    let client = secure ? https : http;
    let address = server.address();

    return new Promise((resolve, reject) => {
        let req = client.request(
            {
                host: '127.0.0.1',
                port: address.port,
                path: options.path || '/metrics',
                method: options.method || 'GET',
                rejectUnauthorized: !secure
            },
            res => {
                let chunks = [];
                let chunklen = 0;
                let encrypted = !!res.socket.encrypted;
                res.on('data', chunk => {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                });
                res.once('error', reject);
                res.once('end', () =>
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        encrypted,
                        body: Buffer.concat(chunks, chunklen).toString()
                    })
                );
            }
        );
        req.once('error', reject);
        req.end();
    });
}

describe('Standalone Prometheus server', function () {
    this.timeout(10000);

    let server;
    let apiEnabled;

    beforeEach(() => {
        apiEnabled = config.api.enabled;
        config.api.enabled = false;
    });

    afterEach(async () => {
        config.api.enabled = apiEnabled;
        await closeServer(server);
        server = false;
    });

    it('should serve metrics when the general API is disabled', async () => {
        server = await startServer({
            enabled: true,
            host: '127.0.0.1',
            port: 0,
            secure: false
        });

        const response = await request(server);

        expect(config.api.enabled).to.equal(false);
        expect(response.statusCode).to.equal(200);
        expect(response.headers['content-type']).to.equal(metrics.contentType);
        expect(response.body).to.include('# HELP wildduck_info');
    });

    it('should serve metrics over HTTPS', async () => {
        server = await startServer({
            enabled: true,
            host: '127.0.0.1',
            port: 0,
            secure: true
        });

        const response = await request(server, { secure: true });

        expect(response.statusCode).to.equal(200);
        expect(response.encrypted).to.equal(true);
        expect(response.headers['content-type']).to.equal(metrics.contentType);
        expect(response.body).to.include('# HELP wildduck_info');
    });

    it('should expose only GET /metrics over HTTP', async () => {
        server = await startServer({
            enabled: true,
            host: '127.0.0.1',
            port: 0,
            secure: false
        });

        const unknownPath = await request(server, { path: '/health' });
        const unsupportedMethod = await request(server, { method: 'POST' });

        expect(unknownPath.statusCode).to.equal(404);
        expect(unsupportedMethod.statusCode).to.equal(404);
    });

    it('should return 404 for an undefined HTTPS path', async () => {
        server = await startServer({
            enabled: true,
            host: '127.0.0.1',
            port: 0,
            secure: true
        });

        const response = await request(server, { secure: true, path: '/health' });

        expect(config.api.enabled).to.equal(false);
        expect(response.statusCode).to.equal(404);
        expect(response.encrypted).to.equal(true);
    });
});
