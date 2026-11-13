'use strict';

const setSubscription = require('./set-subscription');

// UNSUBSCRIBE "path/to/mailbox"
module.exports = server => setSubscription(server, false);
