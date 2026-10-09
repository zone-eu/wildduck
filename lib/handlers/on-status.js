'use strict';

const db = require('../db');
const consts = require('../consts');

// STATUS (X Y X)
module.exports = server => async (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'status',
            cid: session.id
        },
        '[%s] Requested status for "%s"',
        session.id,
        path
    );
    let mailboxData;
    try {
        mailboxData = await db.database.collection('mailboxes').findOne(
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

    if (!mailboxData) {
        return callback(null, 'NONEXISTENT');
    }

    let total;
    try {
        total = await db.database.collection('messages').countDocuments(
            {
                mailbox: mailboxData._id
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MESSAGES
            }
        );
    } catch (err) {
        return callback(err);
    }

    let unseen;
    try {
        unseen = await db.database.collection('messages').countDocuments(
            {
                mailbox: mailboxData._id,
                unseen: true
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MESSAGES
            }
        );
    } catch (err) {
        return callback(err);
    }
    return callback(null, {
        messages: total,
        uidNext: mailboxData.uidNext,
        uidValidity: mailboxData.uidValidity,
        unseen,
        highestModseq: Number(mailboxData.modifyIndex) || 1
    });
};
