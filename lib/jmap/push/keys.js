'use strict';

// Redis keys of JMAP Web Push change detection, shared by ImapNotifier (the write side) and the push
// service (lib/jmap/push/delivery.js). Kept free of other requires, the notifier loads it everywhere.

module.exports = {
    // users with at least one verified PushSubscription
    USERS_KEY: 'jmap:push:users',
    // due checks: user id (a change) or 'r:' + user id (a credential change) -> time of the first change
    DUE_KEY: 'jmap:push:due',
    // notifier payload commands after which the credentials of the subscriptions are checked
    CREDENTIAL_COMMANDS: ['LOGOUT', 'ASPDELETE', 'CREDENTIALS', 'TOKENREVOKE']
};
