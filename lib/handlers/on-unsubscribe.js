'use strict';

const db = require('../db');
const consts = require('../consts');
const acl = require('../acl');
const { resolveMailboxAsync } = require('../mailbox-resolver');

// UNSUBSCRIBE "path/to/mailbox"
module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'unsubscribe',
            cid: session.id
        },
        '[%s] UNSUBSCRIBE from "%s"',
        session.id,
        path
    );

    if (acl.isEnabled(server) && acl.parsePath(path).shared) {
        // subscriptions of shared mailboxes are personal to the grantee and live on the ACL entry
        const unsubscribeShared = async () => {
            let resolved = await resolveMailboxAsync(server, session, path, { requireRights: acl.ACL_RIGHTS.LOOKUP });

            if (!resolved.mailboxData) {
                return 'NONEXISTENT';
            }

            if (resolved.denied) {
                return 'NOPERM';
            }

            await db.database.collection('mailboxacls').updateOne(
                {
                    mailbox: resolved.mailboxData._id,
                    user: session.user.id
                },
                {
                    $set: {
                        subscribed: false
                    }
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                }
            );

            return true;
        };

        return unsubscribeShared().then(result => callback(null, result), callback);
    }

    db.database
        .collection('mailboxes')
        .findOneAndUpdate(
            {
                user: session.user.id,
                path
            },
            {
                $set: {
                    subscribed: false
                }
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        )
        .then(item => {
            if (!item || !item.value) {
                return callback(null, 'NONEXISTENT');
            }

            callback(null, true);
        }, callback);
};
