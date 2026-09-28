'use strict';

const log = require('npmlog');
const db = require('../db');
const consts = require('../consts');
const tools = require('../tools');

let run = async (task, data, options, database = db.database) => {
    const ids = data.ids || [];
    let updated = 0;
    let notificationMailbox;

    if (ids.length) {
        const mailboxes = await database
            .collection('mailboxes')
            .find({ user: data.user }, { projection: { _id: 1 }, maxTimeMS: consts.DB_MAX_TIME_MAILBOXES })
            .toArray();
        notificationMailbox = mailboxes[0]?._id;

        for (const mailbox of mailboxes) {
            // messages is sharded by mailbox+uid. Keeping mailbox as an exact
            // predicate targets one shard, and mailbox+labels is indexed.
            const assigned = await database.collection('messages').findOne(
                { mailbox: mailbox._id, labels: { $in: ids } },
                { projection: { _id: 1 }, maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH }
            );
            if (!assigned) {
                continue;
            }
            const mailboxState = await database.collection('mailboxes').findOneAndUpdate(
                { _id: mailbox._id, user: data.user },
                { $inc: { modifyIndex: 1 } },
                { returnDocument: 'after', projection: { modifyIndex: 1 }, maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
            );
            if (!mailboxState?.value) {
                continue;
            }

            const messageResult = await database.collection('messages').updateMany(
                { mailbox: mailbox._id, labels: { $in: ids } },
                { $pull: { labels: { $in: ids } }, $set: { modseq: mailboxState.value.modifyIndex } },
                { maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH }
            );
            updated += messageResult.modifiedCount || 0;
        }
    }

    const filterResult = await database.collection('filters').updateMany(
        { user: data.user, 'action.labels': { $in: ids } },
        { $pull: { 'action.labels': { $in: ids } } },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );
    const filters = filterResult.modifiedCount || 0;

    const labelResult = await database.collection('labels').deleteMany(
        { user: data.user, _id: { $in: ids }, deleting: true },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );

    if (options.messageHandler?.redis) {
        await tools.bumpAccountCounterVersion(options.messageHandler.redis, data.user);
    }

    if (data.name && notificationMailbox && options.messageHandler?.notifier) {
        await new Promise((resolve, reject) => {
            options.messageHandler.notifier.addEntries(
                notificationMailbox,
                [{ command: 'LABEL_COUNTERS', label: data.name, total: 0, unseen: 0 }],
                err => (err ? reject(err) : resolve())
            );
        });
        options.messageHandler.notifier.fire(data.user);
    }

    options.loggelf({
        short_message: '[LABELS] Deleted label',
        _mail_action: 'label_delete',
        _task_id: task._id.toString(),
        _user: data.user.toString(),
        _label: data.name,
        _label_ids: ids.map(id => id.toString()),
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
