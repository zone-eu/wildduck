'use strict';

// One response budget per API request (limits.maxResponseBytes). The responses of all method calls are
// held until the request ends and are serialized together, so every /get call draws what it returns from
// one budget shared by the calls of the request. The sizes are estimates from stored values (the stored
// size of an event or a card, body value lengths, header lengths), never a serialization of the result.

const { MethodError } = require('./errors');

// what one object of a /get list costs besides the content its type draws itself: ids, flags, dates,
// names, the JSON punctuation of a small object
const OBJECT_BYTES = 256;

function budgetOf(context) {
    if (!context.responseBudget) {
        context.responseBudget = { remaining: context.limits.maxResponseBytes };
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

/** Gives back octets drawn for a call that failed after all */
function refund(context, bytes) {
    budgetOf(context).remaining += bytes;
}

/**
 * A budget of at most `limit` octets within what is left of the response budget of the request, for
 * values a call truncates as it goes (body values, blob content). The call takes from `remaining`,
 * close() spends what it took from the request budget.
 */
function capped(context, limit) {
    const start = Math.min(limit, remaining(context));
    const budget = { remaining: start, close: () => spend(context, start - budget.remaining) };
    return budget;
}

/**
 * The fixed cost of the objects of a /get call (the content of large objects is drawn by their type).
 * A call with a list of ids pays for every id before it runs, so a call that can not fit fails before
 * doing the work; a call with `ids: null` pays for what it returned.
 *
 * @returns {Number} the octets drawn before the call (refund them when the call fails)
 */
function drawBefore(context, args) {
    if (!Array.isArray(args.ids)) {
        return 0;
    }
    const bytes = args.ids.length * OBJECT_BYTES;
    draw(context, bytes);
    return bytes;
}

function drawAfter(context, args, result) {
    if (!Array.isArray(args.ids) && result && Array.isArray(result.list) && result.list.length) {
        draw(context, result.list.length * OBJECT_BYTES);
    }
}

module.exports = { draw, spend, refund, capped, remaining, drawBefore, drawAfter, OBJECT_BYTES };
