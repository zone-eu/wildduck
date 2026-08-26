/* eslint no-invalid-this: 0 */

'use strict';

const http = require('http');
const https = require('https');
const { X509Certificate } = require('crypto');
const chai = require('chai');
const prometheus = require('../prometheus');
const certs = require('../lib/certs');
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

// start an enabled listener on a random port, secure is the only axis the tests vary
function startMetrics(secure) {
    return startServer({ enabled: true, host: '127.0.0.1', port: 0, secure: secure === true });
}

// certs.registerReload has no unregister path, so capture the registrations instead of keeping them
async function captureRegisterReload(fn) {
    let registered = [];
    let registerReload = certs.registerReload;
    certs.registerReload = (server, name, serverOptions) => registered.push({ server, name, serverOptions });

    try {
        await fn();
    } finally {
        certs.registerReload = registerReload;
    }

    return registered;
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
                let peerCertificate = encrypted ? res.socket.getPeerCertificate() : false;
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
                        peerCertificate,
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

    afterEach(async () => {
        await closeServer(server);
        server = false;
    });

    it('should not start a listener when metrics are disabled', async () => {
        expect(await startServer({ enabled: false, host: '127.0.0.1', port: 0 })).to.equal(false);
        // metrics collection is keyed off enabled === true, the listener must agree
        expect(await startServer({ enabled: 'false', host: '127.0.0.1', port: 0 })).to.equal(false);
    });

    it('should serve metrics without depending on the API server', async () => {
        // the listener is started from its own config section and never reads config.api
        server = await startMetrics();

        const response = await request(server);

        expect(response.statusCode).to.equal(200);
        expect(response.headers['content-type']).to.equal(metrics.contentType);
        expect(response.body).to.include('# HELP wildduck_info');
    });

    it('should serve metrics over HTTPS using the metrics certificate', async () => {
        server = await startMetrics(true);

        const response = await request(server, { secure: true });
        const expectedCert = new X509Certificate(certs.get('metrics').cert);

        expect(response.statusCode).to.equal(200);
        expect(response.encrypted).to.equal(true);
        expect(response.peerCertificate.raw.equals(expectedCert.raw)).to.equal(true);
        expect(response.headers['content-type']).to.equal(metrics.contentType);
        expect(response.body).to.include('# HELP wildduck_info');
    });

    it('should answer HEAD requests without a body', async () => {
        server = await startMetrics();

        const response = await request(server, { method: 'HEAD' });

        expect(response.statusCode).to.equal(200);
        expect(response.headers['content-type']).to.equal(metrics.contentType);
        expect(response.body).to.equal('');
    });

    it('should ignore a trailing slash and a query string', async () => {
        server = await startMetrics();

        const trailingSlash = await request(server, { path: '/metrics/' });
        const queryString = await request(server, { path: '/metrics?format=text' });

        expect(trailingSlash.statusCode).to.equal(200);
        expect(trailingSlash.body).to.include('# HELP wildduck_info');
        expect(queryString.statusCode).to.equal(200);
        expect(queryString.body).to.include('# HELP wildduck_info');
    });

    it('should reject unsupported methods and unknown paths', async () => {
        server = await startMetrics();

        const unknownPath = await request(server, { path: '/health' });
        const unsupportedMethod = await request(server, { method: 'POST' });

        expect(unknownPath.statusCode).to.equal(404);
        expect(unsupportedMethod.statusCode).to.equal(405);
        expect(unsupportedMethod.headers.allow).to.equal('GET, HEAD');
    });

    it('should return 404 for an undefined HTTPS path', async () => {
        server = await startMetrics(true);

        const response = await request(server, { secure: true, path: '/health' });

        expect(response.statusCode).to.equal(404);
        expect(response.encrypted).to.equal(true);
    });

    it('should register the HTTPS listener for certificate reloads', async () => {
        const registered = await captureRegisterReload(async () => {
            server = await startMetrics(true);
        });

        expect(registered.length).to.equal(1);
        expect(registered[0].name).to.equal('metrics');
        expect(registered[0].server).to.equal(server);
        // the options the server was created with must survive a certificate swap
        expect(Object.keys(registered[0].serverOptions)).to.include('cert');

        // https.Server has no updateSecureContext, certs must fall back to setSecureContext
        let updatedWith = false;
        let setSecureContext = server.setSecureContext;
        server.setSecureContext = certOptions => {
            updatedWith = certOptions;
        };
        certs.applySecureContext(server, { key: 'key', cert: 'cert' });
        server.setSecureContext = setSecureContext;

        expect(updatedWith).to.deep.equal({ key: 'key', cert: 'cert' });
    });

    it('should not register a plain HTTP listener for certificate reloads', async () => {
        const registered = await captureRegisterReload(async () => {
            server = await startMetrics();
        });

        expect(registered.length).to.equal(0);
    });
});
