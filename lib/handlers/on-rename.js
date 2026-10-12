'use strict';

const db = require('../db');
const consts = require('../consts');

// RENAME "path/to/mailbox" "new/path"
// NB! RENAME affects child and hierarchy mailboxes as well, this example does not do this
module.exports = (server, mailboxHandler) => (path, newname, session, callback) => {
    server.logger.debug(
        {
            tnx: 'rename',
            cid: session.id
        },
        '[%s] RENAME "%s" to "%s"',
        session.id,
        path,
        newname
    );

    const renameMailbox = async () => {
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

        let result = await mailboxHandler.renameAsync(session.user.id, mailbox._id, newname, false);
        return [result.status, result.mailbox];
    };

    renameMailbox().then(args => callback(null, ...args), callback);
};
