/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('wild-config');

const fs = require('fs');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe.only('Messages tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let testMailbox;
    let trashId;

    before(async () => {
        // ensure that we have an existing user account
        const pubKey = fs.readFileSync(__dirname + '/user2-public.key', 'utf-8');

        const userCreationResponse = await server
            .post('/users')
            .send({
                username: 'messagestestsuser',
                password: 'secretpassword',
                address: 'messagestestsuser@web.zone.test',
                name: 'messages user',
                recipients: 10000,
                pubKey,
                encryptMessages: false
            })
            .expect(200);
        expect(userCreationResponse.body.success).to.be.true;
        expect(userCreationResponse.body.id).to.exist;

        user = userCreationResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).send();
        // inboxMailbox = mailboxesResponse.body.results[0].id; // INBOX id

        const mailboxResponse = await server.post(`/users/${user}/mailboxes`).send({ path: '/testpath', hidden: false, retention: 10000 }).expect(200);
        testMailbox = mailboxResponse.body.id;
        trashId = mailboxesResponse.body.results[4].id;

        // Instantiate some random messages
        const initialMessages = [];
        const initialMessagesCount = 500;
        for (let i = 0; i < initialMessagesCount; i++) {
            const messageCreationPromise = server.post(`/users/${user}/mailboxes/${testMailbox}/messages`).send({
                draft: true,
                headers: [{ key: 'List-Id', value: `${i}` }],
                to: [{ address: 'noreply@to.com' }, { address: 'to3@to.com' }],
                subject: `Test message ${i}`,
                text: `${i}Test message ${i}`
            });

            initialMessages.push(messageCreationPromise);
        }
        await Promise.all(initialMessages);
    });

    it('should POST /users/:user/mailboxes/:mailbox/messages/:message/submit expect success / normal submit', async () => {
        const messageResponse = await server
            .post(`/users/${user}/mailboxes/${testMailbox}/messages`)
            .send({
                draft: true,
                headers: [{ key: 'List-Id', value: '123' }],
                to: [{ address: 'noreply@to.com' }, { address: 'to2@to.com' }, { address: 'to3@to.com' }],
                attachments: [
                    {
                        content:
                            'zZW1wZXIgcGxhY2VyYXQsIGZhdWNpYnVzIGluIG9kaW8uIERvbmVjIGxhY2luaWEgYXJjdSBhYyB2ZWxpdCBjb25kaW1lbnR1bSBsb2JvcnRpcy4gTWF1cmlzIGVnZXQgZGlnbmlzc2ltIGp1c3RvLiBNYWVjZW5hcyBzZWQgbGVvIHV0IHNlbSBpbXBlcmRpZXQgY29uZGltZW50dW0uIEN1cmFiaXR1ciB2ZW5lbmF0aXMsIG51bGxhIGV1IGNvbmR',
                        contentType: 'text/plain'
                    }
                ],
                from: { name: 'messagestestsuser@web.zone.test', address: 'messagestestsuser@web.zone.test' },
                subject: 'test message',
                text: 'This is a test message with attachment'
            })
            .expect(200);
        const message = messageResponse.body.message.id;

        const data = await server.post(`/users/${user}/mailboxes/${testMailbox}/messages/${message}/submit`).send();

        const body = data.body;
        expect(body.success).to.be.true;
        expect(body.message).to.not.be.empty;
        expect(body.message.id).to.eq(1);
    });

    it('should POST users/:user/mailboxes/:mailbox/messages/:message/submit expect success / encrypted mailbox', async () => {
        // set test mailbox as encrypted
        await server.put(`/users/${user}/mailboxes/${testMailbox}`).send({ encryptMessages: true }).expect(200);

        const messageResponse = await server
            .post(`/users/${user}/mailboxes/${testMailbox}/messages`)
            .send({
                draft: false,
                headers: [{ key: 'List-Id', value: '123' }],
                to: [{ address: 'noreply@to.com' }, { address: 'to2@to.com' }, { address: 'to3@to.com' }],
                attachments: [
                    {
                        content:
                            'zZW1wZXIgcGxhY2VyYXQsIGZhdWNpYnVzIGluIG9kaW8uIERvbmVjIGxhY2luaWEgYXJjdSBhYyB2ZWxpdCBjb25kaW1lbnR1bSBsb2JvcnRpcy4gTWF1cmlzIGVnZXQgZGlnbmlzc2ltIGp1c3RvLiBNYWVjZW5hcyBzZWQgbGVvIHV0IHNlbSBpbXBlcmRpZXQgY29uZGltZW50dW0uIEN1cmFiaXR1ciB2ZW5lbmF0aXMsIG51bGxhIGV1IGNvbmR',
                        contentType: 'text/plain'
                    }
                ],
                from: { name: 'messagestestsuser@web.zone.test', address: 'messagestestsuser@web.zone.test' },
                subject: 'Encrypted test message',
                text: 'This is an encrypted test message'
            })
            .expect(200);
        const message = messageResponse.body.message.id;

        const messageData = await server.get(`/users/${user}/mailboxes/${testMailbox}/messages/${message}`).send();

        expect(messageData.body.encrypted).to.be.true;
        expect(messageData.body.contentType.value).to.eq('multipart/encrypted');
        expect(messageData.body.text).to.be.empty;
        expect(messageData.body.html).to.not.exist;
        expect(messageData.body.attachments.length).to.be.eq(2);

        await server.put(`/users/${user}/mailboxes/${testMailbox}`).send({ encryptMessages: false }).expect(200);
    });

    it('should POST /users/:user/search expect success / pagination pages 1 -> 2 -> 3 -> 2 -> 1', async () => {
        const orderSearch = 'desc';
        const from = 'messagestests'; // Partial match
        const limit = 10;

        const search = await server.get(`/users/${user}/search?order=${orderSearch}&mailbox=${testMailbox}&from=${from}&limit=${limit}`).send({});

        const search2 = await server
            .get(`/users/${user}/search?next=${search.body.nextCursor}&order=${orderSearch}&mailbox=${testMailbox}&from=${from}&limit=${limit}`)
            .send({});

        const search3 = await server
            .get(`/users/${user}/search?next=${search2.body.nextCursor}&order=${orderSearch}&mailbox=${testMailbox}&from=${from}&limit=${limit}`)
            .send({});

        const search4 = await server
            .get(`/users/${user}/search?previous=${search3.body.previousCursor}&order=${orderSearch}&mailbox=${testMailbox}&from=${from}&limit=${limit}`)
            .send({});

        expect(search4.body.results).to.deep.eq(search2.body.results); // Check if page 2 is equal to original page 2 after moving back from page 3

        const search5 = await server
            .get(`/users/${user}/search?previous=${search4.body.previousCursor}&order=${orderSearch}&mailbox=${testMailbox}&from=${from}&limit=${limit}`)
            .send({}); // page 2 -> page 1
        expect(search5.body.results).to.deep.eq(search.body.results); // Check if page 1 is equal to original page 1 after moving back from page 2
    });

    it('should GET /users/:user/mailboxes/:mailbox/messages expect success / pagination pages 1 -> 2 -> 3 -> 2 -> 1', async () => {
        const order = 'desc';

        const res = await server.get(`/users/${user}/mailboxes/${testMailbox}/messages?order=${order}`).send({});

        const res2 = await server.get(`/users/${user}/mailboxes/${testMailbox}/messages?next=${res.body.nextCursor}&order=${order}`).send({});

        const res3 = await server.get(`/users/${user}/mailboxes/${testMailbox}/messages?next=${res2.body.nextCursor}&order=${order}`).send({});

        const res4 = await server.get(`/users/${user}/mailboxes/${testMailbox}/messages?previous=${res3.body.previousCursor}&order=${order}`).send({});

        expect(res4.body.results).to.deep.eq(res2.body.results); // Check if page 2 is equal to original page 2 after moving back from page 3

        const res5 = await server.get(`/users/${user}/mailboxes/${testMailbox}/messages?previous=${res4.body.previousCursor}&page=100?order=${order}`).send({}); // page 2 -> page 1
        expect(res5.body.results).to.deep.eq(res.body.results); // Check if page 1 is equal to original page 1 after moving back from page 2
    });

    it('should PUT /users/:user/mailboxes/:mailbox/messages expect success / move lots of messages to trash, should not timeout', async () => {
        const performanceMessages = [];
        // add even more messages
        const perfMessagesCount = 250;
        for (let i = 0; i < perfMessagesCount; i++) {
            const messageCreationPromise = server.post(`/users/${user}/mailboxes/${testMailbox}/messages`).send({
                draft: true,
                headers: [{ key: 'List-Id', value: `${i}` }],
                to: [{ address: 'to4@to.com' }],
                subject: `Test message move to trash ${i}`,
                text: `${i} Test message move to trash ${i}`
            });

            performanceMessages.push(messageCreationPromise);
        }
        await Promise.all(performanceMessages);

        // Move all messages to trash
        await server.put(`/users/${user}/mailboxes/${testMailbox}/messages`).send({ message: '1:*', moveTo: trashId });
    });
});
