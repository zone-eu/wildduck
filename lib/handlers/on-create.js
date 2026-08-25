'use strict';

const acl = require('../acl');

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

    if (acl.isEnabled(server) && acl.parsePath(path).shared) {
        // creating mailboxes in the shared namespace is not supported. This also keeps
        // personal folders from shadowing the shared namespace prefix
        return callback(null, 'CANNOT');
    }

    mailboxHandler.create(session.user.id, path, { subscribed: true }, callback);
};
