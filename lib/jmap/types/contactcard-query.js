'use strict';

// ContactCard/query and ContactCard/queryChanges (RFC 9610 3.3, 3.4).
//
// A query reads the cards of the account that may match from the contacts.cards collection, narrowed by the
// indexed fields (address book, uid, members, kind, dates and the search terms of contact-search.js),
// plus the register cards, and decides the filter and the sort on them in memory. Both are bounded:
// an account has at most [jmap.contacts] maxCards cards and maxRegisterCards register cards.
//
// The query state is the ContactCard state and a fingerprint of filter and sort (query-cache.js); the
// result ids are kept under it, so queryChanges diffs the cached list against the current one.

const { ObjectId } = require('mongodb');
const { URN } = require('../capabilities');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments, isObject } = require('./common');
const { parseId } = require('../ids');
const { parseUTCDate } = require('../utcdate');
const { pagingArguments, sortArgument, windowOf, queryChangesArguments } = require('../query');
const { changeLogFor } = require('../changelog');
const queryCache = require('../query-cache');
const consts = require('../../consts');
const search = require('../contact-search');
const { CARDS } = require('../../contact-handler');
const { contactsOf, loadBooks, REGISTER_ID } = require('./addressbook');
const { storedRecord, registerRecord } = require('./contactcard');

const METHOD = 'ContactCard/query';
const MAX_FILTER_DEPTH = 10;
const MAX_FILTER_CONDITIONS = 100;
// longest string of a filter condition (search strings are matched against every candidate card)
const MAX_FILTER_STRING = 1024;
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
const STRING_FILTERS = ['inAddressBook', 'uid', 'hasMember', 'kind', ...Object.keys(search.FILTER_FIELDS)];
const DATE_FILTERS = { createdBefore: ['created', -1], createdAfter: ['created', 1], updatedBefore: ['updated', -1], updatedAfter: ['updated', 1] };
const NOTHING = { _id: { $exists: false } };
// every register card uid starts with this (contactcard.js registerUid())
const REGISTER_UID_PREFIX = 'urn:uuid:00000000-';
// the fields of a stored card a query reads (json only when a text condition needs the card itself)
const PROJECTION = { _id: true, addressBooks: true, uid: true, kind: true, members: true, created: true, updated: true, sort: true };

// ---------------------------------------------------------------- filter

/** An AND of MongoDB conditions, null ones left out */
function and(conditions) {
    const list = conditions.filter(Boolean);
    return list.length ? (list.length === 1 ? list[0] : { $and: list }) : null;
}

/**
 * Checks a filter and compiles it into a test of query records, a MongoDB condition that every
 * matching stored card satisfies (null for none) and whether a register card can match at all.
 *
 * @returns {{test: Function, narrow: Object|null, text: Boolean, register: Boolean}}
 */
function compileFilter(filter, counter = { conditions: 0 }, depth = 0) {
    if (filter === undefined || filter === null) {
        return { test: () => true, narrow: null, text: false, register: true };
    }
    if (!isObject(filter)) {
        throw invalidArguments('filter must be an object');
    }
    if (depth > MAX_FILTER_DEPTH || ++counter.conditions > MAX_FILTER_CONDITIONS) {
        throw invalidArguments('the filter is too complex');
    }
    if (filter.operator !== undefined) {
        return compileOperator(filter, counter, depth);
    }
    const parts = Object.entries(filter).map(([property, value]) => compileCondition(property, value));
    return {
        test: record => parts.every(part => part.test(record)),
        narrow: and(parts.map(part => part.narrow)),
        text: parts.some(part => part.text),
        register: parts.every(part => part.register)
    };
}

function compileOperator(filter, counter, depth) {
    if (
        !['AND', 'OR', 'NOT'].includes(filter.operator) ||
        !Array.isArray(filter.conditions) ||
        Object.keys(filter).some(key => !['operator', 'conditions'].includes(key))
    ) {
        throw invalidArguments('a FilterOperator has an operator of AND, OR or NOT and a list of conditions');
    }
    const parts = filter.conditions.map(condition => compileFilter(condition, counter, depth + 1));
    const text = parts.some(part => part.text);
    if (filter.operator === 'AND') {
        return {
            test: record => parts.every(part => part.test(record)),
            narrow: and(parts.map(part => part.narrow)),
            text,
            register: parts.every(part => part.register)
        };
    }
    if (filter.operator === 'OR') {
        const narrow = parts.some(part => part.narrow === null) || !parts.length ? null : { $or: parts.map(part => part.narrow) };
        return {
            test: record => parts.some(part => part.test(record)),
            narrow: parts.length ? narrow : NOTHING,
            text,
            register: parts.some(part => part.register)
        };
    }
    // NOT: none of the conditions matches; neither the stored nor the register cards can be narrowed
    return { test: record => !parts.some(part => part.test(record)), narrow: null, text, register: true };
}

function compileCondition(property, value) {
    if (Object.hasOwn(DATE_FILTERS, property)) {
        const date = parseUTCDate(value);
        if (!date) {
            throw invalidArguments(`${property} must be a UTCDate`);
        }
        const [field, direction] = DATE_FILTERS[property];
        const time = date.getTime();
        return {
            test: record => !!record[field] && (direction < 0 ? record[field].getTime() < time : record[field].getTime() >= time),
            narrow: { [field]: direction < 0 ? { $lt: date } : { $gte: date } },
            text: false,
            register: true
        };
    }
    if (!STRING_FILTERS.includes(property)) {
        throw new MethodError('unsupportedFilter', { description: `unknown filter property ${property}` });
    }
    if (typeof value !== 'string') {
        throw invalidArguments(`${property} must be a string`);
    }
    if (value.length > MAX_FILTER_STRING) {
        throw invalidArguments(`${property} is longer than ${MAX_FILTER_STRING} characters`);
    }
    switch (property) {
        case 'inAddressBook': {
            const book = parseId('addressBook', value);
            return {
                test: record => record.books.includes(value),
                narrow: book ? { addressBooks: book } : NOTHING,
                text: false,
                register: value === REGISTER_ID
            };
        }
        // register cards are individuals without members, with uids of their own (contactcard.js registerUid())
        case 'uid':
            return { test: record => record.uid === value, narrow: { uid: value }, text: false, register: value.startsWith(REGISTER_UID_PREFIX) };
        case 'hasMember':
            return { test: record => record.members.includes(value), narrow: { members: value }, text: false, register: false };
        case 'kind':
            return { test: record => record.kind === value, narrow: { kind: value }, text: false, register: value === 'individual' };
        default: {
            const codes = search.FILTER_FIELDS[property];
            const items = search.parseSearch(value);
            return {
                test: record => search.matchesSearch(fieldsOf(record), codes, items),
                narrow: search.termsCondition(codes, items),
                text: !!items.length,
                register: true
            };
        }
    }
}

// the search fields of a record, worked out once
function fieldsOf(record) {
    if (!record.fields) {
        record.fields = search.searchFields(record.card || {});
    }
    return record.fields;
}

/** The address book an AND of conditions limits the result to, when there is one */
function onlyBook(filter) {
    if (!isObject(filter)) {
        return null;
    }
    if (typeof filter.inAddressBook === 'string') {
        return filter.inAddressBook;
    }
    if (filter.operator === 'AND' && Array.isArray(filter.conditions)) {
        return filter.conditions.map(onlyBook).find(Boolean) || null;
    }
    return null;
}

// ---------------------------------------------------------------- sort

function compileSort(sort) {
    if (sort === undefined || sort === null) {
        return search.compileSort([]);
    }
    if (!Array.isArray(sort) || sort.some(comparator => !isObject(comparator) || typeof comparator.property !== 'string')) {
        throw invalidArguments('sort must be a list of Comparators');
    }
    for (const comparator of sort) {
        if (Object.keys(comparator).some(key => !['property', 'isAscending', 'collation'].includes(key))) {
            throw invalidArguments('unknown Comparator property');
        }
        if (comparator.isAscending !== undefined && typeof comparator.isAscending !== 'boolean') {
            throw invalidArguments('isAscending must be a boolean');
        }
        if (comparator.collation !== undefined && typeof comparator.collation !== 'string') {
            throw invalidArguments('collation must be a string');
        }
    }
    const compare = search.compileSort(sort);
    if (!compare) {
        throw new MethodError('unsupportedSort');
    }
    return compare;
}

// ---------------------------------------------------------------- results

/**
 * The whole sorted result list of a query, as card ids.
 */
async function resultList(context, args, filter, compare) {
    const [stored, entries] = await Promise.all([
        onlyBook(args.filter) === REGISTER_ID ? [] : matchingStored(context, filter),
        // most filters (another address book, a member, a kind, a uid) can not match a register card
        filter.register ? contactsOf(context).registerEntries(context.account.user) : []
    ]);
    const records = [...stored, ...entries.map(registerRecord).filter(filter.test)];
    return records.sort(compare).map(record => record.id);
}

/**
 * The query records of the stored cards that match. Cards are tested as they are read and only what the
 * sort needs is kept: a text filter reads the whole card, and an account holds up to maxCards cards of
 * maxCardSize octets each.
 */
async function matchingStored(context, filter) {
    const projection = filter.text ? Object.assign({ json: true }, PROJECTION) : PROJECTION;
    const query = filter.narrow ? { $and: [{ user: context.account.user }, filter.narrow] } : { user: context.account.user };
    const cursor = context.deps.database
        .collection(CARDS)
        .find(query, { projection, maxTimeMS: MAX_TIME_MS })
        .limit(contactsOf(context).limits.maxCards + 1);
    const records = [];
    for await (const doc of cursor) {
        const record = storedRecord(doc);
        if (filter.test(record)) {
            records.push({ id: record.id, created: record.created, updated: record.updated, sort: record.sort });
        }
    }
    return records;
}

/** The ContactCard state as the anchor of query states: the sequence number written as 24 hex */
async function anchorOf(context) {
    const { seq } = await changeLogFor(context).current(context.account.user, 'ContactCard');
    return new ObjectId(seq.toString(16).padStart(24, '0'));
}

const definitionOf = args => ({ filter: args.filter === undefined ? null : args.filter, sort: args.sort === undefined ? null : args.sort });

async function query(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal']);
    requireAccount(args, context);
    const filter = compileFilter(args.filter);
    const compare = compileSort(sortArgument(args.sort));
    const paging = pagingArguments(args, context.limits.maxObjectsInGet);
    await loadBooks(context);
    const anchor = await anchorOf(context);
    const ids = await resultList(context, args, filter, compare);
    const window = windowOf(ids, paging);
    const state = queryCache.queryState(context, METHOD, anchor, definitionOf(args));
    await queryCache.store(context, state, { ids, complete: true }, { prefixed: true });
    const result = { accountId: context.account.id, queryState: state, canCalculateChanges: true, position: window.position, ids: window.ids };
    if (paging.calculateTotal) {
        result.total = ids.length;
    }
    if (paging.limitClamped) {
        result.limit = paging.limit;
    }
    return result;
}

/** ContactCard/queryChanges (RFC 8620 5.6): the cached result list of the old state against the current one */
async function queryChanges(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'sinceQueryState', 'maxChanges', 'upToId', 'calculateTotal']);
    requireAccount(args, context);
    const { maxChanges, upToId, calculateTotal } = queryChangesArguments(args);
    const filter = compileFilter(args.filter);
    const compare = compileSort(sortArgument(args.sort));
    const since = queryCache.parseQueryState(context, METHOD, args.sinceQueryState, definitionOf(args));
    const before = await queryCache.load(context, args.sinceQueryState, { prefixed: true });
    if (!before) {
        throw new MethodError('cannotCalculateChanges');
    }
    const anchor = await anchorOf(context);
    const state = queryCache.queryState(context, METHOD, anchor, definitionOf(args));
    let after = before.ids;
    if (!anchor.equals(since)) {
        after = await resultList(context, args, filter, compare);
        await queryCache.store(context, state, { ids: after, complete: true }, { prefixed: true });
    }
    const { removed, added } = queryCache.diff(before.ids, after, { upToId });
    if (removed.length + added.length > maxChanges) {
        throw new MethodError('tooManyChanges');
    }
    const result = { accountId: context.account.id, oldQueryState: args.sinceQueryState, newQueryState: state, removed, added };
    if (calculateTotal) {
        result.total = after.length;
    }
    return result;
}

module.exports = {
    capability: URN.contacts,
    methods: { 'ContactCard/query': query, 'ContactCard/queryChanges': queryChanges },
    compileFilter
};
