'use strict';

const db = require('../db');
const consts = require('../consts');

/**
 * Resolves the quota root response of a user: the account quota, or the system
 * wide default when the account has none
 *
 * @param {Object} server IMAP server (its options may carry the settings handler)
 * @param {ObjectId} userId User ID
 * @returns {Promise<{root: String, quota: Number, storageUsed: Number}>}
 */
async function getUserQuota(server, userId) {
    let user = await db.users.collection('users').findOne(
        {
            _id: userId
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_USERS
        }
    );

    if (!user) {
        throw new Error('User data not found');
    }

    let maxStorage = 0;
    if (!user.quota && server.options.settingsHandler) {
        maxStorage = await server.options.settingsHandler.get('const:max:storage');
    }

    return {
        root: '',
        quota: user.quota || maxStorage || 0,
        storageUsed: Math.max(user.storageUsed || 0, 0)
    };
}

module.exports = { getUserQuota };
