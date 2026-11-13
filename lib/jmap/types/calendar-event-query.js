'use strict';

// CalendarEvent/query and CalendarEvent/queryChanges (draft-ietf-jmap-calendars-33 5.8, 5.9).
//
// The structural parts of a filter (inCalendar, uid, the time range) select candidates in MongoDB, on
// the {user, ...} indexes and the stored first start and last end (with a margin of a day, which covers
// any reading of a floating event). The exact answer is computed on the candidates: ranges by
// expanding recurrences within the window, string filters on the stored search text (base event and
// overrides together; per instance when expanding). An account has at most maxEventsPerAccount events,
// which bounds every read.
//
// Without expandRecurrences the result is a list of stored event ids; its query state names the
// CalendarEvent change sequence and the query, and the list is cached for /queryChanges
// (lib/jmap/query-cache.js). With expandRecurrences every instance in the window is a result (synthetic
// ids for recurring events), bounded by maxExpandedQueryDuration and an instance cap; such a query can
// not calculate changes.

const { ObjectId } = require('mongodb');
const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments, isObject } = require('./common');
const { changeLogFor } = require('../changelog');
const { pagingArguments, sortArgument, windowOf, queryChangesArguments } = require('../query');
const queryCache = require('../query-cache');
const { loadCalendars } = require('./calendar');
const { storeFor, limitsOf } = require('./calendar-event');
const { fromDocument, searchOf } = require('../../calendar/events');
const recurrence = require('../../calendar/recurrence');
const model = require('../calendar-event-model');
const { isTimeZoneId, isLocalDateTime } = require('../../schemas/jscalendar');

const MAX_LIMIT = 1000;
const MAX_DEPTH = 10;
const MAX_CONDITIONS = 100;
// instances one expanded query may produce
const MAX_EXPANDED = 10000;
// documents whose JSCalendar text is read in one query, and the most octets of it one batch holds
const DATA_BATCH = 500;
const DATA_BATCH_BYTES = 16 * 1024 * 1024;
const DAY = 24 * 3600 * 1000;
const STRING_FILTERS = ['text', 'title', 'description', 'location', 'owner', 'participant'];
const CONDITION_KEYS = new Set(['inCalendar', 'after', 'before', 'uid', ...STRING_FILTERS]);
const SORTS = new Set(['start', 'uid', 'recurrenceId', 'created', 'updated', 'id']);

// ---------------------------------------------------------------- text matching

const wordsOf = text =>
    String(text || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);

/** A string filter value: quoted phrases and single tokens, all of them required */
function parseText(value) {
    const phrases = [];
    const rest = value.replace(/"([^"]*)"/g, (match, phrase) => {
        const words = wordsOf(phrase);
        if (words.length) {
            phrases.push(words);
        }
        return ' ';
    });
    return { phrases, tokens: wordsOf(rest) };
}

// a token matches a word, or the word with a plural ending
const wordMatches = (word, token) => word === token || word === `${token}s` || word === `${token}es`;

function textMatches(text, query) {
    const words = wordsOf(text);
    if (!query.tokens.every(token => words.some(word => wordMatches(word, token)))) {
        return false;
    }
    return query.phrases.every(phrase => words.some((word, i) => phrase.every((token, j) => words[i + j] !== undefined && wordMatches(words[i + j], token))));
}

const FIELDS = {
    text: search => [search.title, search.description, search.location, search.participant].join('\n'),
    title: search => search.title,
    description: search => search.description,
    location: search => search.location,
    owner: search => search.owner,
    participant: search => search.participant
};

// ---------------------------------------------------------------- filter

/** Checks and compiles a filter: strings parsed, times turned into epoch ms in the query zone */
function compileFilter(filter, timeZone, depth = 0, count = { value: 0 }) {
    if (++count.value > MAX_CONDITIONS || depth > MAX_DEPTH) {
        throw new MethodError('unsupportedFilter', { description: 'the filter is too complex' });
    }
    if (!isObject(filter)) {
        throw invalidArguments('a filter is an object');
    }
    if (Object.hasOwn(filter, 'operator')) {
        if (
            !['AND', 'OR', 'NOT'].includes(filter.operator) ||
            !Array.isArray(filter.conditions) ||
            Object.keys(filter).some(key => !['operator', 'conditions'].includes(key))
        ) {
            throw invalidArguments('invalid filter operator');
        }
        return { operator: filter.operator, conditions: filter.conditions.map(condition => compileFilter(condition, timeZone, depth + 1, count)) };
    }
    const condition = {};
    for (const [key, value] of Object.entries(filter)) {
        if (!CONDITION_KEYS.has(key)) {
            throw invalidArguments(`unknown filter property ${key}`);
        }
        if (key === 'after' || key === 'before') {
            if (!isLocalDateTime(value)) {
                throw invalidArguments(`${key} must be a LocalDateTime`);
            }
            condition[key] = recurrence.localToUtc(value, timeZone);
        } else if (typeof value !== 'string') {
            throw invalidArguments(`${key} must be a string`);
        } else if (key === 'inCalendar') {
            condition.inCalendar = parseId('calendar', value) || 'none';
        } else if (key === 'uid') {
            condition.uid = value;
        } else {
            condition[key] = parseText(value);
        }
    }
    return condition;
}

/** The MongoDB preselection of a compiled filter: the conditions every result must meet */
function preselect(filter) {
    const conditions =
        filter && filter.operator === 'AND' ? filter.conditions.filter(condition => !condition.operator) : filter && !filter.operator ? [filter] : [];
    const query = {};
    for (const condition of conditions) {
        if (condition.inCalendar) {
            if (condition.inCalendar === 'none') {
                return null;
            }
            query.calendarIds = condition.inCalendar;
        }
        if (condition.uid !== undefined) {
            query.uid = condition.uid;
        }
        if (condition.after !== undefined) {
            query.last = { $gt: new Date(condition.after - DAY) };
        }
        if (condition.before !== undefined) {
            query.first = { $lt: new Date(condition.before + DAY) };
        }
    }
    return query;
}

/**
 * True when the stored JSCalendar object is needed to answer the query for a document: expanding, a
 * range test of a recurring event, or a document without the stored times (written before they existed).
 */
const needsEvent = (doc, range, expand) => expand || !doc.startAt || !doc.endAt || (range && doc.recurring);

/** The UTC start and end of a stored single event from its document, a floating one read in `timeZone` */
function storedTimes(doc, timeZone) {
    const start = doc.startAt.getTime();
    const end = doc.endAt.getTime();
    if (!doc.floating) {
        return { start, end };
    }
    // the stored times read a floating event in Etc/UTC
    const shift = at => recurrence.localToUtc(recurrence.utcToLocal(at, 'Etc/UTC'), timeZone);
    return { start: shift(start), end: shift(end) };
}

/**
 * The time by which the recurrence expansions of one query must be done: each expansion is capped by
 * itself, an account of many recurring events is capped here ([jmap.calendars] maxQueryExpansionTime, ms)
 */
const expansionDeadline = context => Date.now() + limitsOf(context).maxQueryExpansionTime;

/** Refuses a query whose expansions took too long */
function checkDeadline(deadline) {
    if (deadline && Date.now() >= deadline) {
        throw new MethodError('cannotCalculateOccurrences', { description: 'the recurrences take too long to calculate' });
    }
}

/** True when some instance of a candidate overlaps (after, before) */
function inRange(candidate, condition, timeZone) {
    const from = condition.after === undefined ? null : condition.after;
    const to = condition.before === undefined ? null : condition.before;
    if (!needsEvent(candidate.doc, true)) {
        const { start, end } = storedTimes(candidate.doc, timeZone);
        return (from === null || end > from) && (to === null || start < to);
    }
    const event = candidate.entry().event;
    checkDeadline(candidate.deadline);
    try {
        // one instance answers the question; more than one is a match too
        return recurrence.expandEvent(event, { timeZone, from, to, maxInstances: 1 }).instances.length > 0;
    } catch (err) {
        if (err.code === 'cannotCalculateOccurrences') {
            return true;
        }
        throw err;
    }
}

/** Evaluates a compiled filter on a candidate (a stored event, or an instance when expanding) */
function matches(filter, candidate, timeZone) {
    if (filter.operator) {
        const results = filter.conditions.map(condition => () => matches(condition, candidate, timeZone));
        if (filter.operator === 'AND') {
            return results.every(test => test());
        }
        if (filter.operator === 'OR') {
            return results.some(test => test());
        }
        return !results.some(test => test());
    }
    if (filter.inCalendar && ![].concat(candidate.doc.calendarIds || []).some(id => filter.inCalendar !== 'none' && id.equals(filter.inCalendar))) {
        return false;
    }
    if (filter.inCalendar === 'none' || (filter.uid !== undefined && candidate.doc.uid !== filter.uid)) {
        return false;
    }
    if (filter.after !== undefined || filter.before !== undefined) {
        const ok = candidate.instance
            ? (filter.after === undefined || candidate.instance.utcEnd > filter.after) &&
              (filter.before === undefined || candidate.instance.utcStart < filter.before)
            : inRange(candidate, filter, timeZone);
        if (!ok) {
            return false;
        }
    }
    for (const key of STRING_FILTERS) {
        if (filter[key] && !textMatches(FIELDS[key](candidate.search()), filter[key])) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------- sort

function compileSort(sort) {
    if (sort === undefined || sort === null) {
        return [];
    }
    if (!Array.isArray(sort)) {
        throw invalidArguments('sort must be a list of comparators');
    }
    return sort.map(comparator => {
        if (!isObject(comparator) || typeof comparator.property !== 'string') {
            throw invalidArguments('invalid comparator');
        }
        if (!SORTS.has(comparator.property)) {
            throw new MethodError('unsupportedSort', { description: `can not sort on ${comparator.property}` });
        }
        if (comparator.isAscending !== undefined && typeof comparator.isAscending !== 'boolean') {
            throw invalidArguments('isAscending must be a boolean');
        }
        return { property: comparator.property, direction: comparator.isAscending === false ? -1 : 1 };
    });
}

const compareValues = (a, b) => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1);

/** The UTC start of the base event (the first occurrence of a recurring one, draft 5.8 leaves it open) */
function startKey(candidate, timeZone) {
    if (candidate.instance) {
        return candidate.instance.utcStart;
    }
    if (candidate.doc.startAt) {
        return storedTimes(candidate.doc, timeZone).start;
    }
    const event = candidate.entry().event;
    return recurrence.localToUtc(event.start, event.timeZone || timeZone);
}

const dateKey = value => (value ? new Date(value).getTime() : null);

function sortKey(candidate, property, timeZone) {
    const doc = candidate.doc;
    switch (property) {
        case 'start':
            return startKey(candidate, timeZone);
        case 'uid':
            return doc.uid;
        case 'recurrenceId':
            return candidate.instance ? candidate.instance.recurrenceId : doc.recurrenceId || null;
        case 'created':
            return dateKey(doc.created);
        case 'updated':
            return dateKey(doc.updated);
        default:
            return candidate.id;
    }
}

/** The compact form of a matching candidate the sort needs: its id and sort keys, not the event */
const resultOf = (candidate, comparators, timeZone) => ({
    id: candidate.id,
    keys: comparators.map(comparator => sortKey(candidate, comparator.property, timeZone))
});

function sortResults(results, comparators) {
    results.sort((a, b) => {
        for (let i = 0; i < comparators.length; i++) {
            const result = compareValues(a.keys[i], b.keys[i]) * comparators[i].direction;
            if (result) {
                return result;
            }
        }
        return compareValues(a.id, b.id);
    });
    return results;
}

// ---------------------------------------------------------------- results

/** A stored event as a result candidate; its JSCalendar object is parsed only when needed */
const candidateOf = (doc, deadline) => {
    let entry = null;
    const candidate = { id: formatId('calendarEvent', doc._id), doc, instance: null, deadline, entry: () => entry || (entry = fromDocument(doc)) };
    candidate.search = () => doc.search || searchOf(candidate.entry().event);
    return candidate;
};

/** True when a compiled filter has a range or a string condition */
function filterUses(filter, test) {
    if (!filter) {
        return false;
    }
    return filter.operator ? filter.conditions.some(condition => filterUses(condition, test)) : test(filter);
}

/** One candidate per instance in the window (synthetic ids for recurring events) */
function instancesOf(doc, window, timeZone, budget) {
    const entry = fromDocument(doc);
    const event = entry.event;
    const recurring = !!(event.recurrenceRule || event.recurrenceOverrides);
    if (recurring) {
        checkDeadline(budget.deadline);
    }
    const { instances } = recurrence.expandEvent(event, { timeZone, from: window.from, to: window.to, maxInstances: budget.left });
    budget.left -= instances.length;
    if (budget.left < 0) {
        throw new MethodError('cannotCalculateOccurrences', { description: 'the window holds too many instances' });
    }
    return instances.map(instance => {
        const values = recurring && instance.recurrenceId ? model.instanceOf(event, instance.recurrenceId) : event;
        let search = null;
        return {
            id: recurring && instance.recurrenceId ? model.instanceId(entry.id, instance.recurrenceId) : formatId('calendarEvent', entry.id),
            doc,
            entry: () => entry,
            instance,
            search: () => search || (search = searchOf(values))
        };
    });
}

/** The checked arguments both methods share */
function prepare(args, context) {
    if (args.timeZone !== undefined && args.timeZone !== null && !isTimeZoneId(args.timeZone)) {
        throw invalidArguments('unknown timeZone');
    }
    if (args.expandRecurrences !== undefined && args.expandRecurrences !== null && typeof args.expandRecurrences !== 'boolean') {
        throw invalidArguments('expandRecurrences must be a boolean');
    }
    const timeZone = args.timeZone || 'Etc/UTC';
    const filter = args.filter === undefined || args.filter === null ? null : compileFilter(args.filter, timeZone);
    const comparators = compileSort(sortArgument(args.sort));
    const expand = args.expandRecurrences === true;
    const definition = {
        filter: args.filter === undefined ? null : args.filter,
        sort: args.sort === undefined ? null : args.sort,
        timeZone,
        expandRecurrences: expand
    };
    let window = null;
    if (expand) {
        // draft 5.8: a FilterCondition with both after and before
        if (!filter || filter.operator || filter.after === undefined || filter.before === undefined) {
            throw invalidArguments('expandRecurrences needs a filter with after and before');
        }
        const { days, seconds } = recurrence.parseDuration(limitsOf(context).maxExpandedQueryDuration);
        if (filter.before - filter.after > (days * 86400 + seconds) * 1000) {
            throw new MethodError('expandDurationTooLarge');
        }
        window = { from: filter.after, to: filter.before };
    }
    return { timeZone, filter, comparators, expand, window, definition };
}

/**
 * Marks the documents whose JSCalendar text is needed (`doc.needsData`) and refuses a query whose
 * candidates need more stored JSCalendar text than [jmap.calendars] maxQueryEventBytes: reading and
 * parsing it would block the worker, however it is batched
 */
function markNeeded(docs, range, expand, limits) {
    let bytes = 0;
    for (const doc of docs) {
        doc.needsData = needsEvent(doc, range, expand);
        bytes += doc.needsData ? doc.size || 0 : 0;
    }
    if (bytes > limits.maxQueryEventBytes) {
        throw new MethodError('cannotCalculateOccurrences', { description: 'the events of this query are too large to calculate, narrow the filter' });
    }
}

/** Splits documents into batches of at most DATA_BATCH documents and DATA_BATCH_BYTES of data to read */
function* batchesOf(docs) {
    let batch = [];
    let bytes = 0;
    for (const doc of docs) {
        const size = doc.needsData ? doc.size || 0 : 0;
        if (batch.length && (batch.length >= DATA_BATCH || bytes + size > DATA_BATCH_BYTES)) {
            yield batch;
            batch = [];
            bytes = 0;
        }
        batch.push(doc);
        bytes += size;
    }
    if (batch.length) {
        yield batch;
    }
}

/** Reads the JSCalendar text of the documents of a batch that need it */
async function loadData(store, user, docs) {
    if (!docs.length) {
        return;
    }
    const found = await store.find(user, { _id: { $in: docs.map(doc => doc._id) } }, { projection: { data: true } });
    const data = new Map(found.map(doc => [doc._id.toString(), doc.data]));
    docs.forEach(doc => (doc.data = data.get(doc._id.toString())));
}

/** The candidates of one stored event: its instances in the window when expanding, else the event */
function candidatesOf(doc, plan, budget) {
    if (!plan.expand) {
        return [candidateOf(doc, budget.deadline)];
    }
    try {
        return instancesOf(doc, plan.window, plan.timeZone, budget);
    } catch (err) {
        if (err.code === 'cannotCalculateOccurrences' && !(err instanceof MethodError)) {
            throw new MethodError('cannotCalculateOccurrences', { description: err.message });
        }
        throw err;
    }
}

/**
 * The ids of the whole result list. The stored events are evaluated a batch at a time: only the id and
 * the sort keys of a match are kept, the JSCalendar text of a batch is dropped before the next is read.
 */
async function resultList(context, plan) {
    const limits = limitsOf(context);
    const query = plan.filter ? preselect(plan.filter) : {};
    if (query === null) {
        return [];
    }
    const store = storeFor(context);
    const user = context.account.user;
    const text = filterUses(plan.filter, condition => STRING_FILTERS.some(key => condition[key]));
    const range = filterUses(plan.filter, condition => condition.after !== undefined || condition.before !== undefined);
    // the JSCalendar text and the search text are read only for the documents that need them
    const projection = Object.assign({ data: false }, text ? {} : { search: false });
    const docs = await store.find(user, query, { projection, limit: limits.maxEventsPerAccount + 1 });
    markNeeded(docs, range, plan.expand, limits);

    // the instance cap of an expanding query and the time all expansions may take
    const budget = { left: MAX_EXPANDED, deadline: expansionDeadline(context) };
    const results = [];
    for (const batch of batchesOf(docs)) {
        const reading = Date.now();
        await loadData(
            store,
            user,
            batch.filter(doc => doc.needsData)
        );
        // the deadline is for calculating, reading the data does not count
        budget.deadline += Date.now() - reading;
        for (const doc of batch) {
            for (const candidate of candidatesOf(doc, plan, budget)) {
                if (!plan.filter || matches(plan.filter, candidate, plan.timeZone)) {
                    results.push(resultOf(candidate, plan.comparators, plan.timeZone));
                }
            }
            doc.data = undefined;
        }
    }
    return sortResults(results, plan.comparators).map(result => result.id);
}

/** The anchor of a query state: the CalendarEvent change sequence as 24 hex */
async function anchorOf(context) {
    const current = await changeLogFor(context).current(context.account.user, 'CalendarEvent');
    return new ObjectId(
        Number(current.seq || 0)
            .toString(16)
            .padStart(24, '0')
    );
}

const hexOf = id => id.slice(1);

async function query(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal', 'expandRecurrences', 'timeZone']);
    requireAccount(args, context);
    const plan = prepare(args, context);
    const paging = pagingArguments(args, MAX_LIMIT);
    await loadCalendars(context);
    const anchor = await anchorOf(context);
    const ids = await resultList(context, plan);
    const window = windowOf(ids, paging);
    const state = queryCache.queryState(context, 'CalendarEvent/query', anchor, plan.definition);
    if (!plan.expand) {
        await queryCache.store(context, state, { ids: ids.map(hexOf), complete: true });
    }
    const result = { accountId: context.account.id, queryState: state, canCalculateChanges: !plan.expand, position: window.position, ids: window.ids };
    if (paging.calculateTotal) {
        result.total = ids.length;
    }
    if (paging.limitClamped) {
        result.limit = paging.limit;
    }
    return result;
}

async function queryChanges(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'sinceQueryState', 'maxChanges', 'upToId', 'calculateTotal', 'timeZone', 'expandRecurrences']);
    requireAccount(args, context);
    const { maxChanges, upToId, calculateTotal } = queryChangesArguments(args);
    const plan = prepare(args, context);
    const since = queryCache.parseQueryState(context, 'CalendarEvent/query', args.sinceQueryState, plan.definition);
    const before = plan.expand ? null : await queryCache.load(context, args.sinceQueryState);
    if (!before) {
        throw new MethodError('cannotCalculateChanges');
    }
    const anchor = await anchorOf(context);
    const state = queryCache.queryState(context, 'CalendarEvent/query', anchor, plan.definition);
    let after = before.ids;
    if (!anchor.equals(since)) {
        after = (await resultList(context, plan)).map(hexOf);
        await queryCache.store(context, state, { ids: after, complete: true });
    }
    const upTo = upToId ? parseId('calendarEvent', upToId) : null;
    const { removed, added } = queryCache.diff(before.ids, after, { upToId: upTo ? upTo.toString() : null });
    if (removed.length + added.length > maxChanges) {
        throw new MethodError('tooManyChanges');
    }
    const result = {
        accountId: context.account.id,
        oldQueryState: args.sinceQueryState,
        newQueryState: state,
        removed: removed.map(hex => formatId('calendarEvent', hex)),
        added: added.map(item => ({ id: formatId('calendarEvent', item.id), index: item.index }))
    };
    if (calculateTotal) {
        result.total = after.length;
    }
    return result;
}

module.exports = {
    capability: URN.calendars,
    methods: { 'CalendarEvent/query': query, 'CalendarEvent/queryChanges': queryChanges },
    parseText,
    textMatches,
    MAX_EXPANDED
};
