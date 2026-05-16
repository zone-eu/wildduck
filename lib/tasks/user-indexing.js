'use strict';

const log = require('npmlog');
const db = require('../db');
const { BACKLOG_INDEXING_PRIORITY, enqueueMessageSync } = require('../indexing-queue');

let run = async (task, data, options) => {
    const backlogIndexingQueue = options.backlogIndexingQueue;
    const loggelf = options.loggelf;

    let hasFeatureFlag = await db.redis.sismember(`feature:indexing`, data.user.toString());

    if (!hasFeatureFlag) {
        log.silly('Tasks', 'task=user-indexing id=%s Feature flag not set, skipping user=%s command=%s', task._id, data.user.toString(), 'backlog');
        return;
    } else {
        log.verbose('Tasks', 'task=user-indexing id=%s Feature flag set, processing user=%s command=%s', task._id, data.user.toString(), 'backlog');
    }

    let cursor = await db.database.collection('messages').find(
        {
            user: data.user
        },
        {
            projection: {
                _id: true,
                mailbox: true,
                uid: true,
                modseq: true
            }
        }
    );

    let messages = 0;

    let messageData;
    while ((messageData = await cursor.next())) {
        let hasFeatureFlag = await db.redis.sismember(`feature:indexing`, data.user.toString());
        if (!hasFeatureFlag) {
            log.verbose(
                'Tasks',
                'task=user-indexing id=%s Aborted user indexing, feature flag disabled user=%s messages=%s',
                task._id,
                data.user.toString(),
                messages
            );
            await cursor.close();
            return;
        }

        await enqueueMessageSync(
            backlogIndexingQueue,
            db.redis,
            {
                message: messageData._id,
                mailbox: messageData.mailbox,
                uid: messageData.uid,
                modseq: messageData.modseq,
                user: data.user
            },
            BACKLOG_INDEXING_PRIORITY
        );

        messages++;
    }
    await cursor.close();

    log.verbose('Tasks', 'task=user-indexing id=%s User messages queued for indexing user=%s messages=%s', task._id, data.user.toString(), messages);

    loggelf({
        short_message: '[INDEXER]',
        _mail_action: `indexer_user_indexed`,
        _user: data.user,
        _mailbox: data.mailbox,
        _uid: data.uid,
        _modseq: data.modseq,
        _queued_messages: messages
    });
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=user-indexing id=%s user=%s error=%s', task._id, data.user, err.stack);

            options.loggelf({
                short_message: '[INDEXER]',
                _mail_action: `indexer_user_indexed`,
                _user: data.user,
                _mailbox: data.mailbox,
                _uid: data.uid,
                _modseq: data.modseq,
                _error: err.message
            });

            callback(err);
        });
};
