/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */
/* global before, after */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const MessageHandler = require('../lib/message-handler');
const db = require('../lib/db');

describe('MessageHandler threading updates', function () {
    this.timeout(30000); // eslint-disable-line no-invalid-this

    let handler;
    let userId;

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
        handler = new MessageHandler({
            database: db.database,
            users: db.users,
            gridfs: db.gridfs,
            redis: db.redis
        });
        userId = new ObjectId();
    });

    after(async () => {
        if (!userId) {
            return;
        }
        await db.database.collection('threads').deleteMany({ user: userId });
    });

    it('should persist literal subject values in thread upsert pipeline', async () => {
        const subjects = ['$subject.', 'subject.', '$subject'];

        for (const subject of subjects) {
            const messageId = `<${new ObjectId().toHexString()}@example.test>`;
            const returnedThreadId = await handler.getThreadIdAsync(userId, subject, {
                parsedHeader: {
                    'message-id': [messageId]
                }
            });

            expect(returnedThreadId).to.be.instanceOf(ObjectId);

            const thread = await db.database.collection('threads').findOne({
                _id: returnedThreadId,
                user: userId
            });
            expect(thread).to.exist;
            expect(thread.subject).to.equal(subject);
        }
    });
});
