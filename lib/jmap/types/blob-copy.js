'use strict';

// Blob/copy (RFC 8620 6.3). It copies blobs between two accounts; every WildDuck user has exactly one
// account, so the only call that names two valid accounts names the same one twice. The method exists
// so that clients get the RFC errors instead of unknownMethod: an unknown or foreign accountId is
// accountNotFound, equal ids are invalidArguments, any other fromAccountId is fromAccountNotFound.

const { URN } = require('../capabilities');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');

async function copy(args, context) {
    checkArguments(args, ['fromAccountId', 'accountId', 'blobIds']);
    requireAccount(args, context);
    if (typeof args.fromAccountId !== 'string') {
        throw invalidArguments('fromAccountId is required');
    }
    if (!Array.isArray(args.blobIds) || !args.blobIds.every(id => typeof id === 'string')) {
        throw invalidArguments('blobIds must be a list of blob ids');
    }
    if (args.fromAccountId === context.account.id) {
        throw invalidArguments('fromAccountId and accountId must name different accounts');
    }
    // another user's account is reported exactly like an unknown one
    throw new MethodError('fromAccountNotFound');
}

module.exports = { capability: URN.core, methods: { 'Blob/copy': copy } };
