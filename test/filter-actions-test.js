/*eslint no-unused-expressions: 0 */
/* global before, after */
'use strict';

const crypto = require('crypto');
const supertest = require('supertest');
const chai = require('chai');
const nodemailer = require('nodemailer');
const { MongoClient } = require('mongodb');
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

describe('Filter actions runtime behavior', function () {
    this.timeout(60000); // eslint-disable-line no-invalid-this

    let mongoClient;
    let senderQueueDatabase;

    before(async () => {
        mongoClient = await MongoClient.connect(config.dbs.mongo, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        senderQueueDatabase = mongoClient.db(config.dbs.sender || config.dbs.dbname);
    });

    after(async () => {
        if (mongoClient) {
            await mongoClient.close();
            mongoClient = undefined;
            senderQueueDatabase = undefined;
        }
    });

    const wait = timeout => new Promise(resolvePromise => setTimeout(resolvePromise, timeout));

    /**
     * @param {string} usernamePrefix
     * @returns {Promise<{userId: string, address: string}>}
     */
    const createUser = async usernamePrefix => {
        const uniqueSuffix = `${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
        const username = `${usernamePrefix}${uniqueSuffix}`;
        const userAddress = `${username}@example.com`;

        const createUserResponse = await server
            .post('/users')
            .send({
                username,
                password: 'secretpass',
                address: userAddress,
                name: `Filter Action ${usernamePrefix}`
            })
            .expect(200);

        expect(createUserResponse.body.success).to.be.true;

        return {
            userId: createUserResponse.body.id,
            address: userAddress
        };
    };

    /**
     * @param {string} userId
     * @returns {Promise<void>}
     */
    const deleteUser = async userId => {
        const deleteResponse = await server.delete(`/users/${userId}`).expect(200);
        expect(deleteResponse.body.success).to.be.true;
    };

    /**
     * @param {string} userId
     * @returns {Promise<Array<any>>}
     */
    const listUserMailboxes = async userId => {
        const mailboxListResponse = await server.get(`/users/${userId}/mailboxes`).expect(200);
        expect(mailboxListResponse.body.success).to.be.true;
        return mailboxListResponse.body.results || [];
    };

    /**
     * @param {string} userId
     * @param {(mailboxData: any) => boolean} mailboxPredicate
     * @returns {Promise<any>}
     */
    const findMailbox = async (userId, mailboxPredicate) => {
        const mailboxList = await listUserMailboxes(userId);
        const mailboxData = mailboxList.find(mailboxPredicate);
        expect(mailboxData).to.exist;
        return mailboxData;
    };

    /**
     * @param {string} userId
     * @param {string} mailboxId
     * @returns {Promise<Array<any>>}
     */
    const listMailboxMessages = async (userId, mailboxId) => {
        const messageListResponse = await server.get(`/users/${userId}/mailboxes/${mailboxId}/messages`).expect(200);
        expect(messageListResponse.body.success).to.be.true;
        return messageListResponse.body.results || [];
    };

    /**
     * @param {{userId: string, mailboxId: string, subjectToken: string, attempts?: number, delayMs?: number}} waitOptions
     * @returns {Promise<any | undefined>}
     */
    const waitForMessageBySubject = async waitOptions => {
        const maxAttempts = waitOptions.attempts || 12;
        const delayMs = waitOptions.delayMs || 500;

        for (let attemptNumber = 0; attemptNumber < maxAttempts; attemptNumber++) {
            const messageList = await listMailboxMessages(waitOptions.userId, waitOptions.mailboxId);
            const matchingMessage = messageList.find(messageData => (messageData.subject || '').includes(waitOptions.subjectToken));
            if (matchingMessage) {
                return matchingMessage;
            }
            await wait(delayMs);
        }

        return undefined;
    };

    /**
     * @param {{recipientAddress: string, senderAddress: string, subjectToken: string}} sendOptions
     * @returns {Promise<void>}
     */
    const sendMatchingMessage = async sendOptions => {
        const sendResult = await lmtpTransport.sendMail({
            envelope: {
                from: sendOptions.senderAddress,
                to: [sendOptions.recipientAddress]
            },
            from: `Filter Action Sender <${sendOptions.senderAddress}>`,
            to: `Recipient <${sendOptions.recipientAddress}>`,
            subject: `Filter action test ${sendOptions.subjectToken}`,
            text: `Message for filter action ${sendOptions.subjectToken}`
        });

        expect(sendResult.accepted).to.include(sendOptions.recipientAddress);
    };

    /**
     * @param {{userId: string, queryFrom: string, action: Record<string, unknown>}} filterOptions
     * @returns {Promise<string>}
     */
    const createFilter = async filterOptions => {
        const createFilterResponse = await server
            .post(`/users/${filterOptions.userId}/filters`)
            .send({
                name: `runtime filter ${filterOptions.queryFrom}`,
                query: {
                    from: filterOptions.queryFrom
                },
                action: filterOptions.action
            })
            .expect(200);

        expect(createFilterResponse.body.success).to.be.true;
        return createFilterResponse.body.id;
    };

    /**
     * @param {{recipientAddress: string, attempts?: number, delayMs?: number}} waitOptions
     * @returns {Promise<any | undefined>}
     */
    const waitForForwardQueueEntry = async waitOptions => {
        const maxAttempts = waitOptions.attempts || 24;
        const delayMs = waitOptions.delayMs || 500;

        for (let attemptNumber = 0; attemptNumber < maxAttempts; attemptNumber++) {
            const queueEntry = await senderQueueDatabase.collection('zone-queue').findOne({
                recipient: waitOptions.recipientAddress
            });

            if (queueEntry) {
                return queueEntry;
            }

            await wait(delayMs);
        }

        return undefined;
    };

    const actionCases = [
        {
            caseName: 'seen action',
            actionBuilder: async () => ({ seen: true }),
            verify: async context => {
                const inboxMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.inboxMailbox.id,
                    subjectToken: context.subjectToken
                });

                expect(inboxMessage).to.exist;
                expect(inboxMessage.seen).to.equal(true);
            }
        },
        {
            caseName: 'flag action',
            actionBuilder: async () => ({ flag: true }),
            verify: async context => {
                const inboxMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.inboxMailbox.id,
                    subjectToken: context.subjectToken
                });

                expect(inboxMessage).to.exist;
                expect(inboxMessage.flagged).to.equal(true);
            }
        },
        {
            caseName: 'keywords action',
            actionBuilder: async () => ({ keywords: ['runtime-keyword'] }),
            verify: async context => {
                const inboxMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.inboxMailbox.id,
                    subjectToken: context.subjectToken
                });

                expect(inboxMessage).to.exist;
                expect(inboxMessage.keywords).to.include('runtime-keyword');
            }
        },
        {
            caseName: 'spam action',
            actionBuilder: async () => ({ spam: true }),
            verify: async context => {
                const junkMailbox = await findMailbox(context.mainUser.userId, mailboxData => mailboxData.specialUse === '\\Junk');

                const junkMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: junkMailbox.id,
                    subjectToken: context.subjectToken
                });

                expect(junkMessage).to.exist;

                const inboxMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.inboxMailbox.id,
                    subjectToken: context.subjectToken,
                    attempts: 3,
                    delayMs: 300
                });
                expect(inboxMessage).to.equal(undefined);
            }
        },
        {
            caseName: 'mailbox action',
            actionBuilder: async context => {
                const createMailboxResponse = await server
                    .post(`/users/${context.mainUser.userId}/mailboxes`)
                    .send({
                        path: '/RuntimeTargetMailbox',
                        hidden: false,
                        retention: 0
                    })
                    .expect(200);

                expect(createMailboxResponse.body.success).to.be.true;

                context.targetMailboxId = createMailboxResponse.body.id;
                return { mailbox: context.targetMailboxId };
            },
            verify: async context => {
                const targetMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.targetMailboxId,
                    subjectToken: context.subjectToken
                });

                expect(targetMessage).to.exist;
            }
        },
        {
            caseName: 'delete action',
            actionBuilder: async () => ({ delete: true }),
            verify: async context => {
                const inboxMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.inboxMailbox.id,
                    subjectToken: context.subjectToken,
                    attempts: 5,
                    delayMs: 300
                });

                expect(inboxMessage).to.equal(undefined);
            }
        },
        {
            caseName: 'targets action',
            actionBuilder: async context => {
                context.forwardTargetAddress = `queued-target-${Date.now()}${crypto.randomBytes(4).toString('hex')}@example.net`;
                return { targets: [context.forwardTargetAddress] };
            },
            verify: async context => {
                const originInboxMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.inboxMailbox.id,
                    subjectToken: context.subjectToken
                });
                expect(originInboxMessage).to.exist;

                const forwardQueueEntry = await waitForForwardQueueEntry({
                    recipientAddress: context.forwardTargetAddress,
                    attempts: 24,
                    delayMs: 500
                });
                expect(forwardQueueEntry).to.exist;
            }
        },
        {
            caseName: 'combined action in one filter',
            actionBuilder: async context => {
                context.forwardTargetAddress = `queued-combined-${Date.now()}${crypto.randomBytes(4).toString('hex')}@example.net`;
                return {
                    seen: true,
                    flag: true,
                    keywords: ['combined-a', 'combined-b'],
                    targets: [context.forwardTargetAddress]
                };
            },
            verify: async context => {
                const inboxMessage = await waitForMessageBySubject({
                    userId: context.mainUser.userId,
                    mailboxId: context.inboxMailbox.id,
                    subjectToken: context.subjectToken
                });

                expect(inboxMessage).to.exist;
                expect(inboxMessage.seen).to.equal(true);
                expect(inboxMessage.flagged).to.equal(true);
                expect(inboxMessage.keywords).to.include.members(['combined-a', 'combined-b']);

                const forwardQueueEntry = await waitForForwardQueueEntry({
                    recipientAddress: context.forwardTargetAddress,
                    attempts: 24,
                    delayMs: 500
                });
                expect(forwardQueueEntry).to.exist;
            }
        }
    ];

    for (const actionCase of actionCases) {
        it(`should apply ${actionCase.caseName} on inbound message`, async () => {
            const context = {
                createdUsers: []
            };

            try {
                context.mainUser = await createUser('runtimeaction');
                context.createdUsers.push(context.mainUser.userId);
                context.inboxMailbox = await findMailbox(context.mainUser.userId, mailboxData => mailboxData.path === 'INBOX');

                context.senderTag = `runtime-${actionCase.caseName.replace(/\s+/g, '-')}-${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
                context.senderAddress = `${context.senderTag}@example.com`;
                context.subjectToken = `${actionCase.caseName}-${Date.now()}${crypto.randomBytes(2).toString('hex')}`;

                const action = await actionCase.actionBuilder(context);
                await createFilter({
                    userId: context.mainUser.userId,
                    queryFrom: context.senderTag,
                    action
                });

                await sendMatchingMessage({
                    recipientAddress: context.mainUser.address,
                    senderAddress: context.senderAddress,
                    subjectToken: context.subjectToken
                });

                await actionCase.verify(context);
            } finally {
                while (context.createdUsers.length) {
                    const userId = context.createdUsers.pop();
                    if (!userId) {
                        continue;
                    }

                    await deleteUser(userId);
                }
            }
        });
    }

    it('should combine actions from multiple matching filters', async () => {
        const context = {
            createdUsers: []
        };

        try {
            context.mainUser = await createUser('runtimeaction');
            context.createdUsers.push(context.mainUser.userId);
            context.inboxMailbox = await findMailbox(context.mainUser.userId, mailboxData => mailboxData.path === 'INBOX');

            context.senderTag = `runtime-multi-filters-${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
            context.senderAddress = `${context.senderTag}@example.com`;
            context.subjectToken = `multiple-filters-${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
            context.forwardTargetAddressOne = `queued-multi-one-${Date.now()}${crypto.randomBytes(4).toString('hex')}@example.net`;
            context.forwardTargetAddressTwo = `queued-multi-two-${Date.now()}${crypto.randomBytes(4).toString('hex')}@example.net`;

            await createFilter({
                userId: context.mainUser.userId,
                queryFrom: context.senderTag,
                action: {
                    seen: true,
                    keywords: ['multi-one'],
                    targets: [context.forwardTargetAddressOne]
                }
            });

            await createFilter({
                userId: context.mainUser.userId,
                queryFrom: context.senderTag,
                action: {
                    flag: true,
                    keywords: ['multi-two'],
                    targets: [context.forwardTargetAddressTwo]
                }
            });

            await sendMatchingMessage({
                recipientAddress: context.mainUser.address,
                senderAddress: context.senderAddress,
                subjectToken: context.subjectToken
            });

            const inboxMessage = await waitForMessageBySubject({
                userId: context.mainUser.userId,
                mailboxId: context.inboxMailbox.id,
                subjectToken: context.subjectToken
            });

            expect(inboxMessage).to.exist;
            expect(inboxMessage.seen).to.equal(true);
            expect(inboxMessage.flagged).to.equal(true);
            expect(inboxMessage.keywords).to.include.members(['multi-one', 'multi-two']);

            const forwardQueueEntryOne = await waitForForwardQueueEntry({
                recipientAddress: context.forwardTargetAddressOne,
                attempts: 24,
                delayMs: 500
            });
            expect(forwardQueueEntryOne).to.exist;

            const forwardQueueEntryTwo = await waitForForwardQueueEntry({
                recipientAddress: context.forwardTargetAddressTwo,
                attempts: 24,
                delayMs: 500
            });
            expect(forwardQueueEntryTwo).to.exist;
        } finally {
            while (context.createdUsers.length) {
                const userId = context.createdUsers.pop();
                if (!userId) {
                    continue;
                }

                await deleteUser(userId);
            }
        }
    });
});
