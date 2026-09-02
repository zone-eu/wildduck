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

        if (resolved.account) {
            // SETACL on the account node manages the owner's account wide grant
            if (!acl.hasRight(resolved.rights, acl.ACL_RIGHTS.ADMINISTER)) {
                return callback(null, !acl.hasRight(resolved.rights, acl.ACL_RIGHTS.LOOKUP) ? 'NONEXISTENT' : 'NOPERM');
            }

            return acl.resolveIdentifier(update.identifier, { grantee: true }, (err, granteeData) => {
                if (err) {
                    return callback(err);
                }

                if (!granteeData) {
                    return callback(null, 'CANNOT');
                }

                if (granteeData._id.toString() === resolved.owner.toString()) {
                    // the rights of the account owner can not be modified
                    return callback(null, 'CANNOT');
                }

                acl.checkTenantScope(resolved.owner, granteeData, (err, sameTenant) => {
                    if (err) {
                        return callback(err);
                    }

                    if (!sameTenant) {
                        return callback(null, 'CANNOT');
                    }

                    acl.getAccountGrant(resolved.owner, granteeData._id, (err, aclData) => {
                        if (err) {
                            return callback(err);
                        }

                        let rights = acl.applyRights((aclData && aclData.rights) || '', update.rights);

                        acl.setAccountGrant({ _id: resolved.owner }, granteeData, rights, (err, result) => {
                            if (err) {
                                if (err.imapResponse) {
                                    return callback(null, err.imapResponse);
                                }
                                return callback(err);
                            }

                            let previousRights = acl.normalizeRights((aclData && aclData.rights) || '');
                            if (previousRights.split('').some(right => rights.indexOf(right) < 0)) {
                                // account wide rights were revoked: kick the grantee from every
                                // mailbox of the owner, since the notifier only drops a session
                                // whose selected mailbox matches the payload
                                acl.getOwnerMailboxIds(resolved.owner, (err, mailboxIds) => {
                                    if (err) {
                                        return;
                                    }
                                    for (let mailboxId of mailboxIds) {
                                        server.notifier.fire(granteeData._id, {
                                            command: 'DROP',
                                            mailbox: mailboxId
                                        });
                                    }
                                });
                            }

                            server.loggelf({
                                short_message: '[ACLUPDATE] ' + (result.removed ? '-' : '+'),
                                _mail_action: 'acl_update',
                                _acl_scope: 'account',
                                _user: session.user.id.toString(),
                                _owner: resolved.owner.toString(),
                                _grantee: granteeData._id.toString(),
                                _rights: rights,
                                _sess: session.id
                            });

                            callback(null, true);
                        });
                    });
                });
            });
        }

        let mailboxData = resolved.mailboxData;
        if (!mailboxData) {
            return callback(null, 'NONEXISTENT');
        }

        if (typeof resolved.rights === 'string' && !acl.hasRight(resolved.rights, acl.ACL_RIGHTS.ADMINISTER)) {
            // without the lookup right the mailbox must appear nonexistent
            return callback(null, !acl.hasRight(resolved.rights, acl.ACL_RIGHTS.LOOKUP) ? 'NONEXISTENT' : 'NOPERM');
        }

        acl.resolveIdentifier(update.identifier, { grantee: true }, (err, granteeData) => {
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

            acl.checkTenantScope(mailboxData.user, granteeData, (err, sameTenant) => {
                if (err) {
                    return callback(err);
                }

                if (!sameTenant) {
                    // respond exactly like for an unknown identifier
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

                        let previousRights = acl.normalizeRights((aclData && aclData.rights) || '');
                        if (previousRights.split('').some(right => rights.indexOf(right) < 0)) {
                            // rights were revoked: kick active sessions of the grantee from the mailbox
                            server.notifier.fire(granteeData._id, {
                                command: 'DROP',
                                mailbox: mailboxData._id
                            });
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
    });
};
