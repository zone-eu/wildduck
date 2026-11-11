'use strict';

// Called by writers outside the JMAP service after a user's sending rights changed (addresses added,
// renamed, removed or made main through the REST API). Brings the JMAP identities up to date, so the
// change is in Identity/changes, and pushes the new Identity state (see owned-sync.js).

const { ChangeLog } = require('./changelog');
const { reconcile, STATE_PROJECTION } = require('./types/identity');
const { syncOwned } = require('./owned-sync');

/**
 * @param {Object} deps {database, users, notifier}
 * @param {ObjectId} user
 */
async function syncIdentities(deps, user) {
    // the reconcile writes no state strings, so the change log needs no checksum key
    const log = new ChangeLog({ database: deps.database, secret: '' });
    await syncOwned(deps, user, async stateDoc => (await reconcile(deps, user, log, { stateDoc })).changed, {
        name: 'identity',
        projection: STATE_PROJECTION
    });
}

module.exports = { syncIdentities };
