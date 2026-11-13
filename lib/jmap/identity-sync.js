'use strict';

// Called by writers outside the JMAP service after a user's sending rights changed (addresses added,
// renamed, removed or made main through the REST API, or the user renamed). Brings the JMAP identities
// and the calendar participant identities, both derived from the addresses, up to date, so the change
// is in Identity/changes and ParticipantIdentity/changes, and pushes the new states (see owned-sync.js).

const { changeWriter } = require('./changelog');
const { reconcile, STATE_PROJECTION } = require('./types/identity');
const participants = require('./types/participant-identity');
const { syncOwned } = require('./owned-sync');

/**
 * @param {Object} deps {database, users, notifier}
 * @param {ObjectId} user
 */
async function syncIdentities(deps, user) {
    const log = changeWriter(deps.database);
    const both = async stateDoc => {
        const [identities, participantIdentities] = await Promise.all([reconcile(deps, user, log, { stateDoc }), participants.reconcile(deps, user, log)]);
        return identities.changed || participantIdentities.changed;
    };
    await syncOwned(deps, user, both, {
        name: 'identity',
        projection: STATE_PROJECTION
    });
}

module.exports = { syncIdentities };
