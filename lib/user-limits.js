'use strict';

const USER_LIMIT_FIELDS = Object.freeze([
    'maxMailboxes',
    'maxLabels',
    'maxRecipientsPerMessage',
    'maxApplicationPasswords',
    'maxMcpTokens',
    'maxAutoreplies',
    'autoreplyInterval'
]);

// Zero keeps the existing user-limit convention: inherit the deployment default.
// A separate ceiling protects limits imposed by storage or protocol implementations.
function getUserLimit(userData, field, fallback, ceiling) {
    const value = Number(userData && userData[field]);
    const limit = Number.isSafeInteger(value) && value > 0 ? value : fallback;
    return ceiling === undefined ? limit : Math.min(limit, ceiling);
}

module.exports = { getUserLimit, USER_LIMIT_FIELDS };
