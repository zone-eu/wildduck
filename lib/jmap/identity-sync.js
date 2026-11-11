'use strict';

// Called by writers outside the JMAP service after a user's sending rights changed (addresses added,
// renamed, removed or made main through the REST API). Brings the JMAP identities up to date, so the
// change is in Identity/changes, and notifies the user's listeners, so an open EventSource pushes the
// new Identity state. Does nothing while the JMAP service is disabled; never fails the caller.

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const { ChangeLog } = require('./changelog');
const { reconcile } = require('./types/identity');

/**
 * @param {Object} deps {database, users, notifier}
 * @param {ObjectId} user
 */
async function syncIdentities(deps, user) {
    if (!config.jmap || !config.jmap.enabled || !user) {
        return;
    }
    try {
        // the reconcile writes no state strings, so the change log needs no checksum key
        await reconcile(deps, user, new ChangeLog({ database: deps.database, secret: '' }));
        if (deps.notifier) {
            // a payload-less event: IMAP sessions check their journal, the event stream its states
            deps.notifier.fire(user);
        }
    } catch (err) {
        log.error('JMAP', 'user=%s identity sync failed: %s', user, err.message);
    }
}

module.exports = { syncIdentities };
