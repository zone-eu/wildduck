/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../lib/db');
const onAppend = require('../lib/handlers/on-append');
const onSearch = require('../lib/handlers/on-search');

describe('IMAP label bridge', () => {
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

    it('converts APPEND label flags to stable label ids', done => {
        const user = new ObjectId();
        const label = { _id: new ObjectId(), user, name: 'Team/Blue', slot: 0 };
        const foreignLabel = new ObjectId();
        let addOptions;
        let labelQuery;

        db.database = {
            collection(name) {
                expect(name).to.equal('labels');
                return {
                    find(query) {
                        labelQuery = query;
                        return { toArray: async () => [label] };
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
            id: 'append-label-test',
            user: { id: user, address: 'user@example.com' },
            remoteAddress: '127.0.0.1'
        };

        onAppend(server, messageHandler, userCache)(
            'INBOX',
            ['\\Seen', '$label1', `$wdlabel$${label._id}`, `$wdlabel$${foreignLabel}`, 'Team/Blue'],
            null,
            Buffer.from('Subject: test\r\n\r\nbody'),
            session,
            err => {
                try {
                    expect(err).to.not.exist;
                    expect(labelQuery).to.deep.equal({ user, _id: { $in: [label._id, foreignLabel] } });
                    expect(addOptions.flags).to.deep.equal(['\\Seen', '$label1', `$wdlabel$${foreignLabel}`, 'Team/Blue']);
                    expect(addOptions.labels.map(value => value.toString())).to.deep.equal([label._id.toString()]);
                    return done();
                } catch (testErr) {
                    return done(testErr);
                }
            }
        );
    });

    it('searches stable label ids through the IMAP flag', done => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const label = { _id: new ObjectId(), user, name: 'Team/Blue' };
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
                if (name === 'labels') {
                    return {
                        find() {
                            return { toArray: async () => [label] };
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
        const session = { id: 'search-label-test', user: { id: user }, selected: { uidList: [] } };
        onSearch(server)(mailbox, { query: [{ key: 'flag', value: `$wdlabel$${label._id}`, exists: true }] }, session, (err, result) => {
            try {
                expect(err).to.not.exist;
                expect(result.uidList).to.deep.equal([]);
                expect(messageQuery.$and[0]).to.deep.equal({
                    $or: [{ labels: label._id }, { flags: `$wdlabel$${label._id}` }]
                });
                return done();
            } catch (testErr) {
                return done(testErr);
            }
        });
    });
});
