/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* global before */

'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const crypto = require('crypto');
//const util = require('util');
const chai = require('chai');
const request = require('request');
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

const config = require('@zone-eu/wild-config');
const URL = `http://127.0.0.1:${config.api.port}`;
const user2PubKey = fs.readFileSync(__dirname + '/fixtures/user2-public.key', 'utf-8');
const user3PubKey = fs.readFileSync(__dirname + '/fixtures/user3-public.key', 'utf-8');

describe('Send multiple messages', function () {
    this.timeout(100 * 1000); // eslint-disable-line

    let userIds = [];

    before(done => {
        request.post(
            URL + '/users',
            {
                json: {
                    username: 'user1',
                    password: 'secretpass',
                    address: 'user1@example.com',
                    name: 'user1'
                }
            },
            (err, meta, response) => {
                expect(err).to.not.exist;
                expect(response.success).to.be.true;
                userIds.push(response.id);
                request.post(
                    URL + '/users',
                    {
                        json: {
                            username: 'user2',
                            password: 'secretpass',
                            address: 'user2@example.com',
                            name: 'user2',
                            pubKey: user2PubKey,
                            encryptMessages: true,
                            encryptForwarded: true
                        }
                    },
                    (err, meta, response) => {
                        expect(err).to.not.exist;
                        expect(response.success).to.be.true;
                        userIds.push(response.id);
                        request.post(
                            URL + '/users',
                            {
                                json: {
                                    username: 'user3',
                                    password: 'secretpass',
                                    address: 'user3@example.com',
                                    name: 'user3',
                                    pubKey: user3PubKey,
                                    encryptMessages: true,
                                    encryptForwarded: true
                                }
                            },
                            (err, meta, response) => {
                                expect(err).to.not.exist;
                                expect(response.success).to.be.true;
                                userIds.push(response.id);
                                request.post(
                                    URL + '/users',
                                    {
                                        json: {
                                            username: 'user4',
                                            password: 'secretpass',
                                            address: 'user4@example.com',
                                            name: 'user4',
                                            pubKey: user2PubKey,
                                            encryptMessages: false,
                                            encryptForwarded: true
                                        }
                                    },
                                    (err, meta, response) => {
                                        expect(err).to.not.exist;
                                        expect(response.success).to.be.true;
                                        userIds.push(response.id);
                                        request.post(
                                            URL + '/users',
                                            {
                                                json: {
                                                    username: 'user5',
                                                    password: 'secretpass',
                                                    address: 'user5@example.com',
                                                    name: 'user5'
                                                }
                                            },
                                            (err, meta, response) => {
                                                expect(err).to.not.exist;
                                                expect(response.success).to.be.true;
                                                userIds.push(response.id);
                                                done();
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });

    it('Should have users set', done => {
        expect(userIds.length).to.equal(5);
        done();
    });

    it('Send mail to all users', done => {
        let recipients = ['user1@example.com', 'user2@example.com', 'user3@example.com', 'user4@example.com', 'user5@example.com'];
        let subject = 'Test ööö message [' + Date.now() + ']';
        transporter.sendMail(
            {
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
            },
            (err, info) => {
                expect(err).to.not.exist;
                expect(info.accepted).to.deep.equal(['user1@example.com', 'user2@example.com', 'user3@example.com', 'user4@example.com', 'user5@example.com']);

                let getFirstMessage = (userId, callback) => {
                    request(URL + '/users/' + userId + '/mailboxes', { json: true }, (err, meta, response) => {
                        expect(err).to.not.exist;
                        expect(response.success).to.be.true;
                        let inbox = response.results.find(mbox => mbox.path === 'INBOX');
                        request(URL + '/users/' + userId + '/mailboxes/' + inbox.id + '/messages', { json: true }, (err, meta, response) => {
                            expect(err).to.not.exist;
                            expect(response.success).to.be.true;

                            let message = response.results[0];
                            expect(message).to.exist;

                            request(URL + '/users/' + userId + '/mailboxes/' + inbox.id + '/messages/' + message.id, { json: true }, (err, meta, message) => {
                                expect(err).to.not.exist;

                                let processAttachments = next => {
                                    let pos = 0;
                                    let getAttachments = () => {
                                        if (pos >= message.attachments.length) {
                                            return next();
                                        }
                                        let attachment = message.attachments[pos++];
                                        request(
                                            URL +
                                                '/users/' +
                                                message.user +
                                                '/mailboxes/' +
                                                message.mailbox +
                                                '/messages/' +
                                                message.id +
                                                '/attachments/' +
                                                attachment.id,
                                            { encoding: null },
                                            (err, meta, raw) => {
                                                expect(err).to.not.exist;
                                                attachment.raw = raw;
                                                setImmediate(getAttachments);
                                            }
                                        );
                                    };
                                    setImmediate(getAttachments);
                                };

                                processAttachments(() => {
                                    request(
                                        URL + '/users/' + userId + '/mailboxes/' + inbox.id + '/messages/' + message.id + '/message.eml',
                                        (err, meta, raw) => {
                                            expect(err).to.not.exist;

                                            message.raw = raw;

                                            simpleParser(raw, (err, parsed) => {
                                                expect(err).to.not.exist;
                                                message.parsed = parsed;
                                                callback(null, message);
                                            });
                                        }
                                    );
                                });
                            });
                        });
                    });
                };

                let checkNormalUsers = next => {
                    let npos = 0;
                    let nusers = [1, 4, 5];
                    let checkUser = () => {
                        if (npos >= nusers.length) {
                            return next();
                        }
                        let user = nusers[npos++];
                        getFirstMessage(userIds[user - 1], (err, message) => {
                            expect(err).to.not.exist;
                            expect(message.subject).to.equal(subject);
                            expect(message.attachments.length).to.equal(3);
                            expect(message.parsed.attachments.length).to.equal(3);
                            for (let i = 0; i < message.attachments.length; i++) {
                                let hashA = crypto.createHash('md5').update(message.attachments[i].raw).digest('hex');
                                let hashB = crypto.createHash('md5').update(message.parsed.attachments[i].content).digest('hex');
                                expect(hashA).equal(hashB);
                            }
                            expect(message.parsed.to.value).deep.equal([
                                { address: 'user1@example.com', name: 'User #1' },
                                { address: 'user2@example.com', name: 'User #2' },
                                { address: 'user3@example.com', name: 'User #3' },
                                { address: 'user4@example.com', name: 'User #4' },
                                { address: 'user5@example.com', name: 'User #5' }
                            ]);
                            expect(message.parsed.headers.get('delivered-to').value[0].address).equal('user' + user + '@example.com');

                            setImmediate(checkUser);
                        });
                    };
                    setImmediate(checkUser);
                };

                let checkEncryptedUsers = next => {
                    let npos = 0;
                    let nusers = [2, 3];
                    let checkUser = () => {
                        if (npos >= nusers.length) {
                            return next();
                        }
                        let user = nusers[npos++];
                        getFirstMessage(userIds[user - 1], (err, message) => {
                            expect(err).to.not.exist;

                            expect(message.subject).to.equal(subject);
                            expect(message.parsed.to.value).deep.equal([
                                { address: 'user1@example.com', name: 'User #1' },
                                { address: 'user2@example.com', name: 'User #2' },
                                { address: 'user3@example.com', name: 'User #3' },
                                { address: 'user4@example.com', name: 'User #4' },
                                { address: 'user5@example.com', name: 'User #5' }
                            ]);
                            expect(message.parsed.headers.get('delivered-to').value[0].address).equal('user' + user + '@example.com');
                            expect(message.parsed.attachments.length).equal(2);
                            expect(message.parsed.attachments[0].contentType).equal('application/pgp-encrypted');
                            expect(message.parsed.attachments[0].content.toString()).equal('Version: 1\r\n');
                            expect(message.parsed.attachments[1].contentType).equal('application/octet-stream');
                            expect(message.parsed.attachments[1].filename).equal('encrypted.asc');
                            expect(message.parsed.attachments[1].size).gte(1000000);
                            setImmediate(checkUser);
                        });
                    };
                    setImmediate(checkUser);
                };

                checkNormalUsers(() => checkEncryptedUsers(() => done()));
            }
        );
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
