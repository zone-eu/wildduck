'use strict';

const db = require('../db');
const consts = require('../consts');

async function run(task, data, options, users = db.users) {
    const roleData = await users.collection('roles').findOne({ _id: data.role }, { maxTimeMS: consts.DB_MAX_TIME_USERS });
    // A cleanup job for an earlier deletion must leave restored assignments intact.
    if (roleData && !roleData.deleted && roleData.isSystem && data.systemRoleRestoreId !== (roleData.systemRoleRestoreId ?? '')) {
        return { updated: 0 };
    }

    if (!roleData || !roleData.deleted) {
        // The job is persisted before the tombstone, so a worker can reach it first.
        throw new Error('Role deletion has not committed yet');
    }

    const result = await users.collection('users').updateMany({ role: data.role }, { $unset: { role: '' } }, { maxTimeMS: consts.DB_MAX_TIME_USERS });

    const response = { updated: result.modifiedCount };
    if (options?.loggelf) {
        options.loggelf({
            short_message: '[ROLES] Cleared deleted role assignments',
            _task_id: task._id.toString(),
            _role: data.role,
            ...response
        });
    }

    return response;
}

module.exports = (task, data, options, callback) => {
    run(task, data, options).then(result => callback(null, result), callback);
};

module.exports.run = run;
