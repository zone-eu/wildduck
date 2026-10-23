'use strict';

const db = require('../db');
const consts = require('../consts');
const acl = require('../acl');

// LIST "" "*"
// Returns all folders, query is informational
// folders is either an Array or a Map
module.exports = server =>
    (server.onList = function (query, session, callback) {
        server.logger.debug(
            {
                tnx: 'list',
                cid: session.id
            },
            '[%s] LIST for "%s"',
            session.id,
            query
        );
        db.database
            .collection('mailboxes')
            .find({
                user: session.user.id,
                hidden: { $ne: true }
            })
            .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
            .toArray()
            .then(async mailboxes => {
                if (!acl.isEnabled(server)) {
                    return mailboxes;
                }

                let shared = await acl.asyncGetSharedMailboxes(session.user.id);
                return mailboxes.concat(shared);
            })
            .then(mailboxes => callback(null, mailboxes), callback);
    });
