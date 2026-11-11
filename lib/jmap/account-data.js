'use strict';

// The data JMAP keeps for a user outside the mail collections. The user-delete task removes all of it
// once the restore window of a deleted user is over; until then it stays, so a restored user finds its
// JMAP state, identities and change history as they were. Every phase that adds a per user collection
// adds it here.

const StorageHandler = require('../storage-handler');

const UPLOAD_BATCH_SIZE = 500;

// collection -> query of the user's documents (each one backed by an index with the user first)
const COLLECTIONS = {
    jmapstate: user => ({ _id: user }),
    jmapidentities: user => ({ user }),
    jmapchanges: user => ({ user }),
    jmapsubmissions: user => ({ user })
};

/**
 * Removes the JMAP data of a deleted user.
 *
 * @param {Object} db {database, gridfs}
 * @param {ObjectId} user
 * @returns {Promise<Object>} collection -> {deleted: count}
 */
async function deleteAccountData(db, user) {
    const result = {};
    for (const [collection, query] of Object.entries(COLLECTIONS)) {
        result[collection] = { deleted: (await db.database.collection(collection).deleteMany(query(user))).deletedCount };
    }
    // the temporary uploads (blobs uploaded over JMAP), on the user_temporary_files index
    const storageHandler = new StorageHandler({ database: db.database, gridfs: db.gridfs });
    result.uploads = {
        deleted: await storageHandler.removeUploads({ 'metadata.user': user, 'metadata.expires': { $exists: true } }, { batchSize: UPLOAD_BATCH_SIZE })
    };
    return result;
}

module.exports = { deleteAccountData };
