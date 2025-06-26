/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('wild-config');

const fs = require('fs');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe.only('Messages tests', function () {
    this.timeout(10000000); // eslint-disable-line no-invalid-this

    let user;
    let mailbox;
    let message;
    // let message2;

    before(async () => {
        // ensure that we have an existing user account
        const pubKey = fs.readFileSync(__dirname + '/user2-public.key', 'utf-8');

        const response = await server
            .post('/users')
            .send({
                username: 'messagestestsuser',
                password: 'secretvalue',
                address: 'messagestestsuser@web.zone.test',
                name: 'messages user',
                recipients: 10000,
                pubKey,
                encryptMessages: false
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        user = response.body.id;

        // const startDate = new Date();

        // const mailboxResponse = await server.post(`/users/${user}/mailboxes`).send({ path: '/coolpath/abcda', hidden: false, retention: 10000 }).expect(200);
        // mailbox = mailboxResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).send();
        // console.log(mailboxesResponse.body.results[0]); // INBOX
        const inboxId = mailboxesResponse.body.results[0].id;
        mailbox = inboxId;
        // const trashId = mailboxesResponse.body.results[4].id;

        // set inbox as encrypted

        // await server.put(`/users/${user}/mailboxes/${inboxId}`).send({ encryptMessages: true }).expect(200);

        // server.post(`/users/${user}/mailboxes/${inboxId}/messages`).send({
        //     draft: true,
        //     headers: [{ key: 'List-Id', value: '123' }],
        //     to: [{ address: 'noreply@to.com' }, { address: 'to3@to.com' }],
        //     attachments: [
        //         {
        //             content:
        //                 'zZW1wZXIgcGxhY2VyYXQsIGZhdWNpYnVzIGluIG9kaW8uIERvbmVjIGxhY2luaWEgYXJjdSBhYyB2ZWxpdCBjb25kaW1lbnR1bSBsb2JvcnRpcy4gTWF1cmlzIGVnZXQgZGlnbmlzc2ltIGp1c3RvLiBNYWVjZW5hcyBzZWQgbGVvIHV0IHNlbSBpbXBlcmRpZXQgY29uZGltZW50dW0uIEN1cmFiaXR1ciB2ZW5lbmF0aXMsIG51bGxhIGV1IGNvbmR',
        //             contentType: 'text/plain'
        //         }
        //     ],
        //     subject: 'test message beforee',
        //     text: 'This is a test message with attachment222'
        // });

        // const initialpromises = [];
        // for (let i = 0; i < 1000; i++) {
        //     const data = server.post(`/users/${user}/mailboxes/${inboxId}/messages`).send({
        //         draft: true,
        //         headers: [{ key: 'List-Id', value: `${i}` }],
        //         to: [{ address: 'noreply@to.com' }, { address: 'to3@to.com' }],
        //         subject: `Test message ${i}`,
        //         text: `${i}Test message ${i}`
        //     });

        //     initialpromises.push(data);
        // }

        // await Promise.all(initialpromises);

        // const awaitedinitialpromises = await Promise.all(initialpromises);
        // const promises = [];
        // for (const data of awaitedinitialpromises) {
        //     // promises.push(server.post(`/users/${user}/mailboxes/${inboxId}/messages/${data.body.message.id}/submit`).send({}));
        //     await server.post(`/users/${user}/mailboxes/${inboxId}/messages/${data.body.message.id}/submit`).send({});
        // }

        // await Promise.all(promises);

        // for (const data of awaitedinitialpromises) {
        //     promises.push(server.put(`/users/${user}/mailboxes/${inboxId}/messages`).send({ message: String(data.body.message.id), moveTo: trashId }));
        // }
        // await Promise.all(promises);

        // await server.put(`/users/${user}/mailboxes/${inboxId}/messages`).send({ message: '1:*', moveTo: trashId });

        const messageResponse = await server
            .post(`/users/${user}/mailboxes/${inboxId}/messages`)
            .send({
                draft: true,
                headers: [{ key: 'List-Id', value: '123' }],
                // to: [{ address: 'noreply@to.com' }, { address: 'to2@to.com' }, { address: 'to3@to.com' }],
                to: [{ address: 'noreply@to.com' }],
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
        message = messageResponse.body.message.id;
        // console.log('UPLOADED A MESSAGE', message);

        // const messageGet = await server.get(`/users/${user}/mailboxes/${inboxId}/messages/${message}`).send();
        // console.log(messageGet.body);

        // const messageResponse2 = await server
        //     .post(`/users/${user}/mailboxes/${inboxId}/messages`)
        //     .send({
        //         draft: true,
        //         headers: [{ key: 'List-Id', value: '123' }],
        //         to: [{ address: 'to2@to.com' }],
        //         attachments: [
        //             {
        //                 content:
        //                     'zZW1wZXIgcGxhY2VyYXQsIGZhdWNpYnVzIGluIG9kaW8uIERvbmVjIGxhY2luaWEgYXJjdSBhYyB2ZWxpdCBjb25kaW1lbnR1bSBsb2JvcnRpcy4gTWF1cmlzIGVnZXQgZGlnbmlzc2ltIGp1c3RvLiBNYWVjZW5hcyBzZWQgbGVvIHV0IHNlbSBpbXBlcmRpZXQgY29uZGltZW50dW0uIEN1cmFiaXR1ciB2ZW5lbmF0aXMsIG51bGxhIGV1IGNvbmR',
        //                 contentType: 'text/plain'
        //             }
        //         ],
        //         subject: 'test message',
        //         text: 'This is a test message with attachment'
        //     })
        //     .expect(200);
        // message2 = messageResponse2.body.message.id;
        // console.log('UPLOADED A MESSAGE2', message2);

        // const isDelete = await server.del(`/users/${user}/mailboxes/${inboxId}/messages/${message}`).send();
        // if (isDelete) {
        //     console.log('successful del');

        //     const res3 = await server.post(`/users/${user}/archived/restore`).send({
        //         start: startDate,
        //         end: new Date()
        //     });
        //     console.log(res3);
        // }
    });

    after(async () => {
        // if (!user) {
        //     return;
        // }
        // const response = await server.delete(`/users/${user}`).expect(200);
        // expect(response.body.success).to.be.true;
        // user = false;
        // console.log(mailbox);
    });

    it('should POST /users/:user/mailboxes/:mailbox/messages/:message/submit expect success', async () => {
        const data = await server.post(`/users/${user}/mailboxes/${mailbox}/messages/${message}/submit`).send();

        const body = data.body;
        expect(body.success).to.be.true;
        expect(body.message).to.not.be.empty;
        expect(body.message.id).to.eq(1);
    });

    // const data2 = await server.get(`/users/${user}/mailboxes/${mailbox}/messages/${message}/attachments/ATT00001?sendAsString=true`).send();

    // const data3 = await server.get(`/users/${user}/mailboxes/${data.body.message.mailbox}/messages/${data.body.message.id}/message.eml`).send();
    // const data3 = await server.get(`/users/${user}/mailboxes/${mailbox}/messages/${message}/message.eml`).send();
    // expect(response.body.success).to.be.true;
    // expect(response.body.id).to.be.not.empty;

    it.only('should POST /users/:user/search expect success / pagination pages 1 -> 2 -> 3 -> 2 -> 1', async () => {
        const orderSearch = 'desc';
        const from = 'messagestests'; // Partial match
        const limit = 100;

        const search = await server.get(`/users/${user}/search?order={orderSearch}&mailbox=${mailbox}&from=${from}&limit=${limit}`).send({});

        const search2 = await server
            .get(`/users/${user}/search?next=${search.body.nextCursor}&order=${orderSearch}&mailbox=${mailbox}&from=${from}&limit=${limit}`)
            .send({});

        const search3 = await server
            .get(`/users/${user}/search?next=${search2.body.nextCursor}&order=${orderSearch}&mailbox=${mailbox}&from=${from}&limit=${limit}`)
            .send({});

        const search4 = await server
            .get(`/users/${user}/search?previous=${search3.body.previousCursor}&order=${orderSearch}&mailbox=${mailbox}&from=${from}&limit=${limit}`)
            .send({});

        expect(search4.body.results).to.deep.eq(search2.body.results); // Check if page 2 is equal to original page 2 after moving back from page 3

        const search5 = await server
            .get(`/users/${user}/search?previous=${search4.body.previousCursor}&page=100&order=${orderSearch}&mailbox=${mailbox}&from=${from}&limit=${limit}`)
            .send({}); // page 2 -> page 1
        expect(search5.body.results).to.deep.eq(search.body.results); // Check if page 1 is equal to original page 1 after moving back from page 2
    });

    it('should GET /users/:user/mailboxes/:mailbox/messages expect success / pagination pages 1 -> 2 -> 3 -> 2 -> 1', async () => {
        const order = 'desc';

        const res = await server.get(`/users/${user}/mailboxes/${mailbox}/messages?order=${order}`).send({});

        const res2 = await server.get(`/users/${user}/mailboxes/${mailbox}/messages?next=${res.body.nextCursor}&order=${order}`).send({});

        const res3 = await server.get(`/users/${user}/mailboxes/${mailbox}/messages?next=${res2.body.nextCursor}&order=${order}`).send({});

        const res4 = await server.get(`/users/${user}/mailboxes/${mailbox}/messages?previous=${res3.body.previousCursor}&order=${order}`).send({});

        expect(res4.body.results).to.deep.eq(res2.body.results); // Check if page 2 is equal to original page 2 after moving back from page 3

        const res5 = await server.get(`/users/${user}/mailboxes/${mailbox}/messages?previous=${res4.body.previousCursor}&page=100?order=${order}`).send({}); // page 2 -> page 1
        expect(res5.body.results).to.deep.eq(res.body.results); // Check if page 1 is equal to original page 1 after moving back from page 2
    });
});
