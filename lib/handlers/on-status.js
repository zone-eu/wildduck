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
    db.database.collection('mailboxes').findOne(
        {
            user: session.user.id,
            path
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        },
        (err, mailboxData) => {
            if (err) {
                return callback(err);
            }
            if (!mailboxData) {
                return callback(null, 'NONEXISTENT');
            }

            db.database.collection('messages').countDocuments(
                {
                    mailbox: mailboxData._id
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                },
                (err, total) => {
                    if (err) {
                        return callback(err);
                    }
                    db.database.collection('messages').countDocuments(
                        {
                            mailbox: mailboxData._id,
                            unseen: true
                        },
                        {
                            maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                        },
                        (err, unseen) => {
                            if (err) {
                                return callback(err);
                            }

                            return callback(null, {
                                messages: total,
                                uidNext: mailboxData.uidNext,
                                uidValidity: mailboxData.uidValidity,
                                unseen,
                                highestModseq: Number(mailboxData.modifyIndex) || 1
                            });
                        }
                    );
                }
            );
        }
    );
};
