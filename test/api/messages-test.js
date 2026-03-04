/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Messages tests', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    let user;
    let testMailbox;
    let trashId;
    let queryMailbox;
    let queryThread;

    const queryFixture = {
        subjectKeyword: 'Search Query Keyword Phrase',
        subjectExcluded: 'Search Query Excluded Phrase',
        subjectAttachment: 'Search Query Attachment Marker',
        body: 'searchquerybodytoken',
        attachmentBody: 'searchqueryattachmenttoken',
        multiTerm1: 'searchquerymultiterm1token',
        multiTerm2: 'searchquerymultiterm2token',
        toAddress: 'search.query.to@to.com',
        ccAddress: 'search.query.cc@to.com',
        fromAddress: 'messagestestsuser@web.zone.test'
    };

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
                pubKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nxsBNBGmoM3UBCAC19FO8c9Wfgsr6hJll/JbM3q+bDQ/Bb+t9kLxHdfae6bRZ\nfAm0wgpI0yYNrI2OlAbq7Ax6T7y9ULzDl4KC0eVJUEfhwQAaxXUbdOhhZ/5G\n66c8JcBYouJcQLu1RZ9KV7/HcJ28vH0tEYw8/wB81l8RHMwsR1wFt0oz1qnI\nQo76f87EHv751MveG5Dt+s7GEJ569YIZQZYjE5ssBPJoZT7MzhxBj7tKyvv+\nOYC4DVy9lBn9yUE0fRc5HcxfrF98oJp9A9E67heUU9XBav9oryUOvMeRcm8Z\nyG6RvVG9vcvyOOC+xB5rtJWUxcKQJY5ehr5+gUBZy/aZ8afL3kNorUF5ABEB\nAAHNH1dpbGQgRHVjayA8dGVzdEB3aWxkZHVjay5lbWFpbD7CwIoEEAEIAD4F\ngmmoM3UECwkHCAmQJjX094XgEEUDFQgKBBYAAgECGQECmwMCHgEWIQTSj6BP\nf7Fss07AItAmNfT3heAQRQAABUIH/jw29K6Ed1eS9f9YcSQvrqMrwE2dE9O6\nGXYfXeEK3BTpTpYuz9/X1SNP9pIFrIbHCTsyv/oMfoIhjf4vz1DTzxfmvWQe\nLk+jwkT2oRMH9D6MBHNH35YkWCgSxbSoehLr9e4vAC1ePW6tPAOTr5yuJHql\njn+hMJ3ZLYkNcQjUqkhmvT+uUrsQkVeUBjHzrc7LomfPxgMnaRO6MGtw1iDq\n00lIq5weF4yO8zK796hWk1QXtzddX4QpEIwpKrGkyqlz66cQDBU/DJEanTuV\nxDiyma+uhrN2rOOxy8cuMJICwSWgXndEmToVpAyB5Fu2YmtPsUqXACFB+l7U\nWghE5tOgQAjOwE0EaagzdQEIAIqGzI69Sx+cWbAbwEf4x9J9H4T+Z5K6e/I1\nmNXMA5lTnXus81j7SMqFS7rF+RXnSC9QLyuctkqv0bCr/Uhzb2Dy6BF5SY09\njNwTg8snB5xLbWoG11o1UsVGyZ3invdRaym6qcdGEPpFwzy4CZDF8oAbaOfd\nBQTblTmxb9EyX0fYmONSrHfEPh8MY3mXr9Mg1aA3c2l4jXEPKA7gjbxt26hj\n4h0aCN5i9lXftMIfXeYATOeljyBESTO85CDFbLsylleB/5OtVjzOhukld5qM\nB13RdlKH93W6PYIPE8q3K6Kn1DanpqQhQljxwbmVDUrCvcpBnAbYFtpvFBV9\nLJAjeWUAEQEAAcLAdgQYAQgAKgWCaagzdQmQJjX094XgEEUCmwwWIQTSj6BP\nf7Fss07AItAmNfT3heAQRQAAoWgIAK/WgMe56uCRqJiOIX6XabAX3UyY/B0l\nBroO+sLATXsBpcuv4iRPIumHQaeeXVDK93+vRCnQi7ooOn1K1jE1+gwOJubt\nwN8mDWWzhe/CQh81eFYhD97A8qJbg79zUebmnS920yHRWsZs5hwSTS0zA3RL\nV6kDVw7py7ROYyQ66nTk45qgaYEDwyiGWuj+tlfHOKU71ZtMhWg+0rJjfn+c\nU8z+hIiZ5EtfHL8sSKX84YWX3rKXwl0vnpbUtADSwV3F9+foFuWHT3hSRhy5\ngPCEtZJSz1o6F2mqGab3n3qAw2+Ksp1RW3QJsy6kkOSQGmAdyMBlN1l8L5ct\nqidN19okZ6s=\n=XkH6\n-----END PGP PUBLIC KEY BLOCK-----',
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

        const queryMailboxResponse = await server
            .post(`/users/${user}/mailboxes`)
            .send({ path: '/search-query-tests', hidden: false, retention: 10000 })
            .expect(200);
        queryMailbox = queryMailboxResponse.body.id;

        const keywordMessage = await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                draft: true,
                from: { address: queryFixture.fromAddress },
                to: [{ address: queryFixture.toAddress }, { address: queryFixture.ccAddress }],
                cc: [{ address: queryFixture.ccAddress }],
                bcc: [{ address: queryFixture.ccAddress }],
                subject: queryFixture.subjectKeyword,
                text: `${queryFixture.body} keyword marker ${queryFixture.multiTerm1} ${queryFixture.multiTerm2}`
            })
            .expect(200);

        await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                draft: true,
                from: { address: queryFixture.fromAddress },
                to: [{ address: queryFixture.toAddress }],
                subject: queryFixture.subjectExcluded,
                text: `${queryFixture.body} excluded marker`
            })
            .expect(200);

        await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                draft: true,
                from: { address: queryFixture.fromAddress },
                to: [{ address: queryFixture.toAddress }],
                subject: queryFixture.subjectAttachment,
                text: `attachment marker ${queryFixture.attachmentBody}`,
                attachments: [{ content: 'dGVzdA==', contentType: 'text/plain' }]
            })
            .expect(200);

        const keywordMessageDetails = await server
            .get(`/users/${user}/mailboxes/${queryMailbox}/messages/${keywordMessage.body.message.id}`)
            .send({})
            .expect(200);
        queryThread = keywordMessageDetails.body.thread;
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

    it('should GET /users/:user/search expect success / q supports subject and in keywords', async () => {
        const q = `subject:"${queryFixture.subjectKeyword}" in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.query).to.equal(q);
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(search.body.results.map(entry => entry.mailbox)).to.eql([queryMailbox]);
    });

    it('should GET /users/:user/search expect success / q to: matches Cc recipients', async () => {
        const q = `to:${queryFixture.toAddress} in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
    });

    it('should GET /users/:user/search expect success / q has:attachment matches attachment messages', async () => {
        const q = `has:attachment in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectAttachment);
        expect(search.body.results.every(entry => entry.attachments)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q supports fulltext terms', async () => {
        const q = `${queryFixture.body} in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectExcluded);
    });

    it('should GET /users/:user/search expect success / q with two terms and searchable=1', async () => {
        const q = `${queryFixture.multiTerm1} ${queryFixture.multiTerm2} in:${queryMailbox}`;

        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        const searchWithSearchable = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&searchable=1&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(searchWithSearchable.body.success).to.be.true;
        expect(searchWithSearchable.body.query).to.equal(q);
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(searchWithSearchable.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(searchWithSearchable.body.results).to.deep.equal(search.body.results);
    });

    it('should GET /users/:user/search expect success / q supports OR groups', async () => {
        const q = `(${queryFixture.body} OR ${queryFixture.attachmentBody}) in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectAttachment);
    });

    it('should GET /users/:user/search expect success / q supports focused OR groups with subject keywords', async () => {
        const q = `(subject:Keyword OR subject:Attachment) in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectAttachment);
    });

    it('should GET /users/:user/search expect success / q supports negated subject filters', async () => {
        const q = `from:${queryFixture.fromAddress} -subject:"${queryFixture.subjectExcluded}" in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(search.body.results.map(entry => entry.subject)).to.not.include(queryFixture.subjectExcluded);
    });

    it('should GET /users/:user/search expect success / q thread limits results to matching thread', async () => {
        const q = `thread:${queryThread}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results.length).to.be.above(0);
        expect(search.body.results.every(entry => entry.thread === queryThread)).to.be.true;
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
