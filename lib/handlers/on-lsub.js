'use strict';

const db = require('../db');
const consts = require('../consts');
const acl = require('../acl');

// LSUB "" "*"
// Returns all subscribed folders, query is informational
// folders is either an Array or a Map
module.exports = server => (query, session, callback) => {
    server.logger.debug(
        {
            tnx: 'lsub',
            cid: session.id
        },
        '[%s] LSUB for "%s"',
        session.id,
        query
    );
    db.database
        .collection('mailboxes')
        .find({
            user: session.user.id,
            subscribed: true,
            hidden: { $ne: true }
        })
        .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
        .toArray()
        .then(async mailboxes => {
            if (!acl.isEnabled(server)) {
                return mailboxes;
            }

            let shared = await acl.asyncGetSharedMailboxes(session.user.id, { subscribedOnly: true });
            return mailboxes.concat(shared);
        })
        .then(mailboxes => callback(null, mailboxes), callback);
};
