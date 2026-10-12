'use strict';

const db = require('../db');
const consts = require('../consts');

// STATUS (X Y X)
module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'status',
            cid: session.id
        },
        '[%s] Requested status for "%s"',
        session.id,
        path
    );

    const status = async () => {
        let mailboxData = await db.database.collection('mailboxes').findOne(
            {
                user: session.user.id,
                path
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        );

        if (!mailboxData) {
            return 'NONEXISTENT';
        }

        let [total, unseen] = await Promise.all([
            db.database.collection('messages').countDocuments(
                {
                    mailbox: mailboxData._id
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                }
            ),
            db.database.collection('messages').countDocuments(
                {
                    mailbox: mailboxData._id,
                    unseen: true
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                }
            )
        ]);

        return {
            messages: total,
            uidNext: mailboxData.uidNext,
            uidValidity: mailboxData.uidValidity,
            unseen,
            highestModseq: Number(mailboxData.modifyIndex) || 1
        };
    };

    status().then(result => callback(null, result), callback);
};
