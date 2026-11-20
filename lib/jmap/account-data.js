'use strict';

// The data JMAP and webmail clients keep for a user outside the mail collections. The user-delete task
// removes all of it once the restore window of a deleted user is over; until then it stays, so a
// restored user finds its JMAP state, identities, change history and webmail settings as they were.
// Every per user collection added for JMAP or for webmail clients (lib/webmail/) is listed here.

const StorageHandler = require('../storage-handler');

const UPLOAD_BATCH_SIZE = 500;

// collection -> query of the user's documents (each one backed by an index with the user first)
const COLLECTIONS = {
    'jmap.state': user => ({ _id: user }),
    'jmap.identities': user => ({ user }),
    'jmap.changes': user => ({ user }),
    'jmap.submissions': user => ({ user }),
    'jmap.push': user => ({ user }),
    'jmap.participants': user => ({ user }),
    'calendars.calendars': user => ({ user }),
    'calendars.events': user => ({ user }),
    'contacts.books': user => ({ user }),
    'contacts.cards': user => ({ user }),
    'contacts.media': user => ({ user }),
    'webmail.preferences': user => ({ _id: user }),
    'webmail.senders': user => ({ user }),
    'webmail.searches': user => ({ user })
};

/**
 * Removes the JMAP and webmail data of a deleted user.
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
    // the temporary uploads (blobs uploaded over JMAP), on the user_temporary_usage index
    const storageHandler = new StorageHandler({ database: db.database, gridfs: db.gridfs });
    result.uploads = {
        deleted: await storageHandler.removeUploads({ 'metadata.user': user, 'metadata.expires': { $exists: true } }, { batchSize: UPLOAD_BATCH_SIZE })
    };
    return result;
}

module.exports = { deleteAccountData };
