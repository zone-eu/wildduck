/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../lib/db');
const onStore = require('../lib/handlers/on-store');

describe('on-store counter notifications', () => {
    it('reports actual seen and flagged transitions from IMAP STORE', done => {
        const databaseSnapshot = db.database;
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const message = new ObjectId();
        const keyword = { _id: new ObjectId(), user, path: 'legacy-keyword' };
        let notification;

        const cursor = {
            calls: 0,
            project() {
                return this;
            },
            maxTimeMS() {
                return this;
            },
            sort() {
                return this;
            },
            next(callback) {
                if (this.calls++) {
                    return callback(null, null);
                }
                callback(null, { _id: message, uid: 1, flags: ['\\Seen', '\\Flagged'], keywords: [keyword._id], modseq: 1 });
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
                            callback(null, { _id: mailbox, user, flags: [] });
                        },
                        findOneAndUpdate(query, update, options, callback) {
                            callback(null, { value: { modifyIndex: 2 } });
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
                    find() {
                        return cursor;
                    },
                    bulkWrite(updates, options, callback) {
                        expect(updates).to.have.lengthOf(1);
                        expect(updates[0].updateOne.update.$set).to.include({ unseen: true, flagged: false, modseq: 2 });
                        expect(updates[0].updateOne.update.$set.keywords).to.deep.equal([]);
                        callback();
                    }
                };
            }
        };

        const server = {
            logger: { debug() {} },
            notifier: {
                addEntries(mailboxData, entries, callback) {
                    notification = entries[0];
                    callback();
                },
                fire() {}
            }
        };
        const session = {
            id: 'store-test',
            user: { id: user },
            selected: { uidList: [1], condstoreEnabled: false },
            writeStream: { write() {} },
            formatResponse() {}
        };

        onStore(server)(mailbox, { messages: [1], action: 'remove', value: ['\\Seen', '\\Flagged', 'legacy-keyword'], silent: true }, session, err => {
            db.database = databaseSnapshot;
            try {
                expect(err).to.not.exist;
                expect(notification).to.include({ unseenChange: true, flaggedChangedTo: false });
                expect(notification.removedKeywords).to.deep.equal(['legacy-keyword']);
                expect(notification).to.not.have.property('addedKeywords');
                return done();
            } catch (testErr) {
                return done(testErr);
            }
        });
    });

    it('stores IMAP keywords as ids and emits keyword deltas', done => {
        const databaseSnapshot = db.database;
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const message = new ObjectId();
        const keyword = { _id: new ObjectId(), user, path: 'Projects/Web', slot: 0 };
        const parentKeyword = { _id: new ObjectId(), user, path: 'Projects', slot: 1 };
        let notification;
        let responseFlags;

        const cursor = {
            calls: 0,
            project() {
                return this;
            },
            maxTimeMS() {
                return this;
            },
            sort() {
                return this;
            },
            next(callback) {
                callback(null, this.calls++ ? null : { _id: message, uid: 1, flags: ['\\Seen'], keywords: [], modseq: 1 });
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
                            callback(null, { _id: mailbox, user, flags: [] });
                        },
                        findOneAndUpdate(query, update, options, callback) {
                            callback(null, { value: { modifyIndex: 2 } });
                        },
                        updateOne(query, update, options, callback) {
                            callback();
                        }
                    };
                }
                if (name === 'keywords') {
                    return {
                        find() {
                            return { toArray: async () => [keyword, parentKeyword] };
                        }
                    };
                }
                return {
                    find() {
                        return cursor;
                    },
                    bulkWrite(updates, options, callback) {
                        const stored = updates[0].updateOne.update.$set;
                        expect(stored.flags).to.deep.equal(['\\Seen']);
                        expect(stored.keywords.map(value => value.toString())).to.deep.equal([keyword._id.toString()]);
                        callback();
                    }
                };
            }
        };

        const server = {
            logger: { debug() {} },
            notifier: {
                addEntries(mailboxData, entries, callback) {
                    notification = entries[0];
                    callback();
                },
                fire() {}
            }
        };
        const session = {
            id: 'store-keyword-test',
            user: { id: user },
            selected: { uidList: [1], condstoreEnabled: false },
            writeStream: {
                write() {}
            },
            formatResponse(command, uid, data) {
                responseFlags = data.flags;
                return {};
            }
        };

        onStore(server)(mailbox, { messages: [1], action: 'add', value: ['Projects/Web'], silent: false }, session, err => {
            db.database = databaseSnapshot;
            try {
                expect(err).to.not.exist;
                expect(responseFlags).to.deep.equal(['\\Seen', 'Projects/Web']);
                expect(notification.addedKeywords).to.deep.equal(['Projects/Web']);
                expect(notification).to.not.have.property('removedKeywords');
                return done();
            } catch (testErr) {
                return done(testErr);
            }
        });
    });
});
