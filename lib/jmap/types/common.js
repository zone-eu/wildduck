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

/**
 * Maps items with an async function, at most `limit` at a time, keeping the order.
 *
 * @returns {Promise<Array>}
 */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

module.exports = { requireAccount, checkArguments, mapLimit };
