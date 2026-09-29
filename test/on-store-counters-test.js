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
        const label = { _id: new ObjectId(), user, name: 'legacy-label' };
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
                callback(null, { _id: message, uid: 1, flags: ['\\Seen', '\\Flagged'], labels: [label._id], modseq: 1 });
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
                if (name === 'labels') {
                    return {
                        find() {
                            return { toArray: async () => [label] };
                        }
                    };
                }
                expect(name).to.equal('messages');
                return {
                    async distinct() {
                        return [label._id];
                    },
                    find() {
                        return cursor;
                    },
                    bulkWrite(updates, options, callback) {
                        expect(updates).to.have.lengthOf(1);
                        const pipelineSet = updates[0].updateOne.update[0].$set;
                        expect(pipelineSet).to.deep.include({ unseen: { $literal: true }, flagged: { $literal: false }, modseq: { $literal: 2 } });
                        expect(pipelineSet.labels.$setUnion[0].$filter.input).to.deep.equal({ $ifNull: ['$labels', []] });
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

        onStore(server)(mailbox, { messages: [1], action: 'remove', value: ['\\Seen', '\\Flagged', `$wdlabel$${label._id}`], silent: true }, session, err => {
            db.database = databaseSnapshot;
            try {
                expect(err).to.not.exist;
                expect(notification).to.include({ unseenChange: true, flaggedChangedTo: false });
                expect(notification.removedLabels).to.deep.equal(['legacy-label']);
                expect(notification).to.not.have.property('addedLabels');
                return done();
            } catch (testErr) {
                return done(testErr);
            }
        });
    });

    it('stores IMAP labels as ids and emits label deltas', done => {
        const databaseSnapshot = db.database;
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const message = new ObjectId();
        const label = { _id: new ObjectId(), user, name: 'Projects/Web', slot: 0 };
        const previouslyUnknown = new ObjectId();
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
                callback(null, this.calls++ ? null : { _id: message, uid: 1, flags: ['\\Seen', `$wdlabel$${previouslyUnknown}`], labels: [], modseq: 1 });
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
                            expect(update.$addToSet.flags.$each).to.deep.equal(['$label1']);
                            callback();
                        }
                    };
                }
                if (name === 'labels') {
                    return {
                        find() {
                            return { toArray: async () => [label, { _id: previouslyUnknown, user, name: 'Created later' }] };
                        }
                    };
                }
                return {
                    async distinct() {
                        return [];
                    },
                    find() {
                        return cursor;
                    },
                    bulkWrite(updates, options, callback) {
                        const stored = updates[0].updateOne.update[0].$set;
                        expect(stored.flags.$setUnion[1].$literal).to.deep.equal(['$label1']);
                        expect(stored.labels.$setUnion[1].$literal.map(value => value.toString())).to.deep.equal([label._id.toString()]);
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
            id: 'store-label-test',
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

        onStore(server)(mailbox, { messages: [1], action: 'add', value: [`$wdlabel$${label._id}`, `$wdlabel$${previouslyUnknown}`, '$label1'], silent: false }, session, err => {
            db.database = databaseSnapshot;
            try {
                expect(err).to.not.exist;
                expect(responseFlags).to.deep.equal(['\\Seen', `$wdlabel$${previouslyUnknown}`, '$label1', `$wdlabel$${label._id}`]);
                expect(notification.addedLabels).to.deep.equal(['Projects/Web']);
                expect(notification).to.not.have.property('removedLabels');
                return done();
            } catch (testErr) {
                return done(testErr);
            }
        });
    });
});
