'use strict';

const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');

const LOCK_TTL = 2 * 60 * 1000;

// EXPUNGE deletes all messages in selected mailbox marked with \Delete
module.exports = (server, messageHandler) => (mailbox, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'expunge',
            cid: session.id
        },
        '[%s] Deleting messages from "%s"',
        session.id,
        mailbox
    );

    expunge(server, messageHandler, mailbox, update, session).then(result => callback(null, result), callback);
};

// Resolves with true, a response code, or (as the handler always did) an Error when the folder lock is taken
async function expunge(server, messageHandler, mailbox, update, session) {
    let mailboxData = await db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (!mailboxData) {
        return 'NONEXISTENT';
    }

    if (!mailboxData.user.equals(session.user.id)) {
        return 'NONEXISTENT';
    }

    let query = {
        mailbox: mailboxData._id,
        undeleted: false
    };

    if (update.isUid) {
        query.uid = tools.checkRangeQuery(update.messages);
    }

    let logdata = {
        short_message: '[EXPUNGE]',
        _mail_action: 'expunge',
        _user: session.user.id.toString(),
        _mailbox: mailboxData._id.toString(),
        _mailbox_path: mailboxData.path,
        _sess: session.id,
        _deleted: 0
    };

    let lockKey = ['mbwr', mailboxData._id.toString()].join(':');
    let lock = await server.lock.waitAcquireLock(lockKey, LOCK_TTL, 1 * 60 * 1000);

    if (!lock.success) {
        return new Error('Failed to get folder write lock');
    }

    server.logger.debug(
        {
            tnx: 'MOVE'
        },
        'Acquired lock for deleting messages user=%s mailbox=%s message=%s lock=%s',
        session.user.id.toString(),
        mailbox.toString(),
        mailboxData._id.toString(),
        lock.id
    );

    let extendLockIntervalTimer = setInterval(
        async () => {
            try {
                let info = await server.lock.extendLock(lock, LOCK_TTL);
                server.logger.debug(
                    {
                        tnx: 'MOVE'
                    },
                    `Lock extended lock=${info.id} result=${info.success ? 'yes' : 'no'}`
                );
            } catch (err) {
                server.logger.debug(
                    {
                        tnx: 'MOVE',
                        err
                    },
                    'Failed to extend lock lock=%s error=%s',
                    lock?.id,
                    err.message
                );
            }
        },
        Math.round(LOCK_TTL * 0.8)
    );

    let deletedSize = 0;

    // fetch entire messages as these need to be copied to the archive
    let cursor = db.database.collection('messages').find(query).sort({ uid: 1 }).maxTimeMS(consts.DB_MAX_TIME_MESSAGES);

    try {
        for await (let messageData of cursor) {
            let deleted;
            try {
                deleted = await messageHandler.delAsync({
                    messageData,
                    session,
                    // do not archive drafts nor copied messages
                    archive: !messageData.flags.includes('\\Draft') && !messageData.copied,
                    delayNotifications: true
                });
            } catch (err) {
                server.logger.error(
                    {
                        tnx: 'EXPUNGE',
                        err
                    },
                    'Failed to delete message id=%s. %s',
                    messageData._id,
                    err.message
                );
                logdata._error = err.message;
                logdata._code = err.code;
                logdata._response = err.response;
                server.loggelf(logdata);
                throw err;
            }

            if (!deleted) {
                // nothing was deleted, so skip
                continue;
            }

            logdata._deleted++;
            deletedSize += messageData.size;

            server.logger.debug(
                {
                    tnx: 'EXPUNGE'
                },
                'Deleted message id=%s',
                messageData._id
            );

            if (!update.silent) {
                session.writeStream.write(session.formatResponse('EXPUNGE', messageData.uid));
            }
        }

        server.notifier.fire(session.user.id);
        if (!update.silent && session && session.selected && session.selected.uidList && logdata._deleted) {
            session.writeStream.write({
                tag: '*',
                command: String(session.selected.uidList.length),
                attributes: [
                    {
                        type: 'atom',
                        value: 'EXISTS'
                    }
                ]
            });
        }
    } finally {
        await cursor.close().catch(() => false);
        clearInterval(extendLockIntervalTimer);

        try {
            await server.lock.releaseLock(lock);
        } catch {
            // the lock expires on its own
        }

        if (deletedSize) {
            // try to update quota
            try {
                await messageHandler.updateQuotaAsync(
                    session.user.id,
                    {
                        storageUsed: -deletedSize,
                        mailbox: mailboxData._id,
                        mailboxPath: mailboxData.path
                    },
                    {
                        session
                    }
                );
            } catch {
                // the quota task corrects the value later
            }
        }
    }

    return true;
}
