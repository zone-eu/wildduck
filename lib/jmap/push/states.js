'use strict';

// Push states (RFC 8620 7.1 StateChange) of one account, shared by the event source, PushSubscription
// verification and Web Push delivery. Every module with push types answers the states of its types
// (`pushStates`); only the modules of the wanted types are asked.

/** The modules that have push states */
const pushModulesOf = modules => (modules || []).filter(module => module.pushStates);

/**
 * The current states of an account: {Email: '...', Quota: '...', ...}.
 *
 * @param {Object[]} modules the registered type modules
 * @param {Object} context a request context of the account (account, deps, options); it is not changed
 * @param {Object} [options] {types: Set or list of the wanted types (all when missing or null),
 *   cache: the request cache to read through (default a new one), it may hold a user document already read}
 * @returns {Promise<Object>} type -> state; a module answers all of its types, also those not wanted
 */
async function readStates(modules, context, options = {}) {
    const wanted = options.types ? new Set(options.types) : null;
    const asked = pushModulesOf(modules).filter(module => !wanted || (module.pushTypes || []).some(type => wanted.has(type)));
    const fresh = Object.assign({}, context, { cache: options.cache || {} });
    const parts = await Promise.all(asked.map(module => module.pushStates(fresh)));
    return Object.assign({}, ...parts);
}

module.exports = { pushModulesOf, readStates };
