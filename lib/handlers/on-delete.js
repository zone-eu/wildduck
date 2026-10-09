'use strict';

const db = require('../db');
const consts = require('../consts');

// DELETE "path/to/mailbox"
module.exports = (server, mailboxHandler) => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'delete',
            cid: session.id
        },
        '[%s] DELETE "%s"',
        session.id,
        path
    );

    const deleteMailbox = async () => {
        let mailbox = await db.database.collection('mailboxes').findOne(
            {
                user: session.user.id,
                path
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        );

        if (!mailbox) {
            return ['NONEXISTENT'];
        }

        let status = await mailboxHandler.delAsync(session.user.id, mailbox._id);
        return [status, mailbox._id];
    };

    deleteMailbox().then(args => callback(null, ...args), callback);
};
