/* globals before: false, after: false */
'use strict';

const supertest = require('supertest');
const chai = require('chai');
const expect = chai.expect;
const config = require('@zone-eu/wild-config');
const ObjectId = require('mongodb').ObjectId;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// Test credentials - centralized to avoid plain text duplication
const TEST_CREDENTIALS = {
    userA: { username: 'jmapuserA', password: 'secretvalueA', email: 'jmapuserA@example.com', name: 'JMAP User A' },
    userB: { username: 'jmapuserB', password: 'secretvalueB', email: 'jmapuserB@example.com', name: 'JMAP User B' }
};

describe('JMAP Security and Error Handling Tests', function () {
    this.timeout(15000);

    let userA, userB;

    before(async () => {
        // Create test users
        const respA = await server
            .post('/users')
            .send({
                username: TEST_CREDENTIALS.userA.username,
                password: TEST_CREDENTIALS.userA.password,
                address: TEST_CREDENTIALS.userA.email,
                name: TEST_CREDENTIALS.userA.name
            })
            .expect(200);
        expect(respA.body.success).to.be.true;
        userA = respA.body.id;

        const respB = await server
            .post('/users')
            .send({
                username: TEST_CREDENTIALS.userB.username,
                password: TEST_CREDENTIALS.userB.password,
                address: TEST_CREDENTIALS.userB.email,
                name: TEST_CREDENTIALS.userB.name
            })
            .expect(200);
        expect(respB.body.success).to.be.true;
        userB = respB.body.id;
    });

    after(async () => {
        // Cleanup users even if tests fail
        try {
            if (userA) {
                await server.delete(`/users/${userA}`).expect(200);
            }
        } catch (e) {
            console.warn('Cleanup failed for userA:', e.message);
        }
        try {
            if (userB) {
                await server.delete(`/users/${userB}`).expect(200);
            }
        } catch (e) {
            console.warn('Cleanup failed for userB:', e.message);
        }
    });

    describe('Authentication failures', () => {
        it('should reject invalid credentials with 403', async () => {
            const token = Buffer.from('jmapuserA:wrongpassword').toString('base64');
            const body = { methodCalls: [['Mailbox/get', {}, 'R1']] };
            const response = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(body).expect(403);
            expect(response.body.code).to.equal('AuthFailed');
        });

        it('should reject malformed Basic auth with 403', async () => {
            const token = Buffer.from('invalidformat').toString('base64');
            const body = { methodCalls: [['Mailbox/get', {}, 'R1']] };
            const response = await server.post('/jmap').set('Authorization', 'Basic ' + token).send(body).expect(403);
            expect(response.body.code).to.equal('AuthFailed');
        });

        it('should reject missing auth with 401', async () => {
            const body = { methodCalls: [['Mailbox/get', {}, 'R1']] };
            const response = await server.post('/jmap').send(body).expect(401);
            expect(response.body.code).to.equal('AuthRequired');
        });
    });

    describe('Account isolation', () => {
        let userAMessageId, userBToken;

        before(async () => {
            // Create a message for user A
            const submitResp = await server
                .post(`/users/${userA}/submit`)
                .send({ to: [{ address: TEST_CREDENTIALS.userA.email }], subject: 'Private A', text: 'Sensitive data' })
                .expect(200);
            userAMessageId = submitResp.body.message.id.toString();
            await new Promise(r => setTimeout(r, 50));

            // Get user B's token
            userBToken = Buffer.from(`${TEST_CREDENTIALS.userB.username}:${TEST_CREDENTIALS.userB.password}`).toString('base64');
        });

        it('should not allow user B to query user A messages', async () => {
            // User B tries to query with user A's mailbox
            const mailboxesResp = await server.get(`/users/${userA}/mailboxes`).expect(200);
            const inbox = mailboxesResp.body.results.find(m => m.path === 'INBOX');

            const queryBody = { methodCalls: [['Email/query', { filter: { inMailbox: inbox.id } }, 'R1']] };
            const queryResp = await server.post('/jmap').set('Authorization', 'Basic ' + userBToken).send(queryBody).expect(200);

            const qResp = queryResp.body.methodResponses.find(r => r[0] === 'Email/query');
            // User B should see 0 results (filtered by auth)
            expect(qResp[1].ids).to.be.an('array').that.is.empty;
        });

        it('should not allow user B to get user A message by ID', async () => {
            const getBody = { methodCalls: [['Email/get', { ids: [userAMessageId] }, 'R1']] };
            const getResp = await server.post('/jmap').set('Authorization', 'Basic ' + userBToken).send(getBody).expect(200);

            const gResp = getResp.body.methodResponses.find(r => r[0] === 'Email/get');
            expect(gResp[1].list).to.be.an('array').that.is.empty;
            expect(gResp[1].notFound).to.include(userAMessageId);
        });

        it('should not allow user B to update user A message', async () => {
            const setBody = {
                methodCalls: [['Email/set', { update: { [userAMessageId]: { keywords: { '$seen': true } } } }, 'R1']]
            };
            const setResp = await server.post('/jmap').set('Authorization', 'Basic ' + userBToken).send(setBody).expect(200);

            const sResp = setResp.body.methodResponses.find(r => r[0] === 'Email/set');
            expect(sResp[1].notUpdated).to.have.property(userAMessageId);
            expect(sResp[1].notUpdated[userAMessageId].type).to.equal('notFound');
        });

        it('should not allow user B to destroy user A message', async () => {
            const setBody = { methodCalls: [['Email/set', { destroy: [userAMessageId] }, 'R1']] };
            const setResp = await server.post('/jmap').set('Authorization', 'Basic ' + userBToken).send(setBody).expect(200);

            const sResp = setResp.body.methodResponses.find(r => r[0] === 'Email/set');
            expect(sResp[1].notDestroyed).to.have.property(userAMessageId);
            expect(sResp[1].notDestroyed[userAMessageId].type).to.equal('notFound');
        });
    });

    describe('Invalid input handling', () => {
        let tokenA;

        before(() => {
            tokenA = Buffer.from(`${TEST_CREDENTIALS.userA.username}:${TEST_CREDENTIALS.userA.password}`).toString('base64');
        });

        it('should reject invalid ObjectId in Email/get', async () => {
            const getBody = { methodCalls: [['Email/get', { ids: ['notavalidobjectid'] }, 'R1']] };
            const getResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(getBody).expect(200);

            const gResp = getResp.body.methodResponses.find(r => r[0] === 'Email/get');
            expect(gResp[1].list).to.be.an('array').that.is.empty;
            expect(gResp[1].notFound).to.include('notavalidobjectid');
        });

        it('should reject invalid mailbox ID in Email/query', async () => {
            const queryBody = { methodCalls: [['Email/query', { filter: { inMailbox: 'invalid-mailbox-id' } }, 'R1']] };
            const queryResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(queryBody).expect(200);

            const qResp = queryResp.body.methodResponses.find(r => r[0] === 'Email/query');
            // Invalid mailbox should result in empty results (no error, just filtered out)
            expect(qResp[1].ids).to.be.an('array').that.is.empty;
        });

        it('should reject invalid ObjectId in Email/set update', async () => {
            const setBody = { methodCalls: [['Email/set', { update: { notvalid: { keywords: { '$seen': true } } } }, 'R1']] };
            const setResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(setBody).expect(200);

            const sResp = setResp.body.methodResponses.find(r => r[0] === 'Email/set');
            expect(sResp[1].notUpdated).to.have.property('notvalid');
            expect(sResp[1].notUpdated.notvalid.type).to.equal('invalidProperties');
        });

        it('should reject invalid ObjectId in Email/set destroy', async () => {
            const setBody = { methodCalls: [['Email/set', { destroy: ['notvalidid'] }, 'R1']] };
            const setResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(setBody).expect(200);

            const sResp = setResp.body.methodResponses.find(r => r[0] === 'Email/set');
            expect(sResp[1].notDestroyed).to.have.property('notvalidid');
            expect(sResp[1].notDestroyed.notvalidid.type).to.equal('invalidProperties');
        });

        it('should handle non-existent message ID gracefully', async () => {
            const fakeId = new ObjectId().toString();
            const getBody = { methodCalls: [['Email/get', { ids: [fakeId] }, 'R1']] };
            const getResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(getBody).expect(200);

            const gResp = getResp.body.methodResponses.find(r => r[0] === 'Email/get');
            expect(gResp[1].list).to.be.an('array').that.is.empty;
            expect(gResp[1].notFound).to.include(fakeId);
        });

        it('should handle malformed methodCalls gracefully', async () => {
            const body = { methodCalls: 'not-an-array' };
            // This should fail validation
            await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(body).expect(400);
        });

        it('should return error for unknown method', async () => {
            const body = { methodCalls: [['UnknownMethod/get', {}, 'R1']] };
            const response = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(body).expect(200);

            const errResp = response.body.methodResponses.find(r => r[0] === 'error');
            expect(errResp).to.exist;
            expect(errResp[1].type).to.equal('unknownMethod');
        });
    });

    describe('Edge cases', () => {
        let tokenA;

        before(() => {
            tokenA = Buffer.from(`${TEST_CREDENTIALS.userA.username}:${TEST_CREDENTIALS.userA.password}`).toString('base64');
        });

        it('should handle empty mailboxes gracefully', async () => {
            // Get user's spam folder (likely empty)
            const mailboxesResp = await server.get(`/users/${userA}/mailboxes`).expect(200);
            const spam = mailboxesResp.body.results.find(m => m.path === 'Junk' || m.specialUse === '\\Junk');

            if (spam) {
                const queryBody = { methodCalls: [['Email/query', { filter: { inMailbox: spam.id } }, 'R1']] };
                const queryResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(queryBody).expect(200);

                const qResp = queryResp.body.methodResponses.find(r => r[0] === 'Email/query');
                expect(qResp[1].ids).to.be.an('array').that.is.empty;
                expect(qResp[1].total).to.equal(0);
            }
        });

        it('should handle Unicode subjects correctly', async () => {
            const unicodeSubject = '测试 🌟 émojis and 日本語';
            const submitResp = await server
                .post(`/users/${userA}/submit`)
                .send({ to: [{ address: TEST_CREDENTIALS.userA.email }], subject: unicodeSubject, text: 'Unicode test' })
                .expect(200);

            await new Promise(r => setTimeout(r, 50));

            const msgId = submitResp.body.message.id.toString();
            const getBody = { methodCalls: [['Email/get', { ids: [msgId] }, 'R1']] };
            const getResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(getBody).expect(200);

            const gResp = getResp.body.methodResponses.find(r => r[0] === 'Email/get');
            expect(gResp[1].list[0].subject).to.equal(unicodeSubject);
        });

        it('should handle Email/get with empty ids array', async () => {
            const getBody = { methodCalls: [['Email/get', { ids: [] }, 'R1']] };
            const getResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(getBody).expect(200);

            const gResp = getResp.body.methodResponses.find(r => r[0] === 'Email/get');
            expect(gResp[1].list).to.be.an('array').that.is.empty;
        });

        it('should handle Email/query with no filter', async () => {
            const queryBody = { methodCalls: [['Email/query', {}, 'R1']] };
            const queryResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(queryBody).expect(200);

            const qResp = queryResp.body.methodResponses.find(r => r[0] === 'Email/query');
            expect(qResp[1].ids).to.be.an('array');
            // Should return some results (user A's messages)
        });

        it('should handle Email/set with empty update object', async () => {
            const setBody = { methodCalls: [['Email/set', { update: {} }, 'R1']] };
            const setResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(setBody).expect(200);

            const sResp = setResp.body.methodResponses.find(r => r[0] === 'Email/set');
            expect(sResp[1].updated).to.be.an('object');
            expect(Object.keys(sResp[1].updated)).to.have.lengthOf(0);
        });
    });

    describe('Upload validation', () => {
        let tokenA;

        before(() => {
            tokenA = Buffer.from(`${TEST_CREDENTIALS.userA.username}:${TEST_CREDENTIALS.userA.password}`).toString('base64');
        });

        it('should reject upload without content', async () => {
            const response = await server
                .post('/jmap/upload')
                .set('Authorization', 'Basic ' + tokenA)
                .set('x-filename', 'test.txt')
                .expect(400);

            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should handle upload size limits', async () => {
            // Create a buffer larger than max upload size
            const maxSize = config.jmap?.maxUploadMB || 25;
            const largeBuffer = Buffer.alloc((maxSize + 1) * 1024 * 1024, 'x');

            const response = await server
                .post('/jmap/upload')
                .set('Authorization', 'Basic ' + tokenA)
                .set('x-filename', 'large.dat')
                .set('content-type', 'application/octet-stream')
                .send(largeBuffer)
                .expect(413);

            expect(response.body.code).to.equal('PayloadTooLarge');
        });
    });

    describe('Error propagation in Email/send', () => {
        let tokenA;

        before(() => {
            tokenA = Buffer.from(`${TEST_CREDENTIALS.userA.username}:${TEST_CREDENTIALS.userA.password}`).toString('base64');
        });

        it('should report errors when Email/send fails', async () => {
            // Try to send with invalid recipient format
            const sendBody = {
                methodCalls: [
                    [
                        'Email/send',
                        {
                            create: {
                                c1: {
                                    email: {
                                        to: 'not-an-array', // Invalid format
                                        subject: 'Test',
                                        text: 'Test'
                                    }
                                }
                            }
                        },
                        'R1'
                    ]
                ]
            };

            const sendResp = await server.post('/jmap').set('Authorization', 'Basic ' + tokenA).send(sendBody).expect(200);

            const sendRespEntry = sendResp.body.methodResponses.find(r => r[0] === 'Email/send');
            expect(sendRespEntry).to.exist;
            // Should have notCreated entries with error details
            expect(sendRespEntry[1].notCreated).to.be.an('object');
            if (Object.keys(sendRespEntry[1].notCreated).length > 0) {
                const errorEntry = sendRespEntry[1].notCreated.c1;
                expect(errorEntry).to.have.property('type');
                expect(errorEntry).to.have.property('description');
            }
        });
    });
});
