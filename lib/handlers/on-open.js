'use strict';

const db = require('../db');
const consts = require('../consts');

// SELECT/EXAMINE
module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'open',
            cid: session.id
        },
        '[%s] Opening "%s"',
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
        (err, mailbox) => {
            if (err) {
                return callback(err);
            }
            if (!mailbox) {
                return callback(null, 'NONEXISTENT');
            }

            if (mailbox.hidden) {
                return callback(null, 'CANNOT');
            }

            db.database
                .collection('messages')
                .find({
                    mailbox: mailbox._id
                })
                .project({
                    uid: true
                })
                .sort({ uid: 1 })
                .maxTimeMS(consts.DB_MAX_TIME_MESSAGES)
                .toArray((err, messages) => {
                    if (err) {
                        return callback(err);
                    }
                    // sort and ensure unique UIDs
                    mailbox.uidList = Array.from(new Set(messages.map(message => message.uid)));
                    callback(null, mailbox);
                });
        }
    );
};
