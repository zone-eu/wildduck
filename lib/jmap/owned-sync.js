'use strict';

// Called by writers outside the JMAP service after data behind a JMAP owned type changed (identities
// after sending rights changed, the VacationResponse after the autoreply changed). Brings the type's
// state up to date and notifies the user's listeners, so an open EventSource pushes the new state.
// Only for users who use JMAP (who have a jmapstate document); does nothing in a process where the JMAP
// service is disabled and never fails the caller.

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const consts = require('../consts');

/**
 * @param {Object} deps {database, notifier}
 * @param {ObjectId} user
 * @param {Function} reconcile async (stateDoc) => true when the state moved; stateDoc is the user's
 *   jmapstate document with the `projection` fields
 * @param {Object} [options] {name: of the type in log lines, projection: the jmapstate fields reconcile needs}
 * @returns {Promise<Boolean>} true when the state moved
 */
async function syncOwned(deps, user, reconcile, options = {}) {
    // a process with [jmap] enabled = false does nothing. A process without a [jmap] section (the Haraka and
    // ZoneMTA plugins load these handlers with their own configuration) still records the change for users
    // who use JMAP: the jmapstate lookup below answers that, and costs one _id read for everyone else
    if (!user || (config.jmap && config.jmap.enabled === false)) {
        return false;
    }
    try {
        // one read tells whether the user ever used JMAP and holds what reconcile needs of the state
        const stateDoc = await deps.database
            .collection('jmapstate')
            .findOne({ _id: user }, { projection: Object.assign({ _id: true }, options.projection), maxTimeMS: consts.DB_MAX_TIME_USERS });
        if (!stateDoc) {
            // a user who never used JMAP gets the state on the first call of the type
            return false;
        }
        const changed = !!(await reconcile(stateDoc));
        if (changed && deps.notifier) {
            // a payload-less event: IMAP sessions check their journal, the event stream its states
            deps.notifier.fire(user);
        }
        return changed;
    } catch (err) {
        log.error('JMAP', 'user=%s %s sync failed: %s', user, options.name || 'state', err.message);
        return false;
    }
}

module.exports = { syncOwned };
