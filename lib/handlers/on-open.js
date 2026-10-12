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

    const openMailbox = async () => {
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
            return 'NONEXISTENT';
        }

        if (mailbox.hidden) {
            return 'CANNOT';
        }

        let messages = await db.database
            .collection('messages')
            .find({
                mailbox: mailbox._id
            })
            .project({
                uid: true,
                _id: false
            })
            .sort({ uid: 1 })
            .maxTimeMS(consts.DB_MAX_TIME_MESSAGES)
            .toArray();

        // sort and ensure unique UIDs
        mailbox.uidList = Array.from(new Set(messages.map(message => message.uid)));
        return mailbox;
    };

    openMailbox().then(mailbox => callback(null, mailbox), callback);
};
