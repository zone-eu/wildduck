'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { run } = require('../lib/tasks/keyword-delete');

describe('Keyword deletion task', () => {
    it('removes descendant paths from messages and filters before deleting catalog records', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const task = { _id: new ObjectId() };
        const events = [];
        const database = {
            collection(name) {
                if (name === 'mailboxes') {
                    return { find() { return { async toArray() { return [{ _id: mailbox }]; } }; } };
                }
                if (name === 'messages') {
                    return {
                        find(query) {
                            expect(query).to.deep.equal({ mailbox, flags: { $in: ['Projects', 'Projects/2026'] } });
                            return {
                                sort() { return this; },
                                calls: 0,
                                async next() { return this.calls++ ? null : { _id: new ObjectId(), uid: 42 }; },
                                async close() { events.push('cursor-close'); }
                            };
                        }
                    };
                }
                if (name === 'filters') {
                    return {
                        async updateMany(query, update) {
                            expect(query).to.deep.equal({ user, 'action.keywords': { $in: ['Projects', 'Projects/2026'] } });
                            expect(update).to.deep.equal({ $pull: { 'action.keywords': { $in: ['Projects', 'Projects/2026'] } } });
                            events.push('filters');
                            return { modifiedCount: 1 };
                        }
                    };
                }
                expect(name).to.equal('keywords');
                return {
                    async deleteMany(query) {
                        expect(query).to.deep.equal({ user, path: { $in: ['Projects', 'Projects/2026'] }, deleting: true });
                        events.push('keywords');
                        return { deletedCount: 2 };
                    }
                };
            }
        };
        const messageHandler = {
            update(userArg, mailboxArg, uid, changes, callback) {
                expect(userArg).to.equal(user);
                expect(mailboxArg).to.equal(mailbox);
                expect(uid).to.equal(42);
                expect(changes).to.deep.equal({ removeKeywords: ['Projects', 'Projects/2026'] });
                events.push('message');
                callback(null, 1);
            }
        };
        const result = await run(task, { user, path: 'Projects', paths: ['Projects', 'Projects/2026'] }, { messageHandler, loggelf: entry => events.push(entry) }, database);
        expect(result).to.deep.equal({ updated: 1, filters: 1, deleted: 2 });
        expect(events.slice(0, 4)).to.deep.equal(['message', 'cursor-close', 'filters', 'keywords']);
        expect(events[4]).to.include({ _mail_action: 'keyword_delete', _messages_updated: 1, _filters_updated: 1, _keywords_deleted: 2 });
    });
});
