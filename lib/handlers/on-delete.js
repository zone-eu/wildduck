'use strict';

const db = require('../db');
const consts = require('../consts');

// DELETE "path/to/mailbox"
module.exports = (server, mailboxHandler) => async (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'delete',
            cid: session.id
        },
        '[%s] DELETE "%s"',
        session.id,
        path
    );

    let mailbox;
    try {
        mailbox = await db.database.collection('mailboxes').findOne(
            {
                user: session.user.id,
                path
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        );
    } catch (err) {
        return callback(err);
    }

    if (!mailbox) {
        return callback(null, 'NONEXISTENT');
    }

    mailboxHandler.del(session.user.id, mailbox._id, callback);
};
