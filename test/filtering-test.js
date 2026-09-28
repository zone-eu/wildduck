/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* global before */

'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const crypto = require('crypto');
//const util = require('util');
const chai = require('chai');
const { request } = require('undici');
const fs = require('fs');
const simpleParser = require('mailparser').simpleParser;
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const transporter = nodemailer.createTransport({
    lmtp: true,
    host: '127.0.0.1',
    port: 2424,
    logger: false,
    debug: false,
    tls: {
        rejectUnauthorized: false
    }
});

const expect = chai.expect;
chai.config.includeStack = true;

const URL = 'http://127.0.0.1:8080';
const user2PubKey = fs.readFileSync(__dirname + '/fixtures/user2-public.key', 'utf-8');
const user3PubKey = fs.readFileSync(__dirname + '/fixtures/user3-public.key', 'utf-8');

describe('Send multiple messages', function () {
    this.timeout(100 * 1000); // eslint-disable-line

    let userIds = [];

    before(async () => {
        const users = [
            {
                username: 'user1',
                password: 'secretpass',
                address: 'user1@example.com',
                name: 'user1'
            },
            {
                username: 'user2',
                password: 'secretpass',
                address: 'user2@example.com',
                name: 'user2',
                pubKey: user2PubKey,
                encryptMessages: true,
                encryptForwarded: true
            },
            {
                username: 'user3',
                password: 'secretpass',
                address: 'user3@example.com',
                name: 'user3',
                pubKey: user3PubKey,
                encryptMessages: true,
                encryptForwarded: true
            },
            {
                username: 'user4',
                password: 'secretpass',
                address: 'user4@example.com',
                name: 'user4',
                pubKey: user2PubKey,
                encryptMessages: false,
                encryptForwarded: true
            },
            {
                username: 'user5',
                password: 'secretpass',
                address: 'user5@example.com',
                name: 'user5'
            }
        ];

        for (const user of users) {
            const { body } = await request(URL + '/users', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json'
                },
                body: JSON.stringify(user)
            });
            const response = await body.json();
            expect(response.success).to.be.true;
            userIds.push(response.id);
        }
    });

    it('Should have users set', done => {
        expect(userIds.length).to.equal(5);
        done();
    });

    it('Send mail to all users', async () => {
        let recipients = ['user1@example.com', 'user2@example.com', 'user3@example.com', 'user4@example.com', 'user5@example.com'];
        let subject = 'Test ööö message [' + Date.now() + ']';
        const info = await transporter.sendMail({
            envelope: {
                from: 'andris@kreata.ee',
                to: recipients
            },

            headers: {
                // set to Yes to send this message to Junk folder
                'x-rspamd-spam': 'No'
            },

            from: 'Kärbes 🐧 <andris@kreata.ee>',
            to: recipients.map((rcpt, i) => ({ name: 'User #' + (i + 1), address: rcpt })),
            subject,
            text: 'Hello world! Current time is ' + new Date().toString(),
            html:
                '<p>Hello world! Current time is <em>' +
                new Date().toString() +
                '</em> <img src="cid:note@example.com"/> <img src="http://www.neti.ee/img/neti-logo-2015-1.png"></p>',
            attachments: [
                // attachment as plaintext
                {
                    filename: 'notes.txt',
                    content: 'Some notes about this e-mail',
                    contentType: 'text/plain' // optional, would be detected from the filename
                },

                // Small Binary Buffer attachment, should be kept with message
                {
                    filename: 'image.png',
                    content: Buffer.from(
                        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAQMAAAAlPW0iAAAABlBMVEUAAAD/' +
                            '//+l2Z/dAAAAM0lEQVR4nGP4/5/h/1+G/58ZDrAz3D/McH8yw83NDDeNGe4U' +
                            'g9C9zwz3gVLMDA/A6P9/AFGGFyjOXZtQAAAAAElFTkSuQmCC',
                        'base64'
                    ),

                    cid: 'note@example.com' // should be as unique as possible
                },

                // Large Binary Buffer attachment, should be kept separately
                {
                    path: __dirname + '/../examples/swan.jpg',
                    filename: 'swän.jpg'
                }
            ]
        });
        expect(info.accepted).to.deep.equal(['user1@example.com', 'user2@example.com', 'user3@example.com', 'user4@example.com', 'user5@example.com']);

        const getJson = async url => {
            const { body } = await request(url);
            return body.json();
        };

        const getBuffer = async url => {
            const { body } = await request(url);
            return Buffer.from(await body.arrayBuffer());
        };

        const getFirstMessage = async userId => {
            const mailboxes = await getJson(URL + '/users/' + userId + '/mailboxes');
            expect(mailboxes.success).to.be.true;
            const inbox = mailboxes.results.find(mbox => mbox.path === 'INBOX');
            const messages = await getJson(URL + '/users/' + userId + '/mailboxes/' + inbox.id + '/messages');
            expect(messages.success).to.be.true;

            const firstMessage = messages.results[0];
            expect(firstMessage).to.exist;

            const message = await getJson(URL + '/users/' + userId + '/mailboxes/' + inbox.id + '/messages/' + firstMessage.id);
            for (const attachment of message.attachments) {
                attachment.raw = await getBuffer(
                    URL +
                        '/users/' +
                        message.user +
                        '/mailboxes/' +
                        message.mailbox +
                        '/messages/' +
                        message.id +
                        '/attachments/' +
                        attachment.id
                );
            }

            message.raw = await getBuffer(URL + '/users/' + userId + '/mailboxes/' + inbox.id + '/messages/' + message.id + '/message.eml');
            message.parsed = await simpleParser(message.raw);
            return message;
        };

        const expectedRecipients = [
            { address: 'user1@example.com', name: 'User #1' },
            { address: 'user2@example.com', name: 'User #2' },
            { address: 'user3@example.com', name: 'User #3' },
            { address: 'user4@example.com', name: 'User #4' },
            { address: 'user5@example.com', name: 'User #5' }
        ];

        for (const user of [1, 4, 5]) {
            const message = await getFirstMessage(userIds[user - 1]);
            expect(message.subject).to.equal(subject);
            expect(message.attachments.length).to.equal(3);
            expect(message.parsed.attachments.length).to.equal(3);
            for (let i = 0; i < message.attachments.length; i++) {
                const hashA = crypto.createHash('md5').update(message.attachments[i].raw).digest('hex');
                const hashB = crypto.createHash('md5').update(message.parsed.attachments[i].content).digest('hex');
                expect(hashA).equal(hashB);
            }
            expect(message.parsed.to.value).deep.equal(expectedRecipients);
            expect(message.parsed.headers.get('delivered-to').value[0].address).equal('user' + user + '@example.com');
        }

        for (const user of [2, 3]) {
            const message = await getFirstMessage(userIds[user - 1]);
            expect(message.subject).to.equal(subject);
            expect(message.parsed.to.value).deep.equal(expectedRecipients);
            expect(message.parsed.headers.get('delivered-to').value[0].address).equal('user' + user + '@example.com');
            expect(message.parsed.attachments.length).equal(2);
            expect(message.parsed.attachments[0].contentType).equal('application/pgp-encrypted');
            expect(message.parsed.attachments[0].content.toString()).equal('Version: 1\r\n');
            expect(message.parsed.attachments[1].contentType).equal('application/octet-stream');
            expect(message.parsed.attachments[1].filename).equal('encrypted.asc');
            expect(message.parsed.attachments[1].size).gte(1000000);
        }
    });

    it('should fetch messages from IMAP', done => {
        let imagePng = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAQMAAAAlPW0iAAAABlBMVEUAAAD/' +
                '//+l2Z/dAAAAM0lEQVR4nGP4/5/h/1+G/58ZDrAz3D/McH8yw83NDDeNGe4U' +
                'g9C9zwz3gVLMDA/A6P9/AFGGFyjOXZtQAAAAAElFTkSuQmCC',
            'base64'
        );
        let textTxt = 'Some notes about this e-mail';
        let swanJpg = fs.readFileSync(__dirname + '/../examples/swan.jpg');

        let checksums = [
            crypto.createHash('md5').update(imagePng).digest('hex'),
            crypto.createHash('md5').update(Buffer.from(textTxt)).digest('hex'),
            crypto.createHash('md5').update(swanJpg).digest('hex')
        ];

        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 9993,
            secure: true,
            auth: {
                user: 'user4',
                pass: 'secretpass'
            },
            tls: {
                rejectUnauthorized: false
            },
            clientInfo: {
                name: 'My Client',
                version: '0.1'
            }
        });

        client.on('error', err => {
            expect(err).to.not.exist;
            done();
        });
        client.on('close', () => done());

        client
            .connect()
            .then(async () => {
                const result = await client.list();
                const folders = result.map(mbox => ({ name: mbox.name, specialUse: mbox.specialUse || false })).sort((a, b) => a.name.localeCompare(b.name));
                expect(folders).to.deep.equal([
                    { name: 'Drafts', specialUse: '\\Drafts' },
                    { name: 'INBOX', specialUse: '\\Inbox' },
                    { name: 'Junk', specialUse: '\\Junk' },
                    { name: 'Sent Mail', specialUse: '\\Sent' },
                    { name: 'Trash', specialUse: '\\Trash' }
                ]);

                const mailbox = await client.mailboxOpen('INBOX');
                expect(mailbox.exists).gte(1);

                let messages = [];
                for await (let msg of client.fetch(mailbox.exists, { uid: true, source: true })) {
                    messages.push(msg);
                }
                expect(messages.length).equal(1);

                let messageInfo = messages[0];
                let parsed = await simpleParser(messageInfo.source);
                checksums.forEach((checksum, i) => {
                    expect(checksum).to.equal(parsed.attachments[i].checksum);
                });
                client.close();
            })
            .catch(err => {
                expect(err).to.not.exist;
                client.close();
            });
    });
});
