/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../lib/db');
const onAppend = require('../lib/handlers/on-append');
const onSearch = require('../lib/handlers/on-search');

describe('IMAP keyword bridge', () => {
    let databaseSnapshot;
    let usersSnapshot;

    beforeEach(() => {
        databaseSnapshot = db.database;
        usersSnapshot = db.users;
    });

    afterEach(() => {
        db.database = databaseSnapshot;
        db.users = usersSnapshot;
    });

    it('converts APPEND keyword flags to stable keyword ids', done => {
        const user = new ObjectId();
        const keyword = { _id: new ObjectId(), user, path: 'Team/Blue', slot: 0 };
        const parentKeyword = { _id: new ObjectId(), user, path: 'Team', slot: 1 };
        let addOptions;

        db.database = {
            collection(name) {
                expect(name).to.equal('keywords');
                return {
                    find() {
                        return { toArray: async () => [keyword, parentKeyword] };
                    }
                };
            }
        };
        db.users = {
            collection(name) {
                expect(name).to.equal('users');
                return {
                    findOne(query, options, callback) {
                        callback(null, { _id: user, storageUsed: 0 });
                    }
                };
            }
        };

        const messageHandler = {
            counters: {
                ttlcounter(key, increment, limit, strict, callback) {
                    callback(null, { success: true });
                }
            },
            add(options, callback) {
                addOptions = options;
                callback(null, true, { uid: 1 });
            }
        };
        const server = {
            logger: { debug() {}, error() {} },
            loggelf() {}
        };
        const userCache = {
            get(id, key, options, callback) {
                callback(null, 0);
            }
        };
        const session = {
            id: 'append-keyword-test',
            user: { id: user, address: 'user@example.com' },
            remoteAddress: '127.0.0.1'
        };

        onAppend(server, messageHandler, userCache)(
            'INBOX',
            ['\\Seen', '$label1', 'Team/Blue'],
            null,
            Buffer.from('Subject: test\r\n\r\nbody'),
            session,
            err => {
                try {
                    expect(err).to.not.exist;
                    expect(addOptions.flags).to.deep.equal(['\\Seen', '$label1']);
                    expect(addOptions.keywords.map(value => value.toString())).to.deep.equal([keyword._id.toString()]);
                    return done();
                } catch (testErr) {
                    return done(testErr);
                }
            }
        );
    });

    it('searches stable keyword ids while retaining legacy flag compatibility', done => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const keyword = { _id: new ObjectId(), user, path: 'Team/Blue' };
        let messageQuery;

        const cursor = {
            project() {
                return this;
            },
            withReadPreference() {
                return this;
            },
            maxTimeMS() {
                return this;
            },
            next(callback) {
                callback(null, null);
            },
            close(callback) {
                callback();
            }
        };
        db.database = {
            collection(name) {
                if (name === 'mailboxes') {
                    return {
                        findOne(query, options, callback) {
                            callback(null, { _id: mailbox, user });
                        }
                    };
                }
                if (name === 'keywords') {
                    return {
                        find() {
                            return { toArray: async () => [keyword] };
                        }
                    };
                }
                expect(name).to.equal('messages');
                return {
                    find(query) {
                        messageQuery = query;
                        return cursor;
                    }
                };
            }
        };

        const server = { logger: { info() {}, error() {} } };
        const session = { id: 'search-keyword-test', user: { id: user }, selected: { uidList: [] } };
        onSearch(server)(mailbox, { query: [{ key: 'flag', value: 'team/blue', exists: true }] }, session, (err, result) => {
            try {
                expect(err).to.not.exist;
                expect(result.uidList).to.deep.equal([]);
                expect(messageQuery.$and[0]).to.deep.equal({
                    $or: [{ keywords: keyword._id }, { flags: 'Team/Blue' }]
                });
                return done();
            } catch (testErr) {
                return done(testErr);
            }
        });
    });
});
