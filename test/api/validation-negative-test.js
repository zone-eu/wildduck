/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const { ObjectId } = require('mongodb');

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const { connect, createRoleToken, generateSelfSignedPair } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const UNKNOWN_ID = '0'.repeat(24);

describe('API validation negative tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let inboxId;

    let auditUser;
    let audit;
    let auditAccessToken;
    let auditTokenHash;

    let certServername;
    let certKeyPem;
    let certPem;

    const runId = `${Date.now()}${Math.round(Math.random() * 10000)}`;

    // access tokens are validated even when access control is not required,
    // so a role token grants the audit permissions that the default root
    // role does not have (same helper as in audit-test.js)

    // self-signed throwaway certificate. The RSA key comes from the native
    // node:crypto generator (fast), node-forge only assembles and signs the
    // certificate structure

    before(async () => {
        await connect();

        // main test user
        const response = await server
            .post('/users')
            .send({
                username: `vneguser${runId}`,
                password: 'secretvalue',
                address: `vneguser${runId}@example.com`,
                name: 'validation negative user'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;
        user = response.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        const inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX');
        expect(inbox).to.exist;
        inboxId = inbox.id;

        // audit fixtures
        const tokenData = await createRoleToken('audit');
        auditAccessToken = tokenData.accessToken;
        auditTokenHash = tokenData.tokenHash;

        const auditUserResponse = await server
            .post('/users')
            .send({
                username: `vnegaudit${runId}`,
                password: 'secretvalue',
                address: `vnegaudit${runId}@example.com`,
                name: 'validation negative audit user'
            })
            .expect(200);
        expect(auditUserResponse.body.success).to.be.true;
        auditUser = auditUserResponse.body.id;

        const auditResponse = await server
            .post('/audit')
            .set('X-Access-Token', auditAccessToken)
            .send({
                user: auditUser,
                expires: new Date(Date.now() + 3600 * 1000).toISOString()
            })
            .expect(200);
        expect(auditResponse.body.success).to.be.true;
        expect(auditResponse.body.id).to.exist;
        audit = auditResponse.body.id;

        // certificate fixtures
        certServername = `vnegcert${runId}.example.com`;
        const pair = generateSelfSignedPair(certServername);
        certKeyPem = pair.keyPem;
        certPem = pair.certPem;
    });

    after(async () => {
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
            user = false;
        }

        if (audit) {
            await db.database.collection('tasks').deleteMany({
                task: 'audit',
                'data.audit': new ObjectId(audit)
            });
            await db.database.collection('audits').deleteOne({
                _id: new ObjectId(audit)
            });
            audit = false;
        }

        if (auditUser) {
            await server.delete(`/users/${auditUser}`).expect(200);
            auditUser = false;
        }

        if (auditTokenHash) {
            await db.redis.del(`tn:token:${auditTokenHash}`);
            auditTokenHash = false;
        }

        if (certServername) {
            // failsafe in case the DELETE test did not run
            await db.database.collection('certs').deleteMany({
                servername: certServername
            });
            certServername = false;
        }
    });

    describe('Search', () => {
        it('should GET /users/{user}/search expect failure / malformed mailbox id', async () => {
            const response = await server.get(`/users/${user}/search?mailbox=123`).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should POST /users/{user}/search expect failure / missing action', async () => {
            const response = await server.post(`/users/${user}/search`).send({ query: 'test' }).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"action" is required');
        });
    });

    describe('Filters', () => {
        it('should GET /filters expect failure / invalid limit', async () => {
            const response = await server.get('/filters?limit=notanumber').expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"limit" must be a number');
        });

        it('should GET /users/{user}/filters expect failure / malformed user id', async () => {
            const response = await server.get(`/users/${123}/filters`).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should POST /users/{user}/filters expect failure / invalid action', async () => {
            const response = await server
                .post(`/users/${user}/filters`)
                .send({
                    query: { subject: 'test' },
                    action: { unknownAction: true }
                })
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"unknownAction" is not allowed');
        });

        it('should PUT /users/{user}/filters/{filter} expect failure / malformed filter id', async () => {
            const response = await server
                .put(`/users/${user}/filters/${123}`)
                .send({ query: { subject: 'test' } })
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should DELETE /users/{user}/filters/{filter} expect failure / unknown filter', async () => {
            const response = await server.delete(`/users/${user}/filters/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Filter was not found');
            expect(response.body.code).to.equal('FilterNotFound');
        });

        it('should GET /users/{user}/filters/{filter} expect success', async () => {
            const createResponse = await server
                .post(`/users/${user}/filters`)
                .send({
                    name: 'validation negative filter',
                    query: { subject: 'validation-negative' },
                    action: { seen: true }
                })
                .expect(200);

            expect(createResponse.body.success).to.be.true;
            expect(createResponse.body.id).to.exist;

            const filter = createResponse.body.id;

            const response = await server.get(`/users/${user}/filters/${filter}`).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(filter);
            expect(response.body.name).to.equal('validation negative filter');
            expect(response.body.query).to.deep.equal({ subject: 'validation-negative' });
            expect(response.body.action).to.deep.equal({ seen: true });
            expect(response.body.disabled).to.be.false;
        });

        it('should GET /users/{user}/filters/{filter} expect failure / unknown filter', async () => {
            const response = await server.get(`/users/${user}/filters/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('This filter does not exist');
            expect(response.body.code).to.equal('FilterNotFound');
        });
    });

    describe('DKIM', () => {
        it('should POST /dkim expect failure / invalid privateKey', async () => {
            const response = await server
                .post('/dkim')
                .send({
                    domain: `vnegdkim${runId}.example.com`,
                    selector: 'default',
                    privateKey: 'not-a-valid-private-key'
                })
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should GET /dkim/{dkim} expect failure / unknown dkim', async () => {
            const response = await server.get(`/dkim/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown DKIM key');
            expect(response.body.code).to.equal('DkimNotFound');
        });

        it('should DELETE /dkim/{dkim} expect failure / unknown dkim', async () => {
            const response = await server.delete(`/dkim/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown DKIM key');
            expect(response.body.code).to.equal('DkimNotFound');
        });

        it('should GET /dkim/resolve/{domain} expect failure / unknown domain', async () => {
            const response = await server.get(`/dkim/resolve/vnegmissing${runId}.example.com`).expect(404);

            expect(response.body.error).to.equal('This domain does not exist');
            expect(response.body.code).to.equal('DkimNotFound');
        });
    });

    describe('Certs', () => {
        it('should POST /certs expect failure / invalid cert pem', async () => {
            const response = await server
                .post('/certs')
                .send({
                    servername: certServername,
                    privateKey: certKeyPem,
                    cert: 'not-a-valid-certificate'
                })
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should GET /certs/{cert} expect failure / unknown cert', async () => {
            const response = await server.get(`/certs/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown cert');
            expect(response.body.code).to.equal('CertNotFound');
        });

        it('should GET /certs/resolve/{servername} expect failure / unknown servername', async () => {
            const response = await server.get(`/certs/resolve/vnegmissing${runId}.example.com`).expect(404);

            expect(response.body.error).to.equal('This servername does not exist');
            expect(response.body.code).to.equal('CertNotFound');
        });

        it('should DELETE /certs/{cert} expect success', async () => {
            const createResponse = await server
                .post('/certs')
                .send({
                    servername: certServername,
                    privateKey: certKeyPem,
                    cert: certPem,
                    description: 'validation negative test certificate'
                })
                .expect(200);

            expect(createResponse.body.success).to.be.true;
            expect(createResponse.body.id).to.exist;
            expect(createResponse.body.servername).to.equal(certServername);

            const response = await server.delete(`/certs/${createResponse.body.id}`).expect(200);

            expect(response.body.success).to.be.true;
        });

        it('should DELETE /certs/{cert} expect failure / unknown cert', async () => {
            const response = await server.delete(`/certs/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown cert');
            expect(response.body.code).to.equal('CertNotFound');
        });
    });

    describe('DomainAliases', () => {
        it('should POST /domainaliases expect failure / missing alias', async () => {
            const response = await server.post('/domainaliases').send({ domain: 'example.com' }).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"alias" is required');
        });

        it('should GET /domainaliases/{alias} expect failure / unknown alias', async () => {
            const response = await server.get(`/domainaliases/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown alias');
            expect(response.body.code).to.equal('AliasNotFound');
        });

        it('should DELETE /domainaliases/{alias} expect failure / unknown alias', async () => {
            const response = await server.delete(`/domainaliases/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown email alias identifier');
            expect(response.body.code).to.equal('AliasNotFound');
        });

        it('should GET /domainaliases/resolve/{alias} expect failure / unknown alias', async () => {
            const response = await server.get(`/domainaliases/resolve/vnegmissing${runId}.example.com`).expect(404);

            expect(response.body.error).to.equal('This alias does not exist');
            expect(response.body.code).to.equal('AliasNotFound');
        });
    });

    describe('Addresses', () => {
        it('should POST /addresses/forwarded expect failure / invalid address', async () => {
            const response = await server
                .post('/addresses/forwarded')
                .send({
                    address: 'not-an-address',
                    targets: [`vnegtarget${runId}@example.com`]
                })
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should PUT /addresses/forwarded/{id} expect failure / malformed id', async () => {
            const response = await server.put(`/addresses/forwarded/${123}`).send({ name: 'updated name' }).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should DELETE /addresses/forwarded/{address} expect failure / unknown address', async () => {
            const response = await server.delete(`/addresses/forwarded/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown email address identifier');
            expect(response.body.code).to.equal('AddressNotFound');
        });

        it('should GET /addresses/forwarded/{address} expect failure / unknown address', async () => {
            const response = await server.get(`/addresses/forwarded/${UNKNOWN_ID}`).expect(404);

            expect(response.body.error).to.equal('Invalid or unknown address');
            expect(response.body.code).to.equal('AddressNotFound');
        });
    });

    describe('Authentication', () => {
        it('should POST /preauth expect failure / unknown user', async () => {
            const response = await server
                .post('/preauth')
                .send({
                    username: `vnegunknown${runId}`,
                    scope: 'master'
                })
                .expect(403);

            expect(response.body.error).to.equal('Authentication failed');
            expect(response.body.code).to.equal('AuthFailed');
        });
    });

    describe('Audit', () => {
        it('should POST /audit expect failure / malformed user', async () => {
            const response = await server
                .post('/audit')
                .set('X-Access-Token', auditAccessToken)
                .send({
                    user: '123',
                    expires: new Date(Date.now() + 3600 * 1000).toISOString()
                })
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should GET /audit/{audit} expect success', async () => {
            const response = await server.get(`/audit/${audit}`).set('X-Access-Token', auditAccessToken).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(audit);
            expect(response.body.user).to.equal(auditUser);
            expect(response.body.expires).to.exist;
            expect(response.body.deleted).to.be.false;
            expect(response.body.import).to.exist;
            expect(response.body.import.status).to.exist;
        });

        it('should GET /audit/{audit} expect failure / unknown audit', async () => {
            const response = await server.get(`/audit/${UNKNOWN_ID}`).set('X-Access-Token', auditAccessToken).expect(404);

            expect(response.body.error).to.equal('Audit not found');
            expect(response.body.code).to.equal('AuditNotFoundError');
        });

        it('should GET /audit/{audit}/export.mbox expect success', async () => {
            const response = await server.get(`/audit/${audit}/export.mbox`).set('X-Access-Token', auditAccessToken).expect(200);

            expect(response.headers['content-type']).to.equal('application/octet-stream');
            expect(response.headers['content-disposition']).to.equal('attachment; filename=export.mbox');
        });
    });

    describe('Users misc', () => {
        it('should GET /users expect failure / invalid limit', async () => {
            const response = await server.get('/users?limit=notanumber').expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"limit" must be a number');
        });

        it('should DELETE /users/{user} expect failure / malformed user id', async () => {
            const response = await server.delete(`/users/${123}`).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should POST /quota/reset expect failure / unknown body key', async () => {
            const response = await server.post('/quota/reset').send({ rogueKey: true }).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"rogueKey" is not allowed');
        });

        it('should PUT /users/{user}/mailboxes/{mailbox}/messages expect failure / missing message list', async () => {
            const response = await server.put(`/users/${user}/mailboxes/${inboxId}/messages`).send({ seen: true }).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"message" is required');
        });

        it('should POST /users/{user}/mailboxes/{mailbox}/messages expect failure / invalid raw', async () => {
            const response = await server.post(`/users/${user}/mailboxes/${inboxId}/messages`).send({ raw: 123 }).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.contain('"raw" must be a buffer or a string');
        });
    });

    describe('TwoFactorAuth', () => {
        // POST /users/{user}/2fa/totp/setup malformed user id is covered by
        // test/api/twofa-extra-test.js

        it('should POST /users/{user}/2fa/totp/enable expect failure / malformed user id', async () => {
            const response = await server.post(`/users/${123}/2fa/totp/enable`).send({ token: '123456' }).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should GET /users/{user}/2fa/webauthn/credentials expect failure / malformed user id', async () => {
            const response = await server.get(`/users/${123}/2fa/webauthn/credentials`).expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });
    });

    describe('ACME', () => {});
});
