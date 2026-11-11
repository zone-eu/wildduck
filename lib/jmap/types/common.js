'use strict';

// Helpers shared by the type modules.

const { MethodError, invalidArguments } = require('../errors');

/**
 * Checks the accountId argument (RFC 8620 3.6.2). Another user's account is reported exactly like an
 * unknown one, so account ids can not be probed.
 *
 * @returns {Object} The account of the request
 */
function requireAccount(args, context) {
    if (typeof args.accountId !== 'string') {
        throw invalidArguments('accountId is required');
    }
    if (args.accountId !== context.account.id) {
        throw new MethodError('accountNotFound');
    }
    return context.account;
}

/**
 * Rejects arguments the method does not define (RFC 8620 3.6.2: invalidArguments).
 *
 * @param {Object} args
 * @param {String[]} known Names of the defined arguments
 */
function checkArguments(args, known) {
    for (const key of Object.keys(args)) {
        if (!known.includes(key)) {
            throw invalidArguments(`unknown argument ${key}`);
        }
    }
}

module.exports = { requireAccount, checkArguments };
