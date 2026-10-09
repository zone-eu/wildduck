'use strict';

// Shared fixtures for the API test suite. Not a test file itself, the mocha
// glob only picks up *-test.js.

const crypto = require('crypto');
const http = require('http');
const { buffer } = require('stream/consumers');
const forge = require('node-forge');
const { ObjectId } = require('mongodb');

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const { ExportStream } = require('../../lib/export');

// db.connect has no idempotency guard and opens (and leaks) a fresh
// MongoDB+Redis connection set on every call, so connect at most once
const connect = () => {
    if (db.database && db.redis) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
};

/**
 * Mints an access token for a role the root token does not cover (export,
 * audit) straight into redis, the way UserHandler.setAuthToken would.
 * Pass a user id to get a user scoped token (what the "me" alias resolves to),
 * otherwise the token belongs to "root".
 * Returns { accessToken, tokenHash }; delete the key with deleteRoleToken.
 */
const createRoleToken = async (role, user) => {
    await connect();

    const accessToken = crypto.randomBytes(20).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    const tokenData = {
        user: user || 'root',
        role,
        ttl: 3600,
        created: Date.now().toString()
    };

    // a user scoped token carries the account's auth version and the signature
    // covers it, in this key order (UserHandler.setAuthToken); a token for
    // "root" is not a user id and never reaches that check
    const signPayload = {
        token: accessToken,
        user: tokenData.user
    };

    if (user) {
        const userData = await db.database.collection('users').findOne({ _id: new ObjectId(user) }, { projection: { authVersion: true } });
        tokenData.authVersion = Number(userData && userData.authVersion) || 0;
        signPayload.authVersion = tokenData.authVersion;
    }

    signPayload.role = tokenData.role;

    tokenData.s = crypto.createHmac('sha256', config.api.accessControl.secret).update(JSON.stringify(signPayload)).digest('hex');

    await db.redis.multi().hmset(`tn:token:${tokenHash}`, tokenData).expire(`tn:token:${tokenHash}`, Number(tokenData.ttl)).exec();

    return { accessToken, tokenHash };
};

const deleteRoleToken = async tokenHash => {
    if (tokenHash) {
        await db.redis.del(`tn:token:${tokenHash}`);
    }
};

/**
 * Throwaway self-signed certificate for the certs and ACME endpoints. The RSA
 * key comes from node:crypto, node-forge only assembles and signs the
 * certificate structure.
 */
const generateSelfSignedPair = commonName => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    // PKCS#1 PEM ("BEGIN RSA PRIVATE KEY") to match the API key pattern
    const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(publicPem);
    cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 7 * 24 * 3600 * 1000);

    const attrs = [{ name: 'commonName', value: commonName }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());

    return { keyPem, certPem: forge.pki.certificateToPem(cert) };
};

// supertest response parser for binary payloads (downloads, export dumps)
const binaryParser = (res, callback) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
};

/**
 * Opens the SSE updates stream at the given API path and resolves with
 * { statusCode, headers, data } once the collected output satisfies `until`
 * (by default the first idle comment) or the response ends. Rejects on timeout.
 * `afterOpen` runs once the stream is established (first idle comment).
 */
const readUpdatesStream = (path, { headers = {}, until = data => data.includes(': idling'), timeout = 5000, afterOpen } = {}) =>
    new Promise((resolve, reject) => {
        let settled = false;
        let data = '';
        let opened = false;
        let timer;
        let req;

        const finish = (err, res) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            req.destroy();
            if (err) {
                return reject(err);
            }
            resolve({ statusCode: res.statusCode, headers: res.headers, data });
        };

        timer = setTimeout(() => finish(new Error(`Timeout waiting for stream output, received:\n${data}`)), timeout);

        req = http.get({ host: '127.0.0.1', port: config.api.port, path, headers }, res => {
            res.setEncoding('utf8');
            res.on('data', chunk => {
                data += chunk;
                if (!opened && afterOpen && data.includes(': idling')) {
                    opened = true;
                    afterOpen().catch(err => finish(err));
                }
                if (until(data)) {
                    finish(null, res);
                }
            });
            res.on('end', () => finish(null, res));
            res.on('error', () => false); // socket teardown after destroy()
        });

        req.on('error', err => finish(err));
    });

// builds an export dump (the POST /data/import input) with the given header metadata
const buildDump = async (meta, records) => {
    const exporter = new ExportStream(meta);
    for (const record of records) {
        exporter.write(record);
    }
    exporter.end();
    return await buffer(exporter);
};

/**
 * Every entry of a paged listing, following nextCursor. Listings are shared by
 * all suites, so a test looks for its own entries instead of counting.
 */
const listAll = async (server, url) => {
    const results = [];
    let next = false;
    do {
        const separator = url.includes('?') ? '&' : '?';
        const response = await server.get(`${url}${separator}limit=250${next ? `&next=${encodeURIComponent(next)}` : ''}`).expect(200);
        if (response.body.success !== true) {
            throw new Error(`GET ${url} failed: ${JSON.stringify(response.body).slice(0, 200)}`);
        }
        results.push(...response.body.results);
        next = response.body.nextCursor;
    } while (next);
    return results;
};

// unique per run so a suite can be re-run without a database reset
const uniqueName = prefix => `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

module.exports = {
    connect,
    createRoleToken,
    deleteRoleToken,
    generateSelfSignedPair,
    binaryParser,
    readUpdatesStream,
    buildDump,
    listAll,
    uniqueName
};
