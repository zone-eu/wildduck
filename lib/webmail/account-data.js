'use strict';

// Per user data kept for webmail clients in the webmail.* collections. The user-delete task removes
// it together with the JMAP data once the restore window of a deleted user is over. Every resource
// that adds a per user collection adds it here.

// collection -> query of the user's documents
const COLLECTIONS = {
    'webmail.preferences': user => ({ _id: user })
};

/**
 * Removes the webmail data of a deleted user.
 *
 * @param {Object} db {database}
 * @param {ObjectId} user
 * @returns {Promise<Object>} collection -> {deleted: count}
 */
async function deleteWebmailData(db, user) {
    const result = {};
    for (const [collection, query] of Object.entries(COLLECTIONS)) {
        result[collection] = { deleted: (await db.database.collection(collection).deleteMany(query(user))).deletedCount };
    }
    return result;
}

module.exports = { deleteWebmailData, COLLECTIONS };
