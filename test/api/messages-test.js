/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Messages tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let testMailbox;
    let trashId;

    before(async () => {
        // ensure that we have an existing user account
        const userCreationResponse = await server
            .post('/users')
            .send({
                username: 'messagestestsuser',
                password: 'secretpassword',
                address: 'messagestestsuser@web.zone.test',
                name: 'messages user',
                recipients: 10000,
                pubKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: Keybase OpenPGP v1.0.0\nComment: https://keybase.io/crypto\n\nxo0EYb0PqAEEANJtI/ivwudfCMmxm+a77Fll5YwSzaaI2nqhcp6pMRJ4l0aafsX3\nBcXUQpsyyELelt2xFtwTNygR4RFWVTn4OoXmO5zFtWCSegAwSyUNK7R/GXi2GTKk\nkYtxUwGcNKBkfY7yAn5KsaeuZL1feDXUGt0YHUmBds5i+6ylI+i4tNbRABEBAAHN\nH1dpbGQgRHVjayA8dGVzdEB3aWxkZHVjay5lbWFpbD7CrQQTAQoAFwUCYb0PqAIb\nLwMLCQcDFQoIAh4BAheAAAoJEJVLs8wf5gSCzBoD/3gz32OfJM1D4IrmKVwyLKxC\n1P81kL7E6ICWD2A0JF9EkojsMHl+/zagwoJejBQhmzTNkFmui5zwmdLGforKl303\ntB0l9vCTb5+eDDHOTUatJrvlw76Fz2ZjIhQTqD4xEM7MWx4xwTGY8bC5roIpdZJD\n9+vr81MXxiq9LZJDBXIyzo0EYb0PqAEEAL/uCTOrAncTRC/3cOQz+kLIzF4A9OTe\n6yxdNWWmx+uo9yJxnBv59Xz9qt8OT8Ih7SD/A4kFCuQqlyd0OFVhyd3KTAQ3CEml\nYOgL5jOE11YrEQjr36xPqO646JZuZIorKDf9PoIyipAMG89BlAoAjSXB1oeQADYn\n5fFLFVm1S7pLABEBAAHCwIMEGAEKAA8FAmG9D6gFCQ8JnAACGy4AqAkQlUuzzB/m\nBIKdIAQZAQoABgUCYb0PqAAKCRBhR/oKY9pg/YqnA/0Szmy4q4TnTBby+j57oXtn\nX/7H/xiaqlCd6bA3lbj3cPK4ybn/gnI4ECsfZfmSFG3T5C9EcZU0e9ByzimH6sxi\nOwPgKFWeJzpl5o8toR7m4wQVhv2NZRUukHe+2JH7nITS0gKeIBHMq2TbufcH6do1\n8s2G7XyLSd5Kkljxx7YmNiKoA/9CQ4l2WkARAFByyEJT9BEE4NBO0m0bI8sg0HRK\nGuP3FKcUu0Pz9R8AExEecofh8s4kaxofa2sbrTcK+L0p0hdR/39JWNuTJbxwEU3C\nA0mZKthjzL7seiRTG7Eny5gGenejRp2x0ziyMEaTgkvf44LPi06XiuE6FGnhElOc\nC7JoIc6NBGG9D6gBBADzW30GOysnqYkexL+bY9o+ai1mL+X58GPLilXJ5WXgEEdf\n8Pg/9jlEOzOnWTTgJAQDGHtwm0duKmK7EJGozLEY94QGOzRjAir6tMF2OYDQIDgj\nAoXavPAc5chFABEVUS12hUPPLoW6YgvaIb3AAZbIM8603BLXTaLGbtZ0z7eYxwAR\nAQABwsCDBBgBCgAPBQJhvQ+oBQkPCZwAAhsuAKgJEJVLs8wf5gSCnSAEGQEKAAYF\nAmG9D6gACgkQ58zrS0TNGbAiVAP/UIxYiSdoHDnBW5qB7onEiUVL5ZFk1Xk+NB0z\n7jOm1oAV0RH8I5NRQBtZ+75xar0vPTX122IdkgpaiNT0wy5Kd/2vz4LKVK9apyJI\neaZ+D7dt5Ipu1p0lWtglqL0xtjOSWuwHFwHuiRYg6eyhGN1RylFpuiKi5KykhrBS\nuBL/BHrk6AP/boRA+KIlb6s19KHNt54Kl8n8G4ZApCwZbUc2jzvbP5DZL5rcjlHd\ns4i4XE+uIJxsiX3iJZtVXzhTKuQlaoEljlhPs/TZYUmxeJ3TdV4o7emWiZ4gE8EQ\nhfxV37ew/GoYm6yME3tAZLIXbv2+bj6HZ4eE8bAMmPvpcQ+UwNJXvnk=\n=dR+x\n-----END PGP PUBLIC KEY BLOCK-----',
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

    it('should POST /users/:user/mailboxes/:mailbox/messages/:message/submit expect success / encrypted mailbox', async () => {
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
