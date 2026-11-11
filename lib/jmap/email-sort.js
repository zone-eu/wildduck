'use strict';

// Email/query comparators (RFC 8621 4.4.2), see docs/jmap/email-sorting.md.
//
// receivedAt, sentAt and size sort in the database on indexed fields, hasKeyword on a computed key. The
// string sorts (from, to, subject) and the thread keyword sorts have no index: their results are sorted
// in memory here, at most [jmap.query] memoryLimit messages, and a larger result answers unsupportedSort.
// The sorted list is cached under the query state (query-cache.js), so paging through it reads it once.

const addressparser = require('nodemailer/lib/addressparser');
const { MethodError, invalidArguments } = require('./errors');
const { EMAIL_SORTS } = require('./capabilities');
const { collationKey, compareStrings } = require('./collation');
const { keywordQuery, keywordExpression, threadKeywordFlags, memoryLimit } = require('./email-search');

const FIELDS = { receivedAt: 'idate', sentAt: 'hdate', size: 'size' };
const STRING_SORTS = ['from', 'to', 'subject'];
const THREAD_SORTS = ['allInThreadHaveKeyword', 'someInThreadHaveKeyword'];
const KEYWORD_SORTS = ['hasKeyword', ...THREAD_SORTS];
const COMPARATOR_KEYS = ['property', 'isAscending', 'collation', 'keyword'];
const DEFAULT_SORT = [{ property: 'receivedAt', isAscending: false }];

function checkComparator(comparator) {
    if (!comparator || typeof comparator !== 'object' || Array.isArray(comparator) || typeof comparator.property !== 'string') {
        throw invalidArguments('invalid Comparator');
    }
    for (const key of Object.keys(comparator)) {
        if (!COMPARATOR_KEYS.includes(key)) {
            throw invalidArguments(`unknown Comparator property ${key}`);
        }
    }
    if (comparator.isAscending !== undefined && typeof comparator.isAscending !== 'boolean') {
        throw invalidArguments('isAscending must be a boolean');
    }
    if (comparator.collation !== undefined && typeof comparator.collation !== 'string') {
        throw invalidArguments('collation must be a string');
    }
    if (!EMAIL_SORTS.includes(comparator.property)) {
        throw new MethodError('unsupportedSort', { description: `can not sort by ${comparator.property}` });
    }
    // RFC 8620 5.5: the collation applies to string properties only and is ignored for the others
    if (STRING_SORTS.includes(comparator.property) && comparator.collation !== undefined && !collationKey(comparator.collation)) {
        throw new MethodError('unsupportedSort', { description: `collation ${comparator.collation} is not supported` });
    }
    if (KEYWORD_SORTS.includes(comparator.property)) {
        if (typeof comparator.keyword !== 'string') {
            throw invalidArguments(`${comparator.property} needs a keyword`);
        }
        keywordQuery(comparator.keyword, true);
    }
}

/**
 * Validates the sort argument.
 *
 * @returns {{comparators: Object[], inMemory: Boolean, mutable: Boolean, definition: Object[]}} definition is the
 *          normalised list for the query state: null, an empty list and the explicit default give the same one
 */
function parseSort(sort) {
    // no comparators (null or an empty list) is the server defined order, newest first
    const list = sort === undefined || sort === null || (Array.isArray(sort) && !sort.length) ? DEFAULT_SORT : sort;
    if (!Array.isArray(list)) {
        throw invalidArguments('sort must be a list');
    }
    const comparators = list.map(comparator => {
        checkComparator(comparator);
        const normalised = { property: comparator.property, isAscending: comparator.isAscending !== false };
        if (STRING_SORTS.includes(comparator.property) && comparator.collation !== undefined) {
            normalised.collation = comparator.collation;
        }
        if (KEYWORD_SORTS.includes(comparator.property)) {
            normalised.keyword = comparator.keyword;
        }
        return normalised;
    });
    return {
        comparators,
        inMemory: comparators.some(comparator => STRING_SORTS.includes(comparator.property) || THREAD_SORTS.includes(comparator.property)),
        mutable: comparators.some(comparator => KEYWORD_SORTS.includes(comparator.property)),
        definition: comparators
    };
}

// a tie between all comparators falls back to the message id, in the direction of receivedAt (newest first by default)
function tieDirection(comparators) {
    const received = comparators.find(comparator => comparator.property === 'receivedAt');
    return received && received.isAscending ? 1 : -1;
}

/**
 * The database order of comparators that do not sort in memory.
 *
 * @returns {{order: Object, addFields: Object}} $sort and $addFields stages
 */
function databaseSort(comparators) {
    const order = {};
    const addFields = {};
    comparators.forEach((comparator, index) => {
        const direction = comparator.isAscending ? 1 : -1;
        if (FIELDS[comparator.property]) {
            order[FIELDS[comparator.property]] = direction;
            return;
        }
        // hasKeyword
        addFields[`_sort${index}`] = keywordExpression(comparator.keyword);
        order[`_sort${index}`] = direction;
    });
    if (!('_id' in order)) {
        order._id = tieDirection(comparators);
    }
    return { order, addFields };
}

/**
 * RFC 5256 2.1 base subject: without leading Re:, Fw:, Fwd: and [blob] parts, a trailing (fwd) and an
 * enclosing [fwd: ...], white space collapsed.
 */
function baseSubject(value) {
    let subject = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    for (;;) {
        const before = subject;
        subject = subject.replace(/(?:\s*\(fwd\))+\s*$/i, '').trim();
        for (let leader = true; leader;) {
            leader = false;
            const refwd = /^(?:re|fwd?)\s*(?:\[[^[\]]*\]\s*)?:\s*/i.exec(subject);
            const blob = /^\[[^[\]]*\]\s*/.exec(subject);
            if (refwd) {
                subject = subject.slice(refwd[0].length);
                leader = true;
            } else if (blob && blob[0].length < subject.length) {
                subject = subject.slice(blob[0].length);
                leader = true;
            }
        }
        const fwd = /^\[fwd:(.*)\]$/i.exec(subject);
        if (fwd) {
            subject = fwd[1].trim();
        }
        if (subject === before) {
            return subject;
        }
    }
}

/** The address sort key (RFC 8621 4.4.2): name of the first address, or its email, or the empty string */
function addressKey(headers, name) {
    const values = (headers || []).filter(header => header.key === name);
    if (!values.length) {
        return '';
    }
    // the last header field is the Email property, as in Email/get
    const entries = addressparser(String(values[values.length - 1].value || ''), { flatten: true });
    const first = entries[0];
    return first ? first.name || first.address || '' : '';
}

/** The stored fields an in memory sort reads; header values are decoded and lowercase (see MessageHandler) */
function memoryProjection(comparators) {
    const projection = { _id: 1, root: 1, thread: 1, idate: 1, hdate: 1, size: 1, subject: 1 };
    const headers = comparators.filter(comparator => comparator.property === 'from' || comparator.property === 'to').map(comparator => comparator.property);
    if (headers.length) {
        projection.headers = { $filter: { input: { $ifNull: ['$headers', []] }, cond: { $in: ['$$this.key', headers] } } };
    }
    comparators.forEach((comparator, index) => {
        if (comparator.property === 'hasKeyword') {
            projection[`_sort${index}`] = keywordExpression(comparator.keyword);
        }
    });
    return projection;
}

/** Sort key of one comparator for a document; strings as collation keys. flags: the thread's threadKeywordFlags() entry */
function keyOf(comparator, index, doc, flags) {
    switch (comparator.property) {
        case 'receivedAt':
        case 'sentAt':
        case 'size': {
            const value = doc[FIELDS[comparator.property]];
            return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : -Infinity;
        }
        case 'hasKeyword':
            return doc[`_sort${index}`];
        case 'subject':
            return collationKey(comparator.collation)(baseSubject(doc.subject));
        case 'from':
        case 'to':
            return collationKey(comparator.collation)(addressKey(doc.headers, comparator.property));
        default:
            return flags && (comparator.property === 'someInThreadHaveKeyword' ? flags.some : flags.all) ? 1 : 0;
    }
}

/**
 * Sorts all results of a query in memory and answers their roots in order (thread representatives only
 * when collapsing).
 *
 * @param {Object} context
 * @param {Object} query MongoDB query from buildQuery()
 * @param {Object[]} comparators From parseSort()
 * @param {Boolean} collapse
 * @param {Number} maxTimeMS
 * @returns {Promise<String[]>} Roots (24 hex)
 */
async function sortInMemory(context, query, comparators, collapse, maxTimeMS) {
    const limit = memoryLimit(context);
    const docs = await context.deps.database
        .collection('messages')
        .aggregate([{ $match: query }, { $limit: limit + 1 }, { $project: memoryProjection(comparators) }], { maxTimeMS, allowDiskUse: true })
        .toArray();
    if (docs.length > limit) {
        throw new MethodError('unsupportedSort', {
            description: `the query matches more than ${limit} emails, sorting by ${comparators.map(c => c.property).join(', ')} needs a narrower filter`
        });
    }
    const threadSorts = comparators.filter(comparator => THREAD_SORTS.includes(comparator.property));
    let threadFlags = new Map();
    if (threadSorts.length) {
        const threads = [...new Map(docs.filter(doc => doc.thread).map(doc => [doc.thread.toString(), doc.thread])).values()];
        threadFlags = await threadKeywordFlags(
            context,
            threads,
            threadSorts.map(comparator => comparator.keyword),
            maxTimeMS
        );
    }
    const keyed = docs.map(doc => ({
        doc,
        id: doc._id.toString(),
        keys: comparators.map((comparator, index) =>
            keyOf(comparator, index, doc, threadFlags && (threadFlags.get(String(doc.thread)) || [])[threadSorts.indexOf(comparator)])
        )
    }));
    const tie = tieDirection(comparators);
    keyed.sort((a, b) => {
        for (const [index, comparator] of comparators.entries()) {
            const result = compareStrings(a.keys[index], b.keys[index]);
            if (result) {
                return comparator.isAscending ? result : -result;
            }
        }
        return tie * compareStrings(a.id, b.id);
    });
    const seen = new Set();
    const roots = [];
    for (const { doc } of keyed) {
        const thread = String(doc.thread);
        if (collapse && seen.has(thread)) {
            continue;
        }
        seen.add(thread);
        roots.push((doc.root || doc._id).toString());
    }
    return roots;
}

module.exports = { parseSort, databaseSort, sortInMemory, baseSubject, addressKey, STRING_SORTS, THREAD_SORTS, KEYWORD_SORTS };
