'use strict';

const acl = require('../acl');
const { resolveMailbox } = require('../mailbox-resolver');

// DELETEACL "mailbox" "identifier"
module.exports = server => (path, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'deleteacl',
            cid: session.id
        },
        '[%s] Removing ACL entry from "%s"',
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
                // nothing to remove for an unknown identifier
                return callback(null, true);
            }

            if (granteeData._id.toString() === mailboxData.user.toString()) {
                // the rights of the mailbox owner can not be removed
                return callback(null, 'CANNOT');
            }

            acl.deleteGrant(mailboxData._id, granteeData._id, (err, result) => {
                if (err) {
                    return callback(err);
                }

                if (result.removed) {
                    server.loggelf({
                        short_message: '[ACLUPDATE] -',
                        _mail_action: 'acl_delete',
                        _user: session.user.id.toString(),
                        _owner: mailboxData.user.toString(),
                        _mailbox: mailboxData._id.toString(),
                        _mailbox_path: mailboxData.path,
                        _grantee: granteeData._id.toString(),
                        _sess: session.id
                    });
                }

                callback(null, true);
            });
        });
    });
};
