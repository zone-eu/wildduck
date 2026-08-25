/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const Maildropper = require('../lib/maildropper');

const expect = chai.expect;

describe('Maildropper', function () {
    const createMaildropper = (queueFile, updateMany) =>
        new Maildropper({
            db: {
                senderDb: {
                    collection(name) {
                        if (name === 'mail.files') {
                            return {
                                findOne: async query => {
                                    expect(query).to.deep.equal({ filename: 'message queue-id' });
                                    return queueFile;
                                }
                            };
                        }

                        if (name === 'zone-queue') {
                            return { updateMany };
                        }

                        throw new Error(`Unexpected collection: ${name}`);
                    }
                }
            },
            collection: 'zone-queue',
            gfs: 'mail',
            gridstore: {}
        });

    it('updates all unlocked entries with the requested delivery time', async function () {
        const sendTime = new Date('2026-08-25T12:00:00.000Z');
        const queueFile = {
            metadata: {
                data: {
                    userId: 'user-id'
                }
            }
        };
        let updateQuery;
        let updateValue;
        const maildropper = createMaildropper(queueFile, async (query, update) => {
            updateQuery = query;
            updateValue = update;
            return { modifiedCount: 2 };
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', sendTime);

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

    it('rejects a queue entry owned by another user', async function () {
        const queueFile = {
            metadata: {
                data: {
                    userId: 'another-user-id'
                }
            }
        };
        let updateCalled = false;
        const maildropper = createMaildropper(queueFile, async () => {
            updateCalled = true;
            return { modifiedCount: 1 };
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

        expect(updateCalled).to.be.false;
        expect(result).to.deep.equal({
            success: false,
            code: 'NotEnoughPrivileges'
        });
    });

    it('returns a missing-entry response when the queue file does not exist', async function () {
        let updateCalled = false;
        const maildropper = createMaildropper(false, async () => {
            updateCalled = true;
            return { modifiedCount: 1 };
        });

        const result = await maildropper.updateQueueTime('queue-id', 'user-id', new Date());

        expect(updateCalled).to.be.false;
        expect(result).to.deep.equal({
            success: false,
            code: 'NoSuchQueueEntry'
        });
    });
});
