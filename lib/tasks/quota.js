'use strict';

const log = require('npmlog');
const { setTimeout: sleep } = require('timers/promises');
const db = require('../db');

// pause after a failed user before moving on to the next one
const ERROR_PAUSE = 5000;

// Recalculates the storage usage of every user from the stored messages
async function recalculateQuotas(task, options) {
    let cursor = db.users.collection('users').find({}).project({ _id: true, storageUsed: true });

    for await (let userData of cursor) {
        let storageData;
        try {
            storageData = await db.database
                .collection('messages')
                .aggregate([
                    {
                        $match: {
                            user: userData._id
                        }
                    },
                    {
                        $group: {
                            _id: {
                                user: '$user'
                            },
                            storageUsed: {
                                $sum: '$size'
                            }
                        }
                    }
                ])
                .toArray();
        } catch (err) {
            log.error('Tasks', 'task=quota id=%s user=%s error=%s', task._id, userData._id, err.message);
            await sleep(ERROR_PAUSE);
            continue;
        }

        let storageUsed = (storageData && storageData[0] && storageData[0].storageUsed) || 0;
        if (storageUsed === userData.storageUsed) {
            log.info('Tasks', 'task=quota id=%s user=%s stored=%s calculated=%s updated=%s', task._id, userData._id, userData.storageUsed, storageUsed, 'no');
            continue;
        }

        let r;
        try {
            r = await db.users.collection('users').findOneAndUpdate(
                {
                    _id: userData._id
                },
                {
                    $set: {
                        storageUsed: Number(storageUsed) || 0
                    }
                },
                {
                    returnDocument: 'before',
                    projection: {
                        storageUsed: true
                    }
                }
            );
        } catch (err) {
            log.error('Tasks', 'task=quota id=%s user=%s error=%s', task._id, userData._id, err.message);
            await sleep(ERROR_PAUSE);
            continue;
        }

        if (r && r.value) {
            options.loggelf({
                short_message: '[QUOTA] reset',
                _mail_action: 'quota',
                _user: userData._id,
                _set: Number(storageUsed) || 0,
                _previous_storage_used: r.value.storageUsed,
                _storage_used: Number(storageUsed) || 0,
                _sess: 'task.quota.' + task._id
            });
        }

        log.info(
            'Tasks',
            'task=quota id=%s user=%s stored=%s calculated=%s updated=%s',
            task._id,
            userData._id,
            userData.storageUsed,
            storageUsed,
            r.lastErrorObject && r.lastErrorObject.updatedExisting ? 'yes' : 'no'
        );
    }

    return true;
}

module.exports = (task, data, options, callback) => {
    recalculateQuotas(task, options).then(
        result => callback(null, result),
        err => {
            log.error('Tasks', 'task=quota id=%s error=%s', task._id, err.message);
            callback(err);
        }
    );
};
