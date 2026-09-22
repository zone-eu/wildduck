/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const util = require('util');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');

const db = require('../lib/db');
const searchApplyTask = util.promisify(require('../lib/tasks/search-apply'));

describe('Search apply task', function () {
    it('should resolve move destination mailbox with the task user scope', async () => {
        const user = new ObjectId();
        const destinationMailbox = new ObjectId();

        const originalUsers = db.users;
        const originalDatabase = db.database;

        let mailboxLookup;

        db.users = {
            collection(name) {
                expect(name).to.equal('users');

                return {
                    async findOne() {
                        return {
                            _id: user
                        };
                    }
                };
            }
        };

        db.database = {
            collection(name) {
                switch (name) {
                    case 'messages':
                        return {
                            find(filter) {
                                expect(filter.user.toString()).to.equal(user.toString());

                                return {
                                    project() {
                                        return this;
                                    },
                                    async toArray() {
                                        return [];
                                    }
                                };
                            }
                        };

                    default:
                        throw new Error(`Unexpected collection lookup: ${name}`);
                }
            }
        };

        try {
            await searchApplyTask(
                { _id: new ObjectId() },
                {
                    user: user.toHexString(),
                    action: {
                        moveTo: destinationMailbox.toHexString()
                    }
                },
                {
                    messageHandler: {
                        update(...args) {
                            const callback = args[args.length - 1];
                            callback(null, 0);
                        },
                        async getMailboxAsync(query) {
                            mailboxLookup = query;
                            return { _id: query.mailbox };
                        },
                        async moveAsync() {
                            throw new Error('moveAsync should not be called without matching messages');
                        },
                        async delAsync() {
                            throw new Error('delAsync should not be called in move-only task');
                        }
                    }
                }
            );
        } finally {
            db.users = originalUsers;
            db.database = originalDatabase;
        }

        expect(mailboxLookup).to.exist;
        expect(mailboxLookup.user.toString()).to.equal(user.toString());
        expect(mailboxLookup.mailbox.toString()).to.equal(destinationMailbox.toString());
    });

    it('should delete all 3000 messages matched by a 2025 date search', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const messageIds = Array.from({ length: 3000 }, () => new ObjectId());
        const deleted = [];

        const originalUsers = db.users;
        const originalDatabase = db.database;

        db.users = {
            collection(name) {
                expect(name).to.equal('users');

                return {
                    async findOne() {
                        return { _id: user };
                    }
                };
            }
        };

        db.database = {
            collection(name) {
                expect(name).to.equal('messages');

                return {
                    find(filter) {
                        expect(filter.user.toString()).to.equal(user.toString());
                        expect(filter.idate.$gte).to.deep.equal(new Date('2025-01-01T00:00:00.000Z'));
                        expect(filter.idate.$lte).to.deep.equal(new Date('2025-12-31T23:59:59.999Z'));
                        return {
                            project(projection) {
                                expect(projection).to.deep.equal({ _id: true });
                                return this;
                            },
                            async toArray() {
                                return messageIds.map(_id => ({ _id }));
                            }
                        };
                    },
                    async findOne(query) {
                        const _id = query._id;
                        return {
                            _id,
                            user,
                            mailbox,
                            uid: messageIds.indexOf(_id) + 1,
                            flags: [],
                            size: 1
                        };
                    }
                };
            }
        };

        try {
            await searchApplyTask(
                { _id: new ObjectId() },
                {
                    user: user.toHexString(),
                    mailbox: mailbox.toHexString(),
                    datestart: new Date('2025-01-01T00:00:00.000Z'),
                    dateend: new Date('2025-12-31T23:59:59.999Z'),
                    action: { delete: true }
                },
                {
                    messageHandler: {
                        update(...args) {
                            const callback = args[args.length - 1];
                            callback(null, 0);
                        },
                        async delAsync(options) {
                            deleted.push(options.messageData._id);
                        }
                    }
                }
            );
        } finally {
            db.users = originalUsers;
            db.database = originalDatabase;
        }

        expect(deleted).to.deep.equal(messageIds);
    });

    it('should apply updates and moves to all 3000 matched messages', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const destinationMailbox = new ObjectId();
        const messageIds = Array.from({ length: 3000 }, () => new ObjectId());
        const updated = [];
        const moved = [];

        const originalUsers = db.users;
        const originalDatabase = db.database;

        db.users = {
            collection(name) {
                expect(name).to.equal('users');

                return {
                    async findOne() {
                        return { _id: user };
                    }
                };
            }
        };

        db.database = {
            collection(name) {
                expect(name).to.equal('messages');

                return {
                    find(filter) {
                        expect(filter.user.toString()).to.equal(user.toString());
                        return {
                            project(projection) {
                                expect(projection).to.deep.equal({ _id: true });
                                return this;
                            },
                            async toArray() {
                                return messageIds.map(_id => ({ _id }));
                            }
                        };
                    },
                    async findOne(query) {
                        return {
                            _id: query._id,
                            user,
                            mailbox,
                            uid: messageIds.indexOf(query._id) + 1,
                            flags: [],
                            size: 1
                        };
                    }
                };
            }
        };

        try {
            const messageHandler = {
                update(...args) {
                    updated.push(args[2]);
                    const callback = args[args.length - 1];
                    callback(null, 1);
                },
                async getMailboxAsync(query) {
                    expect(query.user.toString()).to.equal(user.toString());
                    expect(query.mailbox.toString()).to.equal(destinationMailbox.toString());
                    return { _id: destinationMailbox };
                },
                async moveAsync(options) {
                    moved.push(options.source.mailbox);
                }
            };

            await searchApplyTask(
                { _id: new ObjectId() },
                {
                    user: user.toHexString(),
                    mailbox: mailbox.toHexString(),
                    action: { seen: true }
                },
                { messageHandler }
            );

            await searchApplyTask(
                { _id: new ObjectId() },
                {
                    user: user.toHexString(),
                    mailbox: mailbox.toHexString(),
                    action: { moveTo: destinationMailbox.toHexString() }
                },
                { messageHandler }
            );
        } finally {
            db.users = originalUsers;
            db.database = originalDatabase;
        }

        expect(updated).to.have.length(3000);
        expect(moved).to.have.length(3000);
    });
});
