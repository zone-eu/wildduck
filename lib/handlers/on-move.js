'use strict';

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

    let lockKey = ['mbwr', mailbox.toString()].join(':');
    server.lock.waitAcquireLock(lockKey, 5 * 60 * 1000, 1 * 60 * 1000, (err, lock) => {
        if (err) {
            return callback(err);
        }

        if (!lock.success) {
            return callback(null, new Error('Failed to get folder write lock').message);
        }

        messageHandler.move(
            {
                user: session.user.id,
                // folder to move messages from
                source: {
                    mailbox
                },
                // folder to move messages to
                destination: {
                    user: session.user.id,
                    path: update.destination
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
