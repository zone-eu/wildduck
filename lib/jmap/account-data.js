'use strict';

// The data JMAP keeps for a user outside the mail collections. The user-delete task removes all of it
// once the restore window of a deleted user is over; until then it stays, so a restored user finds its
// JMAP state, identities and change history as they were. Every phase that adds a per user collection
// adds it here.

const BATCH_SIZE = 500;

// collection -> query of the user's documents (each one backed by an index with the user first)
const COLLECTIONS = {
    jmapstate: user => ({ _id: user }),
    jmapidentities: user => ({ user }),
    jmapchanges: user => ({ user })
};

/** Deletes the user's temporary uploads (blobs uploaded over JMAP), a batch at a time */
async function deleteUploads(gridfs, user) {
    const files = gridfs.collection('storage.files');
    const chunks = gridfs.collection('storage.chunks');
    let deleted = 0;
    for (;;) {
        const ids = (
            await files
                .find({ 'metadata.user': user, 'metadata.expires': { $exists: true } }, { projection: { _id: true } })
                .limit(BATCH_SIZE)
                .toArray()
        ).map(fileData => fileData._id);
        if (!ids.length) {
            return deleted;
        }
        // the files documents first, so a file is never visible without its chunks
        deleted += (await files.deleteMany({ _id: { $in: ids } })).deletedCount;
        await chunks.deleteMany({ files_id: { $in: ids } });
    }
}

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
    result.uploads = { deleted: await deleteUploads(db.gridfs, user) };
    return result;
}

module.exports = { deleteAccountData, COLLECTIONS };
