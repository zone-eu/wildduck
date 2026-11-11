'use strict';

const setSubscription = require('./set-subscription');

// SUBSCRIBE "path/to/mailbox"
module.exports = server => setSubscription(server, true);
