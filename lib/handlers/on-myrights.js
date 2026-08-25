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

        if (!/[lrikxa]/.test(rights)) {
            // RFC 4314: MYRIGHTS needs at least one of "l", "r", "i", "k", "x" or "a",
            // otherwise the mailbox must appear nonexistent
            return callback(null, 'NONEXISTENT');
        }

        callback(null, {
            rights
        });
    });
};
