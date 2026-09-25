/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const util = require('util');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');

const db = require('../lib/db');
const consts = require('../lib/consts');
const searchApplyTask = util.promisify(require('../lib/tasks/search-apply'));

const createMessageIdCursor = (messageIds, filter, checkFilter) => {
    const boundedFilter = filter.$and && filter.$and.length === 2 && filter.$and[1]._id && filter.$and[1]._id.$lte;
    const baseFilter = boundedFilter ? filter.$and[0] : filter;
    const idRange = boundedFilter ? filter.$and[1]._id : {};
    let pageSize;
    let sortDirection;

    checkFilter(baseFilter);

    return {
        project(projection) {
            expect(projection).to.deep.equal({ _id: true });
            return this;
        },
        sort(sort) {
            expect(sort._id).to.be.oneOf([-1, 1]);
            sortDirection = sort._id;
            return this;
        },
        limit(limit) {
            expect(limit).to.equal(sortDirection === -1 ? 1 : consts.CURSOR_MAX_PAGE_SIZE);
            pageSize = limit;
            return this;
        },
        async toArray() {
            return messageIds
                .filter(id => (!idRange.$gt || id.toString() > idRange.$gt.toString()) && (!idRange.$lte || id.toString() <= idRange.$lte.toString()))
                .sort((a, b) => sortDirection * a.toString().localeCompare(b.toString()))
                .slice(0, pageSize)
                .map(_id => ({ _id }));
        }
    };
};

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
                                return createMessageIdCursor([], filter, baseFilter => {
                                    expect(baseFilter.user.toString()).to.equal(user.toString());
                                });
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
                        return createMessageIdCursor(messageIds, filter, baseFilter => {
                            expect(baseFilter.user.toString()).to.equal(user.toString());
                            expect(baseFilter.idate.$gte).to.deep.equal(new Date('2025-01-01T00:00:00.000Z'));
                            expect(baseFilter.idate.$lte).to.deep.equal(new Date('2025-12-31T23:59:59.999Z'));
                        });
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
                        return createMessageIdCursor(messageIds, filter, baseFilter => {
                            expect(baseFilter.user.toString()).to.equal(user.toString());
                        });
                    },
                    async findOne(query, options) {
                        expect(options).to.deep.equal({
                            projection: {
                                _id: true,
                                user: true,
                                mailbox: true,
                                uid: true
                            }
                        });
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

    for (const scenario of [
        { name: 'the first match is already in the destination', destinationIndex: 0 },
        { name: 'a match in the first page is already in the destination', destinationIndex: 100 },
        { name: 'a match in the second page is already in the destination', destinationIndex: consts.CURSOR_MAX_PAGE_SIZE },
        { name: 'the move also changes flags', destinationIndex: 100, updates: { seen: false, flagged: true } },
        { name: 'the date search uses q with searchable=true', destinationIndex: 100, q: 'after:2025-01-01 before:2025-12-31' }
    ]) {
        it(`should move all remaining date matches when ${scenario.name}`, async () => {
            const user = new ObjectId();
            const sourceMailboxes = [new ObjectId(), new ObjectId()];
            const destinationMailbox = new ObjectId();
            const searchableMailboxes = [...sourceMailboxes, destinationMailbox];
            const messageIds = Array.from({ length: 3000 }, () => new ObjectId());
            const currentMessageIds = [...messageIds];
            const messages = messageIds.map((_id, index) => ({
                _id,
                user,
                mailbox: index === scenario.destinationIndex ? destinationMailbox : sourceMailboxes[index % sourceMailboxes.length],
                uid: index + 1
            }));
            const messagesById = new Map(messages.map(message => [message._id.toString(), message]));
            const moved = [];
            const updated = [];
            const filters = [];
            const datestart = new Date('2025-01-01T00:00:00.000Z');
            const dateend = new Date('2025-12-31T00:00:00.000Z');
            const originalUsers = db.users;
            const originalDatabase = db.database;

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
                    if (name === 'mailboxes') {
                        return {
                            async countDocuments() {
                                return searchableMailboxes.length;
                            },
                            find() {
                                return {
                                    project() {
                                        return this;
                                    },
                                    async toArray() {
                                        return searchableMailboxes.map(_id => ({ _id }));
                                    }
                                };
                            }
                        };
                    }

                    expect(name).to.equal('messages');
                    return {
                        find(filter) {
                            return createMessageIdCursor(currentMessageIds, filter, baseFilter => filters.push(baseFilter));
                        },
                        async findOne(query) {
                            return messagesById.get(query._id.toString());
                        }
                    };
                }
            };

            try {
                await searchApplyTask(
                    { _id: new ObjectId() },
                    {
                        user: user.toHexString(),
                        ...(scenario.q ? { q: scenario.q } : { datestart, dateend }),
                        searchable: true,
                        useAndSearch: true,
                        action: { moveTo: destinationMailbox.toHexString(), ...scenario.updates }
                    },
                    {
                        messageHandler: {
                            update(updateUser, mailbox, uid, updates, callback) {
                                updated.push({ user: updateUser, mailbox, uid, updates });
                                callback(null, 1);
                            },
                            async getMailboxAsync() {
                                return { _id: destinationMailbox };
                            },
                            async moveAsync(options) {
                                moved.push(options);
                                // A real move deletes the source document and inserts a new
                                // one that still matches this date search in the destination.
                                const index = options.messageQuery - 1;
                                const source = messages[index];
                                const destination = { ...source, _id: new ObjectId(), mailbox: destinationMailbox };
                                messagesById.delete(source._id.toString());
                                messagesById.set(destination._id.toString(), destination);
                                currentMessageIds[index] = destination._id;
                            }
                        }
                    }
                );
            } finally {
                db.users = originalUsers;
                db.database = originalDatabase;
            }

            expect(filters).not.to.be.empty;
            for (const filter of filters) {
                expect(filter.user).to.deep.equal(user);
                if (scenario.q) {
                    expect(filter.$and).to.deep.include({ mailbox: { $in: searchableMailboxes } });
                    expect(filter.$and).to.deep.include({ idate: { $gte: datestart } });
                    expect(filter.$and).to.deep.include({ idate: { $lte: dateend } });
                } else {
                    expect(filter.mailbox).to.deep.equal({ $in: searchableMailboxes });
                    expect(filter.searchable).to.equal(true);
                    expect(filter.idate).to.deep.equal({ $gte: datestart, $lte: dateend });
                }
            }
            expect(moved).to.deep.equal(
                messages
                    .filter(message => !message.mailbox.equals(destinationMailbox))
                    .map(message => ({
                        user,
                        source: { user, mailbox: message.mailbox },
                        destination: { mailbox: destinationMailbox },
                        updates: scenario.updates || false,
                        messageQuery: message.uid
                    }))
            );
            expect(updated).to.deep.equal(
                scenario.updates
                    ? [{ user, mailbox: destinationMailbox, uid: messages[scenario.destinationIndex].uid, updates: scenario.updates }]
                    : []
            );
            expect([...messagesById.values()].every(message => message.mailbox.equals(destinationMailbox))).to.equal(true);
        });
    }

    it('should report a later batch query failure so the worker can retry the task', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const messageIds = Array.from({ length: consts.CURSOR_MAX_PAGE_SIZE + 1 }, () => new ObjectId());
        const failure = new Error('Failed to load next batch');
        const updated = [];
        const originalDatabase = db.database;
        let taskError;

        db.database = {
            collection(name) {
                expect(name).to.equal('messages');
                return {
                    find(filter) {
                        const cursor = createMessageIdCursor(messageIds, filter, () => {});
                        const toArray = cursor.toArray.bind(cursor);
                        cursor.toArray = async () => {
                            if (filter.$and && filter.$and[1] && filter.$and[1]._id && filter.$and[1]._id.$gt) {
                                throw failure;
                            }
                            return toArray();
                        };
                        return cursor;
                    },
                    async findOne(query) {
                        return { _id: query._id, user, mailbox, uid: messageIds.indexOf(query._id) + 1 };
                    }
                };
            }
        };

        try {
            await searchApplyTask(
                { _id: new ObjectId() },
                { user: user.toHexString(), q: 'after:2025-01-01', action: { seen: true } },
                {
                    messageHandler: {
                        update(updateUser, updateMailbox, uid, updates, callback) {
                            updated.push(uid);
                            callback(null, 1);
                        }
                    }
                }
            );
        } catch (err) {
            taskError = err;
        } finally {
            db.database = originalDatabase;
        }

        expect(updated).to.have.length(consts.CURSOR_MAX_PAGE_SIZE);
        expect(taskError).to.equal(failure);
    });

    for (const operation of ['move', 'update', 'delete']) {
        it(`should try remaining matches and report an individual ${operation} failure for retry`, async () => {
            const user = new ObjectId();
            const mailbox = new ObjectId();
            const destination = new ObjectId();
            const messageIds = Array.from({ length: 3 }, () => new ObjectId());
            const failure = new Error(`Failed to ${operation} message`);
            const attempted = [];
            const originalDatabase = db.database;
            let taskError;

            db.database = {
                collection(name) {
                    expect(name).to.equal('messages');
                    return {
                        find(filter) {
                            return createMessageIdCursor(messageIds, filter, () => {});
                        },
                        async findOne(query) {
                            return { _id: query._id, user, mailbox, uid: messageIds.indexOf(query._id) + 1, flags: [] };
                        }
                    };
                }
            };

            const apply = uid => {
                attempted.push(uid);
                if (uid === 2) {
                    throw failure;
                }
                return 1;
            };

            try {
                await searchApplyTask(
                    { _id: new ObjectId() },
                    {
                        user: user.toHexString(),
                        q: 'after:2025-01-01',
                        action: operation === 'move' ? { moveTo: destination.toHexString() } : operation === 'delete' ? { delete: true } : { seen: true }
                    },
                    {
                        messageHandler: {
                            update(updateUser, updateMailbox, uid, updates, callback) {
                                try {
                                    return callback(null, apply(uid));
                                } catch (err) {
                                    return callback(err);
                                }
                            },
                            async getMailboxAsync() {
                                return { _id: destination };
                            },
                            async moveAsync(options) {
                                return apply(options.messageQuery);
                            },
                            async delAsync(options) {
                                return apply(options.messageData.uid);
                            }
                        }
                    }
                );
            } catch (err) {
                taskError = err;
            } finally {
                db.database = originalDatabase;
            }

            expect(attempted).to.deep.equal([1, 2, 3]);
            expect(taskError).to.equal(failure);
        });
    }
});
