'use strict';

const log = require('npmlog');
const db = require('../db');
const consts = require('../consts');
const tools = require('../tools');

let getMailboxData = async data =>
    db.database.collection('mailboxes').findOne(
        {
            _id: data.mailbox,
            user: data.user
        },
        {
            projection: {
                retention: true,
                retentionCounter: true
            }
        }
    );

let getTaskRetentionCounter = async task => {
    const taskData = await db.database.collection('tasks').findOne(
        {
            _id: task._id
        },
        {
            projection: {
                'data.retentionCounter': true
            }
        }
    );

    return taskData?.data?.retentionCounter || 0;
};

let run = async (task, data) => {
    let processed = 0;
    let passes = 0;
    let rerun = false;
    let activeRetentionCounter = data?.retentionCounter || 0;

    do {
        passes++;
        rerun = false;
        let lastUid = 0;
        let hasMore = true;
        const [mailboxData, taskRetentionCounter] = await Promise.all([getMailboxData(data), getTaskRetentionCounter(task)]);
        const mailboxRetentionCounter = mailboxData?.retentionCounter || 0;

        if (!mailboxData) {
            log.verbose('Tasks', 'task=mailbox-retention id=%s user=%s mailbox=%s status=missing-mailbox', task._id, data.user, data.mailbox);
            return { processed, passes };
        }

        if (taskRetentionCounter < mailboxRetentionCounter) {
            log.verbose(
                'Tasks',
                'task=mailbox-retention id=%s user=%s mailbox=%s status=stale taskRetentionCounter=%s mailboxRetentionCounter=%s',
                task._id,
                data.user,
                data.mailbox,
                taskRetentionCounter,
                mailboxRetentionCounter
            );
            return { processed, passes };
        }

        if (taskRetentionCounter > activeRetentionCounter) {
            activeRetentionCounter = taskRetentionCounter;
            rerun = true;
            continue;
        }

        while (hasMore) {
            const messages = await db.database
                .collection('messages')
                .find({
                    user: data.user,
                    mailbox: data.mailbox,
                    uid: {
                        $gt: lastUid
                    }
                })
                .project({
                    _id: true,
                    uid: true,
                    exp: true,
                    rdate: true,
                    retention: true,
                    retentionTime: true
                })
                .sort({
                    uid: 1
                })
                .limit(consts.BULK_BATCH_SIZE)
                .toArray();

            if (!messages.length) {
                hasMore = false;
                continue;
            }

            const latestTaskRetentionCounter = await getTaskRetentionCounter(task);

            if (latestTaskRetentionCounter > activeRetentionCounter) {
                activeRetentionCounter = latestTaskRetentionCounter;
                rerun = true;
                break;
            }

            const operations = messages
                .map(messageData => {
                // Messages with an explicit expiry and no mailbox retention marker
                // have been overridden at message level and must be preserved.
                    if (!('retention' in messageData) && messageData.exp && messageData.rdate) {
                        return false;
                    }

                    const addedAt = messageData.retentionTime || messageData._id.getTimestamp().getTime();
                    const retentionState = tools.getMessageRetentionState(mailboxData, addedAt);
                    const update = {
                        $set: {
                            retentionTime: addedAt,
                            retention: retentionState.retention,
                            exp: retentionState.exp
                        }
                    };

                    if ('rdate' in retentionState) {
                        update.$set.rdate = retentionState.rdate;
                    } else {
                        update.$unset = {
                            rdate: true
                        };
                    }

                    return {
                        updateOne: {
                            filter: {
                                _id: messageData._id,
                                mailbox: data.mailbox,
                                uid: messageData.uid
                            },
                            update
                        }
                    };
                })
                .filter(Boolean);

            if (operations.length) {
                await db.database.collection('messages').bulkWrite(operations, {
                    ordered: false
                });
            }

            processed += operations.length;
            lastUid = messages[messages.length - 1].uid;
        }

        if (!rerun) {
            const latestTaskRetentionCounter = await getTaskRetentionCounter(task);

            if (latestTaskRetentionCounter > activeRetentionCounter) {
                activeRetentionCounter = latestTaskRetentionCounter;
                rerun = true;
            }
        }
    } while (rerun);

    log.verbose(
        'Tasks',
        'task=mailbox-retention id=%s user=%s mailbox=%s processed=%s passes=%s retentionCounter=%s',
        task._id,
        data.user,
        data.mailbox,
        processed,
        passes,
        activeRetentionCounter
    );

    return { processed, passes };
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=mailbox-retention id=%s user=%s mailbox=%s error=%s', task._id, data.user, data.mailbox, err.stack);
            callback(err);
        });
};
