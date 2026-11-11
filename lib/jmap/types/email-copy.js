'use strict';

// Email/copy (RFC 8621 4.7, RFC 8620 5.4). It copies Emails between two accounts; every WildDuck user has
// exactly one account, so the only call that names two valid accounts names the same one twice. The
// method exists so that clients get the RFC errors instead of unknownMethod: an unknown or foreign
// accountId is accountNotFound, equal ids are invalidArguments, any other fromAccountId is
// fromAccountNotFound. A copy inside the account is Email/import of the Email's blobId.

const { URN } = require('../capabilities');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function copy(args, context) {
    checkArguments(args, ['fromAccountId', 'ifFromInState', 'accountId', 'ifInState', 'create', 'onSuccessDestroyOriginal', 'destroyFromIfInState']);
    requireAccount(args, context);
    if (typeof args.fromAccountId !== 'string') {
        throw invalidArguments('fromAccountId is required');
    }
    if (!isObject(args.create)) {
        throw invalidArguments('create must be an object');
    }
    for (const key of ['ifFromInState', 'ifInState', 'destroyFromIfInState']) {
        if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') {
            throw invalidArguments(`${key} must be a string`);
        }
    }
    if (args.onSuccessDestroyOriginal !== undefined && typeof args.onSuccessDestroyOriginal !== 'boolean') {
        throw invalidArguments('onSuccessDestroyOriginal must be a boolean');
    }
    if (args.fromAccountId === context.account.id) {
        throw invalidArguments('fromAccountId and accountId must name different accounts');
    }
    // another user's account is reported exactly like an unknown one
    throw new MethodError('fromAccountNotFound');
}

module.exports = { capability: URN.mail, methods: { 'Email/copy': copy } };
