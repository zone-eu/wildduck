'use strict';

const log = require('npmlog');
const db = require('../db');
const util = require('util');
const mailboxTranslations = require('../translations');

function timeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function restore(task, data, options) {
    const { messageHandler, mailboxHandler, loggelf } = options;

    const putMessage = util.promisify(messageHandler.put.bind(messageHandler));

    const createMailbox = util.promisify((...args) => {
        let callback = args.pop();
        mailboxHandler.create(...args, (err, status, id) => {
            if (err) {
                return callback(err);
            }
            return callback(null, { status, id });
        });
    });

    let targetMailbox;

    const ensuretargetMailbox = async (user, language) => {
        if (targetMailbox) {
            return targetMailbox;
        }

        let d = new Date();
        let year = d.getUTCFullYear();
        let month = (d.getUTCMonth() + 1).toString();
        if (month.length < 2) {
            month = '0' + month;
        }
        let day = d.getUTCDate().toString();
        if (day.length < 2) {
            day = '0' + day;
        }

        let lcode = (language || '').toLowerCase().split('_').shift();

        let translation = lcode && mailboxTranslations.hasOwnProperty(lcode) ? mailboxTranslations[lcode] : mailboxTranslations.en;
        let mailboxName = translation.Restored || mailboxTranslations.en.Restored;
        let mailboxPath = `${mailboxName} (${year}-${month}-${day})`;

        let mailboxData = await db.database.collection('mailboxes').findOne({
            user,
            path: mailboxPath
        });

        if (mailboxData) {
            targetMailbox = mailboxData._id;
            return targetMailbox;
        }

        try {
            let { id } = await createMailbox(user, mailboxPath, {
                subscribed: true
            });

            if (id) {
                targetMailbox = id;
                return targetMailbox;
            }
        } catch (err) {
            //ignore
        }

        // was not able to create recover mailbox, fallback to INBOX
        mailboxData = await db.database.collection('mailboxes').findOne({
            user,
            path: 'INBOX'
        });

        if (mailboxData) {
            targetMailbox = mailboxData._id;
            return targetMailbox;
        }

        return false;
    };

    let userData = await db.users.collection('users').findOne({ _id: data.user });
    if (!userData) {
        // no such user anymore
        log.error('Tasks', 'task=restore id=%s user=%s error=%s', task._id, data.user, 'No such user');
        loggelf({
            short_message: '[TASKFAIL] restore',
            _task_action: 'restore',
            _task_id: task._id.toString(),
            _user: data.user.toString(),
            _error: 'No such user',
            _task_result: 'fail'
        });
        return true;
    }

    let cursor = db.database.collection('archived').find({
        user: data.user,
        archived: {
            $gte: data.start,
            $lte: data.end
        }
    });

    let restoredMessages = 0;

    let messageData;
    while ((messageData = await cursor.next())) {
        // use special recovery mailbox
        const archived = messageData._id;

        messageData.mailbox = await ensuretargetMailbox(userData._id, userData.language);
        if (!messageData.mailbox) {
            // failed to ensure mailbox
            log.info('Tasks', 'task=restore id=%s user=%s message=%s action=failed target=%s', task._id, data.user, archived, messageData.mailbox);
            loggelf({
                short_message: '[TASKFAIL] restore',
                _task_action: 'restore',
                _task_id: task._id.toString(),
                _user: data.user.toString(),
                _message: archived.toString(),
                _error: 'Failed to create folder',
                _task_result: 'fail'
            });
            continue;
        }

        delete messageData.archived;
        delete messageData.exp;
        delete messageData.rdate;

        // mark message as not deleted
        messageData.flags = (messageData.flags || []).filter(flag => flag !== '\\Deleted');
        messageData.undeleted = true;

        log.info('Tasks', 'task=restore id=%s user=%s message=%s action=restoring target=%s', task._id, data.user, archived, messageData.mailbox);

        let messageResponse;
        try {
            messageResponse = await putMessage(messageData);
        } catch (err) {
            log.error('Tasks', 'task=restore id=%s user=%s message=%s error=%s', task._id, data.user, archived, 'Failed to restore message. ' + err.message);
            loggelf({
                short_message: '[TASKFAIL] restore',
                _task_action: 'restore',
                _task_id: task._id.toString(),
                _user: data.user.toString(),
                _message: archived.toString(),
                _error: 'Failed to restore message. ' + err.message,
                _task_result: 'fail'
            });

            await timeout(5000);
            continue;
        }

        if (!messageResponse) {
            log.error('Tasks', 'task=restore id=%s user=%s message=%s error=%s', task._id, data.user, archived, 'Failed to restore message');
            loggelf({
                short_message: '[TASKFAIL] restore',
                _task_action: 'restore',
                _task_id: task._id.toString(),
                _user: data.user.toString(),
                _message: archived.toString(),
                _error: 'Failed to restore message',
                _task_result: 'fail'
            });

            await timeout(1000);
            continue;
        }

        try {
            await db.users.collection('users').updateOne(
                {
                    _id: data.user
                },
                {
                    $inc: {
                        storageUsed: messageData.size
                    }
                }
            );
        } catch (err) {
            // just log the error, nothing more
            log.error('Tasks', 'task=restore id=%s user=%s message=%s error=%s', task._id, data.user, archived, 'Failed to update user quota. ' + err.message);
        }

        log.info(
            'Tasks',
            'task=restore id=%s user=%s message=%s mailbox=%s uid=%s action=restored',
            task._id,
            data.user,
            messageResponse.message,
            messageResponse.mailbox,
            messageResponse.uid
        );

        loggelf({
            short_message: '[TASKOK] restore',
            _task_action: 'restore',
            _task_id: task._id.toString(),
            _user: data.user.toString(),
            _message: archived.toString(),
            _task_result: 'success',

            _restored_mailbox: messageResponse.mailbox,
            _restored_mailbox_path: messageResponse.mailboxPath,
            _restored_uid: messageResponse.uid
        });

        restoredMessages++;

        try {
            let r = await db.database.collection('archived').deleteOne({ _id: archived });
            log.info('Tasks', 'task=restore id=%s user=%s message=%s action=deleted count=%s', task._id, data.user, archived, r.deletedCount);
        } catch (err) {
            log.error(
                'Tasks',
                'task=restore id=%s user=%s message=%s error=%s',
                task._id,
                data.user,
                archived,
                'Failed to delete archived message. ' + err.message
            );
        }
    }
    await cursor.close();

    return { restoredMessages };
}

module.exports = (task, data, options, callback) => {
    restore(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=restore id=%s user=%s error=%s', task._id, data.user, err.message);
            callback(err);
        });
};
