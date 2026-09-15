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
                                    async next() {
                                        return null;
                                    },
                                    async close() {
                                        return;
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

    it('should preserve a move action when keyword updates are also requested', async () => {
        const user = new ObjectId();
        const sourceMailbox = new ObjectId();
        const destinationMailbox = new ObjectId();
        const message = {
            _id: new ObjectId(),
            user,
            mailbox: sourceMailbox,
            uid: 42,
            flags: []
        };
        const originalUsers = db.users;
        const originalDatabase = db.database;
        const moves = [];
        let position = 0;

        db.users = {
            collection() {
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
                    find() {
                        return {
                            async next() {
                                return position++ ? null : message;
                            },
                            async close() {
                                return;
                            }
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
                    action: {
                        moveTo: destinationMailbox.toHexString(),
                        addKeywords: ['project']
                    }
                },
                {
                    messageHandler: {
                        update(...args) {
                            const callback = args[args.length - 1];
                            callback(new Error('update should not replace moveAsync'));
                        },
                        async getMailboxAsync() {
                            return { _id: destinationMailbox };
                        },
                        async moveAsync(options) {
                            moves.push(options);
                        },
                        async delAsync() {
                            throw new Error('delAsync should not be called');
                        }
                    }
                }
            );
        } finally {
            db.users = originalUsers;
            db.database = originalDatabase;
        }

        expect(moves).to.have.lengthOf(1);
        expect(moves[0].source.mailbox.toString()).to.equal(sourceMailbox.toString());
        expect(moves[0].destination.mailbox.toString()).to.equal(destinationMailbox.toString());
        expect(moves[0].updates).to.deep.equal({ addKeywords: ['project'] });
        expect(moves[0].messageQuery).to.equal(42);
    });
});
