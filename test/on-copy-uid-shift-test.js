/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const { ObjectId } = require('mongodb');

const db = require('../lib/db');
const onCopy = require('../lib/handlers/on-copy');

describe('on-copy UID arrays', function () {
    let userId, sourceMailboxId, targetMailboxId;
    let dbSnapshot;
    let insertCalls;
    let nextUid;

    before(function () {
        userId = new ObjectId();
        sourceMailboxId = new ObjectId();
        targetMailboxId = new ObjectId();
        dbSnapshot = { users: db.users, database: db.database };
    });

    after(function () {
        db.users = dbSnapshot.users;
        db.database = dbSnapshot.database;
    });

    beforeEach(function () {
        insertCalls = 0;
        nextUid = 1;

        let sourceMessages = [
            { _id: new ObjectId(), mailbox: sourceMailboxId, uid: 10, size: 100, flags: [], mimeTree: { header: [] } },
            { _id: new ObjectId(), mailbox: sourceMailboxId, uid: 20, size: 200, flags: [], mimeTree: { header: [] } }
        ];
        let cursorIdx = 0;

        let mailboxesCollection = {
            findOne: query => {
                if (query._id && query._id.equals && query._id.equals(sourceMailboxId)) {
                    return Promise.resolve({ _id: sourceMailboxId, user: userId, path: 'INBOX' });
                }
                if (query.user && query.path === 'Vault') {
                    return Promise.resolve({ _id: targetMailboxId, user: userId, path: 'Vault', uidValidity: 1000 });
                }
                return Promise.resolve(null);
            },
            findOneAndUpdate: () => Promise.resolve({ value: { uidNext: nextUid++, modifyIndex: 0 } })
        };

        let messagesCollection = {
            find: () => ({
                sort: () => ({
                    maxTimeMS: () => ({
                        next: () => Promise.resolve(sourceMessages[cursorIdx++] || null),
                        close: () => Promise.resolve()
                    })
                })
            }),
            updateOne: () => Promise.resolve({ matchedCount: 1, modifiedCount: 1 }),
            insertOne: () => {
                insertCalls++;
                // First insert succeeds, second comes back not acknowledged
                if (insertCalls === 1) {
                    return Promise.resolve({ acknowledged: true, insertedId: new ObjectId() });
                }
                return Promise.resolve({ acknowledged: false });
            }
        };

        let usersCollection = {
            findOne: () => Promise.resolve({ _id: userId, quota: 0, storageUsed: 0 }),
            findOneAndUpdate: () => Promise.resolve({ value: { storageUsed: 100 } })
        };

        db.database = {
            collection: name => {
                if (name === 'mailboxes') return mailboxesCollection;
                if (name === 'messages') return messagesCollection;
                throw new Error('unexpected db.database.collection: ' + name);
            }
        };
        db.users = {
            collection: name => {
                if (name === 'users') return usersCollection;
                throw new Error('unexpected db.users.collection: ' + name);
            }
        };
    });

    it('clears plaintext index fields when copying into an encrypted mailbox', async function () {
        let sourceMessages = [
            {
                _id: new ObjectId(),
                mailbox: sourceMailboxId,
                uid: 10,
                size: 100,
                flags: [],
                mimeTree: { header: [], attachmentMap: {} },
                // Stale plaintext fields from when the source was indexed unencrypted.
                text: 'plaintext body start',
                textFooter: 'plaintext spillover that exceeded MAX_PLAINTEXT_INDEXED',
                html: ['<p>plaintext html</p>'],
                intro: 'plaintext intro'
            }
        ];
        let cursorIdx = 0;
        let insertedDoc = null;

        db.database = {
            collection: name => {
                if (name === 'mailboxes') {
                    return {
                        findOne: query => {
                            if (query._id && query._id.equals && query._id.equals(sourceMailboxId)) {
                                return Promise.resolve({ _id: sourceMailboxId, user: userId, path: 'INBOX' });
                            }
                            if (query.user && query.path === 'Vault') {
                                return Promise.resolve({
                                    _id: targetMailboxId,
                                    user: userId,
                                    path: 'Vault',
                                    uidValidity: 1000,
                                    encryptMessages: true
                                });
                            }
                            return Promise.resolve(null);
                        },
                        findOneAndUpdate: () => Promise.resolve({ value: { uidNext: 1, modifyIndex: 0 } })
                    };
                }
                if (name === 'messages') {
                    return {
                        find: () => ({
                            sort: () => ({
                                maxTimeMS: () => ({
                                    next: () => Promise.resolve(sourceMessages[cursorIdx++] || null),
                                    close: () => Promise.resolve()
                                })
                            })
                        }),
                        updateOne: () => Promise.resolve({ matchedCount: 1, modifiedCount: 1 }),
                        insertOne: doc => {
                            insertedDoc = doc;
                            return Promise.resolve({ acknowledged: true, insertedId: new ObjectId() });
                        }
                    };
                }
                throw new Error('unexpected db.database.collection: ' + name);
            }
        };
        db.users = {
            collection: () => ({
                findOne: () => Promise.resolve({ _id: userId, quota: 0, storageUsed: 0, smimeCerts: ['fake-cert-pem'] }),
                findOneAndUpdate: () => Promise.resolve({ value: { storageUsed: 100 } })
            })
        };

        let server = {
            logger: { debug() {}, error() {} },
            loggelf() {},
            notifier: {
                addEntries(target, entry, cb) {
                    if (cb) {
                        return cb();
                    }
                },
                fire() {}
            }
        };

        let messageHandler = {
            isMessageEncrypted: () => false,
            _getContentType: () => '',
            attachmentStorage: { updateMany: () => Promise.resolve() },
            // Stub returns a fresh prepared/maildata so the copy handler treats this as a successful encrypt.
            encryptAndPrepareMessageAsync: () =>
                Promise.resolve({
                    prepared: {
                        mimeTree: { header: [], attachmentMap: {} },
                        size: 500,
                        bodystructure: {},
                        envelope: {},
                        headers: {}
                    },
                    maildata: { attachments: [], magic: 'new-magic' },
                    type: 'smime'
                })
        };

        let connection = { send() {} };
        let session = {
            id: 'test-session',
            user: { id: userId, address: 'test@example.com' },
            socket: { destroyed: false, readyState: 'open' }
        };

        let handler = onCopy(server, messageHandler);

        let { status } = await new Promise((resolve, reject) => {
            handler(connection, sourceMailboxId, { messages: [10], destination: 'Vault' }, session, (err, s, i) => {
                if (err) return reject(err);
                resolve({ status: s, info: i });
            });
        });

        expect(status).to.be.true;
        expect(insertedDoc).to.not.be.null;
        // Stored encrypted-copy document must not carry the source's plaintext-derived fields.
        expect(insertedDoc).to.not.have.property('text');
        expect(insertedDoc).to.not.have.property('textFooter');
        expect(insertedDoc).to.not.have.property('html');
        expect(insertedDoc.intro).to.equal('');
    });

    // Build a self-contained COPY environment with spies on the attachment-storage refcount calls.
    function setupCopyEnv({ sourceMessages, targetEncrypted = false, encryptResult = null, insertOneImpl, updateManyImpl, deleteManyAsyncImpl }) {
        let cursorIdx = 0;
        let calls = { insertOne: [], updateOneCopied: [], updateMany: [], deleteManyAsync: [] };

        let mailboxesCollection = {
            findOne: query => {
                if (query._id && query._id.equals && query._id.equals(sourceMailboxId)) {
                    return Promise.resolve({ _id: sourceMailboxId, user: userId, path: 'INBOX' });
                }
                if (query.user && query.path === 'Vault') {
                    return Promise.resolve({ _id: targetMailboxId, user: userId, path: 'Vault', uidValidity: 1000, encryptMessages: !!targetEncrypted });
                }
                return Promise.resolve(null);
            },
            findOneAndUpdate: () => Promise.resolve({ value: { uidNext: nextUid++, modifyIndex: 0 } })
        };

        let messagesCollection = {
            find: () => ({
                sort: () => ({
                    maxTimeMS: () => ({
                        next: () => Promise.resolve(sourceMessages[cursorIdx++] || null),
                        close: () => Promise.resolve()
                    })
                })
            }),
            updateOne: (query, update) => {
                if (update && update.$set && update.$set.copied) {
                    calls.updateOneCopied.push(query);
                }
                return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
            },
            insertOne: doc => {
                calls.insertOne.push(doc);
                return insertOneImpl(doc, calls.insertOne.length);
            }
        };

        let usersCollection = {
            findOne: () => Promise.resolve({ _id: userId, quota: 0, storageUsed: 0, smimeCerts: ['fake-cert-pem'] }),
            findOneAndUpdate: () => Promise.resolve({ value: { storageUsed: 100 } })
        };

        db.database = {
            collection: name => {
                if (name === 'mailboxes') return mailboxesCollection;
                if (name === 'messages') return messagesCollection;
                throw new Error('unexpected db.database.collection: ' + name);
            }
        };
        db.users = {
            collection: name => {
                if (name === 'users') return usersCollection;
                throw new Error('unexpected db.users.collection: ' + name);
            }
        };

        let server = {
            logger: { debug() {}, error() {} },
            loggelf() {},
            notifier: {
                addEntries(target, entry, cb) {
                    if (cb) {
                        return cb();
                    }
                },
                fire() {}
            }
        };

        let messageHandler = {
            isMessageEncrypted: () => false,
            _getContentType: () => '',
            encryptAndPrepareMessageAsync: () => Promise.resolve(encryptResult),
            attachmentStorage: {
                updateMany: (ids, count, magic) => {
                    calls.updateMany.push({ ids, count, magic });
                    return updateManyImpl ? updateManyImpl(ids, count, magic) : Promise.resolve();
                },
                deleteManyAsync: (ids, magic) => {
                    calls.deleteManyAsync.push({ ids, magic });
                    return deleteManyAsyncImpl ? deleteManyAsyncImpl(ids, magic) : Promise.resolve();
                }
            }
        };

        return { server, messageHandler, calls };
    }

    function runCopy(server, messageHandler, messages) {
        let connection = { send() {} };
        let session = {
            id: 'test-session',
            user: { id: userId, address: 'test@example.com' },
            socket: { destroyed: false, readyState: 'open' }
        };
        let handler = onCopy(server, messageHandler);
        return new Promise((resolve, reject) => {
            handler(connection, sourceMailboxId, { messages, destination: 'Vault' }, session, (err, s, i) => {
                if (err) return reject(err);
                resolve({ status: s, info: i });
            });
        });
    }

    let encryptResult = {
        prepared: {
            mimeTree: { header: [], attachmentMap: { '1': 'enc-id-1' } },
            size: 500,
            bodystructure: {},
            envelope: {},
            headers: {}
        },
        maildata: { attachments: [], magic: 'new-magic' },
        type: 'smime'
    };

    it('releases newly encrypted attachments when the encrypted-copy insert is not acknowledged', async function () {
        let { server, messageHandler, calls } = setupCopyEnv({
            sourceMessages: [{ _id: new ObjectId(), mailbox: sourceMailboxId, uid: 10, size: 100, flags: [], magic: 'src-magic', mimeTree: { header: [], attachmentMap: { '1': 'src-id-1' } } }],
            targetEncrypted: true,
            encryptResult,
            insertOneImpl: () => Promise.resolve({ acknowledged: false })
        });

        let { status, info } = await runCopy(server, messageHandler, [10]);

        expect(status).to.be.true;
        // failed insert is dropped from the result
        expect(info.sourceUid).to.deep.equal([]);
        // encrypted bodies created by storeNodeBodies() must be released with the NEW magic
        expect(calls.deleteManyAsync).to.have.lengthOf(1);
        expect(calls.deleteManyAsync[0].ids).to.deep.equal(['enc-id-1']);
        expect(calls.deleteManyAsync[0].magic).to.equal('new-magic');
        // encrypted path never bumps refcount via updateMany, and a failed copy must not mark the source
        expect(calls.updateMany).to.have.lengthOf(0);
        expect(calls.updateOneCopied).to.have.lengthOf(0);
    });

    it('releases newly encrypted attachments and propagates when the encrypted-copy insert throws', async function () {
        let { server, messageHandler, calls } = setupCopyEnv({
            sourceMessages: [{ _id: new ObjectId(), mailbox: sourceMailboxId, uid: 10, size: 100, flags: [], magic: 'src-magic', mimeTree: { header: [], attachmentMap: { '1': 'src-id-1' } } }],
            targetEncrypted: true,
            encryptResult,
            insertOneImpl: () => Promise.reject(Object.assign(new Error('insert boom'), { code: 'StoreError' }))
        });

        let err;
        try {
            await runCopy(server, messageHandler, [10]);
        } catch (e) {
            err = e;
        }

        expect(err).to.be.an('error');
        expect(calls.deleteManyAsync).to.have.lengthOf(1);
        expect(calls.deleteManyAsync[0].ids).to.deep.equal(['enc-id-1']);
        expect(calls.deleteManyAsync[0].magic).to.equal('new-magic');
        expect(calls.updateOneCopied).to.have.lengthOf(0);
    });

    it('increments plaintext refcount before insert and releases it when the insert is not acknowledged', async function () {
        let { server, messageHandler, calls } = setupCopyEnv({
            sourceMessages: [{ _id: new ObjectId(), mailbox: sourceMailboxId, uid: 10, size: 100, flags: [], magic: 'src-magic', mimeTree: { header: [], attachmentMap: { '1': 'src-id-1' } } }],
            targetEncrypted: false,
            insertOneImpl: () => Promise.resolve({ acknowledged: false })
        });

        let { status } = await runCopy(server, messageHandler, [10]);

        expect(status).to.be.true;
        // +1 established before the insert
        expect(calls.updateMany).to.have.lengthOf(1);
        expect(calls.updateMany[0].ids).to.deep.equal(['src-id-1']);
        expect(calls.updateMany[0].count).to.equal(1);
        expect(calls.updateMany[0].magic).to.equal('src-magic');
        // and released after the insert failed
        expect(calls.deleteManyAsync).to.have.lengthOf(1);
        expect(calls.deleteManyAsync[0].ids).to.deep.equal(['src-id-1']);
        expect(calls.deleteManyAsync[0].magic).to.equal('src-magic');
        expect(calls.updateOneCopied).to.have.lengthOf(0);
    });

    it('skips the message without inserting when the plaintext refcount increment fails', async function () {
        let { server, messageHandler, calls } = setupCopyEnv({
            sourceMessages: [{ _id: new ObjectId(), mailbox: sourceMailboxId, uid: 10, size: 100, flags: [], magic: 'src-magic', mimeTree: { header: [], attachmentMap: { '1': 'src-id-1' } } }],
            targetEncrypted: false,
            insertOneImpl: () => Promise.resolve({ acknowledged: true, insertedId: new ObjectId() }),
            updateManyImpl: () => Promise.reject(Object.assign(new Error('refcount boom'), { code: 'AttachmentUpdateError' }))
        });

        let { status, info } = await runCopy(server, messageHandler, [10]);

        expect(status).to.be.true;
        // no under-counted copy is stored
        expect(calls.insertOne).to.have.lengthOf(0);
        expect(info.sourceUid).to.deep.equal([]);
        // nothing to release because the increment never took effect
        expect(calls.deleteManyAsync).to.have.lengthOf(0);
        expect(calls.updateOneCopied).to.have.lengthOf(0);
    });

    it('marks the source copied only after a confirmed insert', async function () {
        let { server, messageHandler, calls } = setupCopyEnv({
            sourceMessages: [
                { _id: new ObjectId(), mailbox: sourceMailboxId, uid: 10, size: 100, flags: [], magic: 'src-magic', mimeTree: { header: [], attachmentMap: {} } },
                { _id: new ObjectId(), mailbox: sourceMailboxId, uid: 20, size: 200, flags: [], magic: 'src-magic', mimeTree: { header: [], attachmentMap: {} } }
            ],
            targetEncrypted: false,
            // first insert succeeds, second is not acknowledged
            insertOneImpl: (doc, n) => (n === 1 ? Promise.resolve({ acknowledged: true, insertedId: new ObjectId() }) : Promise.resolve({ acknowledged: false }))
        });

        let { status, info } = await runCopy(server, messageHandler, [10, 20]);

        expect(status).to.be.true;
        expect(info.sourceUid).to.deep.equal([10]);
        // copied:true is issued exactly once - for the message whose insert was acknowledged
        expect(calls.updateOneCopied).to.have.lengthOf(1);
    });

    it('omits failed insertOne UIDs from sourceUid/destinationUid', async function () {
        let server = {
            logger: { debug() {}, error() {} },
            loggelf() {},
            notifier: {
                addEntries(target, entry, cb) {
                    if (cb) {
                        return cb();
                    }
                },
                fire() {}
            }
        };

        let messageHandler = {
            isMessageEncrypted: () => false,
            _getContentType: () => '',
            attachmentStorage: { updateMany: () => Promise.resolve() }
        };

        let connection = { send() {} };
        let session = {
            id: 'test-session',
            user: { id: userId, address: 'test@example.com' },
            socket: { destroyed: false, readyState: 'open' }
        };

        let handler = onCopy(server, messageHandler);

        let { status, info } = await new Promise((resolve, reject) => {
            handler(connection, sourceMailboxId, { messages: [10, 20], destination: 'Vault' }, session, (err, s, i) => {
                if (err) return reject(err);
                resolve({ status: s, info: i });
            });
        });

        expect(insertCalls).to.equal(2);
        expect(status).to.be.true;
        expect(info.sourceUid).to.deep.equal([10]);
        expect(info.destinationUid).to.have.lengthOf(1);
    });
});
