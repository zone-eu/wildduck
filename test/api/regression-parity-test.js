/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// Regression tests for the behaviors fixed after the fastify migration
// review. The parity block pins behavior the restify implementation on
// master exhibits as well; to prove the two stacks answer identically, run
// it against a master checkout (with its own server running):
//
//   NODE_ENV=test mocha test/api/regression-parity-test.js -g parity
//
// The fastify-specific block covers behavior master cannot express (restify
// read request bodies without a size limit, so an oversized upload hangs
// instead of answering) and is excluded from the master run by the grep.
//
// To run against a master checkout, copy test/api/_helpers.js alongside this
// file (master does not have it); everything else it uses exists on both
// branches.

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');
const http = require('http');
const { ObjectId } = require('mongodb');

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const { connect, createRoleToken, deleteRoleToken, binaryParser } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API migration parity regressions', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const suffix = crypto.randomBytes(6).toString('hex');
    let user;

    before(async () => {
        await connect();

        // created without a name on purpose: the missing name is stored as
        // null and one of the tests pins how null serializes
        const response = await server
            .post('/users')
            .send({
                username: `parity-${suffix}`,
                password: 'paritysecretvalue',
                address: `parity-${suffix}@example.com`
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        user = response.body.id;
    });

    after(async () => {
        if (!user) {
            return;
        }

        await server.delete(`/users/${user}`).expect(200);
        user = false;
    });

    it('should POST /users/{user}/storage expect success / multipart file upload round-trips', async () => {
        const content = crypto.randomBytes(2048);

        const response = await server.post(`/users/${user}/storage`).attach('content', content, 'upload.bin').expect(200);
        expect(response.body.success).to.be.true;

        const fileResponse = await server.get(`/users/${user}/storage/${response.body.id}`).buffer(true).parse(binaryParser).expect(200);
        expect(Buffer.compare(fileResponse.body, content)).to.equal(0);
    });

    it('should POST /users/{user}/storage expect success / multipart form fields reach the handler', async () => {
        const content = crypto.randomBytes(512);

        const response = await server.post(`/users/${user}/storage`).field('filename', 'custom-name.bin').attach('content', content, 'upload.bin').expect(200);
        expect(response.body.success).to.be.true;

        const listResponse = await server.get(`/users/${user}/storage`).expect(200);
        const fileData = listResponse.body.results.find(entry => entry.id === response.body.id);
        expect(fileData).to.exist;
        expect(fileData.filename).to.equal('custom-name.bin');
    });

    // OPTIONS titles are not counted by the test overview generator
    // (test/_globals-test.js only maps GET/POST/PUT/DELETE); accepted
    it('should OPTIONS /authenticate expect success / preflight allows json requests', async () => {
        const response = await server
            .options('/authenticate')
            .set('Origin', 'http://spa.example.com')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type');

        expect(response.status).to.be.below(300);
        // `|| ''` keeps a missing header reported as an assertion failure
        // instead of a chai TypeError
        expect(response.headers['access-control-allow-headers'] || '').to.match(/content-type/i);
    });

    it('should POST /authenticate expect failure / suffixed json content type is parsed', async () => {
        // 403 proves the body was parsed and authentication was attempted; an
        // unparsed body would fail validation with 400 instead. The username
        // does not exist on purpose: the attempt fails before the expensive
        // password KDF and without touching a real user's failure budget
        const response = await server
            .post('/authenticate')
            .set('Content-Type', 'application/report+json')
            .send(JSON.stringify({ username: `nosuch-${suffix}`, password: 'invalid password value' }));

        expect(response.status).to.equal(403);
        expect(response.body.error).to.exist;
    });

    it('should POST /authenticate expect failure / suffixed json content type with charset is parsed', async () => {
        // same discriminator as above: 403 proves the parameterized content
        // type still reached the json parser
        const response = await server
            .post('/authenticate')
            .set('Content-Type', 'application/report+json; charset=utf-8')
            .send(JSON.stringify({ username: `nosuch-${suffix}`, password: 'invalid password value' }));

        expect(response.status).to.equal(403);
        expect(response.body.error).to.exist;
    });

    it('should PUT /users/{user} expect failure / metaData null is rejected', async () => {
        const response = await server.put(`/users/${user}`).send({ metaData: null }).expect(400);
        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should PUT /users/{user} expect failure / number outside the safe integer range is rejected', async () => {
        const response = await server.put(`/users/${user}`).send({ retention: 9007199254740992 }).expect(400);
        expect(response.body.error).to.match(/safe number/);
    });

    it('should POST /users/{user}/mailboxes/{mailbox}/messages expect failure / empty attachment content is rejected', async () => {
        // validation rejects the body before the mailbox is resolved, so a
        // well formed placeholder id suffices; a regression would answer 404
        // MailboxNotFound instead of a false pass
        const response = await server
            .post(`/users/${user}/mailboxes/${'0'.repeat(24)}/messages`)
            .send({
                from: { address: 'parity.sender@example.com' },
                to: [{ address: 'parity.recipient@example.com' }],
                subject: 'empty attachment',
                text: 'message body',
                attachments: [{ content: '' }]
            })
            .expect(400);
        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should PUT /users/{user}/autoreply expect failure / invalid date names the expected type', async () => {
        const response = await server.put(`/users/${user}/autoreply`).send({ start: 'nonsense' }).expect(400);
        expect(response.body.error).to.match(/must be a valid date/);
    });

    it('should GET /users/{user} expect success / unset name stays null on the wire', async () => {
        const response = await server.get(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.name).to.be.null;
    });

    it('should GET /certs/{cert} expect success / record created before SAN support', async () => {
        // pre-SAN certs documents carry no altNames array
        const { insertedId } = await db.database.collection('certs').insertOne({
            servername: `legacy-${suffix}.example.com`,
            acme: false,
            description: 'pre-SAN record',
            fingerprint: 'aa:bb:cc',
            created: new Date()
        });

        try {
            const response = await server.get(`/certs/${insertedId}`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.servername).to.equal(`legacy-${suffix}.example.com`);
            // the absent field must be omitted from the wire format, not
            // emitted as null or a default
            expect(response.body).to.not.have.property('altNames');

            // the certs listing serializes through a separate model that must
            // tolerate the same legacy document
            const listResponse = await server.get(`/certs?query=legacy-${suffix}.example.com`).expect(200);
            const certData = listResponse.body.results.find(entry => entry.id === insertedId.toString());
            expect(certData).to.exist;
            expect(certData).to.not.have.property('altNames');
        } finally {
            await db.database.collection('certs').deleteOne({ _id: insertedId });
        }
    });

    it('should GET /audit/{audit} expect success / record without import status', async () => {
        // audits from the first implementation carry neither an import
        // subdocument nor an expires date
        const { accessToken, tokenHash } = await createRoleToken('audit');
        const { insertedId } = await db.database.collection('audits').insertOne({
            user: new ObjectId(user),
            start: new Date(),
            end: new Date()
        });

        try {
            const response = await server.get(`/audit/${insertedId}`).set('X-Access-Token', accessToken).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(insertedId.toString());
            // the absent fields must be omitted from the wire format, not
            // emitted as null or defaults
            expect(response.body).to.not.have.property('import');
            expect(response.body).to.not.have.property('expires');
        } finally {
            await db.database.collection('audits').deleteOne({ _id: insertedId });
            await deleteRoleToken(tokenHash);
        }
    });
});

describe('API fastify-specific regressions', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    // deliberately not a route-shaped title: this pins the server-level body
    // limit (api.js bodyLimit), not anything about a specific route, so it
    // must not count as route coverage in the test overview
    it('should reject an oversized request body with 413', async () => {
        // sent raw: the declared Content-Length exceeds the body limit, the
        // server must answer 413 from the header alone without reading 2GB
        const status = await new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: config.api.port,
                    path: '/users',
                    method: 'POST',
                    // a server that starts reading the body instead of
                    // rejecting on the header would otherwise hang the test
                    // for the full mocha timeout and leak the socket
                    timeout: 2000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': 2 * 1024 * 1024 * 1024
                    }
                },
                res => {
                    resolve(res.statusCode);
                    req.destroy();
                }
            );
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('no response to oversized Content-Length'));
            });
            req.on('error', reject);
            req.write('{}');
        });

        expect(status).to.equal(413);
    });
});
