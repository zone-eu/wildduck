/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false, after: false */
'use strict';

const chai = require('chai');
const expect = chai.expect;

const crypto = require('crypto');
const {execSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MessageHandler = require('../lib/message-handler');
const SMIMEEncryptor = require('@zone-eu/smime-js');
const tools = require('../lib/tools');
const Indexer = require('../imap-core/lib/indexer/indexer');
const openpgp = require('openpgp');


function smimeKey(certList, cipher, keyTransport) {
    return {type: 'smime', certs: certList, cipher: cipher || 'AES-GCM', keyTransport: keyTransport || 'OAEP'};
}

describe('S/MIME encryption', function () {
    this.timeout(60000); // eslint-disable-line no-invalid-this

    let handler;
    let tmpDir;
    let certs = [];

    // EC key+cert pairs keyed by curve name
    let ecKeys = {};
    let ecCerts = {};

    // Additional RSA sizes
    let rsaKeys = {};
    let rsaCerts = {};

    before(function () {
        // Probe PKCS#1 v1.5 availability (normally done in server.js at startup)
        try {
            let { publicKey: probeKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
            let probeCt = crypto.publicEncrypt({ key: probeKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from('smime-probe'));
            SMIMEEncryptor.pkcs1v15Available = probeCt && probeCt.length > 0;
        } catch (err) {
            // not available
        }

        // Create a minimal MessageHandler instance (only encryption methods needed)
        handler = Object.create(MessageHandler.prototype);
        handler.loggelf = () => false;

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smime-test-'));

        // Generate 3 self-signed RSA 2048 certs for existing tests
        for (let i = 0; i < 3; i++) {
            let keyPath = path.join(tmpDir, `key${i}.pem`);
            let certPath = path.join(tmpDir, `cert${i}.pem`);
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=user${i}@naide.ee" 2>/dev/null`);
            certs.push(fs.readFileSync(certPath, 'utf8').trim());
        }

        // Generate RSA certs at different sizes
        for (let bits of [2048, 3072, 4096]) {
            let keyPath = path.join(tmpDir, `rsa${bits}.key.pem`);
            let certPath = path.join(tmpDir, `rsa${bits}.cert.pem`);
            execSync(`openssl req -x509 -newkey rsa:${bits} -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=rsa${bits}@naide.ee" 2>/dev/null`);
            rsaKeys[bits] = fs.readFileSync(keyPath, 'utf8').trim();
            rsaCerts[bits] = fs.readFileSync(certPath, 'utf8').trim();
        }

        // Generate EC certs for P-256, P-384, P-521
        let curves = {'P-256': 'prime256v1', 'P-384': 'secp384r1', 'P-521': 'secp521r1'};
        for (let [label, curve] of Object.entries(curves)) {
            let keyPath = path.join(tmpDir, `ec-${label}.key.pem`);
            let certPath = path.join(tmpDir, `ec-${label}.cert.pem`);
            execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:${curve} -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=ec-${label}@naide.ee" 2>/dev/null`);
            ecKeys[label] = {path: keyPath, pem: fs.readFileSync(keyPath, 'utf8').trim()};
            ecCerts[label] = {path: certPath, pem: fs.readFileSync(certPath, 'utf8').trim()};
        }
    });

    after(function () {
        // Clean up temp dir
        if (tmpDir) {
            fs.rmSync(tmpDir, {recursive: true, force: true});
        }
    });

    function makeMessage(overrides) {
        let headers = overrides.headers || 'From: sender@naide.ee\r\nTo: recipient@naide.ee\r\nSubject: Test\r\nContent-Type: text/plain\r\n';
        let body = overrides.body || 'Hello, this is a test message.\r\n';
        return Buffer.from(headers + '\r\n' + body);
    }

    // Errors
    it('should return false for an invalid certificate (GCM)', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey(['this is not a valid certificate']), raw);
        expect(result).to.be.false;
    });

    it('should return false for an invalid certificate (CBC)', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey(['this is not a valid certificate'], 'AES-CBC'), raw);
        expect(result).to.be.false;
    });

    it('should return false for a malformed PEM certificate', async () => {
        let raw = makeMessage({});
        let malformed = '-----BEGIN CERTIFICATE-----\nTm90IHJlYWxseSBhIGNlcnRpZmljYXRl\n-----END CERTIFICATE-----';
        let result = await handler.encryptMessageAsync(smimeKey([malformed]), raw);
        expect(result).to.be.false;
    });

    it('should return false for an empty cert array', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([]), raw);
        expect(result).to.be.false;
    });

    // AES-256-GCM (AuthEnvelopedData)
    it('GCM: should encrypt with one valid RSA certificate', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();

        expect(str).to.include('Content-Type: application/pkcs7-mime; smime-type=authEnveloped-data; name=smime.p7m');
        expect(str).to.include('Content-Transfer-Encoding: base64');
        expect(str).to.include('Content-Disposition: attachment; filename=smime.p7m');

        let outerHeaders = str.split('\r\n\r\n')[0];

        expect(outerHeaders).to.include('From: sender@naide.ee');
        expect(outerHeaders).to.include('Subject: Test');
        expect(outerHeaders).to.not.include('text/plain');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        expect(() => Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64')).to.not.throw();

        let derPath = path.join(tmpDir, 'encrypted_gcm.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('From: sender@naide.ee');
        expect(decrypted).to.include('To: recipient@naide.ee');
        expect(decrypted).to.include('Subject: Test');
        expect(decrypted).to.include('Content-Type: text/plain');
        expect(decrypted).to.include('Hello, this is a test message.');
    });

    it('GCM: should encrypt with three valid RSA certificates and each can decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0], certs[1], certs[2]]), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=authEnveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted3_gcm.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        for (let i = 0; i < 3; i++) {
            let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, `key${i}.pem`)} -recip ${path.join(tmpDir, `cert${i}.pem`)}`).toString();

            expect(decrypted).to.include('Hello, this is a test message.');
        }
    });

    it('GCM: should encrypt using only valid certs when mixed with invalid', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey(['not-a-cert', certs[0], 'also-bad']), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=authEnveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_mixed_gcm.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('Hello, this is a test message.');
    });

    it('GCM: should preserve multipart message bytes exactly', async () => {
        let raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'multipart-2.eml'));
        let rawCopy = Buffer.from(raw);

        let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);

        let str = result.raw.toString();
        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_multipart_gcm.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        let decryptedBuf = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`);

        expect(Buffer.compare(decryptedBuf, rawCopy)).to.equal(0);
    });

    // AES-256-CBC (EnvelopedData)
    it('CBC: should encrypt with one valid RSA certificate', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();

        expect(str).to.include('Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m');
        expect(str).to.include('Content-Transfer-Encoding: base64');
        expect(str).to.include('Content-Disposition: attachment; filename=smime.p7m');

        let outerHeaders = str.split('\r\n\r\n')[0];
        expect(outerHeaders).to.include('From: sender@naide.ee');
        expect(outerHeaders).to.include('Subject: Test');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_cbc.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('From: sender@naide.ee');
        expect(decrypted).to.include('To: recipient@naide.ee');
        expect(decrypted).to.include('Subject: Test');
        expect(decrypted).to.include('Hello, this is a test message.');
    });

    it('CBC: should encrypt with multiple valid RSA certificates and each can decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0], certs[1], certs[2]], 'AES-CBC'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=enveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted3_cbc.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        for (let i = 0; i < 3; i++) {
            let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, `key${i}.pem`)} -recip ${path.join(tmpDir, `cert${i}.pem`)}`).toString();

            expect(decrypted).to.include('Hello, this is a test message.');
        }
    });

    it('CBC: should encrypt using only valid certs when mixed with invalid', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey(['not-a-cert', certs[0], 'also-bad'], 'AES-CBC'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=enveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_mixed_cbc.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('Hello, this is a test message.');
    });

    it('CBC: should preserve multipart message bytes exactly', async () => {
        let raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'multipart-2.eml'));
        let rawCopy = Buffer.from(raw);

        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), raw);
        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);

        let str = result.raw.toString();
        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_multipart_cbc.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        let decryptedBuf = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`);

        expect(Buffer.compare(decryptedBuf, rawCopy)).to.equal(0);
    });

    // EC key tests - GCM (AuthEnvelopedData)
    for (let curve of ['P-256', 'P-384', 'P-521']) {
        it(`GCM: should encrypt and decrypt with EC ${curve} certificate`, async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync(smimeKey([ecCerts[curve].pem]), raw);

            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
            let str = result.raw.toString();
            expect(str).to.include('smime-type=authEnveloped-data');

            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, `encrypted_gcm_${curve}.der`);
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

            let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${ecKeys[curve].path} -recip ${ecCerts[curve].path}`).toString();

            expect(decrypted).to.include('From: sender@naide.ee');
            expect(decrypted).to.include('Subject: Test');
            expect(decrypted).to.include('Hello, this is a test message.');
        });
    }

    // EC key tests - CBC (EnvelopedData via pkijs)
    for (let curve of ['P-256', 'P-384', 'P-521']) {
        it(`CBC: should encrypt and decrypt with EC ${curve} certificate`, async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync(smimeKey([ecCerts[curve].pem], 'AES-CBC'), raw);

            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
            let str = result.raw.toString();
            expect(str).to.include('smime-type=enveloped-data');

            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, `encrypted_cbc_${curve}.der`);
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

            let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${ecKeys[curve].path} -recip ${ecCerts[curve].path}`).toString();

            expect(decrypted).to.include('From: sender@naide.ee');
            expect(decrypted).to.include('Subject: Test');
            expect(decrypted).to.include('Hello, this is a test message.');
        });
    }

    // RSA size variants - GCM
    for (let bits of [2048, 3072, 4096]) {
        it(`GCM: should encrypt and decrypt with RSA ${bits} certificate`, async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync(smimeKey([rsaCerts[bits]]), raw);

            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
            let str = result.raw.toString();
            expect(str).to.include('smime-type=authEnveloped-data');

            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, `encrypted_gcm_rsa${bits}.der`);
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

            let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, `rsa${bits}.key.pem`)} -recip ${path.join(tmpDir, `rsa${bits}.cert.pem`)}`).toString();

            expect(decrypted).to.include('Hello, this is a test message.');
        });
    }

    // RSA size variants - CBC
    for (let bits of [2048, 3072, 4096]) {
        it(`CBC: should encrypt and decrypt with RSA ${bits} certificate`, async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync(smimeKey([rsaCerts[bits]], 'AES-CBC'), raw);

            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
            let str = result.raw.toString();
            expect(str).to.include('smime-type=enveloped-data');

            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, `encrypted_cbc_rsa${bits}.der`);
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

            let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, `rsa${bits}.key.pem`)} -recip ${path.join(tmpDir, `rsa${bits}.cert.pem`)}`).toString();

            expect(decrypted).to.include('Hello, this is a test message.');
        });
    }

    // Mixed RSA + EC recipients
    it('GCM: should encrypt for mixed RSA 2048 + EC P-256 recipients and both can decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0], ecCerts['P-256'].pem]), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=authEnveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_gcm_mixed.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        // RSA recipient can decrypt
        let decrypted1 = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();
        expect(decrypted1).to.include('Hello, this is a test message.');

        // EC recipient can decrypt
        let decrypted2 = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${ecKeys['P-256'].path} -recip ${ecCerts['P-256'].path}`).toString();
        expect(decrypted2).to.include('Hello, this is a test message.');
    });

    it('CBC: should encrypt for mixed RSA 2048 + EC P-256 recipients and both can decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0], ecCerts['P-256'].pem], 'AES-CBC'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=enveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_cbc_mixed.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        // RSA recipient can decrypt
        let decrypted1 = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();
        expect(decrypted1).to.include('Hello, this is a test message.');

        // EC recipient can decrypt
        let decrypted2 = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${ecKeys['P-256'].path} -recip ${ecCerts['P-256'].path}`).toString();
        expect(decrypted2).to.include('Hello, this is a test message.');
    });

    // Re-encryption prevention
    it('should not re-encrypt an already S/MIME enveloped-data message', async () => {
        let raw = makeMessage({});
        let encrypted = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), raw);
        expect(encrypted).to.have.property('raw').that.is.an.instanceOf(Buffer);

        // Try to encrypt again with GCM
        let doubleEncrypted = await handler.encryptMessageAsync(smimeKey([certs[0]]), encrypted.raw);
        expect(doubleEncrypted).to.be.false;
    });

    it('should not re-encrypt an already S/MIME authEnveloped-data message', async () => {
        let raw = makeMessage({});
        let encrypted = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
        expect(encrypted).to.have.property('raw').that.is.an.instanceOf(Buffer);

        // Try to encrypt again with CBC
        let doubleEncrypted = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), encrypted.raw);
        expect(doubleEncrypted).to.be.false;
    });

    it('should not re-encrypt a PGP-encrypted message', async () => {
        let raw = makeMessage({
            headers: 'From: sender@naide.ee\r\nSubject: Test\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="abc"\r\n',
            body: '--abc\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--abc--\r\n'
        });

        let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
        expect(result).to.be.false;
    });

    it('should not re-encrypt an S/MIME authEnveloped-data message', async () => {
        let raw = makeMessage({
            headers: 'From: sender@naide.ee\r\nSubject: AuthEnv\r\nContent-Type: application/pkcs7-mime; smime-type=authEnveloped-data; name=smime.p7m\r\n',
            body: 'fake-encrypted-content\r\n'
        });

        let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
        expect(result).to.be.false;
    });

    it('should still encrypt an S/MIME signed-only message', async () => {
        let raw = makeMessage({
            headers: 'From: sender@naide.ee\r\nSubject: Signed\r\nContent-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m\r\n',
            body: 'signed-content\r\n'
        });

        let gcmResult = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
        expect(gcmResult).to.have.property('raw').that.is.an.instanceOf(Buffer);
        expect(gcmResult.raw.toString()).to.include('smime-type=authEnveloped-data');

        let cbcResult = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), raw);
        expect(cbcResult).to.have.property('raw').that.is.an.instanceOf(Buffer);
        expect(cbcResult.raw.toString()).to.include('smime-type=enveloped-data');
    });

    // All certs invalid
    it('GCM: should return false if all certs are invalid', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey(['garbage1', 'garbage2']), raw);
        expect(result).to.be.false;
    });

    it('CBC: should return false if all certs are invalid', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey(['garbage1', 'garbage2'], 'AES-CBC'), raw);
        expect(result).to.be.false;
    });

    // Invalid cipher/keyTransport validation
    it('should return false for unknown cipher value', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-XTS'), raw);
        expect(result).to.be.false;
    });

    it('should return false for unknown keyTransport value', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync({
            type: 'smime', certs: [certs[0]], cipher: 'AES-GCM', keyTransport: 'INVALID'
        }, raw);
        expect(result).to.be.false;
    });

    // Certificate key validation enforcement in encryption path
    it('should reject RSA 1024 cert during encryption (not just validation)', async () => {
        let keyPath = path.join(tmpDir, 'rsa1024_enc.key.pem');
        let certPath = path.join(tmpDir, 'rsa1024_enc.cert.pem');
        execSync(`openssl req -x509 -newkey rsa:1024 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=rsa1024@naide.ee" 2>/dev/null`);
        let weakCert = fs.readFileSync(certPath, 'utf8').trim();

        let raw = makeMessage({});
        let gcmResult = await handler.encryptMessageAsync(smimeKey([weakCert]), raw);
        expect(gcmResult).to.be.false;

        let cbcResult = await handler.encryptMessageAsync(smimeKey([weakCert], 'AES-CBC'), raw);
        expect(cbcResult).to.be.false;
    });

    // Default cipher uses system defaults from consts
    it('should default to system defaults when cipher/keyTransport not specified', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync({type: 'smime', certs: [certs[0]]}, raw);
        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        // Default is AES-CBC (enveloped-data) with PKCS#1 v1.5
        expect(result.raw.toString()).to.include('smime-type=enveloped-data');
    });

    // PKCS#1 v1.5 vs OAEP
    it('PKCS#1 v1.5: should encrypt with AES-CBC + PKCS#1 v1.5 key encryption and decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC', 'PKCS#1 v1.5'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=enveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_cbc_pkcs1.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        // Verify PKCS#1 v1.5 key transport (OID 1.2.840.113549.1.1.1) via asn1parse
        let asn1Output = execSync(`openssl asn1parse -inform DER -in ${derPath}`).toString();
        expect(asn1Output).to.include('rsaEncryption');
        expect(asn1Output).to.not.include('rsaesOaep');


        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('Hello, this is a test message.');
    });

    it('OAEP: should encrypt with AES-CBC + OAEP key encryption and decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC', 'OAEP'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=enveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_cbc_oaep.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        // Verify RSAES-OAEP key transport (OID 1.2.840.113549.1.1.7) via asn1parse
        let asn1Output = execSync(`openssl asn1parse -inform DER -in ${derPath}`).toString();
        expect(asn1Output).to.include('rsaesOaep');


        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('Hello, this is a test message.');
    });

    it('PKCS#1 v1.5: should encrypt with AES-GCM + PKCS#1 v1.5 key encryption and decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-GCM', 'PKCS#1 v1.5'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=authEnveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_gcm_pkcs1.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        // Verify PKCS#1 v1.5 key transport via asn1parse
        let asn1Output = execSync(`openssl asn1parse -inform DER -in ${derPath}`).toString();
        expect(asn1Output).to.include('rsaEncryption');
        expect(asn1Output).to.not.include('rsaesOaep');

        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('Hello, this is a test message.');
    });

    it('OAEP: should encrypt with AES-GCM + OAEP key encryption and decrypt', async () => {
        let raw = makeMessage({});
        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-GCM', 'OAEP'), raw);

        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=authEnveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_gcm_oaep.der');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        // Verify RSAES-OAEP key transport via asn1parse
        let asn1Output = execSync(`openssl asn1parse -inform DER -in ${derPath}`).toString();
        expect(asn1Output).to.include('rsaesOaep');


        let decrypted = execSync(`openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`).toString();

        expect(decrypted).to.include('Hello, this is a test message.');
    });

    // PGP outer header privacy
    it('PGP: should not leak CC or other non-routing headers on outer envelope', async () => {
        let raw = makeMessage({
            headers: 'From: sender@naide.ee\r\nTo: recipient@naide.ee\r\nCc: cc@naide.ee\r\nSubject: Secret subject\r\nX-Custom: custom-value\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\nMessage-ID: <test@naide.ee>\r\nContent-Type: text/plain\r\n'
        });

        // Generate a PGP key for testing
        let {publicKey} = await openpgp.generateKey({
            type: 'rsa', rsaBits: 2048, userIDs: [{email: 'test@naide.ee'}], passphrase: ''
        });

        let result = await handler.encryptMessageAsync({type: 'pgp', key: publicKey}, raw);
        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();

        let outerHeaders = str.split('\r\n\r\n')[0];

        // Routing headers should be on the outer envelope
        expect(outerHeaders).to.include('From: sender@naide.ee');
        expect(outerHeaders).to.include('To: recipient@naide.ee');
        expect(outerHeaders).to.include('Date:');
        expect(outerHeaders).to.include('Message-ID:');

        // Subject should be on the outer envelope for IMAP ENVELOPE/search
        expect(outerHeaders).to.include('Subject:');

        // Privacy-sensitive headers should NOT be on the outer envelope
        expect(outerHeaders).to.not.include('Cc:');
        expect(outerHeaders).to.not.include('X-Custom:');
    });

    // isMessageEncrypted tests
    describe('isMessageEncrypted', function () {
        it('should detect multipart/encrypted', function () {
            expect(handler.isMessageEncrypted('multipart/encrypted; protocol="application/pgp-encrypted"; boundary="abc"')).to.be.true;
        });

        it('should detect multipart/encrypted case-insensitively', function () {
            expect(handler.isMessageEncrypted('Multipart/Encrypted; protocol="application/pgp-encrypted"')).to.be.true;
        });

        it('should detect S/MIME enveloped-data', function () {
            expect(handler.isMessageEncrypted('application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m')).to.be.true;
        });

        it('should detect S/MIME authEnveloped-data', function () {
            expect(handler.isMessageEncrypted('application/pkcs7-mime; smime-type=authEnveloped-data; name=smime.p7m')).to.be.true;
        });

        it('should detect S/MIME case-insensitively', function () {
            expect(handler.isMessageEncrypted('Application/PKCS7-Mime; SMIME-TYPE=AuthEnveloped-Data')).to.be.true;
        });

        it('should not detect signed-data as encrypted', function () {
            expect(handler.isMessageEncrypted('application/pkcs7-mime; smime-type=signed-data; name=smime.p7m')).to.be.false;
        });

        it('should not detect plain text/plain', function () {
            expect(handler.isMessageEncrypted('text/plain; charset=UTF-8')).to.be.false;
        });

        it('should return false for empty string', function () {
            expect(handler.isMessageEncrypted('')).to.be.false;
        });

        it('should return false for null/undefined', function () {
            expect(handler.isMessageEncrypted(null)).to.be.false;
            expect(handler.isMessageEncrypted(undefined)).to.be.false;
        });
    });

    // _getContentType tests
    describe('_getContentType', function () {
        it('should extract content-type from mimeTree header array', function () {
            let mimeTree = {
                header: ['Message-ID: <test@naide.ee>', 'Content-Type: text/plain; charset=UTF-8', 'From: test@naide.ee']
            };
            expect(handler._getContentType(mimeTree)).to.equal('text/plain; charset=UTF-8');
        });

        it('should extract content-type case-insensitively from mimeTree', function () {
            let mimeTree = {
                header: ['CONTENT-TYPE: multipart/encrypted; protocol="application/pgp-encrypted"']
            };
            expect(handler._getContentType(mimeTree)).to.include('multipart/encrypted');
        });

        it('should extract content-type from raw Buffer', function () {
            let raw = Buffer.from('From: test@naide.ee\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nbody');
            expect(handler._getContentType(raw)).to.equal('application/pkcs7-mime; smime-type=enveloped-data');
        });

        it('should return empty string when no content-type in mimeTree', function () {
            let mimeTree = {header: ['From: test@naide.ee']};
            expect(handler._getContentType(mimeTree)).to.equal('');
        });

        it('should return empty string for null', function () {
            expect(handler._getContentType(null)).to.equal('');
        });
    });

    // encryptAndPrepareMessageAsync tests
    describe('encryptAndPrepareMessageAsync', function () {
        let handlerWithIndexer;

        before(function () {
            handlerWithIndexer = Object.create(MessageHandler.prototype);
            handlerWithIndexer.loggelf = () => false;

            let indexer = new Indexer();
            indexer.storeNodeBodies = (maildata, mimeTree, cb) => cb(null);
            handlerWithIndexer.indexer = indexer;
            handlerWithIndexer.attachmentStorage = {
                deleteManyAsync: async () => {
                }
            };
        });

        it('should encrypt a plaintext message and return prepared result', async function () {
            let raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'multipart-2.eml'));
            let mimeTree = handlerWithIndexer.indexer.parseMimeTree(raw);

            let result = await handlerWithIndexer.encryptAndPrepareMessageAsync(mimeTree, smimeKey([certs[0]]));

            expect(result).to.be.an('object');
            expect(result).to.have.property('prepared');
            expect(result).to.have.property('maildata');
            expect(result).to.have.property('type', 'smime');
            expect(result.prepared).to.have.property('mimeTree');

            // Verify the encrypted message has the right content type
            let ctLine = result.prepared.mimeTree.header.find(h => /^content-type\s*:/i.test(h));
            expect(ctLine).to.include('application/pkcs7-mime');
        });

        it('should return false for an already S/MIME encrypted message', async function () {
            let raw = makeMessage({
                headers: 'From: sender@naide.ee\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m\r\n',
                body: 'fake-encrypted\r\n'
            });
            let mimeTree = handlerWithIndexer.indexer.parseMimeTree(raw);

            let result = await handlerWithIndexer.encryptAndPrepareMessageAsync(mimeTree, smimeKey([certs[0]]));
            expect(result).to.be.false;
        });

        it('should return false for an already PGP encrypted message', async function () {
            let raw = makeMessage({
                headers: 'From: sender@naide.ee\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="abc"\r\n',
                body: '--abc\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--abc--\r\n'
            });
            let mimeTree = handlerWithIndexer.indexer.parseMimeTree(raw);

            let result = await handlerWithIndexer.encryptAndPrepareMessageAsync(mimeTree, smimeKey([certs[0]]));
            expect(result).to.be.false;
        });
    });

    // add-condition tests
    describe('Encrypt-on-add conditions', function () {
        it('should skip encryption for Draft messages (condition check)', function () {
            let flags = ['\\Seen', '\\Draft'];
            let alreadyEncrypted = false;
            let encryptMessages = true;

            // This replicates the gate condition from addAsync line 265-268
            let shouldEncrypt = !alreadyEncrypted && encryptMessages && !flags.includes('\\Draft');
            expect(shouldEncrypt).to.be.false;
        });

        it('should skip encryption for already-encrypted S/MIME messages', async function () {
            let raw = makeMessage({
                headers: 'From: sender@naide.ee\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m\r\n',
                body: 'encrypted-content\r\n'
            });
            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.be.false;
        });

        it('should skip encryption for already-encrypted PGP messages', async function () {
            let raw = makeMessage({
                headers: 'From: sender@naide.ee\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="abc"\r\n',
                body: '--abc\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--abc--\r\n'
            });
            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.be.false;
        });

        it('should allow encryption when flags do not include Draft', function () {
            let flags = ['\\Seen'];
            let alreadyEncrypted = false;
            let encryptMessages = true;

            let shouldEncrypt = !alreadyEncrypted && encryptMessages && !flags.includes('\\Draft');
            expect(shouldEncrypt).to.be.true;
        });
    });

    // Large message test
    it('GCM: should encrypt and decrypt a large (~2MB) message', async function () {
        this.timeout(120000); // eslint-disable-line no-invalid-this
        let largeBody = 'X'.repeat(2 * 1024 * 1024) + '\r\n';
        let raw = makeMessage({body: largeBody});

        let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=authEnveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_large_gcm.der');
        let decPath = path.join(tmpDir, 'decrypted_large_gcm.eml');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        execSync(`openssl cms -decrypt -inform DER -in ${derPath} -out ${decPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`);

        let decrypted = fs.readFileSync(decPath, 'utf8');
        expect(decrypted).to.include('From: sender@naide.ee');
        expect(decrypted).to.include('X'.repeat(100));
        expect(decrypted.length).to.be.greaterThan(2 * 1024 * 1024);
    });

    it('CBC: should encrypt and decrypt a large (~2MB) message', async function () {
        this.timeout(120000); // eslint-disable-line no-invalid-this
        let largeBody = 'X'.repeat(2 * 1024 * 1024) + '\r\n';
        let raw = makeMessage({body: largeBody});

        let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), raw);
        expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
        let str = result.raw.toString();
        expect(str).to.include('smime-type=enveloped-data');

        let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        let derPath = path.join(tmpDir, 'encrypted_large_cbc.der');
        let decPath = path.join(tmpDir, 'decrypted_large_cbc.eml');
        fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));

        execSync(`openssl cms -decrypt -inform DER -in ${derPath} -out ${decPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`);

        let decrypted = fs.readFileSync(decPath, 'utf8');
        expect(decrypted).to.include('From: sender@naide.ee');
        expect(decrypted).to.include('X'.repeat(100));
        expect(decrypted.length).to.be.greaterThan(2 * 1024 * 1024);
    });


    // _getContentType folded header tests
    describe('_getContentType with folded headers', function () {
        it('should handle folded Content-Type in raw Buffer', function () {
            let raw = Buffer.from(
                'From: test@naide.ee\r\n' +
                'Content-Type: application/pkcs7-mime;\r\n' +
                ' smime-type=enveloped-data;\r\n' +
                '\tname=smime.p7m\r\n' +
                '\r\nbody'
            );
            let ct = handler._getContentType(raw);
            expect(ct).to.include('application/pkcs7-mime');
            expect(ct).to.include('smime-type=enveloped-data');
            expect(ct).to.include('name=smime.p7m');
        });

        it('should handle folded multipart/encrypted Content-Type in raw Buffer', function () {
            let raw = Buffer.from(
                'Content-Type: multipart/encrypted;\r\n' +
                ' protocol="application/pgp-encrypted";\r\n' +
                ' boundary="abc"\r\n' +
                '\r\nbody'
            );
            let ct = handler._getContentType(raw);
            expect(ct).to.include('multipart/encrypted');
            expect(ct).to.include('protocol="application/pgp-encrypted"');
        });

        it('should detect encrypted message with folded Content-Type header via raw Buffer', function () {
            let raw = Buffer.from(
                'From: test@naide.ee\r\n' +
                'Content-Type: application/pkcs7-mime;\r\n' +
                ' smime-type=authEnveloped-data;\r\n' +
                ' name=smime.p7m\r\n' +
                '\r\nbody'
            );
            let ct = handler._getContentType(raw);
            expect(handler.isMessageEncrypted(ct)).to.be.true;
        });

        it('should return empty string for Buffer with no header block', function () {
            let raw = Buffer.from('just body no headers');
            expect(handler._getContentType(raw)).to.equal('');
        });
    });

    // Empty and malformed message tests
    describe('Empty and malformed messages', function () {
        it('should encrypt a message with empty body', async function () {
            let raw = makeMessage({body: ''});
            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);

            let str = result.raw.toString();
            expect(str).to.include('smime-type=authEnveloped-data');

            // Verify it decrypts
            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, 'encrypted_empty_body.der');
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));
            let decrypted = execSync(
                `openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`
            ).toString();
            expect(decrypted).to.include('From: sender@naide.ee');
        });

        it('should encrypt a headers-only message (no body)', async function () {
            let raw = Buffer.from('From: sender@naide.ee\r\nTo: recipient@naide.ee\r\nSubject: Empty\r\nContent-Type: text/plain\r\n\r\n');
            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
            expect(result.raw.toString()).to.include('smime-type=authEnveloped-data');
        });

        it('should encrypt a message with only a body line and minimal headers', async function () {
            let raw = Buffer.from('Content-Type: text/plain\r\n\r\nJust a body.\r\n');
            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);

            let str = result.raw.toString();
            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, 'encrypted_minimal.der');
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));
            let decrypted = execSync(
                `openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`
            ).toString();
            expect(decrypted).to.include('Just a body.');
        });

        it('should return false for null/undefined encryption key', async function () {
            let raw = makeMessage({});
            expect(await handler.encryptMessageAsync(null, raw)).to.be.false;
            expect(await handler.encryptMessageAsync(undefined, raw)).to.be.false;
            expect(await handler.encryptMessageAsync(false, raw)).to.be.false;
        });

        it('should return false for S/MIME with no certs configured', async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync({type: 'smime', certs: [], cipher: 'AES-GCM', keyTransport: 'OAEP'}, raw);
            expect(result).to.be.false;
        });

        it('should return false for S/MIME with null certs', async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync({type: 'smime', certs: null, cipher: 'AES-GCM', keyTransport: 'OAEP'}, raw);
            expect(result).to.be.false;
        });

        it('should return false for PGP with empty key', async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync({type: 'pgp', key: ''}, raw);
            expect(result).to.be.false;
        });

        it('should return false for PGP with null key', async function () {
            let raw = makeMessage({});
            let result = await handler.encryptMessageAsync({type: 'pgp', key: null}, raw);
            expect(result).to.be.false;
        });
    });

    // Plaintext buffer zeroing after encryption
    describe('Plaintext buffer zeroing', function () {
        it('should zero the raw plaintext buffer after successful S/MIME encryption', async function () {
            let raw = makeMessage({body: 'secret plaintext content\r\n'});
            let originalContent = Buffer.from(raw);
            expect(raw.equals(originalContent)).to.be.true;

            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.have.property('raw');

            // The original buffer should now be zeroed
            expect(raw.every(b => b === 0)).to.be.true;
        });

        it('should zero the raw plaintext buffer after successful PGP encryption', async function () {
            let {publicKey} = await openpgp.generateKey({
                type: 'rsa', rsaBits: 2048, userIDs: [{email: 'zero-test@naide.ee'}], passphrase: ''
            });

            let raw = makeMessage({body: 'secret pgp plaintext\r\n'});
            let result = await handler.encryptMessageAsync({type: 'pgp', key: publicKey}, raw);
            expect(result).to.have.property('raw');

            expect(raw.every(b => b === 0)).to.be.true;
        });

        it('should not zero the buffer when encryption returns false', async function () {
            let raw = makeMessage({
                headers: 'From: test@naide.ee\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n',
                body: 'already encrypted\r\n'
            });
            let originalContent = Buffer.from(raw);

            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.be.false;

            // Buffer should NOT be zeroed since encryption was skipped
            expect(raw.equals(originalContent)).to.be.true;
        });
    });

    // Encryption condition logic (simulating COPY/MOVE decisions)
    describe('COPY/MOVE encryption conditions', function () {
        it('should encrypt when user-level encryptMessages is true, even if mailbox flag is false', function () {
            let userData = {encryptMessages: true};
            let targetData = {encryptMessages: false};
            let shouldEncrypt = !!(userData.encryptMessages || targetData.encryptMessages);
            expect(shouldEncrypt).to.be.true;
        });

        it('should encrypt when mailbox-level encryptMessages is true, even if user flag is false', function () {
            let userData = {encryptMessages: false};
            let targetData = {encryptMessages: true};
            let shouldEncrypt = !!(userData.encryptMessages || targetData.encryptMessages);
            expect(shouldEncrypt).to.be.true;
        });

        it('should encrypt when both user and mailbox flags are true', function () {
            let userData = {encryptMessages: true};
            let targetData = {encryptMessages: true};
            let shouldEncrypt = !!(userData.encryptMessages || targetData.encryptMessages);
            expect(shouldEncrypt).to.be.true;
        });

        it('should not encrypt when neither user nor mailbox flag is set', function () {
            let userData = {encryptMessages: false};
            let targetData = {encryptMessages: false};
            let shouldEncrypt = !!(userData.encryptMessages || targetData.encryptMessages);
            expect(shouldEncrypt).to.be.false;
        });

        it('should not encrypt when flags are undefined/missing', function () {
            let userData = {};
            let targetData = {};
            let shouldEncrypt = !!(userData.encryptMessages || targetData.encryptMessages);
            expect(shouldEncrypt).to.be.false;
        });

        it('should skip already-encrypted messages during COPY/MOVE', function () {
            let isAlreadyEncrypted = handler.isMessageEncrypted('application/pkcs7-mime; smime-type=enveloped-data');
            expect(isAlreadyEncrypted).to.be.true;

            // Even with encryption enabled, already-encrypted messages should be skipped
            let shouldEncrypt = !isAlreadyEncrypted;
            expect(shouldEncrypt).to.be.false;
        });
    });

    // encryptForwarded condition tests
    describe('encryptForwarded condition', function () {
        it('should encrypt forwarded messages when encryptForwarded is true and key is available', function () {
            let userData = {encryptForwarded: true, smimeCerts: [certs[0]]};
            let encryptionKey = tools.getUserEncryptionKey(userData);
            let shouldEncrypt = !!(userData.encryptForwarded && encryptionKey);
            expect(shouldEncrypt).to.be.true;
            expect(encryptionKey).to.have.property('type', 'smime');
        });

        it('should not encrypt forwarded messages when encryptForwarded is false', function () {
            let userData = {encryptForwarded: false, smimeCerts: [certs[0]]};
            let encryptionKey = tools.getUserEncryptionKey(userData);
            let shouldEncrypt = !!(userData.encryptForwarded && encryptionKey);
            expect(shouldEncrypt).to.be.false;
        });

        it('should not encrypt forwarded messages when no encryption key is configured', function () {
            let userData = {encryptForwarded: true, smimeCerts: [], pubKey: ''};
            let encryptionKey = tools.getUserEncryptionKey(userData);
            let shouldEncrypt = !!(userData.encryptForwarded && encryptionKey);
            expect(shouldEncrypt).to.be.false;
        });

        it('should encrypt forwarded message content via encryptMessageAsync when encryptForwarded is set', async function () {
            let userData = {encryptForwarded: true, smimeCerts: [certs[0]], smimeCipher: 'AES-GCM', smimeKeyTransport: 'OAEP'};
            let encryptionKey = tools.getUserEncryptionKey(userData);

            let raw = makeMessage({body: 'Forwarded message body\r\n'});
            let result = await handler.encryptMessageAsync(encryptionKey, raw);
            expect(result).to.have.property('type', 'smime');
            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
            expect(result.raw.toString()).to.include('smime-type=authEnveloped-data');
        });

        it('should prefer S/MIME over PGP for forwarded encryption when both are configured', function () {
            let userData = {encryptForwarded: true, smimeCerts: [certs[0]], pubKey: 'some-pgp-key'};
            let encryptionKey = tools.getUserEncryptionKey(userData);
            expect(encryptionKey).to.have.property('type', 'smime');
        });

        it('should fall back to PGP for forwarded encryption when only PGP key is configured', function () {
            let userData = {encryptForwarded: true, smimeCerts: [], pubKey: 'some-pgp-key'};
            let encryptionKey = tools.getUserEncryptionKey(userData);
            expect(encryptionKey).to.have.property('type', 'pgp');
        });
    });

    // Chunk-based input tests
    describe('Chunk-based input (filter-handler style)', function () {
        it('should encrypt from {chunks, chunklen} input', async function () {
            let msg = makeMessage({body: 'Chunked message body\r\n'});
            // Split into multiple chunks to simulate streaming input
            let chunk1 = msg.subarray(0, 30);
            let chunk2 = msg.subarray(30);
            let raw = {chunks: [Buffer.from(chunk1), Buffer.from(chunk2)], chunklen: msg.length};

            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.have.property('type', 'smime');
            expect(result).to.have.property('raw').that.is.an.instanceOf(Buffer);
            expect(result.raw.toString()).to.include('smime-type=authEnveloped-data');

            // Verify it decrypts correctly
            let str = result.raw.toString();
            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, 'encrypted_chunked.der');
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));
            let decrypted = execSync(
                `openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`
            ).toString();
            expect(decrypted).to.include('Chunked message body');
        });

        it('should encrypt from single-chunk input', async function () {
            let msg = makeMessage({body: 'Single chunk\r\n'});
            let raw = {chunks: [Buffer.from(msg)], chunklen: msg.length};

            let result = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), raw);
            expect(result).to.have.property('type', 'smime');
            expect(result.raw.toString()).to.include('smime-type=enveloped-data');
        });

        it('should encrypt from many small chunks', async function () {
            let msg = makeMessage({body: 'Many small chunks test body\r\n'});
            // Split into byte-sized chunks
            let chunks = [];
            for (let i = 0; i < msg.length; i++) {
                chunks.push(msg.subarray(i, i + 1));
            }
            let raw = {chunks, chunklen: msg.length};

            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.have.property('type', 'smime');

            let str = result.raw.toString();
            let bodyPart = str.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
            let derPath = path.join(tmpDir, 'encrypted_manychunks.der');
            fs.writeFileSync(derPath, Buffer.from(bodyPart.replace(/\r?\n/g, ''), 'base64'));
            let decrypted = execSync(
                `openssl cms -decrypt -inform DER -in ${derPath} -inkey ${path.join(tmpDir, 'key0.pem')} -recip ${path.join(tmpDir, 'cert0.pem')}`
            ).toString();
            expect(decrypted).to.include('Many small chunks test body');
        });

        it('should skip already-encrypted message from chunk input', async function () {
            let msg = Buffer.from(
                'Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nencrypted\r\n'
            );
            let raw = {chunks: [msg], chunklen: msg.length};

            let result = await handler.encryptMessageAsync(smimeKey([certs[0]]), raw);
            expect(result).to.be.false;
        });

        it('should produce identical output for Buffer and equivalent chunk input', async function () {
            let msg = makeMessage({body: 'Identical output test\r\n'});

            // Encrypt as Buffer
            let bufCopy = Buffer.from(msg);
            let resultBuf = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), bufCopy);

            // Encrypt as chunks
            let chunk1 = Buffer.from(msg.subarray(0, 40));
            let chunk2 = Buffer.from(msg.subarray(40));
            let resultChunk = await handler.encryptMessageAsync(smimeKey([certs[0]], 'AES-CBC'), {chunks: [chunk1, chunk2], chunklen: msg.length});

            // Both should produce valid S/MIME output (content differs due to random CEK/IV, but structure matches)
            expect(resultBuf).to.have.property('type', 'smime');
            expect(resultChunk).to.have.property('type', 'smime');
            expect(resultBuf.raw.toString()).to.include('smime-type=enveloped-data');
            expect(resultChunk.raw.toString()).to.include('smime-type=enveloped-data');

            // Both should have the same outer headers
            let headersBuf = resultBuf.raw.toString().split('\r\n\r\n')[0];
            let headersChunk = resultChunk.raw.toString().split('\r\n\r\n')[0];
            expect(headersBuf).to.equal(headersChunk);
        });
    });
});
