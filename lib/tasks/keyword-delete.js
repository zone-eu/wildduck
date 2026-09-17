'use strict';

const log = require('npmlog');
const db = require('../db');
const util = require('util');
const consts = require('../consts');

const run = async (task, data, options, database = db.database) => {
    const updateMessage = util.promisify(options.messageHandler.update.bind(options.messageHandler));
    const paths = data.paths || [];
    let updated = 0;
    let filters = 0;

    for (const mailbox of await database
        .collection('mailboxes')
        .find({ user: data.user }, { projection: { _id: 1 }, maxTimeMS: consts.DB_MAX_TIME_MAILBOXES })
        .toArray()) {
        const cursor = database
            .collection('messages')
            .find(
                { mailbox: mailbox._id, flags: { $in: paths } },
                { projection: { _id: 1, uid: 1 }, maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH }
            )
            .sort({ uid: 1 });
        try {
            let message;
            while ((message = await cursor.next())) {
                updated += await updateMessage(data.user, mailbox._id, message.uid, { removeKeywords: paths });
            }
        } finally {
            await cursor.close();
        }
    }

    const filterResult = await database.collection('filters').updateMany(
        { user: data.user, 'action.keywords': { $in: paths } },
        { $pull: { 'action.keywords': { $in: paths } } },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );
    filters = filterResult.modifiedCount || 0;

    const keywordResult = await database.collection('keywords').deleteMany(
        { user: data.user, path: { $in: paths }, deleting: true },
        { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
    );

    options.loggelf({
        short_message: '[KEYWORDS] Deleted keyword paths',
        _mail_action: 'keyword_delete',
        _task_id: task._id.toString(),
        _user: data.user.toString(),
        _keyword: data.path,
        _keyword_paths: paths,
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
            log.error('Tasks', 'task=keyword-delete id=%s user=%s keyword=%s error=%s', task._id, data.user, data.path, err.message);
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
