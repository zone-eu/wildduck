'use strict';

const acl = require('../acl');
const { resolveMailbox } = require('../mailbox-resolver');

// LISTRIGHTS "mailbox" "identifier"
module.exports = server => (path, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'listrights',
            cid: session.id
        },
        '[%s] Listing grantable rights for "%s"',
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

        acl.resolveIdentifier(update.identifier, (err, granteeData) => {
            if (err) {
                return callback(err);
            }

            if (!granteeData) {
                // unknown identifier
                return callback(null, 'CANNOT');
            }

            if (granteeData._id.toString() === mailboxData.user.toString()) {
                // the owner always holds all rights, none are optional
                return callback(null, {
                    identifier: granteeData.username,
                    required: acl.RIGHTS,
                    optional: []
                });
            }

            callback(null, {
                identifier: granteeData.username,
                required: '',
                optional: acl.RIGHTS.split('')
            });
        });
    });
};
