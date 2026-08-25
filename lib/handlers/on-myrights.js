'use strict';

const acl = require('../acl');
const { resolveMailbox } = require('../mailbox-resolver');

// MYRIGHTS "mailbox"
module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'myrights',
            cid: session.id
        },
        '[%s] Listing own rights for "%s"',
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

        let rights = typeof resolved.rights === 'string' ? resolved.rights : acl.RIGHTS;

        let visibleWith = [
            acl.ACL_RIGHTS.LOOKUP,
            acl.ACL_RIGHTS.READ,
            acl.ACL_RIGHTS.INSERT,
            acl.ACL_RIGHTS.CREATE,
            acl.ACL_RIGHTS.DELETE_MAILBOX,
            acl.ACL_RIGHTS.ADMINISTER
        ];
        if (!visibleWith.some(right => acl.hasRight(rights, right))) {
            // RFC 4314: without any of these rights the mailbox must appear nonexistent
            return callback(null, 'NONEXISTENT');
        }

        callback(null, {
            rights: acl.formatResponseRights(rights)
        });
    });
};
