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

        if (resolved.account) {
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

                acl.checkTenantScope(resolved.owner, granteeData, (err, sameTenant) => {
                    if (err) {
                        return callback(err);
                    }

                    if (!sameTenant) {
                        return callback(null, 'CANNOT');
                    }

                    if (granteeData._id.toString() === resolved.owner.toString()) {
                        // the owner always holds all rights, none are optional
                        return callback(null, {
                            identifier: update.identifier,
                            required: acl.formatResponseRights(acl.RIGHTS),
                            optional: []
                        });
                    }

                    callback(null, {
                        identifier: update.identifier,
                        required: '',
                        optional: acl.RIGHTS.split('').concat(['c', 'd'])
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

            acl.checkTenantScope(mailboxData.user, granteeData, (err, sameTenant) => {
                if (err) {
                    return callback(err);
                }

                if (!sameTenant) {
                    // respond exactly like for an unknown identifier
                    return callback(null, 'CANNOT');
                }

                if (granteeData._id.toString() === mailboxData.user.toString()) {
                    // the owner always holds all rights, none are optional. RFC 4314
                    // requires the response to echo the identifier as sent by the client
                    return callback(null, {
                        identifier: update.identifier,
                        required: acl.formatResponseRights(acl.RIGHTS),
                        optional: []
                    });
                }

                // the virtual "c" and "d" rights are always grantable
                callback(null, {
                    identifier: update.identifier,
                    required: '',
                    optional: acl.RIGHTS.split('').concat(['c', 'd'])
                });
            });
        });
    });
};
