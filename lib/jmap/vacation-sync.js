'use strict';

// Called by writers outside the JMAP service after a user's autoreply changed (the REST autoreply
// routes). Moves the VacationResponse state when the object changed and notifies the user's listeners,
// so an open EventSource pushes the new state. Only for users who use JMAP; does nothing while the JMAP
// service is disabled and never fails the caller.

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const consts = require('../consts');
const { reconcile, toVacation } = require('./types/vacation');

/**
 * @param {Object} deps {database, notifier}
 * @param {ObjectId} user
 */
async function syncVacation(deps, user) {
    if (!config.jmap || !config.jmap.enabled || !user) {
        return;
    }
    try {
        // a user who never used JMAP gets the state on the first VacationResponse call
        if (!(await deps.database.collection('jmapstate').countDocuments({ _id: user }, { limit: 1 }))) {
            return;
        }
        const doc = await deps.database.collection('autoreplies').findOne({ user }, { maxTimeMS: consts.DB_MAX_TIME_USERS });
        const { changed } = await reconcile(deps.database, user, toVacation(doc));
        if (changed && deps.notifier) {
            // a payload-less event: IMAP sessions check their journal, the event stream its states
            deps.notifier.fire(user);
        }
    } catch (err) {
        log.error('JMAP', 'user=%s vacation sync failed: %s', user, err.message);
    }
}

module.exports = { syncVacation };
