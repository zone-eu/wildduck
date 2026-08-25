'use strict';

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
        let resolved = await resolveMailboxAsync(server, session, path);
        let mailbox = resolved.mailboxData;

        if (!mailbox) {
            return ['NONEXISTENT'];
        }

        let status = await mailboxHandler.delAsync(resolved.owner, mailbox._id);
        return [status, mailbox._id];
    };

    deleteMailbox().then(args => callback(null, ...args), callback);
};
