'use strict';

// Called after a user's autoreply changed (lib/autoreply-handler.js, for the REST API and JMAP alike).
// Moves the VacationResponse state when the object changed and pushes it (see owned-sync.js).

const consts = require('../consts');
const { reconcile, toVacation, STATE_PROJECTION } = require('./types/vacation');
const { syncOwned } = require('./owned-sync');

/**
 * @param {Object} deps {database, notifier}
 * @param {ObjectId} user
 */
async function syncVacation(deps, user) {
    await syncOwned(
        deps,
        user,
        async stateDoc => {
            const doc = await deps.database.collection('autoreplies').findOne({ user }, { maxTimeMS: consts.DB_MAX_TIME_USERS });
            return (await reconcile(deps.database, user, toVacation(doc), stateDoc)).changed;
        },
        { name: 'vacation', projection: STATE_PROJECTION }
    );
}

module.exports = { syncVacation };
