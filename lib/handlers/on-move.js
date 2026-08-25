'use strict';

const db = require('../db');
const consts = require('../consts');
const acl = require('../acl');
const { resolveMailbox } = require('../mailbox-resolver');
const { copyHandler } = require('./on-copy');

const LOCK_TTL = 5 * 60 * 1000;
const LOCK_WAIT = 1 * 60 * 1000;

// moves messages between mailboxes of different users by copying them into the
// target (quota and encryption follow the target owner) and expunging the copied
// source messages. Source messages are marked as copied, so they are not archived
async function moveAcrossAccounts(server, messageHandler, mailbox, update, session) {
    let copyResult = [].concat((await copyHandler(server, messageHandler, false, mailbox, update, session)) || []);
    if (copyResult[0] !== true) {
        return copyResult;
    }

    let info = copyResult[1];

    let sourceData = await db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (!sourceData) {
        return copyResult;
    }

    let lockKey = ['mbwr', sourceData._id.toString()].join(':');
    let lock = await new Promise((resolve, reject) => {
        server.lock.waitAcquireLock(lockKey, LOCK_TTL, LOCK_WAIT, (err, lock) => (err ? reject(err) : resolve(lock)));
    });

    if (!lock.success) {
        throw new Error('Failed to get folder write lock');
    }

    let deletedSize = 0;

    try {
        for (let uid of info.sourceUid) {
            let messageData = await db.database.collection('messages').findOne(
                {
                    mailbox: sourceData._id,
                    uid
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                }
            );

            if (!messageData) {
                continue;
            }

            let deleted = await new Promise((resolve, reject) => {
                messageHandler.del(
                    {
                        messageData,
                        session,
                        // do not archive drafts nor copied messages
                        archive: !messageData.flags.includes('\\Draft') && !messageData.copied,
                        delayNotifications: true
                    },
                    (err, deleted) => (err ? reject(err) : resolve(deleted))
                );
            });

            if (!deleted) {
                continue;
            }

            deletedSize += Number(messageData.size) || 0;
            session.writeStream.write(session.formatResponse('EXPUNGE', uid));
        }
    } finally {
        await new Promise(resolve => server.lock.releaseLock(lock, () => resolve()));
    }

    if (deletedSize) {
        await new Promise(resolve => {
            messageHandler.updateQuota(
                sourceData.user,
                {
                    storageUsed: -deletedSize,
                    mailbox: sourceData._id,
                    mailboxPath: sourceData.path
                },
                {
                    session
                },
                () => resolve()
            );
        });
    }

    server.notifier.fireForMailbox(sourceData);

    return [true, info];
}

// MOVE / UID MOVE sequence mailbox
module.exports = (server, messageHandler) => (mailbox, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'move',
            cid: session.id
        },
        '[%s] Moving messages from "%s" to "%s"',
        session.id,
        mailbox,
        update.destination
    );

    let moveWithinAccount = (owner, destinationPath) => {
        let lockKey = ['mbwr', mailbox.toString()].join(':');
        server.lock.waitAcquireLock(lockKey, LOCK_TTL, LOCK_WAIT, (err, lock) => {
            if (err) {
                return callback(err);
            }

            if (!lock.success) {
                return callback(new Error('Failed to get folder write lock'));
            }

            messageHandler.move(
                {
                    user: owner,
                    // folder to move messages from
                    source: {
                        mailbox
                    },
                    // folder to move messages to
                    destination: {
                        user: owner,
                        path: destinationPath
                    },
                    session,
                    // list of UIDs to move
                    messages: update.messages,
                    showExpunged: true
                },
                (...args) => {
                    server.lock.releaseLock(lock, () => {
                        if (args[0]) {
                            if (args[0].imapResponse) {
                                return callback(null, args[0].imapResponse);
                            }
                            return callback(args[0]);
                        }
                        callback(...args);
                    });
                }
            );
        });
    };

    db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            projection: {
                user: true
            },
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        },
        (err, sourceData) => {
            if (err) {
                return callback(err);
            }

            if (!sourceData) {
                return callback(null, 'NONEXISTENT');
            }

            if (!acl.isEnabled(server) || !acl.parsePath(update.destination).shared) {
                // destination is in the personal namespace of the session user
                if (sourceData.user.equals(session.user.id)) {
                    return moveWithinAccount(session.user.id, update.destination);
                }

                // moving out of a shared mailbox into an own folder
                return moveAcrossAccounts(server, messageHandler, mailbox, update, session)
                    .then(args => callback(null, ...[].concat(args || [])))
                    .catch(err => callback(err));
            }

            resolveMailbox(server, session, update.destination, { requireRights: acl.ACL_RIGHTS.INSERT }, (err, resolved) => {
                if (err) {
                    return callback(err);
                }

                if (!resolved.mailboxData) {
                    return callback(null, 'TRYCREATE');
                }

                if (resolved.denied) {
                    return callback(null, 'NOPERM');
                }

                if (sourceData.user.equals(resolved.owner)) {
                    // source and destination belong to the same user
                    return moveWithinAccount(resolved.owner, resolved.path);
                }

                moveAcrossAccounts(server, messageHandler, mailbox, update, session)
                    .then(args => callback(null, ...[].concat(args || [])))
                    .catch(err => callback(err));
            });
        }
    );
};
