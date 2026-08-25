'use strict';

const db = require('../db');
const consts = require('../consts');
const acl = require('../acl');
const { resolveMailbox } = require('../mailbox-resolver');

// GETACL "mailbox"
module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'getacl',
            cid: session.id
        },
        '[%s] Listing ACL for "%s"',
        session.id,
        path
    );

    resolveMailbox(server, session, path, (err, resolved) => {
        if (err) {
            return callback(err);
        }

        let mailboxData = resolved.mailboxData;
        if (!mailboxData) {
            return callback(null, 'NONEXISTENT');
        }

        if (typeof resolved.rights === 'string' && resolved.rights.indexOf('a') < 0) {
            // without the "l" right the mailbox must appear nonexistent
            return callback(null, resolved.rights.indexOf('l') < 0 ? 'NONEXISTENT' : 'NOPERM');
        }

        db.users.collection('users').findOne(
            {
                _id: mailboxData.user
            },
            {
                projection: {
                    username: true
                },
                maxTimeMS: consts.DB_MAX_TIME_USERS
            },
            (err, ownerData) => {
                if (err) {
                    return callback(err);
                }
                if (!ownerData) {
                    return callback(new Error('User data not found'));
                }

                acl.listGrants(mailboxData._id, (err, grants) => {
                    if (err) {
                        return callback(err);
                    }

                    callback(null, {
                        acl: [
                            {
                                identifier: ownerData.username,
                                rights: acl.RIGHTS
                            }
                        ].concat(
                            grants.map(aclData => ({
                                identifier: aclData.username,
                                rights: aclData.rights
                            }))
                        )
                    });
                });
            }
        );
    });
};
