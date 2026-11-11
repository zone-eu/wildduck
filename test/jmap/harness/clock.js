'use strict';

// Helpers for scenarios that depend on time or on asynchronous background work.

const { setTimeout: delay } = require('timers/promises');

/**
 * Polls `check` until it returns a truthy value and returns that value.
 * Throws with `message` when the deadline passes.
 *
 * @param {Function} check Sync or async function
 * @param {Object} [options] {timeout: ms (default 5000), interval: ms (default 50), message}
 */
async function waitFor(check, options = {}) {
    const timeout = options.timeout || 5000;
    const interval = options.interval || 50;
    const deadline = Date.now() + timeout;
    let lastError;
    for (;;) {
        try {
            const value = await check();
            if (value) {
                return value;
            }
        } catch (err) {
            lastError = err;
        }
        if (Date.now() >= deadline) {
            const err = new Error(options.message || `condition not met within ${timeout} ms`);
            err.cause = lastError;
            throw err;
        }
        await delay(interval);
    }
}

module.exports = { waitFor, delay };
