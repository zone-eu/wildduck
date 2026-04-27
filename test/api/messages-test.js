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

    const defaultRecipients = 10000;

    let user;
    let testMailbox;
    let trashId;
    let queryMailbox;
    let queryAltMailbox;
    let queryThread;
    let queryKeywordMessageId;
    let queryExcludedMessageId;
    let queryAttachmentMessageId;
    let queryFlaggedSeenAttachmentMessageId;
    let queryAltMailboxMessageId;
    let testAddress;

    const queryFixture = {
        subjectKeyword: 'Search Query Keyword Phrase',
        subjectExcluded: 'Search Query Excluded Phrase',
        subjectAttachment: 'Search Query Attachment Marker',
        subjectFlaggedSeenAttachment: 'Search Query Flagged Seen Attachment Marker',
        subjectUnseen: 'Search Query Unseen Marker',
        subjectOldDate: 'Search Query Old Date Marker',
        subjectAltMailbox: 'Search Query Alt Mailbox Marker',
        subjectTrash: 'Search Query Trash Marker',
        body: 'searchquerybodytoken',
        attachmentBody: 'searchqueryattachmenttoken',
        multiTerm1: 'searchquerymultiterm1token',
        multiTerm2: 'searchquerymultiterm2token',
        altBody: 'searchqueryaltmailboxtoken',
        unseenBody: 'searchqueryunseentoken',
        oldDateBody: 'searchqueryolddatetoken',
        trashBody: 'searchquerytrashtoken',
        largeBody: 'searchquerylargebodytoken',
        toAddress: 'search.query.to@to.com',
        extraToAddress: 'search.query.extra@to.com',
        ccAddress: 'search.query.cc@to.com',
        otherAddress: 'search.query.other@to.com',
        fromAddress: 'messagestestsuser@web.zone.test',
        altFromAddress: 'search.query.alt-from@web.zone.test'
    };

    const searchQ = async q => {
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.query).to.equal(q);

        return search.body;
    };

    const getSubjects = body => body.results.map(entry => entry.subject);
    const getIds = body => body.results.map(entry => entry.id);

    before(async () => {
        const testUserTag = Date.now().toString(36);
        const testUsername = `messagestestsuser-${testUserTag}`;
        testAddress = `${testUsername}@web.zone.test`;
        queryFixture.fromAddress = testAddress;

        // ensure that we have an existing user account
        const userCreationResponse = await server
            .post('/users')
            .send({
                username: testUsername,
                password: 'secretpassword',
                address: testAddress,
                name: 'messages user',
                recipients: defaultRecipients,
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
        trashId = mailboxesResponse.body.results.find(entry => entry.path === 'Trash').id;

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

        const queryAltMailboxResponse = await server
            .post(`/users/${user}/mailboxes`)
            .send({ path: '/search-query-tests-alt', hidden: false, retention: 10000 })
            .expect(200);
        queryAltMailbox = queryAltMailboxResponse.body.id;

        const keywordMessage = await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                date: new Date('2021-01-02T10:00:00.000Z'),
                draft: true,
                from: { address: queryFixture.fromAddress },
                to: [{ address: queryFixture.toAddress }, { address: queryFixture.ccAddress }],
                cc: [{ address: queryFixture.ccAddress }],
                bcc: [{ address: queryFixture.ccAddress }],
                subject: queryFixture.subjectKeyword,
                text: `${queryFixture.body} keyword marker ${queryFixture.multiTerm1} ${queryFixture.multiTerm2}`
            })
            .expect(200);
        queryKeywordMessageId = keywordMessage.body.message.id;

        const excludedMessage = await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                date: new Date('2021-01-03T10:00:00.000Z'),
                draft: true,
                from: { address: queryFixture.fromAddress },
                to: [{ address: queryFixture.toAddress }],
                subject: queryFixture.subjectExcluded,
                text: `${queryFixture.body} excluded marker`
            })
            .expect(200);
        queryExcludedMessageId = excludedMessage.body.message.id;

        const attachmentMessage = await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                date: new Date('2021-01-04T10:00:00.000Z'),
                draft: true,
                from: { address: queryFixture.fromAddress },
                to: [{ address: queryFixture.toAddress }],
                subject: queryFixture.subjectAttachment,
                text: `attachment marker ${queryFixture.attachmentBody}`,
                attachments: [{ content: 'dGVzdA==', contentType: 'text/plain' }]
            })
            .expect(200);
        queryAttachmentMessageId = attachmentMessage.body.message.id;

        const flaggedSeenAttachmentMessage = await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                date: new Date('2021-01-05T10:00:00.000Z'),
                draft: true,
                from: { address: queryFixture.fromAddress },
                to: [{ address: queryFixture.toAddress }, { address: queryFixture.extraToAddress }],
                cc: [{ address: queryFixture.ccAddress }],
                subject: queryFixture.subjectFlaggedSeenAttachment,
                text: `flagged seen attachment marker ${queryFixture.body} ${queryFixture.multiTerm1} ${queryFixture.multiTerm2} ${queryFixture.largeBody}`.repeat(
                    6
                ),
                attachments: [{ content: 'dGVzdA==', contentType: 'text/plain' }]
            })
            .expect(200);
        queryFlaggedSeenAttachmentMessageId = flaggedSeenAttachmentMessage.body.message.id;

        await server
            .put(`/users/${user}/mailboxes/${queryMailbox}/messages/${flaggedSeenAttachmentMessage.body.message.id}`)
            .send({
                seen: true,
                flagged: true
            })
            .expect(200);

        await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                date: new Date('2021-01-06T10:00:00.000Z'),
                draft: true,
                unseen: true,
                from: { address: queryFixture.altFromAddress },
                to: [{ address: queryFixture.otherAddress }],
                subject: queryFixture.subjectUnseen,
                text: `${queryFixture.unseenBody} ${queryFixture.multiTerm1}`
            })
            .expect(200);

        await server
            .post(`/users/${user}/mailboxes/${queryMailbox}/messages`)
            .send({
                date: new Date('2010-01-01T10:00:00.000Z'),
                draft: true,
                from: { address: queryFixture.altFromAddress },
                to: [{ address: queryFixture.otherAddress }],
                subject: queryFixture.subjectOldDate,
                text: `${queryFixture.oldDateBody} archive marker`
            })
            .expect(200);

        const altMailboxMessage = await server
            .post(`/users/${user}/mailboxes/${queryAltMailbox}/messages`)
            .send({
                date: new Date('2021-01-07T10:00:00.000Z'),
                draft: true,
                from: { address: queryFixture.altFromAddress },
                to: [{ address: queryFixture.otherAddress }],
                subject: queryFixture.subjectAltMailbox,
                text: `${queryFixture.altBody} ${queryFixture.multiTerm2}`
            })
            .expect(200);
        queryAltMailboxMessageId = altMailboxMessage.body.message.id;

        await server
            .post(`/users/${user}/mailboxes/${trashId}/messages`)
            .send({
                date: new Date('2021-01-08T10:00:00.000Z'),
                draft: true,
                from: { address: queryFixture.altFromAddress },
                to: [{ address: queryFixture.otherAddress }],
                subject: queryFixture.subjectTrash,
                text: `${queryFixture.body} ${queryFixture.trashBody}`
            })
            .expect(200);

        const keywordMessageDetails = await server
            .get(`/users/${user}/mailboxes/${queryMailbox}/messages/${keywordMessage.body.message.id}`)
            .send({})
            .expect(200);
        queryThread = keywordMessageDetails.body.thread;
    });

    it('should POST /users/:user/mailboxes/:mailbox/messages/:message/submit expect failure / recipient pre-check counts all recipients', async () => {
        await server.put(`/users/${user}`).send({ recipients: 2 }).expect(200);

        try {
            const messageResponse = await server
                .post(`/users/${user}/mailboxes/${testMailbox}/messages`)
                .send({
                    draft: true,
                    to: [{ address: 'limit1@to.com' }, { address: 'limit2@to.com' }, { address: 'limit3@to.com' }],
                    from: { name: testAddress, address: testAddress },
                    subject: 'recipient limit pre-check',
                    text: 'This message should be rejected before queueing'
                })
                .expect(200);

            const message = messageResponse.body.message.id;

            const submitResponse = await server.post(`/users/${user}/mailboxes/${testMailbox}/messages/${message}/submit`).send({}).expect(403);

            expect(submitResponse.body.code).to.equal('RateLimitedError');
        } finally {
            await server.put(`/users/${user}`).send({ recipients: defaultRecipients }).expect(200);
        }
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
                from: { name: testAddress, address: testAddress },
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
                from: { name: testAddress, address: testAddress },
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

    it('should POST /users/:user/submit expect success / wildcard fromWhitelist must use suffix match', async () => {
        await server
            .put(`/users/${user}`)
            .send({ fromWhitelist: ['*@example.com'] })
            .expect(200);

        let queueId;
        try {
            const submitResponse = await server
                .post(`/users/${user}/submit`)
                .send({
                    from: {
                        name: 'Spoof Attempt',
                        address: 'anyone@example.com.evil.com'
                    },
                    to: [{ address: 'recipient@to.com' }],
                    subject: 'wildcard whitelist suffix check',
                    text: 'This message should be normalized to the account address'
                })
                .expect(200);

            expect(submitResponse.body.success).to.be.true;
            queueId = submitResponse.body.message.queueId;
            expect(queueId).to.exist;

            const messageResponse = await server
                .get(`/users/${user}/mailboxes/${submitResponse.body.message.mailbox}/messages/${submitResponse.body.message.id}`)
                .send({})
                .expect(200);

            expect(messageResponse.body.from.address).to.equal(testAddress);
            expect(messageResponse.body.from.address).to.not.equal('anyone@example.com.evil.com');
        } finally {
            if (queueId) {
                await server.delete(`/users/${user}/outbound/${queueId}`).expect(200);
            }
            await server.put(`/users/${user}`).send({ fromWhitelist: [] }).expect(200);
        }
    });

    it('should POST /users/:user/submit expect success / preserve structured replyTo header', async () => {
        const submitResponse = await server
            .post(`/users/${user}/submit`)
            .send({
                uploadOnly: true,
                from: {
                    name: 'messages user',
                    address: testAddress
                },
                replyTo: {
                    name: 'Reply Handler',
                    address: 'reply-to@test.example'
                },
                to: [{ address: 'recipient@to.com' }],
                subject: 'structured reply-to preservation',
                text: 'This message should keep the Reply-To header'
            })
            .expect(200);

        expect(submitResponse.body.success).to.be.true;

        const messageResponse = await server
            .get(`/users/${user}/mailboxes/${submitResponse.body.message.mailbox}/messages/${submitResponse.body.message.id}`)
            .send({})
            .expect(200);

        expect(messageResponse.body.replyTo).to.deep.equal([
            {
                name: 'Reply Handler',
                address: 'reply-to@test.example'
            }
        ]);
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
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(search.results.map(entry => entry.mailbox)).to.eql([queryMailbox]);
    });

    it('should GET /users/:user/search expect success / q to: matches Cc recipients', async () => {
        const q = `to:${queryFixture.toAddress} in:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
    });

    it('should GET /users/:user/search expect success / q has:attachment matches attachment messages', async () => {
        const q = `has:attachment in:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectAttachment);
        expect(search.results.every(entry => entry.attachments)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q supports fulltext terms', async () => {
        const q = `${queryFixture.body} in:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.include(queryFixture.subjectExcluded);
    });

    it('should GET /users/:user/search expect success / q with two terms and searchable=1', async () => {
        const q = `${queryFixture.multiTerm1} ${queryFixture.multiTerm2} in:${queryMailbox}`;

        const search = await searchQ(q);
        const searchWithSearchable = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&searchable=1&limit=50`)
            .send({})
            .expect(200);

        expect(searchWithSearchable.body.success).to.be.true;
        expect(searchWithSearchable.body.query).to.equal(q);
        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(searchWithSearchable.body.results.map(entry => entry.subject)).to.include(queryFixture.subjectKeyword);
        expect(searchWithSearchable.body.results).to.deep.equal(search.results);
    });

    it('should GET /users/:user/search expect success / q plain text terms default to AND semantics', async () => {
        const q = `${queryFixture.body} ${queryFixture.multiTerm1} in:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(getSubjects(search)).to.not.include(queryFixture.subjectExcluded);
        expect(getSubjects(search)).to.not.include(queryFixture.subjectUnseen);
    });

    it('should GET /users/:user/search expect success / q supports legacy fulltext OR semantics', async () => {
        const q = `${queryFixture.body} ${queryFixture.multiTerm1} in:${queryMailbox}`;
        const search = await server
            .get(`/users/${user}/search?q=${encodeURIComponent(q)}&useAndSearch=false&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.query).to.equal(q);
        expect(getSubjects(search.body)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search.body)).to.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(getSubjects(search.body)).to.include(queryFixture.subjectExcluded);
        expect(getSubjects(search.body)).to.include(queryFixture.subjectUnseen);
    });

    it('should GET /users/:user/search expect success / q combines text and special terms as AND by default', async () => {
        const q = `mailbox:${queryMailbox} subject:Flagged ${queryFixture.multiTerm1} attachments:true flagged:true`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.eql([queryFixture.subjectFlaggedSeenAttachment]);
    });

    it('should GET /users/:user/search expect success / q searchable:true excludes trash mailbox matches', async () => {
        const q = `${queryFixture.body} searchable:true`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.not.include(queryFixture.subjectTrash);
        expect(search.results.every(entry => entry.mailbox !== trashId)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q supports OR groups', async () => {
        const q = `(${queryFixture.body} OR ${queryFixture.attachmentBody}) in:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.include(queryFixture.subjectAttachment);
    });

    it('should GET /users/:user/search expect success / q supports focused OR groups with subject keywords', async () => {
        const q = `(subject:Keyword OR subject:Attachment) in:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.include(queryFixture.subjectAttachment);
    });

    it('should GET /users/:user/search expect success / q supports mixed OR groups with mailbox filters', async () => {
        const q = `(subject:Attachment OR subject:Keyword) mailbox:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectAttachment);
        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(search.results.every(entry => entry.mailbox === queryMailbox)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q supports negated subject filters', async () => {
        const q = `${queryFixture.body} -subject:"${queryFixture.subjectExcluded}" in:${queryMailbox}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.not.include(queryFixture.subjectExcluded);
    });

    it('should GET /users/:user/search expect success / q supports negated to filters and negated attachment filters', async () => {
        const q = `mailbox:${queryMailbox} -to:${queryFixture.extraToAddress} -attachments:true`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.include(queryFixture.subjectExcluded);
        expect(getSubjects(search)).to.include(queryFixture.subjectUnseen);
        expect(getSubjects(search)).to.not.include(queryFixture.subjectAttachment);
        expect(getSubjects(search)).to.not.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(search.results.every(entry => !entry.attachments)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q thread limits results to matching thread', async () => {
        const q = `thread:${queryThread}`;
        const search = await searchQ(q);

        expect(search.results.length).to.be.above(0);
        expect(search.results.every(entry => entry.thread === queryThread)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q mailbox and in both scope results to the expected mailbox', async () => {
        const q = `mailbox:${queryMailbox} in:${queryMailbox} ${queryFixture.body}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(search.results.every(entry => entry.mailbox === queryMailbox)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q id supports exact match and ranges', async () => {
        const exactSearch = await searchQ(`mailbox:${queryMailbox} id:${queryAttachmentMessageId}`);
        const rangeStart = Math.min(queryKeywordMessageId, queryExcludedMessageId);
        const rangeEnd = Math.max(queryKeywordMessageId, queryExcludedMessageId);
        const rangeSearch = await searchQ(`mailbox:${queryMailbox} id:${rangeStart}:${rangeEnd}`);

        expect(getIds(exactSearch)).to.eql([queryAttachmentMessageId]);
        expect(getIds(rangeSearch)).to.include(queryKeywordMessageId);
        expect(getIds(rangeSearch)).to.include(queryExcludedMessageId);
    });

    it('should GET /users/:user/search expect success / q supports date range filters', async () => {
        const q = `mailbox:${queryMailbox} datestart:2021-01-02 dateend:2021-01-06`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(getSubjects(search)).to.not.include(queryFixture.subjectOldDate);
    });

    it('should GET /users/:user/search expect success / q supports minSize and maxSize combinations', async () => {
        const largeSearch = await searchQ(`mailbox:${queryMailbox} minSize:400 subject:Flagged`);
        const smallSearch = await searchQ(`mailbox:${queryMailbox} maxSize:1000 subject:Keyword`);

        expect(getSubjects(largeSearch)).to.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(getSubjects(smallSearch)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(smallSearch)).to.not.include(queryFixture.subjectFlaggedSeenAttachment);
    });

    it('should GET /users/:user/search expect success / q supports attachment and flagged field filters', async () => {
        const q = `mailbox:${queryMailbox} attachments:true flagged:true`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.eql([queryFixture.subjectFlaggedSeenAttachment]);
        expect(search.results.every(entry => entry.attachments && entry.flagged)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q supports seen and unseen field filters', async () => {
        const seenSearch = await searchQ(`mailbox:${queryMailbox} seen:true`);
        const unseenSearch = await searchQ(`mailbox:${queryMailbox} unseen:true`);

        expect(getSubjects(seenSearch)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(seenSearch)).to.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(getSubjects(unseenSearch)).to.include(queryFixture.subjectUnseen);
        expect(getSubjects(unseenSearch)).to.not.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(seenSearch.results.every(entry => entry.seen)).to.be.true;
        expect(unseenSearch.results.every(entry => !entry.seen)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q supports repeated from and to fields with same values', async () => {
        const q = `mailbox:${queryMailbox} from:web.zone.test from:web.zone.test to:${queryFixture.toAddress} to:${queryFixture.toAddress}`;
        const search = await searchQ(q);

        expect(getSubjects(search)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search)).to.include(queryFixture.subjectAttachment);
    });

    it('should GET /users/:user/search expect success / q supports repeated from fields with different values as an AND condition', async () => {
        const q = `mailbox:${queryMailbox} from:${queryFixture.fromAddress} from:${queryFixture.altFromAddress}`;
        const search = await searchQ(q);

        expect(search.results).to.have.length(0);
    });

    it('should GET /users/:user/search expect success / q supports repeated to fields with different values as an AND condition', async () => {
        const q = `mailbox:${queryMailbox} to:${queryFixture.toAddress} to:${queryFixture.otherAddress}`;
        const search = await searchQ(q);

        expect(search.results).to.have.length(0);
    });

    it('should GET /users/:user/search expect success / api search params combine as AND by default', async () => {
        const search = await server.get(`/users/${user}/search?mailbox=${queryMailbox}&attachments=true&flagged=true&limit=50`).send({}).expect(200);

        expect(search.body.success).to.be.true;
        expect(getSubjects(search.body)).to.eql([queryFixture.subjectFlaggedSeenAttachment]);
    });

    it('should GET /users/:user/search expect success / query supports legacy fulltext OR semantics', async () => {
        const search = await server
            .get(`/users/${user}/search?mailbox=${queryMailbox}&query=${queryFixture.body}%20${queryFixture.multiTerm1}&useAndSearch=false&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(getSubjects(search.body)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(search.body)).to.include(queryFixture.subjectFlaggedSeenAttachment);
        expect(getSubjects(search.body)).to.include(queryFixture.subjectExcluded);
        expect(getSubjects(search.body)).to.include(queryFixture.subjectUnseen);
    });

    it('should GET /users/:user/search expect success / api search params return no matches when one AND term does not match', async () => {
        const search = await server
            .get(`/users/${user}/search?mailbox=${queryMailbox}&attachments=true&flagged=true&from=${encodeURIComponent(queryFixture.altFromAddress)}&limit=50`)
            .send({})
            .expect(200);

        expect(search.body.success).to.be.true;
        expect(search.body.results).to.have.length(0);
    });

    it('should GET /users/:user/search expect success / q supports negated mailbox and thread filters', async () => {
        const mailboxSearch = await searchQ(`${queryFixture.body} -mailbox:${trashId}`);
        const threadSearch = await searchQ(`mailbox:${queryMailbox} -thread:${queryThread}`);

        expect(getSubjects(mailboxSearch)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(mailboxSearch)).to.not.include(queryFixture.subjectTrash);
        expect(getSubjects(threadSearch)).to.include(queryFixture.subjectExcluded);
        expect(getSubjects(threadSearch)).to.not.include(queryFixture.subjectKeyword);
    });

    it('should GET /users/:user/search expect success / q supports negated id and date filters', async () => {
        const idSearch = await searchQ(`mailbox:${queryMailbox} -id:${queryKeywordMessageId}`);
        const dateSearch = await searchQ(`mailbox:${queryMailbox} -dateend:2011-01-01`);

        expect(getIds(idSearch)).to.not.include(queryKeywordMessageId);
        expect(getSubjects(dateSearch)).to.include(queryFixture.subjectKeyword);
        expect(getSubjects(dateSearch)).to.not.include(queryFixture.subjectOldDate);
    });

    it('should GET /users/:user/search expect success / q supports all API style mailbox, date, size and flag filters together', async () => {
        const q = `mailbox:${queryMailbox} datestart:2000-01-01 minSize:10 maxSize:1000000 attachments:true flagged:true seen:true`;
        const search = await searchQ(q);

        expect(getIds(search)).to.eql([queryFlaggedSeenAttachmentMessageId]);
        expect(search.results.every(entry => entry.mailbox === queryMailbox)).to.be.true;
        expect(search.results.every(entry => entry.attachments)).to.be.true;
        expect(search.results.every(entry => entry.flagged)).to.be.true;
        expect(search.results.every(entry => entry.seen)).to.be.true;
    });

    it('should GET /users/:user/search expect success / q supports alternate mailbox results', async () => {
        const q = `mailbox:${queryAltMailbox} ${queryFixture.altBody}`;
        const search = await searchQ(q);

        expect(getIds(search)).to.eql([queryAltMailboxMessageId]);
        expect(getSubjects(search)).to.eql([queryFixture.subjectAltMailbox]);
    });

    it('should GET /users/:user/search expect success / q supports long queries with multiple terms and repeated fields', async () => {
        const q = [
            `mailbox:${queryMailbox}`,
            'from:web.zone.test',
            `to:${queryFixture.toAddress}`,
            'subject:Flagged',
            `${queryFixture.body}`,
            `${queryFixture.multiTerm1}`,
            `${queryFixture.multiTerm2}`,
            'attachments:true',
            'flagged:true',
            'seen:true'
        ].join(' ');

        expect(q.length).to.be.at.most(255);

        const search = await searchQ(q);

        expect(getIds(search)).to.eql([queryFlaggedSeenAttachmentMessageId]);
    });

    it('should GET /users/:user/search expect success / q ignores invalid mailbox, thread and id values', async () => {
        const baseline = await searchQ(`mailbox:${queryMailbox} ${queryFixture.body}`);
        const invalidMailbox = await searchQ(`mailbox:${queryMailbox} mailbox:notanobjectid ${queryFixture.body}`);
        const invalidThread = await searchQ(`mailbox:${queryMailbox} thread:notanobjectid ${queryFixture.body}`);
        const invalidId = await searchQ(`mailbox:${queryMailbox} id:not-a-range ${queryFixture.body}`);

        expect(getIds(invalidMailbox)).to.deep.equal(getIds(baseline));
        expect(getIds(invalidThread)).to.deep.equal(getIds(baseline));
        expect(getIds(invalidId)).to.deep.equal(getIds(baseline));
    });

    it('should GET /users/:user/search expect success / q ignores invalid date and size values', async () => {
        const baseline = await searchQ(`mailbox:${queryMailbox} ${queryFixture.body}`);
        const invalidDateStart = await searchQ(`mailbox:${queryMailbox} datestart:not-a-date ${queryFixture.body}`);
        const invalidDateEnd = await searchQ(`mailbox:${queryMailbox} dateend:not-a-date ${queryFixture.body}`);
        const invalidMinSize = await searchQ(`mailbox:${queryMailbox} minSize:not-a-number ${queryFixture.body}`);
        const invalidMaxSize = await searchQ(`mailbox:${queryMailbox} maxSize:not-a-number ${queryFixture.body}`);

        expect(getIds(invalidDateStart)).to.deep.equal(getIds(baseline));
        expect(getIds(invalidDateEnd)).to.deep.equal(getIds(baseline));
        expect(getIds(invalidMinSize)).to.deep.equal(getIds(baseline));
        expect(getIds(invalidMaxSize)).to.deep.equal(getIds(baseline));
    });

    it('should GET /users/:user/search expect success / q ignores unsupported keywords and unknown has values', async () => {
        const baseline = await searchQ(`mailbox:${queryMailbox} ${queryFixture.body}`);
        const unsupportedKeyword = await searchQ(`mailbox:${queryMailbox} nosuchfield:value ${queryFixture.body}`);
        const unsupportedHas = await searchQ(`mailbox:${queryMailbox} has:calendar ${queryFixture.body}`);

        expect(getIds(unsupportedKeyword)).to.deep.equal(getIds(baseline));
        expect(getIds(unsupportedHas)).to.deep.equal(getIds(baseline));
    });

    it('should GET /users/:user/search expect success / q false-like boolean field values fall back to the default search', async () => {
        const baseline = await searchQ(`mailbox:${queryMailbox} ${queryFixture.body}`);
        const attachmentsFalse = await searchQ(`mailbox:${queryMailbox} attachments:false ${queryFixture.body}`);
        const flaggedFalse = await searchQ(`mailbox:${queryMailbox} flagged:false ${queryFixture.body}`);
        const seenFalse = await searchQ(`mailbox:${queryMailbox} seen:false ${queryFixture.body}`);
        const unseenFalse = await searchQ(`mailbox:${queryMailbox} unseen:false ${queryFixture.body}`);
        const searchableFalse = await searchQ(`mailbox:${queryMailbox} searchable:false ${queryFixture.body}`);

        expect(getIds(attachmentsFalse)).to.deep.equal(getIds(baseline));
        expect(getIds(flaggedFalse)).to.deep.equal(getIds(baseline));
        expect(getIds(seenFalse)).to.deep.equal(getIds(baseline));
        expect(getIds(unseenFalse)).to.deep.equal(getIds(baseline));
        expect(getIds(searchableFalse)).to.deep.equal(getIds(baseline));
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

    it('should DELETE /users/:user/mailboxes/:mailbox/messages expect failure / reject mailbox from another user', async () => {
        const otherUserResponse = await server
            .post('/users')
            .send({
                username: 'messagesotherusertests',
                password: 'secretpassword',
                address: 'messagesotherusertests@web.zone.test',
                name: 'other messages user'
            })
            .expect(200);

        const otherUser = otherUserResponse.body.id;

        const otherMailboxResponse = await server
            .post(`/users/${otherUser}/mailboxes`)
            .send({ path: '/other-test-mailbox', hidden: false, retention: 10000 })
            .expect(200);

        const otherMailbox = otherMailboxResponse.body.id;

        const response = await server.delete(`/users/${user}/mailboxes/${otherMailbox}/messages`).send({}).expect(404);

        expect(response.body.code).to.equal('NoSuchMailbox');
    });
});
