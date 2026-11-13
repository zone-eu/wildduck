'use strict';

// One response budget per API request (limits.maxResponseBytes). The responses of all method calls are
// held until the request ends and are serialized together, so every /get call draws what it returns from
// one budget shared by the calls of the request. The sizes are estimates from stored values (the stored
// size of an event or a card, body value lengths, header lengths), never a serialization of the result.

const { MethodError } = require('./errors');

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// what one object of a /get list costs besides the content its type draws itself: ids, flags, dates,
// names, the JSON punctuation of a small object
const OBJECT_BYTES = 256;

function budgetOf(context) {
    if (!context.responseBudget) {
        context.responseBudget = { remaining: context.limits.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES };
    }
    return context.responseBudget;
}

/** Octets left in the response budget of the request */
const remaining = context => budgetOf(context).remaining;

/**
 * Draws octets from the response budget of the request.
 *
 * @throws {MethodError} requestTooLarge when the octets do not fit in what is left (nothing is drawn then)
 */
function draw(context, bytes) {
    const budget = budgetOf(context);
    if (bytes > budget.remaining) {
        throw new MethodError('requestTooLarge', { description: 'the responses of this request would be too large, ask for fewer objects per call' });
    }
    budget.remaining -= bytes;
}

/** Takes octets a call has already returned (truncated values that never exceed what is left) */
function spend(context, bytes) {
    const budget = budgetOf(context);
    budget.remaining = Math.max(0, budget.remaining - bytes);
}

/** The fixed cost of the objects of a /get result (the content of large objects is drawn by their type) */
function drawObjects(context, result) {
    if (result && Array.isArray(result.list) && result.list.length) {
        draw(context, result.list.length * OBJECT_BYTES);
    }
}

module.exports = { draw, spend, remaining, drawObjects, DEFAULT_MAX_RESPONSE_BYTES, OBJECT_BYTES };
