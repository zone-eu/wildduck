/* eslint no-unused-expressions: 0 */
'use strict';

// lib/user-outbound.js and UserHandler#removeQueuedMail with stand ins for the database and the queue.

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const UserHandler = require('../lib/user-handler');
const { removeUserOutbound } = require('../lib/user-outbound');

describe('user-outbound', () => {
    const user = new ObjectId();
    const mailbox = new ObjectId();

    // collections answer find() with fixed documents and record the queries
    function database(data) {
        const queries = [];
        return {
            queries,
            collection: name => ({
                find: (query, options) => {
                    queries.push({ name, query, options });
                    return { limit: () => ({ toArray: async () => data[name] || [] }), toArray: async () => data[name] || [] };
                },
                findOne: async () => null
            })
        };
    }

    function maildropper(results) {
        const removed = [];
        return {
            removed,
            removeFromQueue: async (id, owner) => {
                removed.push([id, owner]);
                if (results[id] instanceof Error) {
                    throw results[id];
                }
                return results[id] || { success: false, code: 'NoSuchQueueEntry' };
            }
        };
    }

    it('removes the queue entries named by pending submissions and recent messages, once each', async () => {
        const db = database({
            'jmap.submissions': [{ queueId: 'q1' }, { queueId: 'q2' }],
            mailboxes: [{ _id: mailbox }],
            messages: [{ outbound: ['q2', 'q3'] }, { outbound: 'q4' }]
        });
        const queue = maildropper({
            q1: { success: true, deleted: 2 },
            q2: { success: true, deleted: 1 },
            q3: new Error('sender database down'),
            q4: { success: false, code: 'NotEnoughPrivileges' }
        });
        const result = await removeUserOutbound({ database: db, maildropper: queue }, user);
        expect(result).to.deep.equal({ messages: 4, entries: 3 });
        expect(queue.removed.map(([id]) => id).sort()).to.deep.equal(['q1', 'q2', 'q3', 'q4']);
        queue.removed.forEach(([, owner]) => expect(owner).to.equal(user));

        const byName = Object.fromEntries(db.queries.map(entry => [entry.name, entry]));
        expect(byName['jmap.submissions'].query).to.deep.equal({ user, undoStatus: 'pending' });
        expect(byName.messages.query.mailbox).to.deep.equal({ $in: [mailbox] });
        expect(byName.messages.query.hdate.$gte).to.be.an.instanceof(Date);
        expect(byName.messages.options.projection).to.deep.equal({ _id: false, outbound: true });
    });

    it('does not read messages of a user without mailboxes', async () => {
        const db = database({});
        const result = await removeUserOutbound({ database: db, maildropper: maildropper({}) }, user);
        expect(result).to.deep.equal({ messages: 0, entries: 0 });
        expect(db.queries.map(entry => entry.name).sort()).to.deep.equal(['jmap.submissions', 'mailboxes']);
    });

    describe('UserHandler#removeQueuedMail', () => {
        const redis = { defineCommand: () => false };

        it('does nothing without a maildropper (the handler as the plugins build it)', async () => {
            const handler = new UserHandler({ database: database({}), redis });
            expect(await handler.removeQueuedMail(user)).to.equal(false);
        });

        it('does not fail the deletion when the queue can not be read', async () => {
            const broken = {
                collection: () => {
                    throw new Error('database down');
                }
            };
            const handler = new UserHandler({ database: broken, users: database({}), redis, maildropper: maildropper({}) });
            expect(await handler.removeQueuedMail(user)).to.equal(false);
        });
    });
});
