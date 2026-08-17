/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);
const { binaryParser } = require('./_helpers');

describe('Messages extra tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const testTag = Date.now().toString(36);

    const htmlSubject = `Extra html message ${testTag}`;
    const htmlBody = '<p>Extra HTML body</p>';
    const textBody = 'Extra plaintext body';

    const attachmentSubject = `Extra attachment message ${testTag}`;
    const attachmentFilename = 'extra-note.txt';
    const attachmentPayload = `Extra attachment payload ${testTag}: Hello World!`;

    const deleteSubject = `Extra delete message ${testTag}`;

    let user;
    let inbox;

    let htmlMessage; // uid of the html message
    let attachmentMessage; // uid of the message with an attachment
    let deleteMessage; // uid of the message that gets deleted

    let forwardQueueId; // outbound queue id created by the forward test

    before(async () => {
        const username = `messagesextrauser-${testTag}`;

        const userResponse = await server
            .post('/users')
            .send({
                username,
                password: 'secretpassword',
                address: `${username}@web.zone.test`,
                name: 'messages extra user'
            })
            .expect(200);
        expect(userResponse.body.success).to.be.true;
        user = userResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX').id;
        expect(inbox).to.exist;

        // message with both plaintext and html content, stored as unseen
        const htmlResponse = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                unseen: true,
                from: { name: 'Extra Sender', address: 'extra-sender@example.com' },
                to: [{ address: 'extra-recipient@example.com' }],
                subject: htmlSubject,
                text: textBody,
                html: htmlBody
            })
            .expect(200);
        expect(htmlResponse.body.success).to.be.true;
        htmlMessage = htmlResponse.body.message.id;

        // message with an attachment
        const attachmentResponse = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                from: { name: 'Extra Sender', address: 'extra-sender@example.com' },
                to: [{ address: 'extra-recipient@example.com' }],
                subject: attachmentSubject,
                text: 'Message with an attachment',
                attachments: [
                    {
                        filename: attachmentFilename,
                        contentType: 'text/plain',
                        content: Buffer.from(attachmentPayload).toString('base64')
                    }
                ]
            })
            .expect(200);
        expect(attachmentResponse.body.success).to.be.true;
        attachmentMessage = attachmentResponse.body.message.id;

        // message that gets deleted, not a draft, so the delete archives it
        const deleteResponse = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages`)
            .send({
                from: { name: 'Extra Sender', address: 'extra-sender@example.com' },
                to: [{ address: 'extra-recipient@example.com' }],
                subject: deleteSubject,
                text: 'Message that gets deleted'
            })
            .expect(200);
        expect(deleteResponse.body.success).to.be.true;
        deleteMessage = deleteResponse.body.message.id;
    });

    after(async () => {
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message} expect success', async () => {
        const response = await server.get(`/users/${user}/mailboxes/${inbox}/messages/${htmlMessage}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(htmlMessage);
        expect(response.body.mailbox).to.equal(inbox);
        expect(response.body.user).to.equal(user);
        expect(response.body.subject).to.equal(htmlSubject);
        expect(response.body.text).to.equal(textBody);
        expect(response.body.html).to.deep.equal([htmlBody]);
        expect(response.body.from).to.deep.equal({ name: 'Extra Sender', address: 'extra-sender@example.com' });
        expect(response.body.contentType.value).to.equal('multipart/alternative');
        expect(response.body.seen).to.be.false;
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message} expect success / attachment listing', async () => {
        const response = await server.get(`/users/${user}/mailboxes/${inbox}/messages/${attachmentMessage}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.subject).to.equal(attachmentSubject);
        expect(response.body.contentType.value).to.equal('multipart/mixed');
        expect(response.body.attachments).to.have.lengthOf(1);

        const attachment = response.body.attachments[0];
        expect(attachment.id).to.equal('ATT00001');
        expect(attachment.filename).to.equal(attachmentFilename);
        expect(attachment.contentType).to.equal('text/plain');
        expect(attachment.disposition).to.equal('attachment');
        expect(attachment.transferEncoding).to.equal('base64');
        expect(attachment.size).to.be.a('number');
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message} expect failure / unknown uid', async () => {
        const response = await server.get(`/users/${user}/mailboxes/${inbox}/messages/99999`).expect(404);

        expect(response.body.code).to.equal('MessageNotFound');
        expect(response.body.error).to.equal('This message does not exist');
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message} expect failure / malformed uid', async () => {
        const response = await server.get(`/users/${user}/mailboxes/${inbox}/messages/abc`).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/messages/{message} expect success', async () => {
        const response = await server.put(`/users/${user}/mailboxes/${inbox}/messages/${htmlMessage}`).send({ seen: true }).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.updated).to.equal(1);

        const messageData = await server.get(`/users/${user}/mailboxes/${inbox}/messages/${htmlMessage}`).expect(200);
        expect(messageData.body.seen).to.be.true;
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/messages/{message} expect failure / malformed message', async () => {
        const response = await server.put(`/users/${user}/mailboxes/${inbox}/messages/abc`).send({ seen: true }).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message}/attachments/{attachment} expect success', async () => {
        const response = await server
            .get(`/users/${user}/mailboxes/${inbox}/messages/${attachmentMessage}/attachments/ATT00001`)
            .buffer(true)
            .parse(binaryParser)
            .expect(200);

        expect(response.headers['content-type']).to.equal('text/plain');
        expect(response.headers['content-disposition']).to.equal(`attachment; filename=${attachmentFilename}`);
        expect(Buffer.isBuffer(response.body)).to.be.true;
        expect(response.body.toString()).to.equal(attachmentPayload);
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message}/attachments/{attachment} expect failure / unknown attachment', async () => {
        const response = await server.get(`/users/${user}/mailboxes/${inbox}/messages/${attachmentMessage}/attachments/ATT00099`).expect(404);

        expect(response.body.code).to.equal('AttachmentNotFound');
        expect(response.body.error).to.equal('This attachment does not exist');
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message}/message.eml expect success', async () => {
        const response = await server
            .get(`/users/${user}/mailboxes/${inbox}/messages/${attachmentMessage}/message.eml`)
            .buffer(true)
            .parse(binaryParser)
            .expect(200);

        expect(response.headers['content-type']).to.equal('message/rfc822');

        const source = response.body.toString();
        expect(source).to.include(`Subject: ${attachmentSubject}`);
        expect(source).to.include('From: Extra Sender <extra-sender@example.com>');
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/messages/{message}/message.eml expect failure / unknown message', async () => {
        const response = await server.get(`/users/${user}/mailboxes/${inbox}/messages/99999/message.eml`).expect(404);

        expect(response.body.code).to.equal('MessageNotFound');
    });

    it('should POST /users/{user}/mailboxes/{mailbox}/messages/{message}/forward expect success', async () => {
        // the forward is queued into the zone-queue collection, no MTA is running in tests,
        // so only the API response shape is asserted here
        const response = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages/${attachmentMessage}/forward`)
            .send({ addresses: ['extra-forward-target@example.com'] })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.queueId).to.be.a('string');
        expect(response.body.queueId).to.not.be.empty;
        expect(response.body.forwarded).to.deep.equal([
            {
                seq: '001',
                type: 'mail',
                value: 'extra-forward-target@example.com'
            }
        ]);

        forwardQueueId = response.body.queueId;
    });

    it('should POST /users/{user}/mailboxes/{mailbox}/messages/{message}/forward expect failure / unknown message', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes/${inbox}/messages/99999/forward`)
            .send({ addresses: ['extra-forward-target@example.com'] })
            .expect(404);

        expect(response.body.code).to.equal('MessageNotFound');
        expect(response.body.error).to.equal('This message does not exist');
    });

    it('should DELETE /users/{user}/outbound/{queueId} expect success', async () => {
        // uses the queue entry created by the forward test above
        expect(forwardQueueId).to.exist;

        const response = await server.delete(`/users/${user}/outbound/${forwardQueueId}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.queueId).to.equal(forwardQueueId);
        expect(response.body.deleted).to.equal(1);
    });

    it('should DELETE /users/{user}/outbound/{queueId} expect failure / malformed queueId', async () => {
        const response = await server.delete(`/users/${user}/outbound/xyz`).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should DELETE /users/{user}/outbound/{queueId} expect failure / unknown queueId', async () => {
        const response = await server.delete(`/users/${user}/outbound/${'0'.repeat(24)}`).expect(404);

        expect(response.body.code).to.equal('NoSuchQueueEntry');
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox}/messages/{message} expect success', async () => {
        const response = await server.delete(`/users/${user}/mailboxes/${inbox}/messages/${deleteMessage}`).expect(200);

        expect(response.body.success).to.be.true;

        // the message must be gone from the mailbox
        await server.get(`/users/${user}/mailboxes/${inbox}/messages/${deleteMessage}`).expect(404);
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox}/messages/{message} expect failure / unknown uid', async () => {
        const response = await server.delete(`/users/${user}/mailboxes/${inbox}/messages/99999`).expect(404);

        // NB! unlike other 404 responses this one has no "code" property
        expect(response.body.error).to.equal('Message was not found');
    });

    let archivedId;

    it('should GET /users/{user}/archived/messages expect success', async () => {
        // the message deleted above was archived (it was not a draft); archived
        // message ids are ObjectId hex strings, not numeric mailbox uids
        const response = await server.get(`/users/${user}/archived/messages`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results).to.be.an('array');
        expect(response.body.results).to.not.be.empty;
        expect(response.body.results[0].id).to.match(/^[0-9a-f]{24}$/);

        archivedId = response.body.results[0].id;
    });

    it('should POST /users/{user}/archived/messages/{message}/restore expect success', async () => {
        const response = await server.post(`/users/${user}/archived/messages/${archivedId}/restore`).send({}).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.mailbox).to.be.a('string');
        expect(response.body.id).to.be.a('number');

        // the restored message is back in a mailbox
        await server.get(`/users/${user}/mailboxes/${response.body.mailbox}/messages/${response.body.id}`).expect(200);

        // and it is gone from the archive
        const archive = await server.get(`/users/${user}/archived/messages`).expect(200);
        expect(archive.body.results.map(entry => entry.id)).to.not.include(archivedId);
    });

    it('should POST /users/{user}/archived/messages/{message}/restore expect failure / unknown message', async () => {
        const response = await server.post(`/users/${user}/archived/messages/0123456789abcdef01234567/restore`).send({}).expect(404);

        expect(response.body.code).to.equal('MessageNotFound');
    });

    it('should POST /users/{user}/archived/messages/{message}/restore expect failure / malformed id', async () => {
        const response = await server.post(`/users/${user}/archived/messages/zzz/restore`).send({}).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should POST /users/{user}/archived/restore expect success', async () => {
        // schedules a task, the task queue is polled asynchronously by the tasks
        // process so only the API response shape is asserted here
        const response = await server
            .post(`/users/${user}/archived/restore`)
            .send({
                start: '2000-01-01T00:00:00.000Z',
                end: '2100-01-01T00:00:00.000Z'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.task).to.be.a('string');
        expect(response.body.task).to.not.be.empty;
    });

    it('should POST /users/{user}/archived/restore expect failure / malformed date', async () => {
        const response = await server
            .post(`/users/${user}/archived/restore`)
            .send({
                start: 'not-a-date',
                end: '2100-01-01T00:00:00.000Z'
            })
            .expect(400);

        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox}/messages expect success', async () => {
        // the html and the attachment messages are still in INBOX at this point,
        // the restore task above may have added back the archived message as well,
        // so at least 2 messages are deleted
        const response = await server.delete(`/users/${user}/mailboxes/${inbox}/messages`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.deleted).to.be.at.least(2);
        expect(response.body.errors).to.equal(0);
    });
});
