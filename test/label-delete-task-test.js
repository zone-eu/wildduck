/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { run } = require('../lib/tasks/label-delete');
const ImapNotifier = require('../lib/imap-notifier');
const { IMAPConnection } = require('../imap-core/lib/imap-connection');
const { BULK_BATCH_SIZE } = require('../lib/consts');

function createState(messageCount = 1, mailboxCount = 1) {
    const user = new ObjectId();
    const label = new ObjectId();
    const remainingLabel = new ObjectId();
    const mailboxes = Array.from({ length: mailboxCount }, () => ({ _id: new ObjectId(), user, modifyIndex: 6 }));
    const records = [
        { _id: label, user, name: 'Projects', deleting: true },
        { _id: remainingLabel, user, name: 'Keep' }
    ];
    const state = {
        user,
        label,
        remainingLabel,
        mailboxes,
        records,
        messages: Array.from({ length: messageCount }, (_, index) => ({
            _id: new ObjectId(),
            user,
            mailbox: mailboxes[index % mailboxCount]._id,
            uid: index + 1,
            thread: new ObjectId(),
            flags: ['\\Seen', 'ordinary'],
            labels: [label, remainingLabel],
            modseq: 6
        })),
        journal: [],
        fires: [],
        countersBumped: 0,
        filters: [{ user, action: { labels: [label, remainingLabel] } }]
    };

    const matches = (message, query) =>
        message.mailbox.equals(query.mailbox) &&
        (!query._id || message._id.equals(query._id)) &&
        (!query.uid || message.uid === query.uid) &&
        (!query.labels || message.labels.some(id => id.equals(query.labels)));
    const snapshot = message => ({ ...message, flags: [...message.flags], labels: [...message.labels] });

    state.database = {
        collection(name) {
            switch (name) {
                case 'mailboxes':
                    return {
                        find(query) {
                            expect(query).to.deep.equal({ user });
                            return { toArray: async () => mailboxes.map(mailbox => ({ ...mailbox })) };
                        },
                        async findOne(query) {
                            return { ...mailboxes.find(mailbox => mailbox._id.equals(query._id)) };
                        },
                        async findOneAndUpdate(query, update) {
                            const mailbox = mailboxes.find(entry => entry._id.equals(query._id));
                            mailbox.modifyIndex += update.$inc.modifyIndex;
                            const value = { ...mailbox };
                            if (state.afterAllocation) {
                                state.afterAllocation(mailbox);
                            }
                            return { value };
                        }
                    };
                case 'messages':
                    return {
                        find(query) {
                            let limit;
                            return {
                                limit(value) {
                                    limit = value;
                                    return this;
                                },
                                async toArray() {
                                    return state.messages
                                        .filter(message => matches(message, query))
                                        .slice(0, limit)
                                        .map(snapshot);
                                }
                            };
                        },
                        async findOneAndUpdate(query, update) {
                            const message = state.messages.find(entry => matches(entry, query));
                            if (!message) {
                                return { value: null };
                            }
                            if (state.beforeRemove) {
                                state.beforeRemove(message);
                            }
                            if (!matches(message, query)) {
                                return { value: null };
                            }
                            message.labels = message.labels.filter(id => !id.equals(update.$pull.labels));
                            return { value: snapshot(message) };
                        },
                        async updateMany(query, update) {
                            for (const message of state.messages) {
                                if (message.mailbox.equals(query.mailbox) && query._id.$in.some(id => id.equals(message._id))) {
                                    message.modseq = Math.max(message.modseq, update.$max.modseq);
                                }
                            }
                        }
                    };
                case 'filters':
                    return {
                        async updateMany(query, update) {
                            expect(query).to.deep.equal({ user, 'action.labels': label });
                            let modifiedCount = 0;
                            for (const filter of state.filters) {
                                if (filter.action.labels.some(id => id.equals(label))) {
                                    filter.action.labels = filter.action.labels.filter(id => !id.equals(update.$pull['action.labels']));
                                    modifiedCount++;
                                }
                            }
                            return { modifiedCount };
                        }
                    };
                case 'labels':
                    return {
                        find(query) {
                            expect(query).to.deep.equal({ user });
                            return { toArray: async () => records };
                        },
                        async deleteOne(query) {
                            expect(query).to.deep.equal({ user, _id: label, deleting: true });
                            const index = records.findIndex(record => record._id.equals(label));
                            if (index < 0) {
                                return { deletedCount: 0 };
                            }
                            records.splice(index, 1);
                            return { deletedCount: 1 };
                        }
                    };
                case 'journal':
                    return {
                        async insertMany(entries) {
                            if (state.journalError) {
                                throw state.journalError;
                            }
                            state.journal.push(...entries);
                            return { insertedCount: entries.length };
                        }
                    };
                default:
                    throw new Error(`Unexpected collection: ${name}`);
            }
        }
    };

    const notifier = Object.create(ImapNotifier.prototype);
    notifier.database = state.database;
    notifier.logger = { debug() {}, error() {} };
    notifier.prepareAccountCounterInvalidations = async () => {};
    notifier.updateCounters = async () => {};
    notifier.updateAccountCounters = async () => {};
    notifier.fire = notifiedUser => state.fires.push(notifiedUser);
    state.run = () =>
        run(
            { _id: new ObjectId() },
            { user, label, name: 'Projects' },
            {
                messageHandler: {
                    notifier,
                    redis: {
                        async set() {
                            state.countersBumped++;
                        }
                    }
                },
                loggelf() {}
            },
            state.database
        );
    return state;
}

describe('Label deletion task', () => {
    it('removes only the selected assignments and notifies every affected mailbox', async () => {
        const state = createState(2, 2);
        const result = await state.run();
        expect(result).to.deep.equal({ updated: 2, filters: 1, deleted: 1 });
        expect(state.filters[0].action.labels).to.deep.equal([state.remainingLabel]);
        expect(state.records.map(record => record._id)).to.deep.equal([state.remainingLabel]);
        expect(state.countersBumped).to.equal(1);

        const fetches = state.journal.filter(entry => entry.command === 'FETCH');
        expect(fetches).to.have.length(2);
        for (const message of state.messages) {
            expect(message.labels).to.deep.equal([state.remainingLabel]);
            const entry = fetches.find(item => item.message.equals(message._id));
            expect(entry.mailbox).to.deep.equal(message.mailbox);
            expect(entry).to.include({ uid: message.uid, thread: message.thread, modseq: 7 });
            expect(entry.flags).to.deep.equal(['\\Seen', 'ordinary', `$wdlabel$${state.remainingLabel}`]);
            expect(entry.removedLabels).to.deep.equal(['Projects']);

            const writes = [];
            const connection = Object.create(IMAPConnection.prototype);
            connection.id = 'label-delete-test';
            connection.state = 'Selected';
            connection.selected = { uidList: [message.uid], modifyIndex: 6, notifications: [entry], condstoreEnabled: true };
            connection.logger = { debug() {} };
            connection.writeStream = {
                write(response) {
                    writes.push(response);
                }
            };
            connection.emitNotifications();
            expect(writes).to.have.length(1);
            expect(writes[0].attributes[1][1].map(flag => flag.value)).to.deep.equal(entry.flags);
        }
        expect(state.journal.filter(entry => entry.command === 'LABEL_COUNTERS')).to.have.length(1);
        expect(state.fires).to.deep.equal([state.user, state.user, state.user]);
    });

    it('journals every message with a fresh modification sequence for each batch', async () => {
        const count = BULK_BATCH_SIZE * 2 + 1;
        const state = createState(count);
        await state.run();
        const fetches = state.journal.filter(entry => entry.command === 'FETCH');
        expect(fetches).to.have.length(count);
        expect(new Set(fetches.map(entry => entry.message.toString())).size).to.equal(count);
        expect(fetches.filter(entry => entry.modseq === 7)).to.have.length(BULK_BATCH_SIZE);
        expect(fetches.filter(entry => entry.modseq === 8)).to.have.length(BULK_BATCH_SIZE);
        expect(fetches.filter(entry => entry.modseq === 9)).to.have.length(1);
        expect(state.messages.every(message => message.labels.length === 1)).to.be.true;
    });

    it('uses current flags and advances beyond a writer that updates before journal allocation', async () => {
        const state = createState();
        state.beforeRemove = message => {
            message.flags = ['\\Flagged', 'concurrent'];
            message.modseq = state.mailboxes[0].modifyIndex = 8;
        };
        await state.run();
        expect(state.messages[0].modseq).to.equal(9);
        expect(state.journal[0].modseq).to.equal(9);
        expect(state.journal[0].flags).to.deep.equal(['\\Flagged', 'concurrent', `$wdlabel$${state.remainingLabel}`]);
    });

    it('preserves a higher message modification sequence written after journal allocation', async () => {
        const state = createState();
        state.afterAllocation = mailbox => {
            state.messages[0].modseq = ++mailbox.modifyIndex;
        };
        await state.run();
        expect(state.messages[0].modseq).to.equal(8);
        expect(state.messages[0].labels).to.deep.equal([state.remainingLabel]);
    });

    it('skips assignments removed concurrently without publishing a duplicate message change', async () => {
        const state = createState();
        state.beforeRemove = message => {
            message.labels = [state.remainingLabel];
        };
        const result = await state.run();
        expect(result.updated).to.equal(0);
        expect(state.journal.map(entry => entry.command)).to.deep.equal(['LABEL_COUNTERS']);
        expect(state.mailboxes[0].modifyIndex).to.equal(6);
    });

    it('keeps the deleting label record when journaling fails', async () => {
        const state = createState();
        state.journalError = new Error('Journal unavailable');
        let error;
        try {
            await state.run();
        } catch (err) {
            error = err;
        }
        expect(error).to.equal(state.journalError);
        expect(state.records.some(record => record._id.equals(state.label) && record.deleting)).to.be.true;
        expect(state.fires).to.have.length(0);
    });
});
