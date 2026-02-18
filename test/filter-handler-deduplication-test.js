/*eslint no-unused-expressions: 0 */
/* globals before: false, after: false */

'use strict';

const crypto = require('crypto');
const supertest = require('supertest');
const chai = require('chai');
const nodemailer = require('nodemailer');
const config = require('@zone-eu/wild-config');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const lmtpTransport = nodemailer.createTransport({
    lmtp: true,
    host: '127.0.0.1',
    port: 2424,
    logger: false,
    debug: false,
    tls: {
        rejectUnauthorized: false
    }
});

describe('Filter Handler Inbound message deduplication', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    let user;
    let inbox;
    let recipientAddress;

    const randomPart = `${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
    const duplicateMessageId = `<dedupe-${randomPart}@example.com>`;

    const buildRawMessage = (dateHeader, extraHeaders = []) =>
        Buffer.from(
            []
                .concat(extraHeaders)
                .concat([
                    'From: Alice Example <alice@example.com>',
                    `To: Recipient <${recipientAddress}>`,
                    `Date: ${dateHeader}`,
                    `Message-ID: ${duplicateMessageId}`,
                    'Subject: Deduplication test message',
                    'MIME-Version: 1.0',
                    'Content-Type: text/plain; charset=UTF-8',
                    'Content-Transfer-Encoding: 7bit',
                    '',
                    'Hello from dedupe test.',
                    ''
                ])
                .join('\r\n'),
            'utf-8'
        );

    const sendRaw = async (raw, envelopeFrom = 'alice@example.com') => {
        const info = await lmtpTransport.sendMail({
            envelope: {
                from: envelopeFrom,
                to: [recipientAddress]
            },
            raw
        });

        expect(info.accepted).to.include(recipientAddress);
    };

    const listInboxMessages = async () => {
        const response = await server.get(`/users/${user}/mailboxes/${inbox}/messages`).expect(200);
        expect(response.body.success).to.be.true;
        return response.body.results || [];
    };

    before(async () => {
        recipientAddress = `dedupe-${randomPart}@example.com`;

        const createUserResponse = await server
            .post('/users')
            .send({
                username: `dedupe${randomPart}`,
                password: 'secretpass',
                address: recipientAddress,
                name: 'Dedupe User'
            })
            .expect(200);

        expect(createUserResponse.body.success).to.be.true;
        user = createUserResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        expect(mailboxesResponse.body.success).to.be.true;

        const inboxData = (mailboxesResponse.body.results || []).find(mailbox => mailbox.path === 'INBOX');
        expect(inboxData).to.exist;
        inbox = inboxData.id;
    });

    after(async () => {
        if (!user) {
            return;
        }

        const response = await server.delete(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;
        user = false;
    });

    it('should skip storing duplicate copy with same Message-ID and Date', async () => {
        const firstRaw = buildRawMessage('Wed, 11 Feb 2026 16:01:24 +0200');
        const duplicateForwardedRaw = buildRawMessage('Wed, 11 Feb 2026 16:01:24 +0200', [
            'Received: from forwarder.example by mx.example with ESMTP id fwd-1; Wed, 11 Feb 2026 16:05:00 +0200',
            'X-Forwarded-For: c@example.com'
        ]);

        await sendRaw(firstRaw, 'alice@example.com');

        const afterFirst = await listInboxMessages();
        expect(afterFirst.length).to.equal(1);

        await sendRaw(duplicateForwardedRaw, 'forwarder@example.com');

        const afterDuplicate = await listInboxMessages();
        expect(afterDuplicate.length).to.equal(1);
        expect(afterDuplicate[0].id).to.equal(afterFirst[0].id);
    });

    it('should store a new message if Date differs even with same Message-ID', async () => {
        const sameMessageIdDifferentDate = buildRawMessage('Wed, 11 Feb 2026 16:02:24 +0200', [
            'Received: from relay.example by mx.example with ESMTP id fwd-2; Wed, 11 Feb 2026 16:06:00 +0200'
        ]);

        await sendRaw(sameMessageIdDifferentDate, 'relay@example.com');

        const messages = await listInboxMessages();
        expect(messages.length).to.equal(2);
    });
});
