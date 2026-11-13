'use strict';

// Email/query and Email/queryChanges (RFC 8621 4.4, 4.5).
//
// Email/query is one aggregation over the account's visible messages for the database sorts (receivedAt,
// sentAt, size, hasKeyword); a tie between sort keys falls back to the message id, so the order is
// stable. The string and thread keyword sorts are done in memory over a bounded result (email-sort.js).
//
// The ids a call reads are cached under its query state (query-cache.js): the beginning of the list up to
// the end of the requested window, or the whole list after an in memory sort. Email/queryChanges reads the
// current list to the same length and reports the difference.

const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments, isObject } = require('./common');
const { mailState } = require('../state');
const { buildQuery, validateFilter } = require('../email-search');
const { parseSort, databaseSort, sortInMemory } = require('../email-sort');
const { pagingArguments, windowOf, queryChangesArguments } = require('../query');
const queryCache = require('../query-cache');
const { rootOf, resolveRoots } = require('../../message-roots');
const { rootsReady } = require('./email');
const consts = require('../../consts');

const MAX_LIMIT = 1000;
// entries read past the length of a cached partial list, for new entries in front of the cached ones
const PREFIX_ROOM = 100;
// a window that starts this far into the list at most is read from position 0 and cached for
// queryChanges; a deeper one is read with $skip and not cached (canCalculateChanges false)
const CACHE_START_LIMIT = 1000;
// how far a query looks for its anchor
const ANCHOR_SCAN_LIMIT = 100000;
// messages a collapsed query reads in sort order before it groups in the database instead, and per batch
const COLLAPSE_SCAN_LIMIT = 20000;
const COLLAPSE_BATCH_SIZE = 500;
// ids per batch of the anchor search: without it the server sends the whole rest of the list (up to the
// scan limit) in the second batch, although the anchor is usually near the start
const ANCHOR_BATCH_SIZE = 500;
// filter conditions on keywords, whose results change with flag updates (RFC 8620 5.6 upToId)
const MUTABLE_CONDITIONS = ['hasKeyword', 'notKeyword', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword', 'noneInThreadHaveKeyword'];
// time limit of the query itself, [jmap] queryTimeout in milliseconds
const maxTime = context => (context.options && context.options.queryTimeout) || consts.DB_MAX_TIME_MESSAGES_SEARCH * 3;

const hexOf = doc => rootOf(doc).toString();

function pipelineFor(query, sort, collapse) {
    const pipeline = [{ $match: query }];
    if (Object.keys(sort.addFields).length) {
        pipeline.push({ $addFields: sort.addFields });
    }
    pipeline.push({ $sort: sort.order });
    if (collapse) {
        // the first message of every thread in sort order stands for the thread
        const keep = Object.fromEntries(Object.keys(sort.order).map(key => [key, 1]));
        pipeline.push({ $project: Object.assign({ root: 1, thread: 1 }, keep) });
        pipeline.push({ $group: { _id: '$thread', doc: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$doc' } }, { $sort: sort.order });
    }
    return pipeline;
}

async function countOf(messages, query, collapse, maxTimeMS) {
    if (!collapse) {
        return messages.countDocuments(query, { maxTimeMS });
    }
    const [result] = await messages
        .aggregate([{ $match: query }, { $group: { _id: '$thread' } }, { $count: 'n' }], { maxTimeMS, allowDiskUse: true })
        .toArray();
    return result ? result.n : 0;
}

/** Roots of the first `count` results, in order */
async function firstRoots(messages, pipeline, count, maxTimeMS) {
    if (!count) {
        return [];
    }
    const docs = await messages.aggregate(pipeline.concat([{ $limit: count }, { $project: { _id: 1, root: 1 } }]), { maxTimeMS, allowDiskUse: true }).toArray();
    return docs.map(hexOf);
}

/**
 * Roots of the first `count` results of a collapsed query, from the messages in sort order: the first
 * message of every thread stands for it, as with the $group of pipelineFor(). Reads only as far as the
 * page needs, where grouping reads every matching message (a whole mailbox for every page). Answers null
 * when more than COLLAPSE_SCAN_LIMIT messages would be read (a page of very long threads), for the caller
 * to group in the database instead.
 */
async function firstCollapsedRoots(messages, pipeline, count, maxTimeMS) {
    const roots = [];
    if (!count) {
        return roots;
    }
    const cursor = messages.aggregate(pipeline.concat([{ $limit: COLLAPSE_SCAN_LIMIT + 1 }, { $project: { _id: 1, root: 1, thread: 1 } }]), {
        maxTimeMS,
        allowDiskUse: true,
        batchSize: COLLAPSE_BATCH_SIZE
    });
    const threads = new Set();
    let read = 0;
    for await (const doc of cursor) {
        if (++read > COLLAPSE_SCAN_LIMIT) {
            await cursor.close();
            return null;
        }
        // messages without a thread form one group, like a $group on a missing field
        const thread = doc.thread ? doc.thread.toString() : '';
        if (!threads.has(thread)) {
            threads.add(thread);
            roots.push(hexOf(doc));
            if (roots.length >= count) {
                await cursor.close();
                break;
            }
        }
    }
    return roots;
}

/** Roots of the first `count` results of the query, collapsed by streaming when that reads less */
async function leadingRoots(plan, queryFilter, count) {
    const sort = databaseSort(plan.sort.comparators);
    if (plan.collapse) {
        const roots = await firstCollapsedRoots(plan.messages, pipelineFor(queryFilter, sort, false), count, plan.maxTimeMS);
        if (roots) {
            return roots;
        }
    }
    return firstRoots(plan.messages, pipelineFor(queryFilter, sort, plan.collapse), count, plan.maxTimeMS);
}

// position of the anchor Email in the full result, found by streaming ids in sort order
async function anchorIndex(context, messages, pipeline, anchor) {
    const root = parseId('email', anchor);
    const docs = root
        ? await resolveRoots(messages, context.account.user, [root], { projection: { _id: true }, legacy: !(await rootsReady(context)) })
        : new Map();
    const target = docs.get(root && root.toString());
    if (!target) {
        throw new MethodError('anchorNotFound');
    }
    const cursor = messages.aggregate(pipeline.concat([{ $limit: ANCHOR_SCAN_LIMIT }, { $project: { _id: 1, root: 1 } }]), {
        maxTimeMS: maxTime(context),
        allowDiskUse: true,
        batchSize: ANCHOR_BATCH_SIZE
    });
    let index = 0;
    for await (const doc of cursor) {
        if (rootOf(doc).toString() === root.toString()) {
            await cursor.close();
            return index;
        }
        index++;
    }
    throw new MethodError('anchorNotFound');
}

/** The checked arguments both methods share, and what defines the result list for the query state */
function prepare(args, context) {
    if (args.collapseThreads !== undefined && typeof args.collapseThreads !== 'boolean') {
        throw invalidArguments('collapseThreads must be a boolean');
    }
    const collapse = !!args.collapseThreads;
    const sort = parseSort(args.sort);
    const filter = args.filter === undefined ? null : args.filter;
    const definition = { filter, sort: sort.definition, collapseThreads: collapse };
    return { collapse, sort, filter, definition, maxTimeMS: maxTime(context), messages: context.deps.database.collection('messages') };
}

/** The whole result list of an in memory sort: from the cache of this state, else sorted now */
async function sortedList(context, plan, queryFilter, state) {
    const cached = await queryCache.load(context, state);
    if (cached && cached.complete) {
        return cached.ids;
    }
    const ids = await sortInMemory(context, queryFilter, plan.sort.comparators, plan.collapse, plan.maxTimeMS);
    await queryCache.store(context, state, { ids, complete: true });
    return ids;
}

/** The window of an in memory sorted query */
async function memoryWindow(context, plan, queryFilter, state, paging) {
    const ids = (await sortedList(context, plan, queryFilter, state)).map(hex => formatId('email', hex));
    const window = windowOf(ids, paging);
    return { ids: window.ids, position: window.position, total: ids.length, cached: true };
}

/**
 * The window of a query sorted in the database. A window near the start of the list (starting at most
 * CACHE_START_LIMIT entries in, ending at most [jmap.queryCache] maxIds in) is read from position 0 and
 * the ids are cached for queryChanges. A deeper page only reads its own ids ($skip) and is not cached.
 */
async function databaseWindow(context, plan, queryFilter, state, paging) {
    const { messages, collapse, maxTimeMS } = plan;
    const pipeline = pipelineFor(queryFilter, databaseSort(plan.sort.comparators), collapse);
    let total = null;
    let start;
    if (paging.anchor) {
        start = Math.max(0, (await anchorIndex(context, messages, pipeline, paging.anchor)) + paging.anchorOffset);
    } else if (paging.position < 0) {
        total = await countOf(messages, queryFilter, collapse, maxTimeMS);
        start = Math.max(0, total + paging.position);
    } else {
        start = paging.position;
    }
    const end = start + paging.limit;
    const cacheable = start <= CACHE_START_LIMIT && end <= queryCache.settingsOf(context).maxIds;
    // the page and the total are independent reads
    const [roots, counted] = await Promise.all([
        cacheable
            ? leadingRoots(plan, queryFilter, end)
            : messages
                  .aggregate(pipeline.concat([{ $skip: start }, { $limit: paging.limit }, { $project: { _id: 1, root: 1 } }]), {
                      maxTimeMS,
                      allowDiskUse: true
                  })
                  .toArray()
                  .then(docs => docs.map(hexOf)),
        paging.calculateTotal && total === null ? countOf(messages, queryFilter, collapse, maxTimeMS) : total
    ]);
    total = counted;
    const page = cacheable ? roots.slice(start) : roots;
    if (cacheable) {
        const complete = roots.length < end || (total !== null && roots.length >= total);
        await queryCache.store(context, state, { ids: roots, complete });
    }
    return {
        ids: page.map(hex => formatId('email', hex)),
        position: total !== null ? Math.min(start, total) : start,
        total,
        cached: cacheable
    };
}

async function query(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal', 'collapseThreads']);
    requireAccount(args, context);
    const plan = prepare(args, context);
    const paging = pagingArguments(Object.assign({}, args, { limit: args.limit === undefined || args.limit === null ? MAX_LIMIT : args.limit }), MAX_LIMIT);
    const queryFilter = await buildQuery(plan.filter, context, { maxTimeMS: plan.maxTimeMS });
    // read before the query runs, so a change made meanwhile is never hidden behind a newer state
    const { anchor } = await mailState(context);
    const state = queryCache.queryState(context, 'Email/query', anchor, plan.definition);

    const window = await (plan.sort.inMemory ? memoryWindow : databaseWindow)(context, plan, queryFilter, state, paging);
    const result = {
        accountId: context.account.id,
        queryState: state,
        // a window past the cached part of the list can not be followed by queryChanges
        canCalculateChanges: window.cached,
        position: window.position,
        ids: window.ids
    };
    if (paging.calculateTotal) {
        result.total = window.total;
    }
    if (args.limit === undefined || args.limit === null || paging.limitClamped) {
        result.limit = paging.limit;
    }
    return result;
}

/** True when the filter or the sort depends on keywords, which change without the Email changing place */
function isMutable(filter, sort) {
    const visit = node =>
        isObject(node) && (Array.isArray(node.conditions) ? node.conditions.some(visit) : Object.keys(node).some(key => MUTABLE_CONDITIONS.includes(key)));
    return sort.mutable || visit(filter);
}

/**
 * The current result list for a queryChanges. After an in memory sort it is the whole list. Otherwise it
 * is read as far as the cached one went (all of it when that was complete), with room for new entries in
 * front of the cached ones.
 *
 * @returns {Promise<{ids: String[], complete: Boolean}>}
 */
async function currentList(context, plan, queryFilter, before, state) {
    if (plan.sort.inMemory) {
        return { ids: await sortedList(context, plan, queryFilter, state), complete: true };
    }
    const maxIds = queryCache.settingsOf(context).maxIds;
    if (before.complete) {
        const ids = await leadingRoots(plan, queryFilter, maxIds + 1);
        if (ids.length > maxIds) {
            // the whole list was known and is too long now: changes past the cacheable part are unknown
            throw new MethodError('cannotCalculateChanges');
        }
        return { ids, complete: true };
    }
    const length = Math.min(maxIds, before.ids.length * 2 + PREFIX_ROOM);
    const ids = await leadingRoots(plan, queryFilter, length);
    return { ids, complete: ids.length < length };
}

/**
 * Email/queryChanges (RFC 8620 5.6): the cached result list of the old query state against the current
 * list. An unknown or expired state, or arguments other than those of the query that produced it, answer
 * cannotCalculateChanges.
 */
async function queryChanges(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'sinceQueryState', 'maxChanges', 'upToId', 'calculateTotal', 'collapseThreads']);
    requireAccount(args, context);
    const { sinceQueryState, maxChanges, upToId, calculateTotal } = queryChangesArguments(args);
    const plan = prepare(args, context);
    validateFilter(plan.filter);
    const since = queryCache.parseQueryState(context, 'Email/query', sinceQueryState, plan.definition);
    const before = await queryCache.load(context, sinceQueryState);
    if (!before) {
        throw new MethodError('cannotCalculateChanges');
    }
    const { anchor } = await mailState(context);
    const state = queryCache.queryState(context, 'Email/query', anchor, plan.definition);
    let queryFilter = null;
    const filterOf = async () => queryFilter || (queryFilter = await buildQuery(plan.filter, context, { maxTimeMS: plan.maxTimeMS }));
    const after = anchor.equals(since) ? before : await currentList(context, plan, await filterOf(), before, state);

    const upTo = upToId && !isMutable(plan.filter, plan.sort) ? parseId('email', upToId) : null;
    const { removed, added, length } = queryCache.diff(before.ids, after.ids, { upToId: upTo ? upTo.toString() : null, partial: !after.complete });
    if (after !== before) {
        // what the client holds after applying the changes
        await queryCache.store(context, state, { ids: after.ids.slice(0, after.complete ? after.ids.length : length), complete: after.complete });
    }
    if (removed.length + added.length > maxChanges) {
        throw new MethodError('tooManyChanges');
    }
    const result = {
        accountId: context.account.id,
        oldQueryState: sinceQueryState,
        newQueryState: state,
        removed: removed.map(hex => formatId('email', hex)),
        added: added.map(item => ({ id: formatId('email', item.id), index: item.index }))
    };
    if (calculateTotal) {
        result.total = after.complete ? after.ids.length : await countOf(plan.messages, await filterOf(), plan.collapse, plan.maxTimeMS);
    }
    return result;
}

module.exports = {
    capability: URN.mail,
    methods: { 'Email/query': query, 'Email/queryChanges': queryChanges },
    MAX_LIMIT,
    anchorIndex,
    firstCollapsedRoots,
    ANCHOR_BATCH_SIZE,
    COLLAPSE_SCAN_LIMIT
};
