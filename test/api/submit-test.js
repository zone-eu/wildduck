/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// Direct message submission (POST /users/:user/submit): reply and forward
// references, draft replacement, rate limits and storage options
describe('API Submit', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const testTag = Date.now().toString(36);
    const testUsername = `submituser-${testTag}`;
    const testAddress = `${testUsername}@web.zone.test`;

    // valid ObjectId that should not match any user
    const unknownUserId = crypto.randomBytes(12).toString('hex');

    // PGP key for the encrypted storage test
    const pubKey = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'wildduck-test-public.key'), 'utf8');

    let user;
    let inbox;
    let sent;
    let drafts;

    // uid of the message replies and forwards reference
    let originalMessage;
    let originalMessageId;

    const queuedMessages = [];

    const getMessage = async (mailbox, uid) => {
        const response = await server.get(`/users/${user}/mailboxes/${mailbox}/messages/${uid}`).expect(200);
        return response.body;
    };

    const addresses = list => (list || []).map(entry => entry.address);

    before(async () => {
        const userResponse = await server
            .post('/users')
            .send({
                username: testUsername,
                password: 'secretpassword',
                address: testAddress,
                name: 'submit user',
                recipients: 100,
                pubKey,
                encryptMessages: false
            })
            .expect(200);
        expect(userResponse.body.success).to.be.true;
        user = userResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX').id;
        sent = mailboxesResponse.body.results.find(entry => entry.specialUse === '\\Sent').id;
        drafts = mailboxesResponse.body.results.find(entry => entry.specialUse === '\\Drafts').id;
        expect(inbox).to.exist;
        expect(sent).to.exist;
        expect(drafts).to.exist;

        // the message replies and forwards are based on
        const originalResponse = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                from: { name: 'Original Sender', address: 'original-sender@example.com' },
                to: [{ address: testAddress }, { name: 'Second', address: 'second@example.com' }],
                cc: [{ address: 'third@example.com' }],
                subject: `Original subject ${testTag}`,
                text: 'Original body'
            })
            .expect(200);
        expect(originalResponse.body.success).to.be.true;
        originalMessage = originalResponse.body.message.id;

        const originalData = await getMessage(inbox, originalMessage);
        originalMessageId = originalData.messageId;
        expect(originalMessageId).to.be.a('string');
    });

    after(async () => {
        for (const queueId of queuedMessages) {
            await server.delete(`/users/${user}/outbound/${queueId}`);
        }

        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('should POST /users/{user}/submit expect failure / unknown user', async () => {
        const response = await server
            .post(`/users/${unknownUserId}/submit`)
            .send({
                to: [{ address: 'recipient@example.com' }],
                subject: 'unknown user',
                text: 'This user does not exist'
            })
            .expect(404);

        expect(response.body.code).to.equal('UserNotFound');
    });

    it('should POST /users/{user}/submit expect failure / disabled user', async () => {
        await server.put(`/users/${user}`).send({ disabled: true }).expect(200);

        try {
            const response = await server
                .post(`/users/${user}/submit`)
                .send({
                    to: [{ address: 'recipient@example.com' }],
                    subject: 'disabled user',
                    text: 'This user is disabled'
                })
                .expect(403);

            expect(response.body.code).to.equal('UserDisabled');
        } finally {
            await server.put(`/users/${user}`).send({ disabled: false }).expect(200);
        }
    });

    it('should POST /users/{user}/submit expect success / reply resolves recipients and threading from the reference', async () => {
        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                reference: { mailbox: inbox, id: originalMessage, action: 'reply' },
                from: { address: testAddress },
                text: 'Reply body'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.message.mailbox).to.equal(sent);
        expect(response.body.message.queueId).to.be.a('string');
        queuedMessages.push(response.body.message.queueId);

        const replyData = await getMessage(sent, response.body.message.id);
        expect(replyData.subject).to.equal(`Re: Original subject ${testTag}`);
        // a plain reply goes to the sender only
        expect(addresses(replyData.to)).to.deep.equal(['original-sender@example.com']);
        expect(addresses(replyData.cc)).to.deep.equal([]);
        expect(replyData.references).to.include(originalMessageId);

        const originalData = await getMessage(inbox, originalMessage);
        expect(originalData.answered).to.be.true;
        expect(originalData.forwarded).to.be.false;
    });

    it('should POST /users/{user}/submit expect success / replyAll keeps every recipient except the own address', async () => {
        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                reference: { mailbox: inbox, id: originalMessage, action: 'replyAll' },
                from: { address: testAddress },
                text: 'Reply all body'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        queuedMessages.push(response.body.message.queueId);

        const replyData = await getMessage(sent, response.body.message.id);
        expect(addresses(replyData.to)).to.deep.equal(['original-sender@example.com', 'second@example.com']);
        expect(addresses(replyData.cc)).to.deep.equal(['third@example.com']);
    });

    it('should POST /users/{user}/submit expect success / forward flags the referenced message', async () => {
        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                reference: { mailbox: inbox, id: originalMessage, action: 'forward' },
                from: { address: testAddress },
                to: [{ address: 'forward-target@example.com' }],
                text: 'Forwarded body'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        queuedMessages.push(response.body.message.queueId);

        const forwardData = await getMessage(sent, response.body.message.id);
        expect(forwardData.subject).to.equal(`Fwd: Original subject ${testTag}`);
        expect(addresses(forwardData.to)).to.deep.equal(['forward-target@example.com']);

        const originalData = await getMessage(inbox, originalMessage);
        expect(originalData.forwarded).to.be.true;
    });

    it('should POST /users/{user}/mailboxes/{mailbox}/messages/{message}/submit expect success / submitting a draft reply flags the referenced message', async () => {
        // a fresh original message, the shared one already carries both flags
        const originalResponse = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                from: { address: 'draft-original@example.com' },
                to: [{ address: testAddress }],
                subject: `Draft original ${testTag}`,
                text: 'Original body'
            })
            .expect(200);
        const original = originalResponse.body.message.id;

        const draftResponse = await server
            .post(`/users/${user}/mailboxes/${drafts}/messages`)
            .send({
                draft: true,
                reference: { mailbox: inbox, id: original, action: 'reply' },
                from: { address: testAddress },
                to: [{ address: 'draft-original@example.com' }],
                text: 'Draft reply body'
            })
            .expect(200);
        const draft = draftResponse.body.message.id;

        const submitResponse = await server.post(`/users/${user}/mailboxes/${drafts}/messages/${draft}/submit`).send({}).expect(200);
        expect(submitResponse.body.success).to.be.true;
        expect(submitResponse.body.queueId).to.be.a('string');
        queuedMessages.push(submitResponse.body.queueId);

        const originalData = await getMessage(inbox, original);
        expect(originalData.answered).to.be.true;
    });

    it('should POST /users/{user}/submit expect success / unknown reference is ignored', async () => {
        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                uploadOnly: true,
                reference: { mailbox: inbox, id: 999999, action: 'reply' },
                from: { address: testAddress },
                to: [{ address: 'recipient@example.com' }],
                subject: 'No such reference',
                text: 'The reference does not exist'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.message.queueId).to.be.false;

        const messageData = await getMessage(sent, response.body.message.id);
        expect(messageData.subject).to.equal('No such reference');
        expect(messageData.references).to.deep.equal([]);
    });

    it('should POST /users/{user}/submit expect success / replaces the draft the message was based on', async () => {
        const draftResponse = await server
            .post(`/users/${user}/submit`)
            .send({
                isDraft: true,
                from: { address: testAddress },
                to: [{ address: 'draft-recipient@example.com' }],
                subject: 'Draft to replace',
                text: 'Draft body'
            })
            .expect(200);

        expect(draftResponse.body.success).to.be.true;
        expect(draftResponse.body.message.mailbox).to.equal(drafts);
        expect(draftResponse.body.message.queueId).to.be.false;

        const draftData = await getMessage(drafts, draftResponse.body.message.id);
        expect(draftData.draft).to.be.true;

        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                uploadOnly: true,
                draft: { mailbox: drafts, id: draftResponse.body.message.id },
                from: { address: testAddress },
                to: [{ address: 'draft-recipient@example.com' }],
                subject: 'Draft to replace',
                text: 'Final body'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.message.mailbox).to.equal(sent);

        // the draft is gone, the final message is in Sent
        await server.get(`/users/${user}/mailboxes/${drafts}/messages/${draftResponse.body.message.id}`).expect(404);
        const finalData = await getMessage(sent, response.body.message.id);
        expect(finalData.text).to.equal('Final body');
        expect(finalData.draft).to.be.false;
    });

    it('should POST /users/{user}/submit expect success / stores to the requested mailbox with custom metadata', async () => {
        const sendTime = new Date(Date.now() + 24 * 3600 * 1000);
        sendTime.setMilliseconds(0);

        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                uploadOnly: true,
                mailbox: inbox,
                sendTime: sendTime.toISOString(),
                meta: { custom: { campaign: testTag } },
                from: { address: testAddress },
                to: [{ address: 'recipient@example.com' }],
                subject: 'Custom mailbox',
                text: 'Stored in INBOX'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.message.mailbox).to.equal(inbox);
        expect(response.body.message.queueId).to.be.false;

        const messageData = await getMessage(inbox, response.body.message.id);
        expect(messageData.metaData).to.deep.equal({ campaign: testTag });
        expect(new Date(messageData.date).getTime()).to.equal(sendTime.getTime());
    });

    it('should POST /users/{user}/submit expect success / html only message gets a plaintext alternative', async () => {
        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                uploadOnly: true,
                from: { address: testAddress },
                to: [{ address: 'recipient@example.com' }],
                subject: 'HTML only',
                html: '<p>Hello <b>world</b></p>'
            })
            .expect(200);

        expect(response.body.success).to.be.true;

        const messageData = await getMessage(sent, response.body.message.id);
        expect(messageData.html).to.deep.equal(['<p>Hello <b>world</b></p>']);
        expect(messageData.text).to.include('Hello');
        expect(messageData.text).to.include('world');
    });

    it('should POST /users/{user}/submit expect success / encrypted account stores an encrypted copy', async () => {
        await server.put(`/users/${user}`).send({ encryptMessages: true }).expect(200);

        try {
            const response = await server
                .post(`/users/${user}/submit`)
                .send({
                    uploadOnly: true,
                    from: { address: testAddress },
                    to: [{ address: 'recipient@example.com' }],
                    subject: 'Encrypted copy',
                    text: 'This copy is encrypted at rest'
                })
                .expect(200);

            expect(response.body.success).to.be.true;

            const messageData = await getMessage(sent, response.body.message.id);
            expect(messageData.encrypted).to.be.true;
            expect(messageData.contentType.value).to.equal('multipart/encrypted');
        } finally {
            await server.put(`/users/${user}`).send({ encryptMessages: false }).expect(200);
        }
    });

    it('should POST /users/{user}/submit expect failure / daily recipient limit', async () => {
        await server.put(`/users/${user}`).send({ recipients: 1 }).expect(200);

        try {
            const response = await server
                .post(`/users/${user}/submit`)
                .send({
                    from: { address: testAddress },
                    to: [{ address: 'limit1@example.com' }, { address: 'limit2@example.com' }],
                    subject: 'Over the daily limit',
                    text: 'This message must not be queued'
                })
                .expect(403);

            expect(response.body.code).to.equal('RateLimitedError');
        } finally {
            await server.put(`/users/${user}`).send({ recipients: 100 }).expect(200);
        }
    });

    it('should POST /users/{user}/submit expect failure / malformed reference', async () => {
        const response = await server
            .post(`/users/${user}/submit`)
            .send({
                reference: { mailbox: 'not-a-mailbox', id: originalMessage, action: 'reply' },
                from: { address: testAddress },
                text: 'Malformed reference'
            })
            .expect(400);

        expect(response.body.code).to.equal('InputValidationError');
    });
});
