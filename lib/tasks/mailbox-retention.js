'use strict';

const log = require('npmlog');
const db = require('../db');
const consts = require('../consts');
const tools = require('../tools');

let run = async (task, data) => {
    let processed = 0;
    let passes = 0;
    let rerun = false;

    do {
        passes++;
        rerun = false;

        const passStart = new Date();
        let lastUid = 0;
        let hasMore = true;

        while (hasMore) {
            const mailboxData = await db.database.collection('mailboxes').findOne(
                {
                    _id: data.mailbox,
                    user: data.user
                },
                {
                    projection: {
                        retention: true
                    }
                }
            );

            if (!mailboxData) {
                log.verbose('Tasks', 'task=mailbox-retention id=%s user=%s mailbox=%s status=missing-mailbox', task._id, data.user, data.mailbox);
                return { processed, passes };
            }

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
                    uid: true
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

            const operations = messages.map(messageData => {
                // Messages get a fresh ObjectId when they are copied or moved, so its timestamp tracks arrival to this mailbox.
                const retentionState = tools.getMessageRetentionState(mailboxData, messageData._id.getTimestamp().getTime());
                const update = {
                    $set: {
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
            });

            await db.database.collection('messages').bulkWrite(operations, {
                ordered: false
            });

            processed += operations.length;
            lastUid = messages[messages.length - 1].uid;
        }

        const taskData = await db.database.collection('tasks').findOne(
            {
                _id: task._id
            },
            {
                projection: {
                    updated: true
                }
            }
        );

        rerun = !!(taskData && taskData.updated && taskData.updated > passStart);
    } while (rerun);

    log.verbose('Tasks', 'task=mailbox-retention id=%s user=%s mailbox=%s processed=%s passes=%s', task._id, data.user, data.mailbox, processed, passes);

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
