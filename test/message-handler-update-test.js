/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, global-require: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');

const eventsPath = require.resolve('../lib/events');
const messageHandlerPath = require.resolve('../lib/message-handler');
const imapNotifierPath = require.resolve('../lib/imap-notifier');

function loadModulesWithPublishStub(published) {
    delete require.cache[messageHandlerPath];
    delete require.cache[imapNotifierPath];

    const events = require(eventsPath);
    const originalPublish = events.publish;

    events.publish = (redis, data) => {
        published.push(data);
        return Promise.resolve();
    };

    delete require.cache[messageHandlerPath];
    delete require.cache[imapNotifierPath];

    const MessageHandler = require('../lib/message-handler');
    const ImapNotifier = require('../lib/imap-notifier');

    return {
        MessageHandler,
        ImapNotifier,
        MARKED_HAM: events.MARKED_HAM,
        restore() {
            events.publish = originalPublish;
            delete require.cache[messageHandlerPath];
            delete require.cache[imapNotifierPath];
        }
    };
}

describe('MessageHandler message updates', function () {
    function buildHandler(MessageHandler) {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const message = new ObjectId();
        const thread = new ObjectId();

        let nextCalls = 0;
        let notified = [];
        let calls = {
            mailboxFinds: 0,
            mailboxUpdates: 0,
            messageUpdates: 0
        };

        let handler = Object.create(MessageHandler.prototype);
        handler.redis = false;
        handler.settingsHandler = {
            get: () => Promise.resolve(100)
        };
        handler.notifier = {
            addEntries(mailboxData, entries, callback) {
                notified.push(...entries);
                return callback();
            },
            fire() {}
        };
        handler.database = {
            collection(name) {
                switch (name) {
                    case 'mailboxes':
                        return {
                            findOneAndUpdate(query, update, options, callback) {
                                calls.mailboxUpdates++;
                                expect(query._id.toString()).to.equal(mailbox.toString());
                                expect(query.user.toString()).to.equal(user.toString());
                                expect(update.$inc.modifyIndex).to.equal(1);
                                return callback(null, {
                                    value: {
                                        _id: mailbox,
                                        user,
                                        modifyIndex: 7
                                    }
                                });
                            },
                            findOne(query, callback) {
                                calls.mailboxFinds++;
                                expect(query._id.toString()).to.equal(mailbox.toString());
                                expect(query.user.toString()).to.equal(user.toString());
                                return callback(null, {
                                    _id: mailbox,
                                    user,
                                    modifyIndex: 7
                                });
                            }
                        };

                    case 'messages':
                        return {
                            find(query) {
                                expect(query.mailbox.toString()).to.equal(mailbox.toString());
                                expect(query.uid).to.equal(42);

                                return {
                                    project(projection) {
                                        expect(projection._id).to.be.true;
                                        expect(projection.uid).to.be.true;

                                        return {
                                            next(callback) {
                                                if (nextCalls++) {
                                                    return callback(null, null);
                                                }
                                                return callback(null, {
                                                    _id: message,
                                                    uid: 42
                                                });
                                            },
                                            close(callback) {
                                                return callback();
                                            }
                                        };
                                    }
                                };
                            },
                            findOneAndUpdate(query, update, options, callback) {
                                calls.messageUpdates++;
                                expect(query._id.toString()).to.equal(message.toString());
                                expect(query.mailbox.toString()).to.equal(mailbox.toString());
                                expect(query.uid).to.equal(42);
                                expect(update.$set.flagged).to.be.true;
                                expect(update.$set.modseq).to.equal(7);
                                expect(update.$addToSet.flags.$each).to.deep.equal(['\\Flagged']);

                                return callback(null, {
                                    value: {
                                        _id: message,
                                        uid: 42,
                                        thread,
                                        flags: ['\\Flagged']
                                    }
                                });
                            }
                        };

                    default:
                        throw new Error('Unexpected collection lookup: ' + name);
                }
            }
        };

        return { handler, user, mailbox, message, notified, calls };
    }

    function updateAsync(handler, user, mailbox, changes) {
        return new Promise((resolve, reject) => {
            handler.update(user, mailbox, 42, changes, (err, updated) => {
                if (err) {
                    return reject(err);
                }
                return resolve(updated);
            });
        });
    }

    it('publishes marked.ham when a message is starred', async function () {
        const published = [];
        const { MessageHandler, MARKED_HAM, restore } = loadModulesWithPublishStub(published);

        try {
            const { handler, user, mailbox, message, notified, calls } = buildHandler(MessageHandler);

            let updated = await updateAsync(handler, user, mailbox, {
                flagged: true
            });

            expect(updated).to.equal(1);
            expect(calls.mailboxUpdates).to.equal(1);
            expect(calls.messageUpdates).to.equal(1);
            expect(notified).to.have.lengthOf(1);
            expect(published).to.have.lengthOf(1);
            expect(published[0].ev).to.equal(MARKED_HAM);
            expect(published[0].user).to.equal(user.toString());
            expect(published[0].mailbox).to.equal(mailbox.toString());
            expect(published[0].message).to.equal(message.toString());
            expect(published[0].id).to.equal(42);
        } finally {
            restore();
        }
    });

    it('publishes marked.ham when markHam=true is the only requested action', async function () {
        const published = [];
        const { MessageHandler, MARKED_HAM, restore } = loadModulesWithPublishStub(published);

        try {
            const { handler, user, mailbox, message, notified, calls } = buildHandler(MessageHandler);

            let updated = await updateAsync(handler, user, mailbox, {
                markHam: true
            });

            expect(updated).to.equal(1);
            expect(calls.mailboxFinds).to.equal(1);
            expect(calls.mailboxUpdates).to.equal(0);
            expect(calls.messageUpdates).to.equal(0);
            expect(notified).to.be.empty;
            expect(published).to.have.lengthOf(1);
            expect(published[0].ev).to.equal(MARKED_HAM);
            expect(published[0].user).to.equal(user.toString());
            expect(published[0].mailbox).to.equal(mailbox.toString());
            expect(published[0].message).to.equal(message.toString());
            expect(published[0].id).to.equal(42);
        } finally {
            restore();
        }
    });

    it('marks moved message notifications as ham when the move also stars the message', async function () {
        const MessageHandler = require('../lib/message-handler');
        const user = new ObjectId();
        const sourceMailbox = new ObjectId();
        const targetMailbox = new ObjectId();
        const sourceMessage = new ObjectId();
        const insertedMessage = new ObjectId();
        const thread = new ObjectId();
        const existsEntries = [];

        let handler = Object.create(MessageHandler.prototype);
        handler.database = {
            collection(name) {
                expect(name).to.equal('messages');
                return {
                    insertOne(message) {
                        expect(message.mailbox.toString()).to.equal(targetMailbox.toString());
                        return Promise.resolve({
                            acknowledged: true,
                            insertedId: insertedMessage
                        });
                    },
                    deleteOne(query) {
                        expect(query._id.toString()).to.equal(sourceMessage.toString());
                        expect(query.mailbox.toString()).to.equal(sourceMailbox.toString());
                        expect(query.uid).to.equal(41);
                        return Promise.resolve({
                            deletedCount: 1
                        });
                    }
                };
            }
        };

        await handler.updateMessage(
            {
                message: {
                    mailbox: targetMailbox,
                    unseen: false,
                    idate: new Date(),
                    thread
                },
                targetData: {
                    _id: targetMailbox
                },
                sourceUid: [],
                destinationUid: [],
                mailboxData: {
                    _id: sourceMailbox,
                    user
                },
                existsEntries,
                removeEntries: [],
                messageId: sourceMessage,
                messageUid: 41,
                unseen: false,
                newModseq: 3,
                uidNext: 42,
                junk: false,
                bulk_batch_size: 100
            },
            {
                close: () => Promise.resolve()
            },
            {
                updates: {
                    flagged: true
                }
            }
        );

        expect(existsEntries).to.have.lengthOf(1);
        expect(existsEntries[0].markHam).to.be.true;
        expect(existsEntries[0].uid).to.equal(42);
        expect(existsEntries[0].message.toString()).to.equal(insertedMessage.toString());
    });
});

describe('ImapNotifier marked.ham events', function () {
    it('publishes markHam entries after addEntries enriches user and mailbox fields', async function () {
        const published = [];
        const { ImapNotifier, MARKED_HAM, restore } = loadModulesWithPublishStub(published);
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const message = new ObjectId();
        let journalEntries;

        let notifier = Object.create(ImapNotifier.prototype);
        notifier.redis = false;
        notifier.updateCounters = entries => {
            expect(entries).to.equal(journalEntries);
            return Promise.resolve();
        };
        notifier.logger = {
            debug() {},
            error() {}
        };
        notifier.database = {
            collection(name) {
                expect(name).to.equal('journal');
                return {
                    insertMany(entries) {
                        journalEntries = entries;
                        return Promise.resolve({
                            insertedCount: entries.length
                        });
                    }
                };
            }
        };

        try {
            let insertedCount = await new Promise((resolve, reject) => {
                notifier.addEntries(
                    {
                        _id: mailbox,
                        user,
                        modifyIndex: 10
                    },
                    {
                        command: 'EXISTS',
                        uid: 42,
                        message,
                        markHam: true,
                        modseq: 99
                    },
                    (err, count) => {
                        if (err) {
                            return reject(err);
                        }
                        return resolve(count);
                    }
                );
            });

            expect(insertedCount).to.equal(1);
            expect(journalEntries).to.have.lengthOf(1);
            expect(journalEntries[0].user.toString()).to.equal(user.toString());
            expect(journalEntries[0].mailbox.toString()).to.equal(mailbox.toString());
            expect(published).to.deep.equal([
                {
                    ev: MARKED_HAM,
                    user: user.toString(),
                    mailbox: mailbox.toString(),
                    message: message.toString(),
                    id: 42
                }
            ]);
        } finally {
            restore();
        }
    });
});
