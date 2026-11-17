'use strict';

// Called by writers outside the JMAP service after address register entries changed: the mail path
// (MessageHandler.updateAddressRegister, when mail is sent or received) and the REST API (an entry
// disabled or renamed). JMAP shows the register as a read only address book, so these changes are
// ContactCard changes: they are recorded in the change log and pushed (see owned-sync.js). Only for
// users who use JMAP; never fails the caller.

const { syncOwned } = require('./owned-sync');
const { ContactHandler } = require('../contact-handler');

/**
 * @param {Object} deps {database, notifier}
 * @param {ObjectId} user
 * @param {Array<{id: ObjectId, created: Boolean}>} changes the entries that were inserted or changed
 * @returns {Promise<Boolean>} true when the ContactCard state moved
 */
function syncRegister(deps, user, changes) {
    if (!changes || !changes.length) {
        return Promise.resolve(false);
    }
    return syncOwned(deps, user, () => new ContactHandler({ database: deps.database }).recordRegisterChanges(user, changes), { name: 'address register' });
}

module.exports = { syncRegister };
