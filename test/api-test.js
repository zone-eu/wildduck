/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);
const ObjectId = require('mongodb').ObjectId;

describe('API tests', function () {
    let userId, asp, address, inbox;

    this.timeout(10000); // eslint-disable-line no-invalid-this

    before(async () => {
        // ensure that we have an existing user account
        const response = await server
            .post('/users')
            .send({
                username: 'testuser',
                password: 'secretpass',
                address: 'testuser@example.com',
                name: 'test user'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        userId = response.body.id;
    });

    after(async () => {
        if (!userId) {
            return;
        }

        const response = await server.delete(`/users/${userId}`).expect(200);
        expect(response.body.success).to.be.true;

        userId = false;
    });

    describe('user', () => {
        it('should POST /domainaliases expect success', async () => {
            const response = await server
                .post('/domainaliases')
                .send({
                    alias: 'jõgeva.öö',
                    domain: 'example.com'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should GET /users/:user expect success', async () => {
            const response = await server.get(`/users/${userId}`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(userId);
            expect(response.body.name).to.equal('test user');
        });

        it('should PUT /users/:user expect success', async () => {
            const response = await server
                .put(`/users/${userId}`)
                .send({
                    name: 'user test'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should GET /users/:user expect success / (updated name)', async () => {
            const response = await server.get(`/users/${userId}`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(userId);
            expect(response.body.name).to.equal('user test');
        });
    });

    describe('authenticate', () => {
        it('should POST /authenticate expect success', async () => {
            const response = await server
                .post(`/authenticate`)
                .send({
                    username: 'testuser@example.com',
                    password: 'secretpass',
                    scope: 'master'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should POST /authenticate expect failure', async () => {
            const response = await server
                .post(`/authenticate`)
                .send({
                    username: 'testuser@example.com',
                    password: 'invalid',
                    scope: 'master'
                })
                .expect(403);
            expect(response.body.error).to.exist;
            expect(response.body.success).to.not.be.true;
        });

        it('should POST /authenticate expect success / using alias domain', async () => {
            const response = await server
                .post(`/authenticate`)
                .send({
                    username: 'testuser@jõgeva.öö',
                    password: 'secretpass',
                    scope: 'master'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should POST /authenticate expect failure / using alias domain', async () => {
            const response = await server
                .post(`/authenticate`)
                .send({
                    username: 'testuser@jõgeva.öö',
                    password: 'invalid',
                    scope: 'master'
                })
                .expect(403);
            expect(response.body.error).to.exist;
            expect(response.body.success).to.not.be.true;
        });
    });

    describe('preauth', () => {
        it('should POST /preauth expect success', async () => {
            const response = await server
                .post(`/preauth`)
                .send({
                    username: 'testuser@example.com',
                    scope: 'master'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should POST /preauth expect success / using alias domain', async () => {
            const response = await server
                .post(`/preauth`)
                .send({
                    username: 'testuser@jõgeva.öö',
                    scope: 'master'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });
    });

    describe('asp', () => {
        it('should POST /users/:user/asps expect success / to generate ASP', async () => {
            const response = await server
                .post(`/users/${userId}/asps`)
                .send({
                    description: 'test',
                    scopes: ['imap', 'smtp'],
                    generateMobileconfig: true
                })
                .expect(200);
            expect(response.body.error).to.not.exist;
            expect(response.body.success).to.be.true;
            expect(response.body.password).to.exist;
            expect(response.body.mobileconfig).to.exist;

            asp = response.body.password;
        });

        it('should POST /users/:user/asps expect success / to generate ASP with custom password', async () => {
            const response = await server
                .post(`/users/${userId}/asps`)
                .send({
                    description: 'test',
                    scopes: ['imap', 'smtp'],
                    generateMobileconfig: true,
                    password: 'a'.repeat(16)
                })
                .expect(200);
            expect(response.body.error).to.not.exist;
            expect(response.body.success).to.be.true;
            expect(response.body.password).to.equal('a'.repeat(16));
            expect(response.body.mobileconfig).to.exist;
        });

        it('should POST /users/:user/asps expect failure / to generate ASP with custom password', async () => {
            const response = await server
                .post(`/users/${userId}/asps`)
                .send({
                    description: 'test',
                    scopes: ['imap', 'smtp'],
                    generateMobileconfig: true,
                    password: '0'.repeat(16)
                })
                .expect(400);
            expect(response.body.error).to.exist;
        });

        it('should POST /authenticate expect success / using ASP and allowed scope', async () => {
            const response = await server
                .post(`/authenticate`)
                .send({
                    username: 'testuser@jõgeva.öö',
                    password: asp,
                    scope: 'imap'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should POST /authenticate expect success / using ASP and allowed scope with custom password', async () => {
            const response = await server
                .post(`/authenticate`)
                .send({
                    username: 'testuser@jõgeva.öö',
                    password: 'a'.repeat(16),
                    scope: 'imap'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should POST /authenticate expect failure / using ASP and master scope', async () => {
            const response = await server
                .post(`/authenticate`)
                .send({
                    username: 'testuser@jõgeva.öö',
                    password: asp,
                    scope: 'master'
                })
                .expect(403);
            expect(response.body.error).to.exist;
            expect(response.body.success).to.not.be.true;
        });
    });

    describe('addresses', () => {
        it('should GET /users/:user/addresses expect success', async () => {
            const response = await server.get(`/users/${userId}/addresses`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.results.length).to.equal(1);
            expect(response.body.results[0].address).to.equal('testuser@example.com');
            expect(response.body.results[0].main).to.be.true;
        });

        it('should POST /users/:user/addresses expect success', async () => {
            const response1 = await server
                .post(`/users/${userId}/addresses`)
                .send({
                    address: 'alias1@example.com',
                    main: true,
                    metaData: {
                        tere: 123
                    }
                })
                .expect(200);
            expect(response1.body.success).to.be.true;

            const response2 = await server
                .post(`/users/${userId}/addresses`)
                .send({
                    address: 'alias2@example.com'
                })
                .expect(200);
            expect(response2.body.success).to.be.true;
        });

        it('should GET /users/:user expect success / (after email update)', async () => {
            const response = await server.get(`/users/${userId}`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(userId);
            expect(response.body.address).to.equal('alias1@example.com');
        });

        it('should GET /users/:user/addresses expect success / (updated listing)', async () => {
            const response = await server.get(`/users/${userId}/addresses`).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.results.length).to.equal(3);

            response.body.results.sort((a, b) => a.id.localeCompare(b.id));

            expect(response.body.results[0].address).to.equal('testuser@example.com');
            expect(response.body.results[0].main).to.be.false;

            expect(response.body.results[1].address).to.equal('alias1@example.com');
            expect(response.body.results[1].main).to.be.true;
            expect(response.body.results[1].metaData).to.not.exist;

            // no metaData present
            expect(response.body.results[2].address).to.equal('alias2@example.com');
            expect(response.body.results[2].main).to.be.false;

            address = response.body.results[2];
        });

        it('should DELETE /users/:user/addresses/:address expect success', async () => {
            const response = await server.delete(`/users/${userId}/addresses/${address.id}`).expect(200);
            expect(response.body.success).to.be.true;
        });

        it('should GET /users/:user/addresses expect success / (with metaData)', async () => {
            const response = await server.get(`/users/${userId}/addresses?metaData=true`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.results.length).to.equal(2);
            response.body.results.sort((a, b) => a.id.localeCompare(b.id));

            expect(response.body.results[1].address).to.equal('alias1@example.com');
            expect(response.body.results[1].main).to.be.true;
            expect(response.body.results[1].metaData.tere).to.equal(123);

            address = response.body.results[1];
        });

        it('should GET /users/:user/addresses/:address expect success', async () => {
            const response = await server.get(`/users/${userId}/addresses/${address.id}`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.metaData.tere).to.equal(123);
        });

        it('should GET /users/:user/addresses expect success / (after DELETE)', async () => {
            const response = await server.get(`/users/${userId}/addresses`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.results.length).to.equal(2);
            response.body.results.sort((a, b) => a.id.localeCompare(b.id));

            expect(response.body.results[0].address).to.equal('testuser@example.com');
            expect(response.body.results[0].main).to.be.false;

            expect(response.body.results[1].address).to.equal('alias1@example.com');
            expect(response.body.results[1].main).to.be.true;
        });

        describe('forwarded', () => {
            let address = false;

            it('should POST /addresses/forwarded expect success', async () => {
                const response = await server
                    .post(`/addresses/forwarded`)
                    .send({
                        address: 'my.new.address@example.com',
                        targets: ['my.old.address@example.com', 'smtp://mx2.zone.eu:25'],
                        forwards: 500,
                        metaData: {
                            tere: 123
                        },
                        tags: ['tere', 'vana']
                    })
                    .expect(200);
                expect(response.body.success).to.be.true;
                address = response.body.id;
            });

            it('should GET /addresses/forwarded/:address expect success', async () => {
                const response = await server.get(`/addresses/forwarded/${address}`).expect(200);
                expect(response.body.success).to.be.true;
                expect(response.body.metaData.tere).to.equal(123);
                expect(response.body.tags).to.deep.equal(['tere', 'vana']);
            });

            it('should PUT /addresses/forwarded/:id expect success', async () => {
                const response = await server
                    .put(`/addresses/forwarded/${address}`)
                    .send({
                        metaData: {
                            tere: 124
                        }
                    })
                    .expect(200);

                expect(response.body.success).to.be.true;

                // check updated data
                const updatedResponse = await server.get(`/addresses/forwarded/${address}`).expect(200);
                expect(updatedResponse.body.success).to.be.true;
                expect(updatedResponse.body.metaData.tere).to.equal(124);
            });

            it('should DELETE /addresses/forwarded/:address expect success', async () => {
                const response = await server.delete(`/addresses/forwarded/${address}`).expect(200);
                expect(response.body.success).to.be.true;
            });
        });
    });

    describe('mailboxes', () => {
        it('should GET /users/:user/mailboxes expect success', async () => {
            const response = await server.get(`/users/${userId}/mailboxes`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.results.length).to.gte(4);

            inbox = response.body.results.find(result => result.path === 'INBOX');
            expect(inbox).to.exist;
        });
    });

    describe('autoreply', () => {
        it('should PUT /users/:user/autoreply expect success', async () => {
            let r;

            r = await server.get(`/users/${userId}/autoreply`).expect(200);
            expect(r.body).to.deep.equal({
                success: true,
                status: false,
                name: '',
                subject: '',
                text: '',
                html: ''
            });

            r = await server
                .put(`/users/${userId}/autoreply`)
                .send({
                    status: true,
                    name: 'AR name',
                    subject: 'AR subject',
                    text: 'Away from office until Dec.19',
                    start: '2017-11-15T00:00:00.000Z',
                    end: '2017-12-19T00:00:00.000Z'
                })
                .expect(200);
            expect(r.body.success).to.be.true;

            const autoreplyId = new ObjectId(r.body._id);

            r = await server.get(`/users/${userId}/autoreply`).expect(200);
            expect(r.body).to.deep.equal({
                success: true,
                status: true,
                name: 'AR name',
                subject: 'AR subject',
                text: 'Away from office until Dec.19',
                html: '',
                start: '2017-11-15T00:00:00.000Z',
                end: '2017-12-19T00:00:00.000Z',
                created: autoreplyId.getTimestamp().toISOString()
            });

            r = await server
                .put(`/users/${userId}/autoreply`)
                .send({
                    name: 'AR name v2',
                    subject: '',
                    start: false
                })
                .expect(200);
            expect(r.body.success).to.be.true;

            r = await server.get(`/users/${userId}/autoreply`).expect(200);
            expect(r.body).to.deep.equal({
                success: true,
                status: true,
                name: 'AR name v2',
                subject: '',
                text: 'Away from office until Dec.19',
                html: '',
                end: '2017-12-19T00:00:00.000Z',
                created: r.body.created // created might have been changed to new date
            });

            await server.delete(`/users/${userId}/autoreply`).expect(200);
            r = await server.get(`/users/${userId}/autoreply`).expect(200);
            expect(r.body).to.deep.equal({
                success: true,
                status: false,
                name: '',
                subject: '',
                text: '',
                html: ''
            });
        });
    });

    describe('domainaccess', () => {
        let tag = 'account:123';
        let domain;

        it('should POST /domainaccess/:tag/:action expect success / action: block', async () => {
            const response1 = await server
                .post(`/domainaccess/${tag}/block`)
                .send({
                    domain: 'example.com'
                })
                .expect(200);
            expect(response1.body.success).to.be.true;

            const response2 = await server
                .post(`/domainaccess/${tag}/block`)
                .send({
                    domain: 'jõgeva.ee'
                })
                .expect(200);
            expect(response2.body.success).to.be.true;
        });

        it('should GET /domainaccess/:tag/:action expect success / action: block', async () => {
            const response = await server.get(`/domainaccess/${tag}/block`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.results.length).to.equal(2);

            expect(response.body.results[0].domain).to.equal('example.com');
            expect(response.body.results[1].domain).to.equal('jõgeva.ee');

            domain = response.body.results[1];
        });

        it('should DELETE /domainaccess/:domain expect success', async () => {
            const response = await server.delete(`/domainaccess/${domain.id}`).expect(200);
            expect(response.body.success).to.be.true;
        });
    });

    describe('message', () => {
        before(async () => {
            const response = await server.get(`/users/${userId}/mailboxes`).expect(200);
            expect(response.body.success).to.be.true;
            inbox = response.body.results.find(result => result.path === 'INBOX');
            expect(inbox).to.exist;
            inbox = inbox.id;
        });

        it('should POST /users/:user/mailboxes/:mailbox/messages expect success / with text and html', async () => {
            const message = {
                from: {
                    name: 'test töster',
                    address: 'bestöser@öxample.com'
                },
                to: [
                    {
                        name: 'best böster',
                        address: 'bestöser2@öxample.com'
                    }
                ],
                subject: 'hello world',
                text: 'Hello hello world!',
                html: '<p>Hello hello world!</p>'
            };
            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.message.id).to.be.gt(0);

            const messageDataResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}`);
            expect(response.body.success).to.be.true;

            const messageData = messageDataResponse.body;
            expect(messageData.subject).to.equal(message.subject);
            expect(messageData.html[0]).to.equal(message.html);
            expect(messageData.attachments).to.deep.equal([]);
        });

        it('should POST /users/:user/mailboxes/:mailbox/messages expect success / with embedded attachment', async () => {
            const message = {
                from: {
                    name: 'test tester',
                    address: 'testuser@example.com'
                },
                subject: 'hello world',
                text: 'Hello hello world!',
                html: '<p>Hello hello world! <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==" alt="Red dot" /></p>'
            };
            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message);

            expect(response.body.success).to.be.true;
            expect(response.body.message.id).to.be.gt(0);

            const messageDataResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}`);
            expect(response.body.success).to.be.true;

            const messageData = messageDataResponse.body;

            expect(messageData.subject).to.equal(message.subject);
            expect(messageData.html[0]).to.equal('<p>Hello hello world! <img src="attachment:ATT00001" alt="Red dot"></p>');
            expect(messageData.attachments).to.deep.equal([
                {
                    contentType: 'image/png',
                    disposition: 'inline',
                    fileContentHash: 'SnEfXNA8Cf15ri8Zuy9xFo5xwYt1YmJqGujZnrwyEv8=',
                    filename: 'attachment-1.png',
                    hash: '049e38d27657b44b4bf76cc2334f0970de52ef09d1634720ffe8daa5d75e9e53',
                    id: 'ATT00001',
                    related: true,
                    size: 120,
                    sizeKb: 1,
                    transferEncoding: 'base64',
                    cid: messageData.attachments[0].cid
                }
            ]);
        });

        it('should POST /users/{user}/mailboxes/{mailbox}/messages/{message}/submit expect success / should create a draft message and submit for delivery', async () => {
            const message = {
                from: {
                    name: 'test tester1',
                    address: 'testuser1@example.com'
                },
                to: [
                    { name: 'test tester2', address: 'testuser2@example.com' },
                    { name: 'test tester3', address: 'testuser3@example.com' },
                    { name: 'test tester4', address: 'testuser4@example.com' },
                    { name: 'test tester5', address: 'testuser5@example.com' },
                    { name: 'test tester6', address: 'testuser6@example.com' },
                    { name: 'test tester7', address: 'testuser7@example.com' }
                ],
                draft: true,
                subject: 'hello world',
                text: 'Hello hello world!',
                html: '<p>Hello hello world!</p>'
            };

            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.message.id).to.be.gt(0);

            let sendTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
            const submitResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}/submit`)
                .send({ sendTime })
                .expect(200);
            expect(submitResponse.body.queueId).to.exist;

            const sentMessageDataResponse = await server.get(
                `/users/${userId}/mailboxes/${submitResponse.body.message.mailbox}/messages/${submitResponse.body.message.id}`
            );

            expect(sentMessageDataResponse.body.outbound[0].queueId).to.equal(submitResponse.body.queueId);

            const deleteResponse = await server.delete(`/users/${userId}/outbound/${submitResponse.body.queueId}`).expect(200);
            expect(deleteResponse.body.deleted).to.equal(6);
        });

        it('should POST /users/{user}/mailboxes/{mailbox}/messages/{message}/submit expect failure / should create a draft message and fail submit', async () => {
            const message = {
                from: {
                    name: 'test tester1',
                    address: 'testuser1@example.com'
                },
                to: [
                    { name: 'test tester2', address: 'testuser2@example.com' },
                    { name: 'test tester3', address: 'testuser3@example.com' },
                    { name: 'test tester4', address: 'testuser4@example.com' },
                    { name: 'test tester5', address: 'testuser5@example.com' },
                    { name: 'test tester6', address: 'testuser6@example.com' },
                    { name: 'test tester7', address: 'testuser7@example.com' }
                ],
                draft: true,
                subject: 'hello world',
                text: 'Hello hello world!',
                html: '<p>Hello hello world!</p>'
            };

            const settingsResponse = await server.post(`/settings/const:max:rcpt_to`).send({ value: 3 }).expect(200);
            expect(settingsResponse.body.success).to.be.true;

            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.message.id).to.be.gt(0);

            let sendTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
            const submitResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}/submit`)
                .send({ sendTime })
                .expect(403);

            expect(submitResponse.body.code).to.equal('TooMany');
        });

        it('should GET /users/:user/addressregister expect success', async () => {
            const response = await server.get(`/users/${userId}/addressregister?query=best`);

            expect(response.body.results[0].name).to.equal('test töster');
        });

        it('should GET /users/:user/addressregister expect failure', async () => {
            const response = await server.get(`/users/${userId}/addressregister?query=wrongname`);

            expect(response.body.results.length).to.equal(0);
            expect(response.body.results).to.be.empty;
        });

        it('should GET /users/:user/addressregister expect success / search domain without tld', async () => {
            const response = await server.get(`/users/${userId}/addressregister?query=öxample`);

            expect(response.body.results[0].name).to.equal('test töster');
        });

        it('should GET /users/:user/addressregister expect success / search domain with tld', async () => {
            const response = await server.get(`/users/${userId}/addressregister?query=öxample.com`);

            expect(response.body.results[0].name).to.equal('test töster');
        });

        it('should GET /users/:user/addressregister expect success / search domain partial', async () => {
            const response = await server.get(`/users/${userId}/addressregister?query=öx`);

            expect(response.body.results[0].name).to.equal('test töster');
        });

        it('should GET /users/:user/addressregister expect failure / search domain', async () => {
            const response = await server.get(`/users/${userId}/addressregister?query=mydomain.tld`);

            expect(response.body.results.length).to.equal(0);
            expect(response.body.results).to.be.empty;
        });
    });

    describe('certs', () => {
        it('should POST /certs expect success', async () => {
            const response1 = await server
                .post(`/certs`)
                .send({
                    privateKey:
                        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDKC9G9BJlpJdKI\nMNsjLTgCthKBrtQy3TI4AC5FooqyMIxcpNllI5Mu63IPHRaBGE9+O07oHtYhPq/E\nq3SVBk0+lK346nHofZqVDWeWuiHFL2ilfhP1bFKbr5GtTWr3ctg5K1VVn/CTTPvv\nhvDlIEEaqa125jRVGabdQ53Wu6scY4IgrgFC6qnMZLuYTrmjnVCAehWxtQhPXH+R\n3nszHhUMcgKnDSv331p4AnPDZinv5SixbhizdOoFPFBDAdX4CXmwi3MiBz9FwMgA\nz6fGboW0DDxmm3AxjpMtVu7I8BcsGIe4sYbHtacNt0y7IKMEdlH38ME1vnHfcVad\nwSRQCuOHAgMBAAECggEBALNCnUnY5Mu3tP0Ea8jf+8vcArtwg/DE9CNfda5usiO6\nky43THJBh/qfBsmGA0tyaEUVFcM4aL+CQKx7eqolty8I9vnb+EhP+HC6PegrKH8s\nuunp3IdpHjnnIZbjEz6MdG70lXesuePW78fqr5x6a4jednsBb/j5E2VI8qdsRjqe\nM2H3SHzvPIO8zIWtAin6jmZjp3bBqR+UQfPW0pN6qXpis4mCqG+0mcGuGe5n/koZ\nDXZeFPPtyEd1Ty/2wXnszzPyRdOlWWlhUSgdFqhUQ9pKiGlJ3PkS5QGK3UFmzQqA\niCwA35RcBm+G59ETJiFTy6eu63xVrrP5ALfEZ3MbmAECgYEA5nVi1WNn0aon0T4C\niI58JiLcK9fuSJxKVggyc2d+pkQTiMVc+/MyLi+80k74aKqsYOigQU9Ju/Wx1n+U\nPuU2CAbHWTt9IxjdhXj5zIrvjUQgRkhy5oaSqQGo/Inb0iab/88beLHsYrhcBmmC\nsesrNHTpfrwG6uJ907/eRlK+wgECgYEA4HBP3xkAvyGAVmAjP0pGoYH3I7NTsp40\nb11FitYaxl2X/lKv9XgsL0rjSN66ZO+02ckEdKEv307xF1bvzqH7tMrXa9gaK7+5\nRfVbKsP51yr5PKQmNANxolED2TPeoALLOxUx3mg5awbDIzPwPaIoCfmSvb7uYWh3\neZmc4paIlYcCgYBbh7HKSKHaPvdzfmppLBYY222QqEFGa3SGuNi4xxkhFhagEqr8\nkjmS6HjZGm5Eu8yc7KeBaOlDErEgHSmW1VhhVbflM+BeiSiqM0MbPu8nrzAWWf3w\nmvAy2arxKhu5WoZI0kv54sic6NX74fn7ight3CVEpY8lyPDqoeC5E3IaAQKBgHWE\n2Y2r/eQWmqiftlURg2JWNx4ObCj/Bd26LQvBiEuN/mRAz7nsrtYklFY3qcnoaf4P\nb7HSJMr8/uiFsRO1ZaMJAzuI8EswHMcw7ge6jjvIWLEUEpzxoLKpUSaOLmgCjn/l\nXTNjx4zvAYaRT542JljywY9xRkji9oxJjwhmYiZJAoGAHwW0UuiU46zm5pBhiEpl\nH3tgTx7ZKx6TNHKSEpa4WX5G0UF77N6Ps7wuMBWof033YhxQwt056rL5B4KELLJ0\nSqwWp8dfuDf90MOjm20ySdK+cQtA8zs9MsNX3oliAMfRbb7GVcdFPMJn3axMQyDx\nvAxj1TCva9wAviNDaGbaIJo=\n-----END PRIVATE KEY-----',
                    cert: '-----BEGIN CERTIFICATE-----\nMIIE2TCCA8GgAwIBAgIJANkrklW5OnnjMA0GCSqGSIb3DQEBCwUAMIGWMQswCQYD\nVQQGEwJFRTEOMAwGA1UECAwFSGFyanUxEDAOBgNVBAcMB1RhbGxpbm4xFjAUBgNV\nBAoMDVBvc3RhbFN5c3RlbXMxCzAJBgNVBAsMAkNBMRwwGgYDVQQDDBNyb290Lndp\nbGRkdWNrLmVtYWlsMSIwIAYJKoZIhvcNAQkBFhNpbmZvQHdpbGRkdWNrLmVtYWls\nMB4XDTIxMDUxNzA2NDAzNFoXDTMxMDUxNTA2NDAzNFowgaAxCzAJBgNVBAYTAkVF\nMQ4wDAYDVQQIDAVIYXJqdTEQMA4GA1UEBwwHVGFsbGlubjEWMBQGA1UECgwNUG9z\ndGFsU3lzdGVtczEVMBMGA1UECwwMbG9jYWxfUm9vdENBMSIwIAYJKoZIhvcNAQkB\nFhNpbmZvQHdpbGRkdWNrLmVtYWlsMRwwGgYDVQQDDBNyb290LndpbGRkdWNrLmVt\nYWlsMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAygvRvQSZaSXSiDDb\nIy04ArYSga7UMt0yOAAuRaKKsjCMXKTZZSOTLutyDx0WgRhPfjtO6B7WIT6vxKt0\nlQZNPpSt+Opx6H2alQ1nlrohxS9opX4T9WxSm6+RrU1q93LYOStVVZ/wk0z774bw\n5SBBGqmtduY0VRmm3UOd1rurHGOCIK4BQuqpzGS7mE65o51QgHoVsbUIT1x/kd57\nMx4VDHICpw0r999aeAJzw2Yp7+UosW4Ys3TqBTxQQwHV+Al5sItzIgc/RcDIAM+n\nxm6FtAw8ZptwMY6TLVbuyPAXLBiHuLGGx7WnDbdMuyCjBHZR9/DBNb5x33FWncEk\nUArjhwIDAQABo4IBHDCCARgwgbUGA1UdIwSBrTCBqqGBnKSBmTCBljELMAkGA1UE\nBhMCRUUxDjAMBgNVBAgMBUhhcmp1MRAwDgYDVQQHDAdUYWxsaW5uMRYwFAYDVQQK\nDA1Qb3N0YWxTeXN0ZW1zMQswCQYDVQQLDAJDQTEcMBoGA1UEAwwTcm9vdC53aWxk\nZHVjay5lbWFpbDEiMCAGCSqGSIb3DQEJARYTaW5mb0B3aWxkZHVjay5lbWFpbIIJ\nANnaLorM6YWQMAkGA1UdEwQCMAAwCwYDVR0PBAQDAgTwMEYGA1UdEQQ/MD2CEHd3\ndy5teWRvbWFpbi5jb22CDG15ZG9tYWluLmNvbYIOKi5teWRvbWFpbi5jb22CC2Fu\nb3RoZXIuY29tMA0GCSqGSIb3DQEBCwUAA4IBAQBAD4ZW6eP3UmlLyvdrMHlRadzO\nt0cdL1CJKBCmpaG92KHTuJMXpM+gqFWm0dvt4bCEPjaQuD1uKXdIUxqvpTPv6L1C\nN0bgLiaVGr6n2XP/rrlbvd8FwApg0NPOh0abRn6gTH48UBa/a0tTBy+p8r7NGWt0\nFV49S4VJQbJgv5sue0IiJMo1Az05KdlZtMMfS7tghgQIF111K/ICMEZgSg1oY7zU\nNUoQCVJLFdLPh1Hxtu2bMFIiUSuo8tAcvSAOyXoKevjvuBRPLsntItAR7JQWmX+8\n5VGYeKxgOR8fanaeJxHm+rBL3uyxgHxfzqhzNX5JTPqB9DjUihnJiwVKs2X3\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIDqjCCApICCQDZ2i6KzOmFkDANBgkqhkiG9w0BAQsFADCBljELMAkGA1UEBhMC\nRUUxDjAMBgNVBAgMBUhhcmp1MRAwDgYDVQQHDAdUYWxsaW5uMRYwFAYDVQQKDA1Q\nb3N0YWxTeXN0ZW1zMQswCQYDVQQLDAJDQTEcMBoGA1UEAwwTcm9vdC53aWxkZHVj\nay5lbWFpbDEiMCAGCSqGSIb3DQEJARYTaW5mb0B3aWxkZHVjay5lbWFpbDAeFw0y\nMTA1MTcwNjM5MjdaFw0zMTA1MTUwNjM5MjdaMIGWMQswCQYDVQQGEwJFRTEOMAwG\nA1UECAwFSGFyanUxEDAOBgNVBAcMB1RhbGxpbm4xFjAUBgNVBAoMDVBvc3RhbFN5\nc3RlbXMxCzAJBgNVBAsMAkNBMRwwGgYDVQQDDBNyb290LndpbGRkdWNrLmVtYWls\nMSIwIAYJKoZIhvcNAQkBFhNpbmZvQHdpbGRkdWNrLmVtYWlsMIIBIjANBgkqhkiG\n9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmBEFPdz350w5++Ds+sAkVktqrk7+eO67R9lu\n9f6wJNTeyq8+w2bGZgfoZo3K+8OFry+ET1yPQDrJgiYIKCe4ZgUohbaUh4/GS6xE\n22InmU+Pt7PJ7UoBZgoVQOD1bf9Z6E68pVfoBA2yj0sPVDFvXd8/ToVMmOdl8voW\nVu3pn8bzgvWy8vpOrIzsWhjy7J2SWlWcAVtO5nwK8Eoqj8Um4X5Zg2+pC7wEMN0G\nnGOCLg7Ky1AFn4v/zoz1c+AW+I2uO6YNE1tRka/lC1ohm0D9SLikrWpmzoANUIDD\n1mKX6Jy+uJjA7iaj2B2Hb4wG83fzx8rPBqxV/AFEFMIdPd2JpwIDAQABMA0GCSqG\nSIb3DQEBCwUAA4IBAQBi0Qzu/+MwvHZQyN9GfqzrFRMi6mdwR1Ti4y7N++mAYVJi\nOh9QL/4QufsRd/5x8KjRcy+3ZZkGLT2yxUUWA15DNx3fQMH1g6jlXgpYl/VDBHUw\npJ1zNolP1YQsN6TI9JahGcHOAjNNNbFQSW1fSSd/D0cGxUM0DkC4O47RQ7ZoTFNt\nPoOEQkw8JhQSBpCw+ise6EvoWjOOhFd1M9hy6XemAVTTix5ff7GzOx+ylwcoaNhW\nTEtB3hWRJmbmqBgojUL2/iHQYpkQiBoxIa7tXgy2eFaEHix/Qt3ivEPte7kOSz53\nAsIaoM78oZNm5A3EgzsFyJbjWv/JNgmeKN4E0PoS\n-----END CERTIFICATE-----',
                    description: 'test key',
                    servername: 'mydomain.com'
                })
                .expect(200);
            expect(response1.body.fingerprint).to.equal('6a:bc:80:54:22:30:d2:4e:20:74:e1:11:df:f0:bb:6d:93:4a:f8:82:ee:48:79:8e:17:2e:ad:80:83:06:62:97');
            expect(response1.body.altNames).to.deep.equal(['www.mydomain.com', 'mydomain.com', '*.mydomain.com', 'another.com']);
        });
    });
});
