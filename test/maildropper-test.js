/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const Maildropper = require('../lib/maildropper');

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
                            return { updateMany: handlers.updateMany || notCalled('updateMany') };
                        }

                        throw new Error(`Unexpected collection: ${name}`);
                    }
                }
            },
            collection: 'zone-queue',
            gfs: 'mail',
            gridstore: {}
        });
    };

    // GridFS entry of a queued message, `data` is the stored envelope
    const queueFileFor = data => ({
        _id: 'gridfs-id',
        metadata: { data }
    });

    const submittedQueueFile = headers => queueFileFor({ userId: 'user-id', reason: 'submit', headers });

    it('updates all unlocked entries with the requested delivery time', async function () {
        const sendTime = new Date('2026-08-25T12:00:00.000Z');
        let lookupQuery;
        let updateQuery;
        let updateValue;
        const maildropper = createMaildropper(queueFileFor({ userId: 'user-id' }), {
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
            updated: 2
        });
    });

    it('counts matched entries, not modified ones', async function () {
        // re-sending the same delivery time modifies nothing but is still a successful update
        const maildropper = createMaildropper(queueFileFor({ userId: 'user-id' }), {
            updateMany: async () => ({ matchedCount: 3, modifiedCount: 0 })
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

        expect(result).to.deep.equal({
            success: true,
            queueId: 'queue-id',
            updated: 3
        });
    });

    it('rejects an update if all queue entries are locked for delivery', async function () {
        const maildropper = createMaildropper(queueFileFor({ userId: 'user-id' }), {
            updateMany: async () => ({ matchedCount: 0, modifiedCount: 0 })
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

        expect(result).to.deep.equal({
            success: false,
            code: 'QueueEntryLocked'
        });
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
        // autoreplies and other generated messages are queued without an owner, these must not be
        // modifiable by a user token
        const maildropper = createMaildropper(queueFileFor({ reason: 'autoreply' }));

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
            updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 }),
            updateOne: async (query, update) => {
                metaQuery = query;
                metaUpdate = update;
                return { matchedCount: 1, modifiedCount: 1 };
            }
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

        expect(result.success).to.be.true;
        expect(metaQuery).to.deep.equal({ _id: 'gridfs-id' });
        expect(metaUpdate.$set['metadata.data.date']).to.equal('Tue, 25 Aug 2026 12:00:00 +0000');

        const headerLines = metaUpdate.$set['metadata.data.headers'];
        const dateLines = headerLines.filter(line => line.key === 'date');
        expect(dateLines).to.have.length(1);
        expect(dateLines[0].line).to.equal('Date: Tue, 25 Aug 2026 12:00:00 +0000');
        expect(headerLines.some(line => line.key === 'from')).to.be.true;
    });

    it('marks submitted queue entries in the internal update result', async function () {
        const maildropper = createMaildropper(submittedQueueFile([]), {
            updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 }),
            updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 })
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

        expect(result.submitted).to.be.true;
    });

    it('adds a Date header to a submitted message that does not have one', async function () {
        const sendTime = new Date('2026-08-25T12:00:00.000Z');
        const queueFile = submittedQueueFile([{ key: 'from', line: 'From: sender@example.com' }]);
        let metaUpdate;
        const maildropper = createMaildropper(queueFile, {
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
            updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 })
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

        expect(result.success).to.be.true;
        expect(result).not.to.have.property('submitted');
    });

    it('does not allow removing a queue entry that is not linked to any user', async function () {
        const maildropper = createMaildropper(queueFileFor({ reason: 'autoreply' }));

        const result = await maildropper.removeFromQueue('queue-id', 'user-id');

        expect(result).to.deep.equal({
            success: false,
            code: 'NotEnoughPrivileges'
        });
    });
});
