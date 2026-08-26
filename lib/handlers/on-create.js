'use strict';

const acl = require('../acl');
const { resolveMailbox } = require('../mailbox-resolver');

// CREATE "path/to/mailbox"
module.exports = (server, mailboxHandler) => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'create',
            cid: session.id
        },
        '[%s] CREATE "%s"',
        session.id,
        path
    );

    if (!acl.isEnabled(server) || !acl.parsePath(path).shared) {
        return mailboxHandler.create(session.user.id, path, { subscribed: true }, callback);
    }

    let parsed = acl.parsePath(path);

    if (!parsed.identifier || !parsed.path) {
        // the namespace entries themselves can not be created. This also keeps
        // personal folders from shadowing the shared namespace prefix
        return callback(null, 'CANNOT');
    }

    let parentParts = parsed.path.split('/');
    parentParts.pop();

    if (!parentParts.length) {
        // creating top level mailboxes for other users is not supported
        return callback(null, 'CANNOT');
    }

    let parentPath = acl.formatPath(parsed.namespace, parsed.identifier, parentParts.join('/'));

    resolveMailbox(server, session, parentPath, { requireRights: acl.ACL_RIGHTS.CREATE }, (err, resolved) => {
        if (err) {
            return callback(err);
        }

        if (!resolved.mailboxData) {
            return callback(null, 'NONEXISTENT');
        }

        if (resolved.denied) {
            return callback(null, 'NOPERM');
        }

        // the new mailbox belongs to the account owner and inherits the ACL of its
        // parent inside mailboxHandler.create, so every user sharing the hierarchy
        // keeps seeing it, including the creator
        mailboxHandler.create(resolved.owner, parsed.path, { subscribed: true }, callback);
    });
};
