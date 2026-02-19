'use strict';

const log = require('npmlog');
const db = require('../db');
const tools = require('../tools');

let run = async (task, data, options) => {
    const messageHandler = options.messageHandler;

    const { user, mailbox, skipArchive } = data;

    let cursor = await db.database
        .collection('messages')
        .find({
            mailbox
        })
        .sort({ uid: -1 });

    let messageData;
    let deleted = 0;
    let errors = 0;

    while ((messageData = await cursor.next())) {
        if (!messageData || messageData.user.toString() !== user.toString()) {
            continue;
        }

        try {
            await messageHandler.delAsync({
                user,
                mailbox: { user, mailbox },
                messageData,
                archive: !messageData.flags.includes('\\Draft') && !skipArchive
            });
            deleted++;
        } catch (err) {
            errors++;
            log.error(
                'Tasks',
                'task=clear-folder id=%s user=%s mailbox=%s message=%s error=%s',
                task._id,
                data.user,
                data.mailbox,
                messageData._id,
                err.message
            );
        }
    }
    await cursor.close();

    try {
        const mailboxKey = tools.redisClusterValue(mailbox, db.redis);
        // clear counters
        await db.redis.multi().del(`total:${mailboxKey}`).del(`unseen:${mailboxKey}`).exec();
    } catch (err) {
        // ignore
    }

    log.verbose('Tasks', 'task=clear-folder id=%s user=%s mailbox=%s deleted=%s errors=%s', task._id, data.user, data.mailbox, deleted, errors);
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=clear-folder id=%s user=%s error=%s', task._id, data.user, err.message);
            callback(err);
        });
};
