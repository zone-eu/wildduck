'use strict';

const db = require('../db');
const consts = require('../consts');
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

    let parentPath = acl.formatPath(parsed.identifier, parentParts.join('/'));

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

        // the new mailbox inherits all ACL entries of its parent, so every user
        // sharing the hierarchy keeps seeing it, including the creator
        db.database
            .collection('mailboxacls')
            .find({
                mailbox: resolved.mailboxData._id
            })
            .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
            .toArray((err, aclList) => {
                if (err) {
                    return callback(err);
                }

                mailboxHandler.create(resolved.owner, parsed.path, { subscribed: true }, (err, status, id) => {
                    if (err || status !== true) {
                        return callback(err, status, id);
                    }

                    if (!aclList.length) {
                        return callback(null, status, id);
                    }

                    let created = new Date();
                    db.database.collection('mailboxacls').insertMany(
                        aclList.map(aclData => ({
                            mailbox: id,
                            user: aclData.user,
                            owner: resolved.owner,
                            rights: acl.normalizeRights(aclData.rights),
                            subscribed: true,
                            created
                        })),
                        {
                            ordered: false
                        },
                        err => {
                            if (err) {
                                server.loggelf({
                                    short_message: '[ACLINHERIT] Failed to inherit ACL entries for a created mailbox',
                                    _mail_action: 'acl_inherit',
                                    _user: session.user.id.toString(),
                                    _mailbox: id.toString(),
                                    _error: err.message,
                                    _sess: session.id
                                });
                                return callback(null, status, id);
                            }

                            // notify the sharees now that their entries exist
                            server.notifier.fireForMailbox({ _id: id, user: resolved.owner });
                            callback(null, status, id);
                        }
                    );
                });
            });
    });
};
