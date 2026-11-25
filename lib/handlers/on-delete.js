'use strict';

const acl = require('../acl');
const { resolveMailboxAsync } = require('../mailbox-resolver');

// DELETE "path/to/mailbox"
module.exports = (server, mailboxHandler) => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'delete',
            cid: session.id
        },
        '[%s] DELETE "%s"',
        session.id,
        path
    );

    const deleteMailbox = async () => {
        let resolved = await resolveMailboxAsync(server, session, path, { requireRights: acl.ACL_RIGHTS.DELETE_MAILBOX });
        let mailbox = resolved.mailboxData;

        if (!mailbox) {
            return ['NONEXISTENT'];
        }

        if (resolved.denied) {
            return ['NOPERM'];
        }

        let status = await mailboxHandler.delAsync(resolved.owner, mailbox._id);
        return [status, mailbox._id];
    };

    deleteMailbox().then(args => callback(null, ...args), callback);
};
