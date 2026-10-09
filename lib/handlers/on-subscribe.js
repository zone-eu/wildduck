'use strict';

const db = require('../db');
const consts = require('../consts');

// SUBSCRIBE "path/to/mailbox"
module.exports = server => async (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'subscribe',
            cid: session.id
        },
        '[%s] SUBSCRIBE to "%s"',
        session.id,
        path
    );
    let item;
    try {
        item = await db.database.collection('mailboxes').findOneAndUpdate(
            {
                user: session.user.id,
                path
            },
            {
                $set: {
                    subscribed: true
                }
            },
            { includeResultMetadata: true, maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
        );
    } catch (err) {
        return callback(err);
    }

    if (!item || !item.value) {
        // was not able to acquire a lock
        return callback(null, 'NONEXISTENT');
    }

    callback(null, true);
};
