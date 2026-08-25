'use strict';

const acl = require('../acl');
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
        let resolved = await resolveMailboxAsync(server, session, path, { requireRights: acl.ACL_RIGHTS.DELETE_MAILBOX });
        let mailbox = resolved.mailboxData;

        if (!mailbox) {
            return ['NONEXISTENT'];
        }

        if (resolved.denied) {
            return ['NOPERM'];
        }

        let targetPath = newname;

        if (!resolved.shared) {
            if (acl.isEnabled(server) && acl.parsePath(newname).shared) {
                // renaming mailboxes into other accounts is not supported
                return ['CANNOT'];
            }
        } else {
            // renaming inside a shared hierarchy: the destination must stay in the same
            // account and its parent must exist with the create right
            let parsedTarget = acl.parsePath(newname);
            if (!parsedTarget.shared || !parsedTarget.identifier || !parsedTarget.path) {
                return ['CANNOT'];
            }

            let parentParts = parsedTarget.path.split('/');
            parentParts.pop();

            if (!parentParts.length) {
                // renaming to a top level mailbox of another user is not supported
                return ['CANNOT'];
            }

            let parentPath = acl.formatPath(parsedTarget.identifier, parentParts.join('/'));
            let resolvedParent = await resolveMailboxAsync(server, session, parentPath, { requireRights: acl.ACL_RIGHTS.CREATE });

            if (!resolvedParent.mailboxData) {
                return ['NONEXISTENT'];
            }

            if (resolvedParent.denied) {
                return ['NOPERM'];
            }

            if (!resolvedParent.owner.equals(resolved.owner)) {
                // source and destination must belong to the same user
                return ['CANNOT'];
            }

            targetPath = parsedTarget.path;
        }

        let result = await mailboxHandler.renameAsync(resolved.owner, mailbox._id, targetPath, false);
        return [result.status, result.mailbox];
    };

    renameMailbox().then(args => callback(null, ...args), callback);
};
