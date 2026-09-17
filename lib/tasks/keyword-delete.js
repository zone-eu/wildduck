'use strict';

const log = require('npmlog');
const db = require('../db');
const consts = require('../consts');
const tools = require('../tools');

let run = async (task, data, options, database = db.database) => {
    const paths = data.paths || [];
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
            // predicate targets one shard, and mailbox+keywords is indexed.
            const assigned = await database.collection('messages').findOne(
                { mailbox: mailbox._id, keywords: { $in: ids } },
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
                { mailbox: mailbox._id, keywords: { $in: ids } },
                { $pull: { keywords: { $in: ids } }, $set: { modseq: mailboxState.value.modifyIndex } },
                { maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH }
            );
            updated += messageResult.modifiedCount || 0;
        }
    }

    const filterResult = await database.collection('filters').updateMany(
        { user: data.user, 'action.keywords': { $in: ids } },
        { $pull: { 'action.keywords': { $in: ids } } },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );
    const filters = filterResult.modifiedCount || 0;

    const keywordResult = await database.collection('keywords').deleteMany(
        { user: data.user, _id: { $in: ids }, deleting: true },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );

    if (options.messageHandler?.redis) {
        await tools.bumpAccountCounterVersion(options.messageHandler.redis, data.user);
    }

    if (paths.length && notificationMailbox && options.messageHandler?.notifier) {
        await new Promise((resolve, reject) => {
            options.messageHandler.notifier.addEntries(
                notificationMailbox,
                paths.map(keyword => ({ command: 'KEYWORD_COUNTERS', keyword, total: 0, unseen: 0 })),
                err => (err ? reject(err) : resolve())
            );
        });
        options.messageHandler.notifier.fire(data.user);
    }

    options.loggelf({
        short_message: '[KEYWORDS] Deleted keyword paths',
        _mail_action: 'keyword_delete',
        _task_id: task._id.toString(),
        _user: data.user.toString(),
        _keyword: data.path,
        _keyword_paths: paths,
        _keyword_ids: ids.map(id => id.toString()),
        _messages_updated: updated,
        _filters_updated: filters,
        _keywords_deleted: keywordResult.deletedCount || 0
    });
    return { updated, filters, deleted: keywordResult.deletedCount || 0 };
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=keyword-delete id=%s user=%s keyword=%s error=%s', task._id, data.user, data.path, err.stack);
            options.loggelf({
                short_message: '[KEYWORDS] Keyword deletion failed',
                _mail_action: 'keyword_delete',
                _task_id: task._id.toString(),
                _user: data.user.toString(),
                _keyword: data.path,
                _error: err.message
            });
            callback(err);
        });
};

module.exports.run = run;
