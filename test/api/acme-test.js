/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const { connect, generateSelfSignedPair } = require('./_helpers');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API ACME challenge', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const servername = `acme-${crypto.randomBytes(6).toString('hex')}.example.com`;
    const token = crypto.randomBytes(16).toString('hex');
    const keyAuthorization = `${token}.${crypto.randomBytes(32).toString('base64url')}`;

    let certId;

    before(async () => {
        await connect();

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
