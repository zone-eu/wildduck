/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');
const forge = require('node-forge');

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API ACME challenge', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const servername = `acme-${crypto.randomBytes(6).toString('hex')}.example.com`;
    const token = crypto.randomBytes(16).toString('hex');
    const keyAuthorization = `${token}.${crypto.randomBytes(32).toString('base64url')}`;

    let certId;

    // self-signed throwaway certificate: the ACME challenge is stored on a
    // certs record, so one has to exist for the servername
    const generateSelfSignedPair = commonName => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
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

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));

        const { keyPem, certPem } = generateSelfSignedPair(servername);
        const response = await server
            .post('/certs')
            .send({
                servername,
                privateKey: keyPem,
                cert: certPem,
                description: 'ACME challenge test'
            })
            .expect(200);

        certId = response.body.id;

        // there is no API to store a challenge, the ACME client writes it
        // through lib/acme/acme-challenge.js
        await db.database.collection('certs').updateOne(
            { servername },
            {
                $set: {
                    '_acme.token': token,
                    '_acme.secret.value': keyAuthorization,
                    '_acme.secret.created': new Date(),
                    '_acme.secret.expires': new Date(Date.now() + 3600 * 1000)
                }
            }
        );
    });

    after(async () => {
        if (certId) {
            await server.delete(`/certs/${certId}`).expect(200);
            certId = false;
        }
    });

    it('should GET /.well-known/acme-challenge/{token} expect success', async () => {
        // the challenge is looked up by the request hostname
        const response = await server.get(`/.well-known/acme-challenge/${token}`).set('Host', servername).expect(200);

        expect(response.headers['content-type']).to.match(/^text\/plain/);
        expect(response.text).to.equal(keyAuthorization);
    });

    it('should GET /.well-known/acme-challenge/{token} expect failure / unknown token', async () => {
        const response = await server
            .get(`/.well-known/acme-challenge/${crypto.randomBytes(16).toString('hex')}`)
            .set('Host', servername)
            .expect(404);

        expect(response.body.message || response.body.error).to.equal('Unknown challenge');
    });

    it('should GET /.well-known/acme-challenge/{token} expect failure / unknown host', async () => {
        const response = await server.get(`/.well-known/acme-challenge/${token}`).set('Host', 'not-registered.example.com').expect(404);

        expect(response.body.message || response.body.error).to.equal('Unknown challenge');
    });
});
