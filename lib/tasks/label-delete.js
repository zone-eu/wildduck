'use strict';

const log = require('npmlog');
const db = require('../db');
const consts = require('../consts');
const tools = require('../tools');
const { getLabelMaps, getMessageImapFlags } = require('../label-handler');

let run = async (task, data, options, database = db.database) => {
    const label = data.label;
    let updated = 0;
    const mailboxes = await database
        .collection('mailboxes')
        .find({ user: data.user }, { projection: { _id: 1 }, maxTimeMS: consts.DB_MAX_TIME_MAILBOXES })
        .toArray();
    const notificationMailbox = mailboxes[0]?._id;
    const { byId } = await getLabelMaps(database, data.user);
    const notifier = options.messageHandler.notifier;
    const journal = (mailbox, entries) =>
        new Promise((resolve, reject) => {
            notifier.addEntries(mailbox, entries, err => (err ? reject(err) : resolve()));
        });

    for (const mailbox of mailboxes) {
        // messages is sharded by mailbox+uid. Keeping mailbox as an exact
        // predicate targets one shard, and mailbox+labels is indexed.
        let assigned;
        do {
            // Materialize a bounded batch before changing the indexed labels field.
            assigned = await database
                .collection('messages')
                .find(
                    { mailbox: mailbox._id, labels: label },
                    { projection: { _id: 1, uid: 1 }, maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH }
                )
                .limit(consts.BULK_BATCH_SIZE)
                .toArray();
            if (!assigned.length) {
                break;
            }

            const entries = [];
            for (const message of assigned) {
                const result = await database.collection('messages').findOneAndUpdate(
                    { _id: message._id, mailbox: mailbox._id, uid: message.uid, labels: label },
                    { $pull: { labels: label } },
                    {
                        includeResultMetadata: true,
                        returnDocument: 'after',
                        projection: { _id: 1, uid: 1, flags: 1, labels: 1, thread: 1 },
                        maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                    }
                );
                if (!result?.value) {
                    continue;
                }

                updated++;
                entries.push({
                    command: 'FETCH',
                    uid: result.value.uid,
                    message: result.value._id,
                    thread: result.value.thread,
                    flags: getMessageImapFlags(result.value, byId),
                    removedLabels: data.name ? [data.name] : []
                });
            }

            if (entries.length) {
                // Allocate a fresh modseq after removal for each journal batch.
                // addEntries uses $max so a concurrent writer's higher modseq is preserved.
                await journal(mailbox._id, entries);
                notifier.fire(data.user);
            }
        } while (assigned.length);
    }

    const filterResult = await database.collection('filters').updateMany(
        { user: data.user, 'action.labels': label },
        { $pull: { 'action.labels': label } },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );
    const filters = filterResult.modifiedCount || 0;

    const labelResult = await database.collection('labels').deleteOne(
        { user: data.user, _id: label, deleting: true },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );

    if (options.messageHandler?.redis) {
        await tools.bumpAccountCounterVersion(options.messageHandler.redis, data.user);
    }

    if (data.name && notificationMailbox) {
        await journal(notificationMailbox, [{ command: 'LABEL_COUNTERS', label: data.name, total: 0, unseen: 0 }]);
        notifier.fire(data.user);
    }

    options.loggelf({
        short_message: '[LABELS] Deleted label',
        _mail_action: 'label_delete',
        _task_id: task._id.toString(),
        _user: data.user.toString(),
        _label: data.name,
        _label_id: label.toString(),
        _messages_updated: updated,
        _filters_updated: filters,
        _labels_deleted: labelResult.deletedCount || 0
    });
    return { updated, filters, deleted: labelResult.deletedCount || 0 };
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=label-delete id=%s user=%s label=%s error=%s', task._id, data.user, data.name, err.stack);
            options.loggelf({
                short_message: '[LABELS] Label deletion failed',
                _mail_action: 'label_delete',
                _task_id: task._id.toString(),
                _user: data.user.toString(),
                _label: data.name,
                _error: err.message
            });
            callback(err);
        });
};

module.exports.run = run;
