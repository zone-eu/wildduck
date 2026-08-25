'use strict';

const acl = require('../acl');
const { resolveMailbox } = require('../mailbox-resolver');

// SETACL "mailbox" "identifier" "rights"
module.exports = server => (path, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'setacl',
            cid: session.id
        },
        '[%s] Updating ACL for "%s"',
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
                // the rights of the mailbox owner can not be modified
                return callback(null, 'CANNOT');
            }

            acl.getGrant(mailboxData._id, granteeData._id, (err, aclData) => {
                if (err) {
                    return callback(err);
                }

                let rights = acl.applyRights((aclData && aclData.rights) || '', update.rights);

                acl.setGrant(mailboxData, granteeData, rights, (err, result) => {
                    if (err) {
                        if (err.imapResponse) {
                            return callback(null, err.imapResponse);
                        }
                        return callback(err);
                    }

                    server.loggelf({
                        short_message: '[ACLUPDATE] ' + (result.removed ? '-' : '+'),
                        _mail_action: 'acl_update',
                        _user: session.user.id.toString(),
                        _owner: mailboxData.user.toString(),
                        _mailbox: mailboxData._id.toString(),
                        _mailbox_path: mailboxData.path,
                        _grantee: granteeData._id.toString(),
                        _rights: rights,
                        _sess: session.id
                    });

                    callback(null, true);
                });
            });
        });
    });
};
