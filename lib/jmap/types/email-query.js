'use strict';

// Email/query (RFC 8621 4.4): one aggregation over the account's visible messages. Plain sorts
// (receivedAt, sentAt, size) are index backed; keyword, thread keyword, from, to and subject sorts use
// computed keys. A tie between sort keys falls back to the message id, so the order is stable.

const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { mailState } = require('../state');
const { buildQuery, keywordQuery } = require('../email-search');
const { pagingArguments } = require('../query');
const { rootOf, resolveRoots } = require('../../message-roots');
const { rootsReady } = require('./email');
const consts = require('../../consts');

const MAX_LIMIT = 1000;
// how far a query looks for its anchor
const ANCHOR_SCAN_LIMIT = 100000;
const MAX_TIME_MS = consts.DB_MAX_TIME_MESSAGES_SEARCH * 3;
const COLLATIONS = ['i;ascii-numeric', 'i;ascii-casemap', 'i;unicode-casemap'];
const SORTS = ['receivedAt', 'sentAt', 'size', 'from', 'to', 'subject', 'hasKeyword', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword'];
const FIELDS = { receivedAt: 'idate', sentAt: 'hdate', size: 'size' };
const BASE_SUBJECT = '^(?:\\s*(?:re|fwd?|aw|sv|vs|antw)\\s*(?:\\[\\d+\\])?\\s*:\\s*)*(.*)$';

// the value of the indexed header field, for from and to sorts
const headerKey = name => ({
    $ifNull: [
        { $getField: { field: 'value', input: { $first: { $filter: { input: { $ifNull: ['$headers', []] }, cond: { $eq: ['$$this.key', name] } } } } } },
        ''
    ]
});

/** A sort key expression for a keyword (1 when the message has it) */
function keywordKey(keyword) {
    const query = keywordQuery(keyword, true);
    if ('unseen' in query) {
        return { $cond: ['$unseen', 0, 1] };
    }
    if ('flagged' in query || 'draft' in query) {
        const field = 'flagged' in query ? '$flagged' : '$draft';
        return { $cond: [field, 1, 0] };
    }
    if ('labels' in query) {
        return { $cond: [{ $in: [query.labels, { $ifNull: ['$labels', []] }] }, 1, 0] };
    }
    const flag = keyword.toLowerCase() === '$answered' ? '\\answered' : keyword.toLowerCase();
    return { $cond: [{ $in: [flag, { $map: { input: { $ifNull: ['$flags', []] }, in: { $toLower: '$$this' } } }] }, 1, 0] };
}

async function threadKeywordKey(context, kind, keyword) {
    const messages = context.deps.database.collection('messages');
    const base = { user: context.account.user, undeleted: true };
    if (kind === 'someInThreadHaveKeyword') {
        const threads = await messages.distinct('thread', Object.assign({}, base, keywordQuery(keyword, true)), { maxTimeMS: MAX_TIME_MS });
        return { $cond: [{ $in: ['$thread', threads] }, 1, 0] };
    }
    const lacking = await messages.distinct('thread', Object.assign({}, base, keywordQuery(keyword, false)), { maxTimeMS: MAX_TIME_MS });
    return { $cond: [{ $in: ['$thread', lacking] }, 0, 1] };
}

/**
 * Compiles the comparators into {sort, addFields} for the aggregation.
 */
async function compileSort(sort, context) {
    const comparators = sort === undefined || sort === null ? [{ property: 'receivedAt', isAscending: false }] : sort;
    if (!Array.isArray(comparators)) {
        throw invalidArguments('sort must be a list');
    }
    const order = {};
    const addFields = {};
    for (const [index, comparator] of comparators.entries()) {
        if (!comparator || typeof comparator !== 'object' || typeof comparator.property !== 'string') {
            throw invalidArguments('invalid Comparator');
        }
        for (const key of Object.keys(comparator)) {
            if (!['property', 'isAscending', 'collation', 'keyword'].includes(key)) {
                throw invalidArguments(`unknown Comparator property ${key}`);
            }
        }
        if (comparator.isAscending !== undefined && typeof comparator.isAscending !== 'boolean') {
            throw invalidArguments('isAscending must be a boolean');
        }
        if (comparator.collation !== undefined && !COLLATIONS.includes(comparator.collation)) {
            throw new MethodError('unsupportedSort', { description: `collation ${comparator.collation} is not supported` });
        }
        if (!SORTS.includes(comparator.property)) {
            throw new MethodError('unsupportedSort', { description: `can not sort by ${comparator.property}` });
        }
        const keywordSort = ['hasKeyword', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword'].includes(comparator.property);
        if (keywordSort && typeof comparator.keyword !== 'string') {
            throw invalidArguments(`${comparator.property} needs a keyword`);
        }
        const direction = comparator.isAscending === false ? -1 : 1;
        if (FIELDS[comparator.property]) {
            order[FIELDS[comparator.property]] = direction;
            continue;
        }
        const name = `_sort${index}`;
        if (comparator.property === 'hasKeyword') {
            addFields[name] = keywordKey(comparator.keyword);
        } else if (keywordSort) {
            addFields[name] = await threadKeywordKey(context, comparator.property, comparator.keyword);
        } else if (comparator.property === 'subject') {
            addFields[name] = {
                $arrayElemAt: [
                    { $getField: { field: 'captures', input: { $regexFind: { input: { $toLower: { $ifNull: ['$subject', ''] } }, regex: BASE_SUBJECT } } } },
                    0
                ]
            };
        } else {
            addFields[name] = headerKey(comparator.property);
        }
        order[name] = direction;
    }
    // stable order for equal keys
    order._id = order.idate || -1;
    return { order, addFields };
}

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

async function countOf(messages, query, sort, collapse) {
    if (!collapse) {
        return messages.countDocuments(query, { maxTimeMS: MAX_TIME_MS });
    }
    const [result] = await messages
        .aggregate([{ $match: query }, { $group: { _id: '$thread' } }, { $count: 'n' }], { maxTimeMS: MAX_TIME_MS, allowDiskUse: true })
        .toArray();
    return result ? result.n : 0;
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
        maxTimeMS: MAX_TIME_MS,
        allowDiskUse: true
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

async function query(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal', 'collapseThreads']);
    requireAccount(args, context);
    if (args.collapseThreads !== undefined && typeof args.collapseThreads !== 'boolean') {
        throw invalidArguments('collapseThreads must be a boolean');
    }
    const paging = pagingArguments(Object.assign({}, args, { limit: args.limit === undefined || args.limit === null ? MAX_LIMIT : args.limit }), MAX_LIMIT);
    const collapse = !!args.collapseThreads;
    const sort = await compileSort(args.sort, context);
    const queryFilter = await buildQuery(args.filter, context);
    const messages = context.deps.database.collection('messages');
    const pipeline = pipelineFor(queryFilter, sort, collapse);

    let total = null;
    let start;
    if (paging.anchor) {
        start = Math.max(0, (await anchorIndex(context, messages, pipeline, paging.anchor)) + paging.anchorOffset);
    } else if (paging.position < 0) {
        total = await countOf(messages, queryFilter, sort, collapse);
        start = Math.max(0, total + paging.position);
    } else {
        start = paging.position;
    }

    const docs = await messages
        .aggregate(pipeline.concat([{ $skip: start }, { $limit: paging.limit }, { $project: { _id: 1, root: 1 } }]), {
            maxTimeMS: MAX_TIME_MS,
            allowDiskUse: true
        })
        .toArray();

    if (paging.calculateTotal && total === null) {
        total = await countOf(messages, queryFilter, sort, collapse);
    }
    const { state } = await mailState(context);
    const result = {
        accountId: context.account.id,
        queryState: state,
        canCalculateChanges: false,
        position: total !== null ? Math.min(start, total) : start,
        ids: docs.map(doc => formatId('email', rootOf(doc)))
    };
    if (paging.calculateTotal) {
        result.total = total;
    }
    if (args.limit === undefined || args.limit === null || paging.limitClamped) {
        result.limit = paging.limit;
    }
    return result;
}

module.exports = { capability: URN.mail, methods: { 'Email/query': query }, compileSort, pipelineFor };
