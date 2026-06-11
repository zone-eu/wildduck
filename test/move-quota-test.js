/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const { ObjectId } = require('mongodb');

const MessageHandler = require('../lib/message-handler');

describe('moveAsync - encrypted-MOVE quota adjustment', function () {
    let insertedDocs;

    // Build a MessageHandler whose destination insert / source delete behaviour is configurable,
    // with a spy on attachmentStorage.deleteManyAsync. The encrypted form carries one attachment
    // (enc-id-1 / new-magic) so the new-ref cleanup has something to release.
    function buildEncryptedMoveHandler({ insertOneImpl, deleteOneImpl }) {
        const userId = new ObjectId();
        const sourceMailboxId = new ObjectId();
        const targetMailboxId = new ObjectId();
        const messageId = new ObjectId();

        const sourceMessage = {
            _id: messageId,
            mailbox: sourceMailboxId,
            uid: 1,
            size: 1000,
            magic: 'old-magic',
            unseen: false,
            flags: [],
            // empty source attachmentMap keeps the old-ref cleanup out of the picture
            mimeTree: { header: [], attachmentMap: {} }
        };

        let cursorIdx = 0;
        let calls = { deleteManyAsync: [], insertOne: [] };

        let handler = Object.create(MessageHandler.prototype);
        handler.loggelf = () => {};

        handler.database = {
            collection: name => {
                if (name === 'mailboxes') {
                    return {
                        findOne: query => {
                            if (query._id && query._id.equals && query._id.equals(sourceMailboxId)) {
                                return Promise.resolve({ _id: sourceMailboxId, user: userId, path: 'INBOX', uidValidity: 100 });
                            }
                            if (query._id && query._id.equals && query._id.equals(targetMailboxId)) {
                                return Promise.resolve({ _id: targetMailboxId, user: userId, path: 'Vault', uidValidity: 200, encryptMessages: true });
                            }
                            return Promise.resolve(null);
                        },
                        findOneAndUpdate: () => Promise.resolve({ value: { uidNext: 1, modifyIndex: 1 } })
                    };
                }
                if (name === 'messages') {
                    return {
                        find: () => ({
                            sort: () => ({
                                next: () => Promise.resolve(cursorIdx++ === 0 ? sourceMessage : null),
                                close: () => Promise.resolve()
                            })
                        }),
                        insertOne: doc => {
                            calls.insertOne.push(doc);
                            return insertOneImpl(doc, calls.insertOne.length);
                        },
                        deleteOne: () => (deleteOneImpl ? deleteOneImpl() : Promise.resolve({ deletedCount: 1 }))
                    };
                }
                throw new Error('unexpected handler.database.collection: ' + name);
            }
        };

        handler.users = {
            collection: () => ({
                findOne: () => Promise.resolve({ _id: userId, encryptMessages: true, smimeCerts: ['fake-cert'] }),
                findOneAndUpdate: () => Promise.resolve({ value: { storageUsed: 100 } })
            })
        };

        handler.settingsHandler = { get: () => Promise.resolve(100) };
        handler.notifier = {
            addEntries: (mailbox, entries, cb) => {
                if (cb) {
                    return cb();
                }
            },
            fire: () => {}
        };
        handler.indexer = { getMaildata: () => ({ attachments: [], magic: 'new-magic' }) };
        handler.attachmentStorage = {
            deleteManyAsync: (ids, magic) => {
                calls.deleteManyAsync.push({ ids, magic });
                return Promise.resolve();
            }
        };
        handler.encryptAndPrepareMessageAsync = () =>
            Promise.resolve({
                prepared: {
                    mimeTree: { header: [], attachmentMap: { '1': 'enc-id-1' } },
                    size: 1500,
                    bodystructure: {},
                    envelope: {},
                    headers: {}
                },
                maildata: { attachments: [], magic: 'new-magic' },
                type: 'smime'
            });

        return { handler, calls, sourceMailboxId, targetMailboxId };
    }

    async function runMove(handler, sourceMailboxId, targetMailboxId) {
        let err;
        try {
            await handler.moveAsync({
                source: { mailbox: sourceMailboxId },
                destination: { mailbox: targetMailboxId },
                messages: [1]
            });
        } catch (e) {
            err = e;
        }
        return err;
    }

    it('releases newly encrypted attachments when the destination insert is not acknowledged', async function () {
        let { handler, calls, sourceMailboxId, targetMailboxId } = buildEncryptedMoveHandler({
            insertOneImpl: () => Promise.resolve({ acknowledged: false })
        });

        let err = await runMove(handler, sourceMailboxId, targetMailboxId);

        expect(err).to.be.an('error');
        expect(calls.deleteManyAsync).to.have.lengthOf(1);
        expect(calls.deleteManyAsync[0].ids).to.deep.equal(['enc-id-1']);
        expect(calls.deleteManyAsync[0].magic).to.equal('new-magic');
    });

    it('releases newly encrypted attachments when the destination insert throws', async function () {
        let { handler, calls, sourceMailboxId, targetMailboxId } = buildEncryptedMoveHandler({
            insertOneImpl: () => Promise.reject(Object.assign(new Error('insert boom'), { code: 'StoreError' }))
        });

        let err = await runMove(handler, sourceMailboxId, targetMailboxId);

        expect(err).to.be.an('error');
        expect(calls.deleteManyAsync).to.have.lengthOf(1);
        expect(calls.deleteManyAsync[0].ids).to.deep.equal(['enc-id-1']);
        expect(calls.deleteManyAsync[0].magic).to.equal('new-magic');
    });

    it('does NOT release newly encrypted attachments when the source delete fails after a successful insert', async function () {
        let { handler, calls, sourceMailboxId, targetMailboxId } = buildEncryptedMoveHandler({
            insertOneImpl: () => Promise.resolve({ acknowledged: true, insertedId: new ObjectId() }),
            deleteOneImpl: () => Promise.reject(Object.assign(new Error('delete boom'), { code: 'DeleteError' }))
        });

        let err = await runMove(handler, sourceMailboxId, targetMailboxId);

        expect(err).to.be.an('error');
        // the destination doc is live and still owns the encrypted refs - they must NOT be released
        expect(calls.deleteManyAsync.some(c => c.ids && c.ids.includes('enc-id-1'))).to.be.false;
    });

    it('increments storageUsed by the encrypted-vs-source size delta', async function () {
        const userId = new ObjectId();
        const sourceMailboxId = new ObjectId();
        const targetMailboxId = new ObjectId();
        const messageId = new ObjectId();

        const sourceMessage = {
            _id: messageId,
            mailbox: sourceMailboxId,
            uid: 1,
            size: 1000,
            magic: 'old-magic',
            unseen: false,
            flags: [],
            mimeTree: { header: [], attachmentMap: {} },
            // Stale plaintext fields from when the source was indexed unencrypted.
            text: 'plaintext body start',
            textFooter: 'plaintext spillover that exceeded MAX_PLAINTEXT_INDEXED',
            html: ['<p>plaintext html</p>'],
            intro: 'plaintext intro'
        };

        let cursorIdx = 0;
        let quotaIncCalls = [];
        insertedDocs = [];

        let handler = Object.create(MessageHandler.prototype);
        handler.loggelf = () => {};

        handler.database = {
            collection: name => {
                if (name === 'mailboxes') {
                    return {
                        findOne: query => {
                            if (query._id && query._id.equals && query._id.equals(sourceMailboxId)) {
                                return Promise.resolve({ _id: sourceMailboxId, user: userId, path: 'INBOX', uidValidity: 100 });
                            }
                            if (query._id && query._id.equals && query._id.equals(targetMailboxId)) {
                                return Promise.resolve({
                                    _id: targetMailboxId,
                                    user: userId,
                                    path: 'Vault',
                                    uidValidity: 200,
                                    encryptMessages: true
                                });
                            }
                            return Promise.resolve(null);
                        },
                        // Returns a uidNext/modifyIndex value for both the source-modseq bump
                        // before the loop and the target-uidNext bump inside the loop.
                        findOneAndUpdate: () => Promise.resolve({ value: { uidNext: 1, modifyIndex: 1 } })
                    };
                }
                if (name === 'messages') {
                    return {
                        find: () => ({
                            sort: () => ({
                                next: () => Promise.resolve(cursorIdx++ === 0 ? sourceMessage : null),
                                close: () => Promise.resolve()
                            })
                        }),
                        insertOne: doc => {
                            insertedDocs.push(doc);
                            return Promise.resolve({ acknowledged: true, insertedId: new ObjectId() });
                        },
                        deleteOne: () => Promise.resolve({ deletedCount: 1 })
                    };
                }
                throw new Error('unexpected handler.database.collection: ' + name);
            }
        };

        handler.users = {
            collection: () => ({
                findOne: () => Promise.resolve({
                    _id: userId,
                    encryptMessages: true,
                    smimeCerts: ['fake-cert']
                }),
                findOneAndUpdate: (query, update) => {
                    if (update && update.$inc && 'storageUsed' in update.$inc) {
                        quotaIncCalls.push(update.$inc.storageUsed);
                    }
                    return Promise.resolve({ value: { storageUsed: 100 } });
                }
            })
        };

        handler.settingsHandler = {
            get: () => Promise.resolve(100)
        };

        handler.notifier = {
            addEntries: (mailbox, entries, cb) => {
                if (cb) {
                    return cb();
                }
            },
            fire: () => {}
        };

        handler.indexer = {
            getMaildata: () => ({ attachments: [], magic: 'new-magic' })
        };

        handler.attachmentStorage = {
            deleteManyAsync: () => Promise.resolve()
        };

        // Stub the encryption result: encrypted form is 500 bytes larger than source.
        handler.encryptAndPrepareMessageAsync = () =>
            Promise.resolve({
                prepared: {
                    mimeTree: { header: [], attachmentMap: {} },
                    size: 1500,
                    bodystructure: {},
                    envelope: {},
                    headers: {}
                },
                maildata: { attachments: [], magic: 'new-magic' },
                type: 'smime'
            });

        await handler.moveAsync({
            source: { mailbox: sourceMailboxId },
            destination: { mailbox: targetMailboxId },
            messages: [1]
        });

        // Cleanup block must have called updateQuotaAsync with sizeDelta = 1500 - 1000 = 500
        expect(quotaIncCalls).to.deep.equal([500]);

        // The moved-and-encrypted document must not carry the source's plaintext-derived fields.
        expect(insertedDocs).to.have.lengthOf(1);
        let moved = insertedDocs[0];
        expect(moved).to.not.have.property('text');
        expect(moved).to.not.have.property('textFooter');
        expect(moved).to.not.have.property('html');
        expect(moved.intro).to.equal('');
    });
});
