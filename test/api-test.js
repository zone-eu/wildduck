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
                    hash: '6bb932138c9062004611ca0170d773e78d79154923c5daaf6d8a2f27361c33a2',
                    id: 'ATT00001',
                    related: true,
                    size: 118,
                    sizeKb: 1,
                    transferEncoding: 'base64',
                    cid: messageData.attachments[0].cid
                }
            ]);
        });

        it('should GET /users/:user/mailboxes/:mailbox/messages/:message/attachments/:attachment expect original content disposition', async () => {
            const message = {
                from: {
                    name: 'test tester',
                    address: 'testuser@example.com'
                },
                subject: 'attachment disposition',
                text: 'Hello hello world!',
                attachments: [
                    {
                        filename: 'inline-test.txt',
                        contentType: 'text/csv',
                        contentDisposition: 'inline',
                        content: Buffer.from('test').toString('base64')
                    }
                ]
            };

            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message).expect(200);
            expect(response.body.success).to.be.true;

            const messageDataResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}`).expect(200);
            const attachment = messageDataResponse.body.attachments[0];

            expect(attachment).to.exist;
            expect(attachment.disposition).to.equal('inline');

            const downloadResponse = await server
                .get(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}/attachments/${attachment.id}`)
                .expect(200);

            expect(downloadResponse.headers['content-disposition']).to.match(/^inline\b/i);
            expect(downloadResponse.text).to.equal('test');
        });

        it('should GET /users/:user/mailboxes/:mailbox/messages/:message/attachments/:attachment expect utf8 filename in content disposition', async () => {
            const utf8Filename = 'täst-Ā.txt';
            const expectedHeaderFilename = "filename*0*=utf-8''t%C3%A4st-%C4%80.txt";
            const message = {
                from: {
                    name: 'test tester',
                    address: 'testuser@example.com'
                },
                subject: 'attachment disposition utf8',
                text: 'Hello hello world!',
                attachments: [
                    {
                        filename: utf8Filename,
                        contentType: 'text/csv',
                        contentDisposition: 'inline',
                        content: Buffer.from('test').toString('base64')
                    }
                ]
            };

            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message).expect(200);
            expect(response.body.success).to.be.true;

            const messageDataResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}`).expect(200);
            const attachment = messageDataResponse.body.attachments[0];

            expect(attachment).to.exist;
            expect(attachment.filename).to.equal(utf8Filename);

            const downloadResponse = await server
                .get(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}/attachments/${attachment.id}`)
                .expect(200);

            expect(downloadResponse.headers['content-disposition']).to.match(/^inline\b/i);
            expect(downloadResponse.headers['content-disposition']).to.include(expectedHeaderFilename);
            expect(downloadResponse.text).to.equal('test');
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

            const messageUrl = `/users/${userId}/mailboxes/${submitResponse.body.message.mailbox}/messages/${submitResponse.body.message.id}`;
            const outboundUrl = `/users/${userId}/outbound/${submitResponse.body.queueId}`;

            const sentMessageDataResponse = await server.get(messageUrl).expect(200);

            expect(sentMessageDataResponse.body.outbound[0].queueId).to.equal(submitResponse.body.queueId);
            expect(new Date(sentMessageDataResponse.body.date).getTime()).to.equal(new Date(sendTime).getTime());

            let updatedSendTime = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
            const updateResponse = await server.put(outboundUrl).send({ sendTime: updatedSendTime }).expect(200);
            expect(updateResponse.body.success).to.be.true;
            expect(updateResponse.body.queueId).to.equal(submitResponse.body.queueId);
            expect(updateResponse.body.updated).to.equal(6);
            expect(updateResponse.body.dateUpdated).to.be.true;
            // the copy in the Sent Mail folder was re-dated as well
            expect(updateResponse.body.storedUpdated).to.equal(1);

            const updatedMessageDataResponse = await server.get(messageUrl).expect(200);
            expect(new Date(updatedMessageDataResponse.body.date).getTime()).to.equal(new Date(updatedSendTime).getTime());
            expect(updatedMessageDataResponse.body.outbound[0].entries).to.have.length(6);
            for (let entry of updatedMessageDataResponse.body.outbound[0].entries) {
                expect(new Date(entry.queued).getTime()).to.equal(new Date(updatedSendTime).getTime());
            }

            const updatedMessageSourceResponse = await server.get(`${messageUrl}/message.eml`).expect(200);
            const updatedMessageSource = updatedMessageSourceResponse.text || updatedMessageSourceResponse.body.toString();
            const updatedSourceDate = updatedMessageSource.match(/^Date:\s*(.+)$/im);
            expect(updatedSourceDate).to.exist;
            expect(new Date(updatedSourceDate[1]).getTime()).to.equal(Math.floor(new Date(updatedSendTime).getTime() / 1000) * 1000);

            // the stored size is what IMAP reports as RFC822.SIZE, it has to match the rebuilt message
            expect(updatedMessageDataResponse.body.size).to.equal(Buffer.byteLength(updatedMessageSource, 'binary'));

            const postponeResponse = await server.put(outboundUrl).send({ sendTime }).expect(200);
            expect(postponeResponse.body.success).to.be.true;
            expect(postponeResponse.body.updated).to.equal(6);

            const postponedMessageDataResponse = await server.get(messageUrl).expect(200);
            expect(new Date(postponedMessageDataResponse.body.date).getTime()).to.equal(new Date(sendTime).getTime());
            for (let entry of postponedMessageDataResponse.body.outbound[0].entries) {
                expect(new Date(entry.queued).getTime()).to.equal(new Date(sendTime).getTime());
            }

            // delivery times in the past are replaced with the current time
            let sendNow = new Date(Date.now() - 3600 * 1000).toISOString();
            const sendNowResponse = await server.put(outboundUrl).send({ sendTime: sendNow }).expect(200);
            expect(sendNowResponse.body.success).to.be.true;
            expect(sendNowResponse.body.updated).to.equal(6);
            expect(new Date(sendNowResponse.body.sendTime).getTime()).to.be.greaterThan(new Date(sendNow).getTime());

            const sendNowMessageDataResponse = await server.get(messageUrl).expect(200);
            expect(new Date(sendNowMessageDataResponse.body.date).getTime()).to.equal(new Date(sendNowResponse.body.sendTime).getTime());
            for (let entry of sendNowMessageDataResponse.body.outbound[0].entries) {
                expect(new Date(entry.queued).getTime()).to.equal(new Date(sendNowResponse.body.sendTime).getTime());
            }

            // updating the same delivery time again still counts the matching queue entries
            const repeatResponse = await server.put(outboundUrl).send({ sendTime: sendNowResponse.body.sendTime }).expect(200);
            expect(repeatResponse.body.updated).to.equal(6);

            const deleteResponse = await server.delete(outboundUrl).expect(200);
            expect(deleteResponse.body.deleted).to.equal(6);
        });

        it('should PUT /users/{user}/outbound/{queueId} expect failure / unknown queue id', async () => {
            const updateResponse = await server
                .put(`/users/${userId}/outbound/ffffffffffffffffff`)
                .send({ sendTime: new Date(Date.now() + 3600 * 1000).toISOString() })
                .expect(404);
            expect(updateResponse.body.success).to.be.false;
            expect(updateResponse.body.code).to.equal('NoSuchQueueEntry');
            expect(updateResponse.body.error).to.be.a('string').and.not.empty;
        });

        it('should PUT /users/{user}/outbound/{queueId} expect failure / delivery time past the queue expiry', async () => {
            const message = {
                from: { name: 'test tester1', address: 'testuser1@example.com' },
                to: [{ name: 'test tester2', address: 'testuser2@example.com' }],
                draft: true,
                subject: 'expiring send time',
                text: 'Hello hello world!'
            };

            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message).expect(200);
            const submitResponse = await server.post(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}/submit`).send({}).expect(200);

            const outboundUrl = `/users/${userId}/outbound/${submitResponse.body.queueId}`;

            // the MTA drops queue entries that are older than consts.MAX_QUEUE_TIME without a bounce
            const tooLate = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
            const updateResponse = await server.put(outboundUrl).send({ sendTime: tooLate }).expect(400);
            expect(updateResponse.body.success).to.be.false;
            expect(updateResponse.body.code).to.equal('SendTimeTooLate');
            expect(updateResponse.body.error).to.be.a('string').and.not.empty;

            await server.delete(outboundUrl).expect(200);
        });

        it('should PUT /users/{user}/outbound/{queueId} expect failure / queue entry of another user', async () => {
            const otherUserResponse = await server
                .post('/users')
                .send({
                    username: 'outboundstranger',
                    password: 'secretvalue',
                    address: 'outboundstranger@example.com',
                    name: 'outbound stranger'
                })
                .expect(200);
            const otherUserId = otherUserResponse.body.id;

            const message = {
                from: { name: 'test tester1', address: 'testuser1@example.com' },
                to: [{ name: 'test tester2', address: 'testuser2@example.com' }],
                draft: true,
                subject: 'not yours',
                text: 'Hello hello world!'
            };

            const response = await server.post(`/users/${userId}/mailboxes/${inbox}/messages`).send(message).expect(200);
            const submitResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages/${response.body.message.id}/submit`)
                .send({ sendTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
                .expect(200);

            const updateResponse = await server
                .put(`/users/${otherUserId}/outbound/${submitResponse.body.queueId}`)
                .send({ sendTime: new Date(Date.now() + 3600 * 1000).toISOString() })
                .expect(403);
            expect(updateResponse.body.success).to.be.false;
            expect(updateResponse.body.code).to.equal('NotEnoughPrivileges');
            expect(updateResponse.body.error).to.be.a('string').and.not.empty;

            await server.delete(`/users/${userId}/outbound/${submitResponse.body.queueId}`).expect(200);
            await server.delete(`/users/${otherUserId}`).expect(200);
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

    describe('keywords', () => {
        let messageId;

        before(async () => {
            const mailboxes = await server.get(`/users/${userId}/mailboxes`).expect(200);
            inbox = mailboxes.body.results.find(mailbox => mailbox.path === 'INBOX').id;
            const response = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages`)
                .send({
                    from: { name: 'Keyword Tester', address: 'kwtest@example.com' },
                    subject: 'keyword test message',
                    text: 'Testing keywords'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
            messageId = response.body.message.id;
        });

        after(async () => {
            if (messageId) {
                await server.delete(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            }
        });

        it('should GET /users/:user/keywords with all custom keywords and counters', async () => {
            const firstResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages`)
                .send({
                    from: { name: 'Keyword Tester', address: 'kwtest@example.com' },
                    subject: 'first keyword list message',
                    text: 'Testing keyword list',
                    unseen: true,
                    keywords: ['keyword-list-a', 'keyword-list-shared']
                })
                .expect(200);
            const secondResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages`)
                .send({
                    from: { name: 'Keyword Tester', address: 'kwtest@example.com' },
                    subject: 'second keyword list message',
                    text: 'Testing keyword list',
                    keywords: ['keyword-list-b', 'keyword-list-shared']
                })
                .expect(200);

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${secondResponse.body.message.id}`)
                .send({ seen: true })
                .expect(200);

            const response = await server.get(`/users/${userId}/keywords?counters=true`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.keywords.map(({ keyword, total, unseen }) => ({ keyword, total, unseen }))).to.deep.include.members([
                { keyword: 'keyword-list-a', total: 1, unseen: 1 },
                { keyword: 'keyword-list-b', total: 1, unseen: 0 },
                { keyword: 'keyword-list-shared', total: 2, unseen: 1 }
            ]);

            const namesOnlyResponse = await server.get(`/users/${userId}/keywords`).expect(200);
            expect(namesOnlyResponse.body.keywords.map(({ keyword }) => ({ keyword }))).to.deep.include.members([
                { keyword: 'keyword-list-a' },
                { keyword: 'keyword-list-b' },
                { keyword: 'keyword-list-shared' }
            ]);
            for (const keyword of namesOnlyResponse.body.keywords) {
                expect(keyword).to.not.have.any.keys('total', 'unseen');
                expect(keyword).to.not.have.property('name');
                expect(keyword.path.startsWith('\\')).to.be.false;
                expect(keyword.path).to.not.equal('$Forwarded');
            }

            await server.delete(`/users/${userId}/mailboxes/${inbox}/messages/${firstResponse.body.message.id}`).expect(200);
            await server.delete(`/users/${userId}/mailboxes/${inbox}/messages/${secondResponse.body.message.id}`).expect(200);
            const emptyLabels = await server.get(`/users/${userId}/keywords?counters=true`).expect(200);
            expect(emptyLabels.body.keywords.find(entry => entry.path === 'keyword-list-a')).to.include({ total: 0, unseen: 0 });
        });

        it('creates empty nested keywords idempotently with parents and validates paths', async () => {
            const path = 'Projects/čau-😀';
            const [first, second] = await Promise.all([
                server.post(`/users/${userId}/keywords`).send({ path }).expect(200),
                server.post(`/users/${userId}/keywords`).send({ path }).expect(200)
            ]);
            expect(second.body.id).to.equal(first.body.id);
            const listing = await server.get(`/users/${userId}/keywords`).expect(200);
            expect(listing.body.keywords.find(entry => entry.path === path)).to.deep.equal({
                id: first.body.id,
                path,
                keyword: 'čau-😀'
            });
            expect(listing.body.keywords.some(entry => entry.path === 'Projects')).to.be.true;
            for (const invalidPath of ['/Projects', 'Projects/', 'Projects//child', '\\Seen', 'a'.repeat(257), 'a/b/c/d/e/f']) {
                await server.post(`/users/${userId}/keywords`).send({ path: invalidPath }).expect(400);
            }
            for (const validPath of ['a'.repeat(256), 'a/b/c/d/e']) {
                await server.post(`/users/${userId}/keywords`).send({ path: validPath }).expect(200);
            }
            const deletion = await server.delete(`/users/${userId}/keywords/${first.body.id}`).expect(200);
            expect(deletion.body.success).to.be.true;
            const repeatedDeletion = await server.delete(`/users/${userId}/keywords/${first.body.id}`).expect(200);
            expect(repeatedDeletion.body.scheduled).to.equal(deletion.body.scheduled);
            expect(repeatedDeletion.body.existing).to.be.true;
            const deletingListing = await server.get(`/users/${userId}/keywords`).expect(200);
            expect(deletingListing.body.keywords.some(entry => entry.path === path)).to.be.false;
            expect(deletingListing.body.keywords.some(entry => entry.path === 'Projects')).to.be.true;
        });

        it('should PUT /users/:user/keywords/:keyword rename only the selected keyword', async () => {
            await server.post(`/users/${userId}/keywords`).send({ path: 'rename-me/nested' }).expect(200);
            const listingBefore = await server.get(`/users/${userId}/keywords`).expect(200);
            const topId = listingBefore.body.keywords.find(entry => entry.path === 'rename-me').id;

            const uploadResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages`)
                .send({
                    from: { name: 'Keyword Tester', address: 'kwtest@example.com' },
                    subject: 'keyword rename message',
                    text: 'Testing keyword rename',
                    keywords: ['rename-me', 'rename-me/nested']
                })
                .expect(200);
            const renamedMessageId = uploadResponse.body.message.id;

            const renameResponse = await server
                .put(`/users/${userId}/keywords/${topId}`)
                .send({ path: 'renamed-root' })
                .expect(200);
            expect(renameResponse.body.success).to.be.true;
            expect(renameResponse.body.id).to.equal(topId);
            expect(renameResponse.body.path).to.equal('renamed-root');
            expect(renameResponse.body.oldPath).to.equal('rename-me');

            const listing = await server.get(`/users/${userId}/keywords`).expect(200);
            expect(listing.body.keywords.some(entry => entry.path === 'rename-me')).to.be.false;
            expect(listing.body.keywords.some(entry => entry.path === 'rename-me/nested')).to.be.true;
            expect(listing.body.keywords.some(entry => entry.path === 'renamed-root')).to.be.true;
            expect(listing.body.keywords.some(entry => entry.path === 'renamed-root/nested')).to.be.false;

            // The message assignment follows the stable keyword ID.
            const renamedMessage = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${renamedMessageId}`).expect(200);
            expect(renamedMessage.body.keywords).to.have.members(['renamed-root', 'rename-me/nested']);

            // The old path is free and creates a separate keyword when assigned again.
            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${renamedMessageId}`)
                .send({ addKeywords: ['rename-me'] })
                .expect(200);

            // Renaming to the current path is idempotent.
            await server
                .put(`/users/${userId}/keywords/${topId}`)
                .send({ path: 'renamed-root' })
                .expect(200);

            await server.delete(`/users/${userId}/mailboxes/${inbox}/messages/${renamedMessageId}`).expect(200);
        });

        it('should PUT /users/:user/keywords/:keyword reject an existing path', async () => {
            await server.post(`/users/${userId}/keywords`).send({ path: 'rename-conflict-target' }).expect(200);
            const source = await server.post(`/users/${userId}/keywords`).send({ path: 'rename-conflict-source' }).expect(200);

            const clash = await server
                .put(`/users/${userId}/keywords/${source.body.id}`)
                .send({ path: 'rename-conflict-target' })
                .expect(409);
            expect(clash.body.code).to.equal('KeywordConflict');

            const missing = await server
                .put(`/users/${userId}/keywords/${new ObjectId()}`)
                .send({ path: 'rename-conflict-target' })
                .expect(404);
            expect(missing.body.code).to.equal('KeywordNotFound');

            const invalid = await server
                .put(`/users/${userId}/keywords/${source.body.id}`)
                .send({ path: 'a/b/c/d/e/f' })
                .expect(400);
            expect(invalid.body.code).to.equal('InputValidationError');

            // nothing was changed by the failed renames
            const listing = await server.get(`/users/${userId}/keywords`).expect(200);
            expect(listing.body.keywords.some(entry => entry.path === 'rename-conflict-source')).to.be.true;
        });

        it('should POST /users/:user/mailboxes/:mailbox/messages with keywords expect success / keywords appear in GET', async () => {
            const uploadResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages`)
                .send({
                    from: { name: 'Keyword Tester', address: 'kwtest@example.com' },
                    subject: 'upload with keywords',
                    text: 'Testing upload keywords',
                    keywords: ['important', 'project-x']
                })
                .expect(200);
            expect(uploadResponse.body.success).to.be.true;

            const msgId = uploadResponse.body.message.id;
            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${msgId}`).expect(200);
            expect(getResponse.body.keywords).to.have.members(['important', 'project-x']);

            await server.delete(`/users/${userId}/mailboxes/${inbox}/messages/${msgId}`).expect(200);
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message set and replace keywords expect success', async () => {
            const putResponse = await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['todo', 'urgent'] })
                .expect(200);
            expect(putResponse.body.success).to.be.true;

            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse.body.keywords).to.have.members(['todo', 'urgent']);

            // Replacing keywords removes the old ones
            await server.put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).send({ keywords: ['new-tag'] }).expect(200);

            const getResponse2 = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse2.body.keywords).to.deep.equal(['new-tag']);
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message clear keywords with empty array expect success', async () => {
            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['to-be-cleared'] })
                .expect(200);

            await server.put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).send({ keywords: [] }).expect(200);

            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse.body.keywords).to.deep.equal([]);
        });

        it('should GET /users/:user/mailboxes/:mailbox/messages keywords appear in listing expect success', async () => {
            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['list-test'] })
                .expect(200);

            const listResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages`).expect(200);
            expect(listResponse.body.success).to.be.true;
            const found = listResponse.body.results.find(m => m.id === messageId);
            expect(found).to.exist;
            expect(found.keywords).to.include('list-test');
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message system flags unaffected by keyword changes expect success', async () => {
            await server.put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).send({ seen: true }).expect(200);

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['check-flags'] })
                .expect(200);

            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse.body.seen).to.be.true;
            expect(getResponse.body.keywords).to.include('check-flags');
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message addKeywords expect success', async () => {
            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['base'] })
                .expect(200);

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ addKeywords: ['added'] })
                .expect(200);

            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse.body.keywords).to.include.members(['base', 'added']);
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message removeKeywords expect success', async () => {
            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['keep', 'remove-me'] })
                .expect(200);

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ removeKeywords: ['remove-me'] })
                .expect(200);

            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse.body.keywords).to.deep.equal(['keep']);
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message keywords with addKeywords expect failure', async () => {
            const putResponse = await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['a'], addKeywords: ['b'] })
                .expect(400);
            expect(putResponse.body.error).to.exist;
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message addKeywords and removeKeywords together expect success', async () => {
            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['keep', 'remove-me'] })
                .expect(200);

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ addKeywords: ['added'], removeKeywords: ['remove-me'] })
                .expect(200);

            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse.body.keywords).to.include.members(['keep', 'added']);
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message multiple flag changes in single request expect success', async () => {
            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ seen: true, keywords: ['old'] })
                .expect(200);

            // Flip seen, add deleted, and replace keywords — all in one atomic operation
            const putResponse = await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ seen: false, deleted: true, keywords: ['new'] })
                .expect(200);
            expect(putResponse.body.success).to.be.true;

            const getResponse = await server.get(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).expect(200);
            expect(getResponse.body.seen).to.be.false;
            expect(getResponse.body.deleted).to.be.true;
            expect(getResponse.body.keywords).to.deep.equal(['new']);
        });

        it('should PUT /users/:user/mailboxes/:mailbox/messages/:message invalid keyword expect failure', async () => {
            const putResponse = await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`)
                .send({ keywords: ['invalid keyword'] })
                .expect(400);
            expect(putResponse.body.error).to.exist;
        });

        it('should GET /users/:user/search keyword filter expect success', async () => {
            await server.put(`/users/${userId}/mailboxes/${inbox}/messages/${messageId}`).send({ keywords: ['search-target'] }).expect(200);

            const searchResponse = await server.get(`/users/${userId}/search?keyword=search-target`).expect(200);
            expect(searchResponse.body.results.some(result => result.id === messageId)).to.be.true;

            const noMatchResponse = await server.get(`/users/${userId}/search?keyword=nonexistent-keyword`).expect(200);
            expect(noMatchResponse.body.results.some(result => result.id === messageId)).to.be.false;
        });

        it('should GET /users/:user/keyword-counters/:keyword reflect keyword and seen deltas expect success', async () => {
            const keywordCounterKeywordOne = `kw-counter-a-${Date.now()}`;
            const keywordCounterKeywordTwo = `kw-counter-b-${Date.now()}`;

            const wait = timeout => new Promise(resolvePromise => setTimeout(resolvePromise, timeout));

            const readCounters = async () => {
                const [keywordAResponse, keywordBResponse] = await Promise.all([
                    server.get(`/users/${userId}/keyword-counters/${keywordCounterKeywordOne}`).expect(200),
                    server.get(`/users/${userId}/keyword-counters/${keywordCounterKeywordTwo}`).expect(200)
                ]);

                return {
                    keywordACounter: {
                        keyword: keywordAResponse.body.keyword,
                        total: keywordAResponse.body.total,
                        unseen: keywordAResponse.body.unseen
                    },
                    keywordBCounter: {
                        keyword: keywordBResponse.body.keyword,
                        total: keywordBResponse.body.total,
                        unseen: keywordBResponse.body.unseen
                    }
                };
            };

            const waitForExpectedCounters = async matchesExpected => {
                for (let attemptNumber = 0; attemptNumber < 20; attemptNumber++) {
                    const counters = await readCounters();
                    if (matchesExpected(counters)) {
                        return counters;
                    }
                    await wait(100);
                }

                throw new Error('Keyword counters did not reach expected values in time');
            };

            const baseline = await readCounters();

            const createExpectedCounters = (keywordATotalDelta, keywordAUnseenDelta, keywordBTotalDelta, keywordBUnseenDelta) => ({
                keywordACounter: {
                    total: baseline.keywordACounter.total + keywordATotalDelta,
                    unseen: baseline.keywordACounter.unseen + keywordAUnseenDelta
                },
                keywordBCounter: {
                    total: baseline.keywordBCounter.total + keywordBTotalDelta,
                    unseen: baseline.keywordBCounter.unseen + keywordBUnseenDelta
                }
            });

            const countersMatchExpected = (currentCounters, expectedCounters) =>
                currentCounters.keywordACounter.total === expectedCounters.keywordACounter.total &&
                currentCounters.keywordACounter.unseen === expectedCounters.keywordACounter.unseen &&
                currentCounters.keywordBCounter.total === expectedCounters.keywordBCounter.total &&
                currentCounters.keywordBCounter.unseen === expectedCounters.keywordBCounter.unseen;

            const expectCounters = async expectedCounters => {
                const observedCounters = await waitForExpectedCounters(currentCounters => countersMatchExpected(currentCounters, expectedCounters));
                expect(observedCounters.keywordACounter.total).to.equal(expectedCounters.keywordACounter.total);
                expect(observedCounters.keywordACounter.unseen).to.equal(expectedCounters.keywordACounter.unseen);
                expect(observedCounters.keywordBCounter.total).to.equal(expectedCounters.keywordBCounter.total);
                expect(observedCounters.keywordBCounter.unseen).to.equal(expectedCounters.keywordBCounter.unseen);
            };

            const createResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages`)
                .send({
                    from: { name: 'Keyword Counter Tester', address: 'kwcounter@example.com' },
                    subject: 'keyword counters',
                    text: 'keyword counters',
                    unseen: true,
                    keywords: [keywordCounterKeywordOne]
                })
                .expect(200);

            const counterMessageId = createResponse.body.message.id;

            await expectCounters(createExpectedCounters(1, 1, 0, 0));

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${counterMessageId}`)
                .send({ addKeywords: [keywordCounterKeywordTwo], seen: true })
                .expect(200);

            await expectCounters(createExpectedCounters(1, 0, 1, 0));

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${counterMessageId}`)
                .send({ removeKeywords: [keywordCounterKeywordOne], seen: false })
                .expect(200);

            await expectCounters(createExpectedCounters(0, 0, 1, 1));

            await server.delete(`/users/${userId}/mailboxes/${inbox}/messages/${counterMessageId}`).expect(200);

            await expectCounters(createExpectedCounters(0, 0, 0, 0));
        });

        it('should GET /users/:user/flagged-counter reflect flagged and seen deltas expect success', async () => {
            const wait = timeout => new Promise(resolvePromise => setTimeout(resolvePromise, timeout));

            const readFlaggedCounter = async () => {
                const flaggedCounterResponse = await server.get(`/users/${userId}/flagged-counter`).expect(200);

                return {
                    total: flaggedCounterResponse.body.total,
                    unseen: flaggedCounterResponse.body.unseen
                };
            };

            const waitForExpectedCounter = async matchesExpected => {
                for (let attemptNumber = 0; attemptNumber < 20; attemptNumber++) {
                    const counter = await readFlaggedCounter();
                    if (matchesExpected(counter)) {
                        return counter;
                    }
                    await wait(100);
                }

                throw new Error('Flagged counter did not reach expected values in time');
            };

            const baseline = await readFlaggedCounter();

            const createExpectedCounter = (totalDelta, unseenDelta) => ({
                total: baseline.total + totalDelta,
                unseen: baseline.unseen + unseenDelta
            });

            const expectCounter = async expectedCounter => {
                const observedCounter = await waitForExpectedCounter(
                    currentCounter => currentCounter.total === expectedCounter.total && currentCounter.unseen === expectedCounter.unseen
                );
                expect(observedCounter.total).to.equal(expectedCounter.total);
                expect(observedCounter.unseen).to.equal(expectedCounter.unseen);
            };

            const createResponse = await server
                .post(`/users/${userId}/mailboxes/${inbox}/messages`)
                .send({
                    from: { name: 'Flagged Counter Tester', address: 'flagcounter@example.com' },
                    subject: 'flagged counters',
                    text: 'flagged counters',
                    unseen: true,
                    flagged: true
                })
                .expect(200);

            const flaggedMessageId = createResponse.body.message.id;

            await expectCounter(createExpectedCounter(1, 1));

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${flaggedMessageId}`)
                .send({ flagged: false, seen: true })
                .expect(200);

            await expectCounter(createExpectedCounter(0, 0));

            await server
                .put(`/users/${userId}/mailboxes/${inbox}/messages/${flaggedMessageId}`)
                .send({ flagged: true, seen: false })
                .expect(200);

            await expectCounter(createExpectedCounter(1, 1));

            await server.delete(`/users/${userId}/mailboxes/${inbox}/messages/${flaggedMessageId}`).expect(200);

            await expectCounter(createExpectedCounter(0, 0));
        });

        it('should DELETE /users/{user}/mailboxes/{mailbox} expect success and invalidate account counters', async () => {
            const keyword = `deleted-mailbox-${Date.now()}`;
            const readCounters = async () => {
                const [keywordResponse, flaggedResponse] = await Promise.all([
                    server.get(`/users/${userId}/keyword-counters/${keyword}`).expect(200),
                    server.get(`/users/${userId}/flagged-counter`).expect(200)
                ]);
                return {
                    keyword: keywordResponse.body,
                    flagged: flaggedResponse.body
                };
            };
            const waitForCounters = async expected => {
                for (let attempt = 0; attempt < 20; attempt++) {
                    const counters = await readCounters();
                    if (
                        counters.keyword.total === expected.keyword.total &&
                        counters.keyword.unseen === expected.keyword.unseen &&
                        counters.flagged.total === expected.flagged.total &&
                        counters.flagged.unseen === expected.flagged.unseen
                    ) {
                        return counters;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error('Deleted mailbox counters did not reach expected values in time');
            };
            const baseline = await readCounters();
            const mailboxResponse = await server
                .post(`/users/${userId}/mailboxes`)
                .send({ path: `Counter deletion ${Date.now()}` })
                .expect(200);
            const mailbox = mailboxResponse.body.id;

            await server
                .post(`/users/${userId}/mailboxes/${mailbox}/messages`)
                .send({
                    from: { name: 'Counter Tester', address: 'counter-delete@example.com' },
                    subject: 'mailbox deletion counters',
                    text: 'mailbox deletion counters',
                    unseen: true,
                    flagged: true,
                    keywords: [keyword]
                })
                .expect(200);

            await waitForCounters({
                keyword: {
                    total: baseline.keyword.total + 1,
                    unseen: baseline.keyword.unseen + 1
                },
                flagged: {
                    total: baseline.flagged.total + 1,
                    unseen: baseline.flagged.unseen + 1
                }
            });

            await server.delete(`/users/${userId}/mailboxes/${mailbox}`).expect(200);

            const afterDeletion = await waitForCounters(baseline);
            expect(afterDeletion.keyword.total).to.equal(baseline.keyword.total);
            expect(afterDeletion.keyword.unseen).to.equal(baseline.keyword.unseen);
            expect(afterDeletion.flagged.total).to.equal(baseline.flagged.total);
            expect(afterDeletion.flagged.unseen).to.equal(baseline.flagged.unseen);
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
