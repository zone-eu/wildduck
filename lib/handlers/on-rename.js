'use strict';

const { resolveMailboxAsync } = require('../mailbox-resolver');

// RENAME "path/to/mailbox" "new/path"
// NB! RENAME affects child and hierarchy mailboxes as well, this example does not do this
module.exports = (server, mailboxHandler) => (path, newname, session, callback) => {
    server.logger.debug(
        {
            tnx: 'rename',
            cid: session.id
        },
        '[%s] RENAME "%s" to "%s"',
        session.id,
        path,
        newname
    );

    const renameMailbox = async () => {
        let resolved = await resolveMailboxAsync(server, session, path);
        let mailbox = resolved.mailboxData;

        if (!mailbox) {
            return ['NONEXISTENT'];
        }

        let result = await mailboxHandler.renameAsync(resolved.owner, mailbox._id, newname, false);
        return [result.status, result.mailbox];
    };

    renameMailbox().then(args => callback(null, ...args), callback);
};
