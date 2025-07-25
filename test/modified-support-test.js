'use strict';

/* eslint-disable no-unused-expressions */

const { expect } = require('chai');
const onStore = require('../lib/handlers/on-store');
const db = require('../lib/db');

describe('IMAP STORE Modified Support Tests', () => {
    let mockServer;
    let mockSession;
    let mockMailbox;
    let callCount;

    beforeEach(() => {
        callCount = 0;
        mockMailbox = 'testmailbox123';

        mockSession = {
            id: 'testsession',
            user: { id: 'testuser' },
            selected: {
                uidList: [1, 2, 3, 4, 5],
                condstoreEnabled: true
            },
            writeStream: {
                write: () => {} // Mock write stream
            },
            formatResponse: () => 'MOCK RESPONSE' // Mock format response
        };

        mockServer = {
            logger: {
                debug: () => {}
            },
            notifier: {
                addEntries: (mailboxData, entries, callback) => callback(),
                fire: () => {}
            }
        };

        // Mock database
        db.database = {
            collection: (name) => {
                if (name === 'mailboxes') {
                    return {
                        findOne: (query, options, callback) => callback(null, {
                            _id: mockMailbox,
                            modifyIndex: 100,
                            flags: ['\\Seen', '\\Flagged']
                        }),
                        findOneAndUpdate: (query, update, options, callback) => callback(null, {
                            value: { modifyIndex: 101 }
                        }),
                        updateOne: (query, update, options, callback) => callback(null, { modifiedCount: 1 })
                    };
                } else if (name === 'messages') {
                    return {
                        find: () => ({
                            project: () => ({
                                maxTimeMS: () => ({
                                    sort: () => ({
                                        next: (callback) => {
                                            // Simulate messages with different modseq values
                                            callCount++;

                                            if (callCount === 1) {
                                                // First message - not modified since unchangedSince
                                                return callback(null, {
                                                    _id: 'msg1',
                                                    uid: 1,
                                                    flags: ['\\Seen'],
                                                    thread: 'thread1',
                                                    modseq: 50 // Lower than unchangedSince
                                                });
                                            } else if (callCount === 2) {
                                                // Second message - modified since unchangedSince
                                                return callback(null, {
                                                    _id: 'msg2',
                                                    uid: 2,
                                                    flags: [],
                                                    thread: 'thread2',
                                                    modseq: 80 // Higher than unchangedSince
                                                });
                                            } else if (callCount === 3) {
                                                // Third message - not modified since unchangedSince
                                                return callback(null, {
                                                    _id: 'msg3',
                                                    uid: 3,
                                                    flags: [],
                                                    thread: 'thread3',
                                                    modseq: 60 // Lower than unchangedSince
                                                });
                                            } else {
                                                // No more messages
                                                return callback(null, null);
                                            }
                                        },
                                        close: (callback) => callback()
                                    })
                                })
                            })
                        }),
                        bulkWrite: (operations, options, callback) => callback(null, { modifiedCount: operations.length })
                    };
                }
            }
        };
    });

    afterEach(() => {
        callCount = 0;
    });

    it('should return modified UIDs when UNCHANGEDSINCE is used and messages have higher modseq', (done) => {
        const storeHandler = onStore(mockServer);

        const update = {
            messages: [1, 2, 3],
            action: 'add',
            value: ['\\Seen'],
            unchangedSince: 70, // Messages with modseq > 70 should be in modified array
            silent: false,
            isUid: true
        };

        storeHandler(mockMailbox, update, mockSession, (err, success, modified) => {
            expect(err).to.be.null;
            expect(success).to.be.true;
            expect(modified).to.be.an('array');
            expect(modified).to.include(2); // UID 2 has modseq 80 > unchangedSince 70
            expect(modified).to.not.include(1); // UID 1 has modseq 50 < unchangedSince 70
            expect(modified).to.not.include(3); // UID 3 has modseq 60 < unchangedSince 70
            done();
        });
    });

    it('should return empty modified array when no UNCHANGEDSINCE is used', (done) => {
        const storeHandler = onStore(mockServer);

        const update = {
            messages: [1, 2, 3],
            action: 'add',
            value: ['\\Seen'],
            // No unchangedSince property
            silent: false,
            isUid: true
        };

        storeHandler(mockMailbox, update, mockSession, (err, success, modified) => {
            expect(err).to.be.null;
            expect(success).to.be.true;
            expect(modified).to.be.an('array');
            expect(modified).to.have.length(0); // Should be empty when no unchangedSince
            done();
        });
    });

    it('should return empty modified array when all messages have lower modseq than unchangedSince', (done) => {
        const storeHandler = onStore(mockServer);

        const update = {
            messages: [1, 2, 3],
            action: 'add',
            value: ['\\Seen'],
            unchangedSince: 100, // All messages have modseq < 100
            silent: false,
            isUid: true
        };

        storeHandler(mockMailbox, update, mockSession, (err, success, modified) => {
            expect(err).to.be.null;
            expect(success).to.be.true;
            expect(modified).to.be.an('array');
            expect(modified).to.have.length(0); // Should be empty when all messages are older
            done();
        });
    });
});

