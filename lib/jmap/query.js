'use strict';

// Shared parts of /query methods (RFC 8620 5.5): argument checks and the result window.

const { MethodError, invalidArguments } = require('./errors');
const { maxChangesOf } = require('./state');

const isInt = value => Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;

/**
 * Checks the paging arguments.
 *
 * @returns {{position: Number, anchor: String|null, anchorOffset: Number, limit: Number|null, calculateTotal: Boolean}}
 */
function pagingArguments(args, maxLimit) {
    const position = args.position === undefined || args.position === null ? 0 : args.position;
    const anchorOffset = args.anchorOffset === undefined || args.anchorOffset === null ? 0 : args.anchorOffset;
    if (!isInt(position) || !isInt(anchorOffset)) {
        throw invalidArguments('position and anchorOffset must be integers');
    }
    if (args.anchor !== undefined && args.anchor !== null && typeof args.anchor !== 'string') {
        throw invalidArguments('anchor must be an id');
    }
    let limit = args.limit === undefined || args.limit === null ? null : args.limit;
    if (limit !== null && (!isInt(limit) || limit < 0)) {
        throw invalidArguments('limit must be a non negative integer');
    }
    if (args.calculateTotal !== undefined && typeof args.calculateTotal !== 'boolean') {
        throw invalidArguments('calculateTotal must be a boolean');
    }
    return {
        position,
        anchor: args.anchor || null,
        anchorOffset,
        limit: limit !== null && limit > maxLimit ? maxLimit : limit,
        limitClamped: limit !== null && limit > maxLimit,
        calculateTotal: !!args.calculateTotal
    };
}

/**
 * Applies position or anchor to a complete, sorted list of ids (RFC 8620 5.5).
 *
 * @returns {{ids: String[], position: Number}}
 */
function windowOf(ids, paging) {
    let start;
    if (paging.anchor) {
        const index = ids.indexOf(paging.anchor);
        if (index < 0) {
            throw new MethodError('anchorNotFound');
        }
        start = Math.max(0, index + paging.anchorOffset);
    } else {
        start = paging.position < 0 ? Math.max(0, ids.length + paging.position) : paging.position;
    }
    const end = paging.limit === null ? ids.length : start + paging.limit;
    return { ids: ids.slice(start, end), position: Math.min(start, ids.length) };
}

/**
 * Checks the arguments every /queryChanges method has (RFC 8620 5.6) besides filter and sort.
 *
 * @returns {{sinceQueryState: String, maxChanges: Number, upToId: String|null, calculateTotal: Boolean}}
 */
function queryChangesArguments(args) {
    if (typeof args.sinceQueryState !== 'string') {
        throw invalidArguments('sinceQueryState must be a string');
    }
    const maxChanges = maxChangesOf(args);
    if (args.upToId !== undefined && args.upToId !== null && typeof args.upToId !== 'string') {
        throw invalidArguments('upToId must be an id');
    }
    if (args.calculateTotal !== undefined && typeof args.calculateTotal !== 'boolean') {
        throw invalidArguments('calculateTotal must be a boolean');
    }
    return { sinceQueryState: args.sinceQueryState, maxChanges, upToId: args.upToId || null, calculateTotal: !!args.calculateTotal };
}

module.exports = { pagingArguments, windowOf, queryChangesArguments };
