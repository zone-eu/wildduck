'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { run } = require('../lib/tasks/label-delete');

describe('Label deletion task', () => {
    it('removes only the selected label from messages and filters', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const label = new ObjectId();
        const ids = [label];
        const task = { _id: new ObjectId() };
        const events = [];
        const journalEntries = [];
        const redis = {
            async set() {
                events.push('redis');
            }
        };
        const notifier = {
            addEntries(mailboxData, entries, callback) {
                expect(mailboxData).to.equal(mailbox);
                journalEntries.push(...entries);
                events.push('journal');
                callback();
            },
            fire(notifiedUser) {
                expect(notifiedUser).to.equal(user);
                events.push('fire');
            }
        };
        const database = {
            collection(name) {
                if (name === 'mailboxes') {
                    return {
                        find() {
                            return { async toArray() { return [{ _id: mailbox }]; } };
                        },
                        async findOneAndUpdate(query, update) {
                            expect(query).to.deep.equal({ _id: mailbox, user });
                            expect(update).to.deep.equal({ $inc: { modifyIndex: 1 } });
                            return { value: { modifyIndex: 7 } };
                        }
                    };
                }
                if (name === 'messages') {
                    return {
                        async findOne(query) {
                            expect(query).to.deep.equal({ mailbox, labels: { $in: ids } });
                            return { _id: new ObjectId() };
                        },
                        async updateMany(query, update) {
                            expect(query).to.deep.equal({ mailbox, labels: { $in: ids } });
                            expect(update).to.deep.equal({ $pull: { labels: { $in: ids } }, $set: { modseq: 7 } });
                            events.push('messages');
                            return { modifiedCount: 1 };
                        }
                    };
                }
                if (name === 'filters') {
                    return {
                        async updateMany(query, update) {
                            expect(query).to.deep.equal({ user, 'action.labels': { $in: ids } });
                            expect(update).to.deep.equal({ $pull: { 'action.labels': { $in: ids } } });
                            events.push('filters');
                            return { modifiedCount: 1 };
                        }
                    };
                }
                expect(name).to.equal('labels');
                return {
                    async deleteMany(query) {
                        expect(query).to.deep.equal({ user, _id: { $in: ids }, deleting: true });
                        events.push('labels');
                        return { deletedCount: 1 };
                    }
                };
            }
        };
        const result = await run(
            task,
            { user, label, name: 'Projects', ids },
            { messageHandler: { notifier, redis }, loggelf: entry => events.push(entry) },
            database
        );
        expect(result).to.deep.equal({ updated: 1, filters: 1, deleted: 1 });
        expect(events.slice(0, 3)).to.deep.equal(['messages', 'filters', 'labels']);
        expect(events.slice(3, 6)).to.deep.equal(['redis', 'journal', 'fire']);
        expect(journalEntries).to.deep.equal([{ command: 'LABEL_COUNTERS', label: 'Projects', total: 0, unseen: 0 }]);
        expect(events[6]).to.include({ _mail_action: 'label_delete', _messages_updated: 1, _filters_updated: 1, _labels_deleted: 1 });
    });
});
