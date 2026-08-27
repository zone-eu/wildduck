/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const Maildropper = require('../lib/maildropper');
const consts = require('../lib/consts');

const expect = chai.expect;

describe('Maildropper', function () {
    const notCalled = name => async () => {
        throw new Error(`${name} should not be called`);
    };

    // Fake sender database that only knows about a single queued message
    const createMaildropper = (queueFile, handlers) => {
        handlers = handlers || {};

        return new Maildropper({
            db: {
                // stored messages that reference a queue ID, used as the ownership fallback
                database: {
                    collection(name) {
                        if (name === 'messages') {
                            return {
                                findOne: async query => {
                                    handlers.onMessageLookup && handlers.onMessageLookup(query);
                                    return handlers.referencedBy || null;
                                }
                            };
                        }

                        throw new Error(`Unexpected collection: ${name}`);
                    }
                },
                senderDb: {
                    collection(name) {
                        if (name === 'mail.files') {
                            return {
                                findOne: async query => {
                                    handlers.onFindOne && handlers.onFindOne(query);
                                    return queueFile;
                                },
                                updateOne: handlers.updateOne || notCalled('updateOne')
                            };
                        }

                        if (name === 'zone-queue') {
                            return {
                                updateMany: handlers.updateMany || notCalled('updateMany'),
                                deleteMany: handlers.deleteMany || notCalled('deleteMany'),
                                // by default every entry that was matched is still the whole queue
                                countDocuments: handlers.countDocuments || (async () => handlers.pending || 0)
                            };
                        }

                        throw new Error(`Unexpected collection: ${name}`);
                    }
                }
            },
            collection: 'zone-queue',
            gfs: 'mail',
            gridstore: handlers.gridstore || {}
        });
    };

    // GridFS entry of a queued message, `data` is the stored envelope
    const queueFileFor = data => ({
        _id: 'gridfs-id',
        uploadDate: new Date('2026-08-24T09:00:00.000Z'),
        metadata: { data }
    });

    const submittedQueueFile = headers => queueFileFor({ userId: 'user-id', reason: 'submit', headers });

    describe('updateQueueTime', function () {
        it('updates all unlocked entries with the requested delivery time', async function () {
            const sendTime = new Date('2026-08-25T12:00:00.000Z');
            let lookupQuery;
            let updateQuery;
            let updateValue;
            const maildropper = createMaildropper(queueFileFor({ userId: 'user-id' }), {
                pending: 2,
                onFindOne: query => {
                    lookupQuery = query;
                },
                updateMany: async (query, update) => {
                    updateQuery = query;
                    updateValue = update;
                    return { matchedCount: 2, modifiedCount: 2 };
                }
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

            expect(lookupQuery).to.deep.equal({ filename: 'message queue-id' });
            expect(updateQuery).to.deep.equal({
                id: 'queue-id',
                locked: false
            });
            expect(updateValue).to.deep.equal({
                $set: {
                    queued: sendTime
                }
            });
            expect(result).to.deep.equal({
                success: true,
                queueId: 'queue-id',
                updated: 2,
                dateUpdated: false
            });
        });

        it('counts matched entries, not modified ones', async function () {
            // re-sending the same delivery time modifies nothing but is still a successful update
            const maildropper = createMaildropper(queueFileFor({ userId: 'user-id' }), {
                pending: 3,
                updateMany: async () => ({ matchedCount: 3, modifiedCount: 0 })
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result.success).to.be.true;
            expect(result.updated).to.equal(3);
        });

        it('rejects an update if all queue entries are locked for delivery', async function () {
            const maildropper = createMaildropper(queueFileFor({ userId: 'user-id' }), {
                pending: 2,
                updateMany: async () => ({ matchedCount: 0, modifiedCount: 0 })
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result).to.deep.equal({
                success: false,
                code: 'QueueEntryLocked',
                updated: 0,
                locked: 2
            });
        });

        it('rejects an update if only some of the queue entries could be rescheduled', async function () {
            // the locked entries keep the Date header they were queued with, so rewriting the shared
            // Date header would hand those recipients a Date value from the future
            const sendTime = new Date('2026-08-25T12:00:00.000Z');
            const maildropper = createMaildropper(submittedQueueFile([]), {
                pending: 6,
                updateMany: async () => ({ matchedCount: 4, modifiedCount: 4 })
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

            expect(result).to.deep.equal({
                success: false,
                code: 'QueueEntryLocked',
                updated: 4,
                locked: 2
            });
        });

        it('reports a missing entry if the last queue entry was delivered while updating', async function () {
            const maildropper = createMaildropper(queueFileFor({ userId: 'user-id' }), {
                pending: 0,
                updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 })
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result).to.deep.equal({
                success: false,
                code: 'NoSuchQueueEntry'
            });
        });

        it('rejects a delivery time that the queue entry would not survive until', async function () {
            // the MTA expires queue entries by insertion time and drops these without a bounce
            const queueFile = queueFileFor({ userId: 'user-id' });
            // updateMany is not stubbed, so touching the queue would throw
            const maildropper = createMaildropper(queueFile);

            const sendTime = new Date(queueFile.uploadDate.getTime() + consts.MAX_QUEUE_TIME + 1000);
            const result = await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

            expect(result.success).to.be.false;
            expect(result.code).to.equal('SendTimeTooLate');
            expect(result.maxSendTime.getTime()).to.equal(queueFile.uploadDate.getTime() + consts.MAX_QUEUE_TIME);
        });

        it('allows a delivery time right at the queue expiry time', async function () {
            const queueFile = queueFileFor({ userId: 'user-id' });
            const maildropper = createMaildropper(queueFile, {
                pending: 1,
                updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 })
            });

            const sendTime = new Date(queueFile.uploadDate.getTime() + consts.MAX_QUEUE_TIME);
            const result = await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

            expect(result.success).to.be.true;
        });

        it('rejects a queue entry owned by another user', async function () {
            const maildropper = createMaildropper(queueFileFor({ userId: 'another-user-id' }));

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result).to.deep.equal({
                success: false,
                code: 'NotEnoughPrivileges'
            });
        });

        it('rejects a queue entry that is not linked to any user', async function () {
            // system generated messages without an owner must not be modifiable by a user token
            const maildropper = createMaildropper(queueFileFor({ reason: 'bounce' }));

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result).to.deep.equal({
                success: false,
                code: 'NotEnoughPrivileges'
            });
        });

        it('accepts an unowned queue entry that one of the user messages references', async function () {
            // not every producer stamps the owner onto the queue metadata, and entries queued before a
            // producer was fixed never will. The `outbound` reference is how the user got the queue ID
            let messageQuery;
            const maildropper = createMaildropper(queueFileFor({ reason: 'forward' }), {
                pending: 1,
                referencedBy: { _id: 'message-id' },
                onMessageLookup: query => {
                    messageQuery = query;
                },
                updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 })
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(messageQuery).to.deep.equal({ user: 'user-id', outbound: 'queue-id' });
            expect(result.success).to.be.true;
        });

        it('does not fall back to the message reference when the entry is owned by another user', async function () {
            // onMessageLookup is not stubbed to return anything, but the owner mismatch must reject first
            const maildropper = createMaildropper(queueFileFor({ userId: 'another-user-id' }), {
                referencedBy: { _id: 'message-id' }
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result).to.deep.equal({
                success: false,
                code: 'NotEnoughPrivileges'
            });
        });

        it('rejects a queue entry that has no metadata yet', async function () {
            // metadata is stored after the message itself, so a queue file might not have it yet
            const maildropper = createMaildropper({ _id: 'gridfs-id' });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result).to.deep.equal({
                success: false,
                code: 'NotEnoughPrivileges'
            });
        });

        it('returns a missing-entry response when the queue file does not exist', async function () {
            const maildropper = createMaildropper(false);

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result).to.deep.equal({
                success: false,
                code: 'NoSuchQueueEntry'
            });
        });

        it('keeps the Date header of a submitted message in sync with the delivery time', async function () {
            const sendTime = new Date('2026-08-25T12:00:00.000Z');
            const queueFile = submittedQueueFile([
                { key: 'from', line: 'From: sender@example.com' },
                { key: 'date', line: 'Date: Mon, 24 Aug 2026 09:00:00 +0000' }
            ]);
            let metaQuery;
            let metaUpdate;
            const maildropper = createMaildropper(queueFile, {
                pending: 1,
                updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 }),
                updateOne: async (query, update) => {
                    metaQuery = query;
                    metaUpdate = update;
                    return { matchedCount: 1, modifiedCount: 1 };
                }
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

            expect(result.success).to.be.true;
            expect(result.dateUpdated).to.be.true;
            expect(metaQuery).to.deep.equal({ _id: 'gridfs-id' });
            expect(metaUpdate.$set['metadata.data.date']).to.equal('Tue, 25 Aug 2026 12:00:00 +0000');

            const headerLines = metaUpdate.$set['metadata.data.headers'];
            const dateLines = headerLines.filter(line => line.key === 'date');
            expect(dateLines).to.have.length(1);
            expect(dateLines[0].line).to.equal('Date: Tue, 25 Aug 2026 12:00:00 +0000');
            expect(headerLines.some(line => line.key === 'from')).to.be.true;
        });

        it('adds a Date header to a submitted message that does not have one', async function () {
            const sendTime = new Date('2026-08-25T12:00:00.000Z');
            const queueFile = submittedQueueFile([{ key: 'from', line: 'From: sender@example.com' }]);
            let metaUpdate;
            const maildropper = createMaildropper(queueFile, {
                pending: 1,
                updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 }),
                updateOne: async (query, update) => {
                    metaUpdate = update;
                    return { matchedCount: 1, modifiedCount: 1 };
                }
            });

            await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

            const dateLines = metaUpdate.$set['metadata.data.headers'].filter(line => line.key === 'date');
            expect(dateLines).to.have.length(1);
            expect(dateLines[0].line).to.equal('Date: Tue, 25 Aug 2026 12:00:00 +0000');
        });

        it('does not touch the Date header of a forwarded message', async function () {
            // forwarded messages carry the Date value of the original message and might be signed
            const queueFile = queueFileFor({
                userId: 'user-id',
                reason: 'forward',
                headers: [{ key: 'date', line: 'Date: Mon, 24 Aug 2026 09:00:00 +0000' }]
            });
            // updateOne is not stubbed, so touching the stored headers would throw
            const maildropper = createMaildropper(queueFile, {
                pending: 1,
                updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 })
            });

            const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

            expect(result.success).to.be.true;
            // the caller uses this to decide whether the stored copies need to be re-dated as well
            expect(result.dateUpdated).to.be.false;
        });
    });

    describe('removeFromQueue', function () {
        it('does not allow removing a queue entry that is not linked to any user', async function () {
            const maildropper = createMaildropper(queueFileFor({ reason: 'bounce' }));

            const result = await maildropper.removeFromQueue('queue-id', 'user-id');

            expect(result).to.deep.equal({
                success: false,
                code: 'NotEnoughPrivileges'
            });
        });

        it('allows the owner to remove an unowned entry that their message references', async function () {
            const maildropper = createMaildropper(queueFileFor({ reason: 'autoreply' }), {
                pending: 1,
                referencedBy: { _id: 'message-id' },
                deleteMany: async () => ({ deletedCount: 1 })
            });

            const result = await maildropper.removeFromQueue('queue-id', 'user-id');

            expect(result.success).to.be.true;
            expect(result.deleted).to.equal(1);
        });

        it('allows the owner to remove an autoreply that was queued for them', async function () {
            // autoreplies are queued with the user as the owner, as the queue ID is handed to the user
            // in the `outbound` array of the message that triggered the autoreply
            const maildropper = createMaildropper(queueFileFor({ userId: 'user-id', reason: 'autoreply' }), {
                pending: 1,
                deleteMany: async () => ({ deletedCount: 1 })
            });

            const result = await maildropper.removeFromQueue('queue-id', 'user-id');

            expect(result).to.deep.equal({
                success: true,
                queueId: 'queue-id',
                deleted: 1
            });
        });

        it('drops the stored message once the last queue entry is removed', async function () {
            let deletedFileId;
            const maildropper = createMaildropper(queueFileFor({ userId: 'user-id', reason: 'submit' }), {
                pending: 0,
                deleteMany: async () => ({ deletedCount: 2 }),
                gridstore: {
                    delete: async id => {
                        deletedFileId = id;
                    }
                }
            });

            const result = await maildropper.removeFromQueue('queue-id', 'user-id');

            expect(result.deleted).to.equal(2);
            expect(deletedFileId).to.equal('gridfs-id');
        });
    });
});
