'use strict';

// The shared part of every /set method (RFC 8620 5.3): argument checks, ifInState, maxObjectsInSet,
// creation ids, and the per object outcome lists. The type module supplies create, update and destroy
// for one object; each of them returns a result or throws a SetError, which fails only that object.

const { MethodError, invalidArguments } = require('./errors');
const { SetError } = require('./set-errors');
const { requireAccount } = require('./types/common');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const CREATION_ID = /^[A-Za-z0-9_-]{1,255}$/;

// defineProperty, so a creation id such as "__proto__" is an ordinary key and never replaces a prototype
const setOwn = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

/**
 * Resolves an id that may be a creation reference ("#c1") of this request.
 *
 * @returns {String|null} the id, or null for an unknown creation id
 */
function resolveId(context, id) {
    if (typeof id === 'string' && id.startsWith('#')) {
        return Object.hasOwn(context.createdIds || {}, id.slice(1)) ? context.createdIds[id.slice(1)] : null;
    }
    return id;
}

function checkSetArguments(args, extra) {
    const known = ['accountId', 'ifInState', 'create', 'update', 'destroy', ...extra];
    for (const key of Object.keys(args)) {
        if (!known.includes(key)) {
            throw invalidArguments(`unknown argument ${key}`);
        }
    }
    for (const key of ['create', 'update']) {
        if (args[key] !== undefined && args[key] !== null && !isObject(args[key])) {
            throw invalidArguments(`${key} must be an object`);
        }
    }
    if (args.destroy !== undefined && args.destroy !== null && !(Array.isArray(args.destroy) && args.destroy.every(id => typeof id === 'string'))) {
        throw invalidArguments('destroy must be a list of ids');
    }
    if (args.ifInState !== undefined && args.ifInState !== null && typeof args.ifInState !== 'string') {
        throw invalidArguments('ifInState must be a string');
    }
    for (const id of Object.keys(args.create || {})) {
        if (!CREATION_ID.test(id)) {
            throw invalidArguments(`invalid creation id ${id}`);
        }
    }
}

function failure(err) {
    if (err instanceof SetError) {
        return err.toSetError();
    }
    throw err;
}

/**
 * Runs a /set method.
 *
 * @param {Object} args method arguments
 * @param {Object} context request context
 * @param {Object} handlers
 * @param {Function} handlers.state async () => current state string
 * @param {Function} [handlers.create] async (object, creationId) => {id, ...server set properties}
 * @param {Function} [handlers.update] async (id, patch) => null or an object of changed server set properties
 * @param {Function} [handlers.destroy] async (id) => void
 * @param {Function} [handlers.prepare] async () => void, called once after the arguments are checked and before the state is read
 * @param {String[]} [handlers.arguments] extra method arguments the type accepts
 * @param {Function} [handlers.finish] async (response) => extra properties for the response
 * @returns {Promise<Object>} the /set response
 */
async function runSet(args, context, handlers) {
    checkSetArguments(args, handlers.arguments || []);
    requireAccount(args, context);
    const create = args.create || {};
    const update = args.update || {};
    const destroy = args.destroy || [];
    if (Object.keys(create).length + Object.keys(update).length + destroy.length > context.limits.maxObjectsInSet) {
        throw new MethodError('requestTooLarge', { description: `more than ${context.limits.maxObjectsInSet} objects` });
    }

    if (handlers.prepare) {
        await handlers.prepare();
    }
    const oldState = await handlers.state();
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) {
        throw new MethodError('stateMismatch');
    }

    const response = { accountId: context.account.id, oldState, newState: oldState };
    const outcome = { created: {}, notCreated: {}, updated: {}, notUpdated: {}, destroyed: [], notDestroyed: {} };

    // RFC 8620 5.3: creates, then updates, then destroys
    for (const [creationId, object] of Object.entries(create)) {
        try {
            if (!handlers.create) {
                throw new SetError('forbidden', 'objects of this type can not be created');
            }
            if (!isObject(object)) {
                throw new SetError('invalidProperties', 'the object must be a JSON object');
            }
            const created = await handlers.create(object, creationId);
            setOwn(outcome.created, creationId, created);
            setOwn(context.createdIds, creationId, created.id);
        } catch (err) {
            setOwn(outcome.notCreated, creationId, failure(err));
        }
    }
    for (const [reference, patch] of Object.entries(update)) {
        const id = resolveId(context, reference);
        try {
            if (id === null) {
                throw new SetError('notFound', `unknown creation id ${reference}`);
            }
            if (!isObject(patch)) {
                throw new SetError('invalidPatch', 'a patch must be a JSON object');
            }
            if (!handlers.update) {
                throw new SetError('forbidden', 'objects of this type can not be updated');
            }
            setOwn(outcome.updated, id, (await handlers.update(id, patch)) || null);
        } catch (err) {
            setOwn(outcome.notUpdated, id === null ? reference : id, failure(err));
        }
    }
    for (const reference of destroy) {
        const id = resolveId(context, reference);
        try {
            if (id === null) {
                throw new SetError('notFound', `unknown creation id ${reference}`);
            }
            if (!handlers.destroy) {
                throw new SetError('forbidden', 'objects of this type can not be destroyed');
            }
            await handlers.destroy(id);
            outcome.destroyed.push(id);
        } catch (err) {
            setOwn(outcome.notDestroyed, id === null ? reference : id, failure(err));
        }
    }

    // RFC 8620 5.3: an empty outcome is null
    for (const [key, value] of Object.entries(outcome)) {
        response[key] = (Array.isArray(value) ? value.length : Object.keys(value).length) ? value : null;
    }
    const changed = response.created || response.updated || response.destroyed;
    response.newState = changed ? await handlers.state() : oldState;
    if (changed && context.deps.notifier) {
        // open event streams of the account learn about the new state
        context.deps.notifier.fire(context.account.user);
    }
    if (handlers.finish) {
        Object.assign(response, await handlers.finish(response));
    }
    return response;
}

module.exports = { runSet, resolveId };
