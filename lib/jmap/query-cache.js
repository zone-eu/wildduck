'use strict';

// Query states and cached query results for /queryChanges (RFC 8620 5.6, plan 3.4).
//
// A query state names the account state the results were read at and the query itself: `q`, the 24 hex
// journal anchor and a keyed checksum over the method, the account, the anchor and a fingerprint of the
// arguments that define the result list (filter, sort and the like). A state of another account, of
// another query or a made up one therefore never matches.
//
// The ids of a result list are kept in Redis under the query state for a short time (default 10 minutes,
// [jmap.queryCache] ttl). Only the beginning of a list is kept: as far as some call at that state has
// read it, at most [jmap.queryCache] maxIds ids. /queryChanges loads the list of the old state, reads the
// current list to the same length and reports the difference. A missing entry answers
// cannotCalculateChanges and the client runs the query again.
//
// All lists of a user live in one hash with a byte budget ([jmap.queryCache] maxBytes) and an entry
// budget (maxEntries): a store that goes over them drops the states stored longest ago, so a client
// running many different queries can not grow Redis without bound. One store is one round trip (a
// Lua script, lib/lua/jmap-query-cache.lua).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { MethodError } = require('./errors');

const QUERY_STATE = /^q([0-9a-f]{24})([0-9a-f]{16})$/;
const DEFAULTS = { ttl: 600, maxIds: 10000, maxBytes: 1024 * 1024, maxEntries: 200 };
// first byte of a cached entry
const COMPLETE = 1;
// bytes of a stored list besides its ids: the first byte and the field name (the query state)
const ENTRY_OVERHEAD = 1 + 41;
const STORE_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'lua', 'jmap-query-cache.lua'), 'utf-8');

/** [jmap.queryCache] over the defaults */
const settingsOf = context => Object.assign({}, DEFAULTS, (context.options && context.options.queryCache) || {});

/**
 * Checks the [jmap.queryCache] and [jmap.query] settings at start.
 *
 * @throws {Error} when the byte budget can not hold one full list, or an in memory sort may produce
 *   more ids than a query state can keep
 */
function checkSettings(options) {
    const settings = Object.assign({}, DEFAULTS, (options && options.queryCache) || {});
    if (settings.maxBytes < settings.maxIds * 12 + ENTRY_OVERHEAD) {
        throw new Error(`jmap.queryCache.maxBytes must hold at least one list of maxIds ids (${settings.maxIds * 12 + ENTRY_OVERHEAD} bytes)`);
    }
    const memoryLimit = options && options.query && options.query.memoryLimit;
    if (memoryLimit && memoryLimit > settings.maxIds) {
        throw new Error('jmap.query.memoryLimit must not be higher than jmap.queryCache.maxIds');
    }
}

/** JSON with sorted object keys, so the same arguments written in another key order give the same text */
function canonical(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

const checksum = (context, method, anchor, fingerprint) =>
    crypto.createHmac('sha256', context.options.accessSecret).update(`${method}\n${context.account.id}\n${anchor}\n${fingerprint}`).digest('hex').slice(0, 16);

/**
 * The query state of a result list.
 *
 * @param {Object} context
 * @param {String} method For example 'Email/query'
 * @param {ObjectId} anchor The account state the list was read at (mailState().anchor)
 * @param {Object} definition The arguments that define the list, already normalised
 */
function queryState(context, method, anchor, definition) {
    const hex = anchor.toString();
    return `q${hex}${checksum(context, method, hex, canonical(definition))}`;
}

/**
 * Checks a sinceQueryState against the arguments of the /queryChanges call.
 *
 * @returns {ObjectId} The anchor of the state
 * @throws {MethodError} cannotCalculateChanges when it is not a state of this query in this account
 */
function parseQueryState(context, method, value, definition) {
    const match = QUERY_STATE.exec(value);
    if (!match || checksum(context, method, match[1], canonical(definition)) !== match[2]) {
        throw new MethodError('cannotCalculateChanges');
    }
    return new ObjectId(match[1]);
}

const keysOf = context => [`jmap:qc:${context.account.user}`, `jmap:qco:${context.account.user}`];

function storeCommand(redis) {
    if (typeof redis.jmapQueryCacheStore !== 'function') {
        redis.defineCommand('jmapQueryCacheStore', { numberOfKeys: 2, lua: STORE_SCRIPT });
    }
    return redis;
}

/**
 * Keeps the beginning of a result list under its query state. An entry already holding a longer list is
 * kept: both lists were read at the same state, so the shorter one is a prefix of the longer one.
 *
 * @param {Object} context
 * @param {String} state Query state
 * @param {{ids: String[], complete: Boolean}} list 24 hex ids in result order; complete when the list has no more entries
 * @param {Object} [options] {prefixed: the ids are one ASCII letter and 24 hex, for types whose ids come from several collections}
 */
async function store(context, state, list, options = {}) {
    const { ttl, maxIds, maxBytes, maxEntries } = settingsOf(context);
    const width = options.prefixed ? 13 : 12;
    if (!ttl || list.ids.length > maxIds || list.ids.length * width + ENTRY_OVERHEAD > maxBytes) {
        return;
    }
    const ids = options.prefixed
        ? list.ids.map(id => Buffer.concat([Buffer.from(id[0], 'latin1'), Buffer.from(id.slice(1), 'hex')]))
        : [Buffer.from(list.ids.join(''), 'hex')];
    const value = Buffer.concat([Buffer.from([list.complete ? COMPLETE : 0]), ...ids]);
    await storeCommand(context.deps.redis).jmapQueryCacheStore(...keysOf(context), state, value, list.complete ? 1 : 0, ttl, maxBytes, maxEntries, Date.now());
}

/**
 * The cached list of a query state.
 *
 * @param {Object} [options] {prefixed: as given to store()}
 * @returns {Promise<{ids: String[], complete: Boolean}|null>}
 */
async function load(context, state, options = {}) {
    const value = await context.deps.redis.hgetBuffer(keysOf(context)[0], state);
    const width = options.prefixed ? 13 : 12;
    if (!value || !value.length || (value.length - 1) % width) {
        return null;
    }
    const ids = [];
    for (let offset = 1; offset < value.length; offset += width) {
        const entry = value.subarray(offset, offset + width);
        ids.push(options.prefixed ? entry.subarray(0, 1).toString('latin1') + entry.subarray(1).toString('hex') : entry.toString('hex'));
    }
    return { ids, complete: value[0] === COMPLETE };
}

/**
 * Indexes of a longest strictly increasing subsequence (patience sorting).
 *
 * @param {Number[]} values
 * @returns {Set<Number>} Positions in values
 */
function increasingRun(values) {
    const tails = [];
    const previous = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (values[tails[middle]] < values[i]) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        previous[i] = low > 0 ? tails[low - 1] : -1;
        tails[low] = i;
    }
    const result = new Set();
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) {
        result.add(i);
    }
    return result;
}

/** Index in `after` of the last kept id (whose old index passes the test), or -1 */
function lastKept(after, keep, test) {
    for (let index = after.length - 1; index >= 0; index--) {
        if (keep.has(after[index]) && test(after[index])) {
            return index;
        }
    }
    return -1;
}

/**
 * The changes between two result lists (RFC 8620 5.6): removed holds every id that left the list or
 * changed its place, added every id that joined it or changed its place, with its new index. Ids that
 * keep their relative order are not reported, so removing `removed` from the old list and inserting
 * `added` in index order gives the new list.
 *
 * When the new list is only the beginning of the results (partial), or the client holds the old one
 * only up to upToId, the changes end at the last id the client keeps: applying them gives the new list
 * up to that point, which is `length` entries long.
 *
 * @param {String[]} before Old list
 * @param {String[]} after New list
 * @param {Object} [options] {upToId: the last id the client holds (immutable queries only), partial: true when after is not the whole result}
 * @returns {{removed: String[], added: {id: String, index: Number}[], length: Number}}
 */
function diff(before, after, options = {}) {
    const oldIndex = new Map(before.map((id, index) => [id, index]));
    const common = [];
    const positions = [];
    after.forEach((id, index) => {
        if (oldIndex.has(id)) {
            common.push(index);
            positions.push(oldIndex.get(id));
        }
    });
    const keep = new Set();
    for (const position of increasingRun(positions)) {
        keep.add(after[common[position]]);
    }
    let removed = before.filter(id => !keep.has(id));

    let length = after.length;
    if (options.partial) {
        const last = lastKept(after, keep, () => true);
        length = last >= 0 ? last + 1 : Math.min(before.length, after.length);
    }
    const limit = options.upToId ? before.indexOf(options.upToId) : -1;
    if (limit >= 0) {
        // what changed after the last id the client keeps is left out
        removed = removed.filter(id => oldIndex.get(id) <= limit);
        const last = lastKept(after, keep, id => oldIndex.get(id) <= limit);
        if (last >= 0) {
            length = Math.min(length, last + 1);
        }
    }
    const added = [];
    for (let index = 0; index < length; index++) {
        if (!keep.has(after[index])) {
            added.push({ id: after[index], index });
        }
    }
    return { removed, added, length };
}

module.exports = { queryState, parseQueryState, store, load, diff, canonical, settingsOf, checkSettings };
