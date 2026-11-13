'use strict';

// The CalendarEvent object (draft-ietf-jmap-calendars-33 5) over a stored JSCalendar Event: synthetic
// instance ids, the instance view of a recurring event, override patches, validation for storing,
// and the server set values (utcStart and utcEnd, isOrigin, sequence, updated).
//
// A stored event keeps the JSCalendar object and the JMAP properties that belong to it (isDraft,
// useDefaultAlerts, mayInviteSelf, mayInviteOthers, hideAttendees); id, calendarIds, isOrigin,
// baseEventId, utcStart and utcEnd are added when it is read.

const recurrence = require('../calendar/recurrence');
const { formatId, parseId } = require('./ids');
const { isObject, setOwn } = require('./types/common');
const { formatUTCDate, parseUTCDate } = require('./utcdate');
const { validateEvent, isLocalDateTime, isVendorValue, validateAlert } = require('../schemas/jscalendar');

// ---------------------------------------------------------------- ids

const INSTANCE_ID = /^V([0-9a-f]{24})_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;

/** The id of an instance of a recurring event: the base id, "_" and the recurrence id without separators */
const instanceId = (baseId, recurrenceId) => `${formatId('calendarEvent', baseId)}_${recurrenceId.replace(/[-:]/g, '')}`;

/**
 * An event id: a stored event {id} or an instance {id, recurrenceId}, null when it is neither.
 *
 * @returns {{id: ObjectId, recurrenceId: String|null}|null}
 */
function parseEventId(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const match = INSTANCE_ID.exec(value);
    if (match) {
        const recurrenceId = `${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}`;
        const id = parseId('calendarEvent', `V${match[1]}`);
        return id && isLocalDateTime(recurrenceId) ? { id, recurrenceId } : null;
    }
    const id = parseId('calendarEvent', value);
    return id ? { id, recurrenceId: null } : null;
}

// ---------------------------------------------------------------- properties

// properties the server computes or derives when an event is read
const COMPUTED = ['id', 'calendarIds', 'isOrigin', 'baseEventId', 'utcStart', 'utcEnd'];
// properties defined for a CalendarEvent (JSCalendar bis plus JMAP Calendars 5); others need a vendor prefix
const KNOWN = new Set([
    '@type',
    'uid',
    'version',
    'relatedTo',
    'prodId',
    'created',
    'updated',
    'sequence',
    'method',
    'title',
    'description',
    'descriptionContentType',
    'showWithoutTime',
    'locations',
    'mainLocationId',
    'virtualLocations',
    'links',
    'locale',
    'keywords',
    'categories',
    'color',
    'recurrenceId',
    'recurrenceIdTimeZone',
    'recurrenceRule',
    'recurrenceOverrides',
    'priority',
    'freeBusyStatus',
    'privacy',
    'organizerCalendarAddress',
    'sentBy',
    'participants',
    'alerts',
    'timeZone',
    'start',
    'duration',
    'endTimeZone',
    'status',
    'isDraft',
    'useDefaultAlerts',
    'mayInviteSelf',
    'mayInviteOthers',
    'hideAttendees',
    ...COMPUTED
]);
// per user properties (draft 5): a change of these does not change the event for other participants
const PER_USER = new Set(['keywords', 'color', 'freeBusyStatus', 'useDefaultAlerts', 'alerts']);
// not part of what the sequence follows
const NOT_SHARED = new Set([...PER_USER, 'calendarIds', 'isDraft', 'updated', 'sequence', 'created', ...COMPUTED]);
// override pointers RFC 8984 4.3.5 tells the server to ignore; the stored override drops them
const OVERRIDE_IGNORED = new Set([
    '@type',
    'excludedRecurrenceRules',
    'method',
    'privacy',
    'prodId',
    'recurrenceId',
    'recurrenceIdTimeZone',
    'recurrenceOverrides',
    'recurrenceRule',
    'recurrenceRules',
    'relatedTo',
    'replyTo',
    'sentBy',
    'timeZones',
    'uid'
]);
// override pointers the draft forbids (5, 5.1): rejected
const OVERRIDE_REJECTED = new Set([
    'isDraft',
    'utcStart',
    'utcEnd',
    'mayInviteSelf',
    'mayInviteOthers',
    'hideAttendees',
    'id',
    'baseEventId',
    'calendarIds',
    'isOrigin'
]);
// what an instance can not change: the property names an instance update may not touch
const INSTANCE_FIXED = ['recurrenceRule', 'recurrenceOverrides', 'uid', 'privacy', 'isDraft', 'calendarIds', 'id', 'baseEventId', 'recurrenceId', 'isOrigin'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const escapeToken = token => token.replace(/~/g, '~0').replace(/\//g, '~1');
const decodeToken = token => token.replace(/~1/g, '/').replace(/~0/g, '~');

/** The current time as a UTCDateTime without fraction */
const nowUTC = (now = Date.now()) => formatUTCDate(now, { seconds: true });

// ---------------------------------------------------------------- override patches

/**
 * Applies an override patch to an instance object, leniently: a pointer whose parent is missing is
 * skipped (the draft lets such a pointer do nothing).
 */
function applyOverride(object, patch) {
    const result = clone(object);
    for (const [key, value] of Object.entries(patch || {})) {
        if (key === 'excluded') {
            continue;
        }
        const tokens = key.split('/').map(decodeToken);
        let container = result;
        let ok = true;
        for (const token of tokens.slice(0, -1)) {
            if (!isObject(container[token])) {
                ok = false;
                break;
            }
            container = container[token];
        }
        if (!ok) {
            continue;
        }
        const last = tokens[tokens.length - 1];
        if (value === null) {
            delete container[last];
        } else {
            setOwn(container, last, clone(value));
        }
    }
    return result;
}

/** A minimal patch from `base` to `target`: changed leaves by pointer, removed keys as null */
function diffPatch(base, target, prefix = '', out = {}) {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(target || {})]);
    for (const key of keys) {
        const path = prefix ? `${prefix}/${escapeToken(key)}` : escapeToken(key);
        if (!Object.hasOwn(target, key)) {
            out[path] = null;
        } else if (!Object.hasOwn(base, key)) {
            out[path] = clone(target[key]);
        } else if (isObject(base[key]) && isObject(target[key])) {
            diffPatch(base[key], target[key], path, out);
        } else if (!same(base[key], target[key])) {
            out[path] = clone(target[key]);
        }
    }
    return out;
}

/** The override patch without the pointers RFC 8984 4.3.5 says to ignore */
function stripIgnored(patch) {
    if (!isObject(patch) || Object.hasOwn(patch, 'excluded')) {
        return patch;
    }
    return Object.fromEntries(Object.entries(patch).filter(([key]) => !OVERRIDE_IGNORED.has(decodeToken(key.split('/')[0]))));
}

// ---------------------------------------------------------------- instances

/** The base event as it applies to one occurrence before its override: no rule, start at the recurrence id */
function occurrenceBase(event, recurrenceId) {
    const base = clone(event);
    delete base.recurrenceRule;
    delete base.recurrenceOverrides;
    base.start = recurrenceId;
    return base;
}

/**
 * The instance of a recurring event at a recurrence id, as stored JSCalendar values (override applied),
 * with recurrenceId and recurrenceIdTimeZone set.
 */
function instanceOf(event, recurrenceId) {
    const patch = (event.recurrenceOverrides || {})[recurrenceId];
    const instance = applyOverride(occurrenceBase(event, recurrenceId), patch);
    instance.recurrenceId = recurrenceId;
    instance.recurrenceIdTimeZone = event.timeZone || null;
    return instance;
}

/** 'rule', 'added', 'excluded' or null: whether a recurrence id names an instance of the event */
function occurrenceOf(event, recurrenceId) {
    if (!event.recurrenceRule && !event.recurrenceOverrides) {
        return null;
    }
    try {
        return recurrence.occurrenceKind(event, recurrenceId, {});
    } catch (err) {
        if (err.code === 'cannotCalculateOccurrences') {
            return null;
        }
        throw err;
    }
}

// ---------------------------------------------------------------- reading

/** The UTC start and end of an event object, a floating one read in `timeZone` */
function utcTimes(event, timeZone) {
    const zone = event.timeZone || timeZone || 'Etc/UTC';
    const start = recurrence.localToUtc(event.start, zone);
    const end = recurrence.addDuration(event.start, event.duration || 'PT0S', zone);
    return { utcStart: formatUTCDate(start, { seconds: true }), utcEnd: formatUTCDate(end, { seconds: true }) };
}

const mailtoAddress = uri => {
    const match = /^mailto:(.+)$/i.exec(typeof uri === 'string' ? uri : '');
    if (!match) {
        return null;
    }
    try {
        return decodeURIComponent(match[1]).trim().toLowerCase();
    } catch {
        return match[1].trim().toLowerCase();
    }
};

/** True when a calendar address is one of the user's addresses (a Set of lower case addresses) */
const isOwnAddress = (uri, addresses) => {
    const address = mailtoAddress(uri);
    return !!address && addresses.has(address);
};

/** isOrigin (draft 5): no organizer, or the organizer is one of the user's addresses */
const isOriginOf = (event, addresses) => !event.organizerCalendarAddress || isOwnAddress(event.organizerCalendarAddress, addresses);

/** reduceParticipants (draft 5.7): owners and the user's own participants, also in the overrides */
function reduceParticipants(object, addresses) {
    const keep = id => {
        const participant = object.participants[id];
        return !!participant && ((participant.roles && participant.roles.owner) || isOwnAddress(participant.calendarAddress, addresses));
    };
    if (isObject(object.participants)) {
        const removed = Object.keys(object.participants).filter(id => !keep(id));
        removed.forEach(id => delete object.participants[id]);
        if (isObject(object.recurrenceOverrides)) {
            for (const patch of Object.values(object.recurrenceOverrides)) {
                for (const key of Object.keys(patch || {})) {
                    const tokens = key.split('/').map(decodeToken);
                    if (tokens[0] === 'participants' && tokens.length > 1 && removed.includes(tokens[1])) {
                        delete patch[key];
                    }
                }
            }
        }
    }
    return object;
}

// ---------------------------------------------------------------- validation

/**
 * The problems of an event to store, as JSON pointer paths: the JSCalendar rules, the properties a
 * CalendarEvent knows, the date range of the account and the override rules of the draft.
 *
 * @param {Object} event
 * @param {Object} limits calendar limits (minDateTime, maxDateTime, maxParticipantsPerEvent)
 * @returns {String[]} paths, top level properties by name
 */
function problemsOf(event, limits) {
    const problems = [];
    for (const key of Object.keys(event)) {
        if (!KNOWN.has(key) && !isVendorValue(key)) {
            problems.push(escapeToken(key));
        }
    }
    const result = validateEvent(event, { stored: true });
    problems.push(...result.problems.map(problem => problem.path));
    if (event['@type'] !== 'Event') {
        problems.push('@type');
    }
    if (event.version !== '2.0') {
        problems.push('version');
    }
    if (!Object.hasOwn(event, 'start')) {
        problems.push('start');
    }
    if (Object.hasOwn(event, 'recurrenceId') && !Object.hasOwn(event, 'recurrenceIdTimeZone')) {
        problems.push('recurrenceIdTimeZone');
    }
    if (Object.hasOwn(event, 'recurrenceId') && Object.hasOwn(event, 'recurrenceRule')) {
        problems.push('recurrenceRule');
    }
    const rule = event.recurrenceRule;
    if (isObject(rule) && Object.hasOwn(rule, 'rscale') && rule.rscale !== 'gregorian') {
        // only the Gregorian calendar can be expanded
        problems.push('recurrenceRule/rscale');
    }
    problems.push(...rangeProblems(event, limits));
    problems.push(...overridePatchProblems(event, limits));
    if (isObject(event.participants) && Object.keys(event.participants).length > limits.maxParticipantsPerEvent) {
        problems.push('participants');
    }
    return withoutAncestors(problems);
}

/**
 * Unique paths, leaving out a path when a deeper path below it says more (an alert whose offset is
 * invalid). Linear: every proper ancestor prefix goes into one Set.
 *
 * @param {String[]} paths
 * @returns {String[]}
 */
function withoutAncestors(paths) {
    const ancestors = new Set();
    for (const path of paths) {
        for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
            ancestors.add(path.slice(0, i));
        }
    }
    return [...new Set(paths)].filter(path => !ancestors.has(path));
}

/** Dates outside minDateTime and maxDateTime (start, until, override keys, absolute triggers, created) */
function rangeProblems(event, limits) {
    const min = Date.parse(limits.minDateTime);
    const max = Date.parse(limits.maxDateTime);
    const outside = ms => !(ms >= min && ms <= max);
    const local = value => isLocalDateTime(value) && outside(Date.parse(`${value}Z`));
    const utc = value => typeof value === 'string' && !!parseUTCDate(value) && outside(Date.parse(value));
    const problems = [];
    if (local(event.start)) {
        problems.push('start');
    }
    if (isObject(event.recurrenceRule) && local(event.recurrenceRule.until)) {
        problems.push('recurrenceRule/until');
    }
    for (const key of Object.keys(event.recurrenceOverrides || {})) {
        if (local(key)) {
            problems.push(`recurrenceOverrides/${key}`);
        }
    }
    for (const [id, alert] of Object.entries(isObject(event.alerts) ? event.alerts : {})) {
        if (isObject(alert) && isObject(alert.trigger) && utc(alert.trigger.when)) {
            problems.push(`alerts/${escapeToken(id)}/trigger/when`);
        }
    }
    if (utc(event.created)) {
        problems.push('created');
    }
    return problems;
}

/** The problems of each override: pointers the draft forbids, and the patched instance as an event */
function overridePatchProblems(event, limits) {
    if (!isObject(event.recurrenceOverrides)) {
        return [];
    }
    const problems = [];
    const base = Object.assign({}, event);
    delete base.recurrenceRule;
    delete base.recurrenceOverrides;
    const baseCount = isObject(event.participants) ? Object.keys(event.participants).length : 0;
    // a problem of the base event is reported for the base event, not again for each override
    const baseProblems = new Set(validateEvent(base, { stored: true }).problems.map(problem => problem.path));
    for (const [key, patch] of Object.entries(event.recurrenceOverrides)) {
        const path = `recurrenceOverrides/${key}`;
        if (!isObject(patch) || Object.hasOwn(patch, 'excluded')) {
            continue;
        }
        if (Object.keys(patch).some(pointer => OVERRIDE_REJECTED.has(decodeToken(pointer.split('/')[0])))) {
            problems.push(path);
            continue;
        }
        const instance = applyOverride(Object.assign({}, base, { start: key }), patch);
        for (const problem of validateEvent(instance, { stored: true }).problems) {
            if (!baseProblems.has(problem.path)) {
                problems.push(`${path}/${problem.path}`);
            }
        }
        const added = isObject(instance.participants) ? Object.keys(instance.participants).length : 0;
        if (added > Math.max(baseCount, limits.maxParticipantsPerEvent)) {
            problems.push(`${path}/participants`);
        }
    }
    return problems;
}

/** True when the change from `before` to `after` touches a property shared with other participants */
function sharedChange(before, after) {
    const strip = event => {
        const copy = Object.fromEntries(Object.entries(event || {}).filter(([key]) => !NOT_SHARED.has(key)));
        if (isObject(copy.recurrenceOverrides)) {
            copy.recurrenceOverrides = Object.fromEntries(
                Object.entries(copy.recurrenceOverrides).map(([key, patch]) => [
                    key,
                    isObject(patch) ? Object.fromEntries(Object.entries(patch).filter(([pointer]) => !PER_USER.has(decodeToken(pointer.split('/')[0])))) : patch
                ])
            );
        }
        return copy;
    };
    return !same(strip(before), strip(after));
}

module.exports = {
    instanceId,
    parseEventId,
    applyOverride,
    diffPatch,
    stripIgnored,
    occurrenceBase,
    instanceOf,
    occurrenceOf,
    utcTimes,
    mailtoAddress,
    isOwnAddress,
    isOriginOf,
    reduceParticipants,
    problemsOf,
    withoutAncestors,
    sharedChange,
    validateAlert,
    nowUTC,
    same,
    clone,
    escapeToken,
    decodeToken,
    COMPUTED,
    KNOWN,
    PER_USER,
    INSTANCE_FIXED,
    OVERRIDE_REJECTED
};
