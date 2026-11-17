'use strict';

// Recurrence engine for JSCalendar events (RFC 8984 4.3.3, draft-ietf-calext-jscalendarbis-22 3.3.3).
//
// The rule arithmetic comes from rrule-temporal, used only here and only on floating local
// date-times: the library is always given the 'UTC' zone with the local wall clock time written as
// if it were UTC, so it never makes a DST decision. This module converts local times to instants
// itself with Intl (RFC 8984 1.4.5: a time in a gap uses the offset before the transition, a
// repeated time the earlier instant), adds the event start as the first counted occurrence, applies
// recurrenceOverrides and bounds the work with caps (docs/jmap/recurrence-options.md).
//
// Times are handled as "wall milliseconds": the local date-time read as UTC, so plain arithmetic
// works on them without any zone.

const { RRuleTemporal } = require('rrule-temporal');

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/**
 * Default caps. maxInstances is the largest number of instances one expansion may return.
 * maxIterations goes to the library (recurrence periods it may advance), bounds the occurrences this
 * module walks through before a window (a rule with count walks from its start), the number of
 * library calls per expansion (maxIterations / 10) and, doubled, the library candidate evaluations.
 * The library takes about 10 microseconds an occurrence, so a walk that fails stops at about 50 ms.
 * An expansion that must fail is refused before any walk where that is known: a window certain to
 * hold more than maxInstances instances (minOccurrences), a walk to the window certain to pass more
 * than maxIterations occurrences, and a set position over more than MAX_SET_CANDIDATES candidates.
 */
const DEFAULT_LIMITS = Object.freeze({ maxInstances: 10000, maxIterations: 5000 });
// the time slots a set position may select from in one day, or in one period when that is shorter
// (a day of minutes is 1440); the library builds them all for every period
const MAX_SET_CANDIDATES = 10000;
// the candidates the chunks of one expansion evaluate, in all
const MAX_CHUNK_WORK = 1000000;

class RecurrenceLimitError extends Error {
    constructor(message) {
        super(message || 'Too many occurrences to calculate');
        this.name = 'RecurrenceLimitError';
        this.code = 'cannotCalculateOccurrences';
    }
}

// ---------------------------------------------------------------- local date-times

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

function wallMs(year, month, day, hour, minute, second) {
    const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
    date.setUTCFullYear(date.getUTCFullYear() - 2000 + year);
    return date.getTime();
}

/** 'YYYY-MM-DDTHH:MM:SS' to wall milliseconds */
function parseLocal(local) {
    const match = typeof local === 'string' && LOCAL_RE.exec(local);
    if (!match) {
        throw new TypeError(`Invalid LocalDateTime: ${local}`);
    }
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    return wallMs(year, month, day, hour, minute, second);
}

/** Wall milliseconds to 'YYYY-MM-DDTHH:MM:SS' */
function formatLocal(ms) {
    const date = new Date(Math.floor(ms / 1000) * 1000);
    const year = date.getUTCFullYear();
    if (year < 0 || year > 9999) {
        throw new RangeError('Date out of range');
    }
    const iso = date.toISOString();
    return iso.slice(0, 19);
}

// ---------------------------------------------------------------- time zones

const UTC_ZONES = new Set(['Etc/UTC', 'UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Etc/Zulu', 'Universal', 'Zulu']);
const formatters = new Map();
const FORMATTER_CACHE_SIZE = 500;

function formatterFor(timeZone) {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            era: 'short',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric'
        });
        if (formatters.size >= FORMATTER_CACHE_SIZE) {
            formatters.clear();
        }
        formatters.set(timeZone, formatter);
    }
    return formatter;
}

const isUtcZone = timeZone => !timeZone || UTC_ZONES.has(timeZone);

/** UTC offset (milliseconds, positive east of Greenwich) of a zone at an instant, whole seconds */
function zoneOffset(ms, timeZone) {
    if (isUtcZone(timeZone)) {
        return 0;
    }
    const instant = Math.floor(ms / 1000) * 1000;
    const fields = {};
    for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
        fields[part.type] = part.value;
    }
    let year = Number(fields.year);
    if (fields.era === 'BC' || fields.era === 'B') {
        year = 1 - year;
    }
    const wall = wallMs(year, Number(fields.month), Number(fields.day), Number(fields.hour) % 24, Number(fields.minute), Number(fields.second));
    return wall - instant;
}

/**
 * Wall milliseconds to an instant (RFC 8984 1.4.5): a time in a gap uses the offset in effect
 * before the transition, a repeated time takes the earlier instant.
 */
function wallToUtc(wall, timeZone) {
    if (isUtcZone(timeZone)) {
        return wall;
    }
    const before = zoneOffset(wall - DAY_MS, timeZone);
    const after = zoneOffset(wall + DAY_MS, timeZone);
    const valid = [];
    for (const offset of before === after ? [before] : [before, after]) {
        const candidate = wall - offset;
        if (zoneOffset(candidate, timeZone) === offset) {
            valid.push(candidate);
        }
    }
    if (valid.length) {
        return Math.min(...valid);
    }
    // in a gap: the offset before the transition, which puts the instant after it
    return wall - before;
}

/** LocalDateTime in a zone (null or absent: Etc/UTC) to epoch milliseconds */
function localToUtc(local, timeZone) {
    return wallToUtc(parseLocal(local), timeZone || 'Etc/UTC');
}

/** Epoch milliseconds to the LocalDateTime in a zone (null or absent: Etc/UTC), seconds precision */
function utcToLocal(ms, timeZone) {
    const instant = Math.floor(ms / 1000) * 1000;
    return formatLocal(instant + zoneOffset(instant, timeZone || 'Etc/UTC'));
}

/** Smallest and largest offset of a zone seen at the given instants */
function offsetRange(instants, timeZone) {
    if (isUtcZone(timeZone)) {
        return { min: 0, max: 0 };
    }
    const offsets = instants.map(ms => zoneOffset(ms, timeZone));
    return { min: Math.min(...offsets), max: Math.max(...offsets) };
}

// ---------------------------------------------------------------- durations

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Duration or SignedDuration to { days, seconds }. Weeks are folded into days (nominal), hours,
 * minutes and seconds into seconds (exact). A leading '-' makes both negative.
 */
function parseDuration(value) {
    const match = typeof value === 'string' && DURATION_RE.exec(value);
    if (!match || value.endsWith('T')) {
        throw new TypeError(`Invalid duration: ${value}`);
    }
    const num = index => Number(match[index] || 0);
    const sign = match[1] === '-' ? -1 : 1;
    const days = num(2) * 7 + num(3);
    const seconds = num(4) * 3600 + num(5) * 60 + num(6);
    // no negative zero
    return { days: days ? sign * days : 0, seconds: seconds ? sign * seconds : 0 };
}

/** A non negative number of seconds as the shortest Duration: 'PT0S', 'PT1H30M', 'P1DT2H' */
function formatDuration(totalSeconds) {
    if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
        throw new TypeError(`Invalid number of seconds: ${totalSeconds}`);
    }
    let rest = Math.round(totalSeconds);
    const days = Math.floor(rest / 86400);
    rest -= days * 86400;
    const hours = Math.floor(rest / 3600);
    rest -= hours * 3600;
    const minutes = Math.floor(rest / 60);
    const seconds = rest - minutes * 60;
    let time = '';
    if (hours) {
        time += `${hours}H`;
    }
    if (minutes) {
        time += `${minutes}M`;
    }
    if (seconds) {
        time += `${seconds}S`;
    }
    if (!days && !time) {
        return 'PT0S';
    }
    return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

const toDuration = duration => (typeof duration === 'string' ? parseDuration(duration) : { days: duration.days || 0, seconds: duration.seconds || 0 });

function addDurationWall(wall, duration, timeZone) {
    return wallToUtc(wall + duration.days * DAY_MS, timeZone) + duration.seconds * 1000;
}

/**
 * Epoch milliseconds of a local start plus a duration (string or { days, seconds }): days are
 * nominal (added to the local date-time, then converted), seconds exact (added to the instant).
 */
function addDuration(local, duration, timeZone) {
    return addDurationWall(parseLocal(local), toDuration(duration), timeZone || 'Etc/UTC');
}

/** An upper bound of the elapsed milliseconds of a duration, for window margins */
function durationUpperMs(duration) {
    const days = Math.max(duration.days, 0);
    return days * DAY_MS + (days ? DAY_MS + 2 * HOUR_MS : 0) + Math.max(duration.seconds, 0) * 1000;
}

// ---------------------------------------------------------------- rule preparation

const own = (object, key) => !!object && Object.prototype.hasOwnProperty.call(object, key);
const nonEmpty = value => Array.isArray(value) && value.length > 0;

function resolveLimits(options) {
    const pick = (key, fallback) => {
        const value = options && options[key];
        return Number.isInteger(value) && value > 0 ? value : fallback;
    };
    return { maxInstances: pick('maxInstances', DEFAULT_LIMITS.maxInstances), maxIterations: pick('maxIterations', DEFAULT_LIMITS.maxIterations) };
}

// the library builds its public values with this "Temporal": occurrences come back as strings
const STRING_TEMPORAL = { ZonedDateTime: { from: value => value } };
const asZoned = local => ({ timeZoneId: 'UTC', toString: () => `${local}+00:00[UTC]` });

/** Upper bound of the occurrences one local day can hold */
function dailyDensity(parts) {
    const count = (values, otherwise) => (nonEmpty(values) ? new Set(values).size : otherwise);
    return count(parts.byHour, 24) * count(parts.byMinute, 60) * count(parts.bySecond, 60);
}

const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];

// the longest length of one period of each frequency
const PERIOD_MS = { secondly: 1000, minutely: 60 * 1000, hourly: HOUR_MS, daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 31 * DAY_MS, yearly: 366 * DAY_MS };

/** The longest length of one period of a rule (its interval included) */
const periodMs = rule => (PERIOD_MS[rule.frequency] || DAY_MS) * (Number.isInteger(rule.interval) && rule.interval > 0 ? rule.interval : 1);

const DATE_PARTS = ['byMonth', 'byWeekNo', 'byYearDay', 'byMonthDay', 'byDay', 'bySetPosition'];

/**
 * A lower bound of the occurrences of a rule in the wall interval [a, b] (b null: no end), not
 * counting the end of the rule (count, until). Only a secondly to daily rule with interval 1 and no
 * date parts has one, as any combination of its time parts is an occurrence: any 24 hours hold
 * exactly its density, and when the time parts are full (every second, minute or hour) any period
 * holds one. 0 for every other rule.
 */
function minOccurrences(prepared, a, b) {
    const rule = prepared.rule;
    const simple =
        !prepared.onlyStart &&
        ['secondly', 'minutely', 'hourly', 'daily'].includes(rule.frequency) &&
        !(rule.interval > 1) &&
        !rule.skip &&
        !DATE_PARTS.some(key => nonEmpty(rule[key]));
    if (!simple) {
        return 0;
    }
    if (b === null) {
        return Infinity;
    }
    const period = periodMs(rule);
    const span = Math.max(0, b - a);
    return prepared.density * period === DAY_MS ? Math.floor(span / period) : Math.floor(span / DAY_MS) * prepared.density;
}

/**
 * The rule with the implicit parts of RFC 8984 4.3.3.1 step 1 made explicit. The library follows
 * RFC 5545, which leaves some of them open (a yearly rule with only byMonthDay runs every month
 * there, in JSCalendar only in the start month), so it gets them spelled out.
 */
function explicitParts(rule, startWall) {
    const parts = {};
    for (const key of ['byMonth', 'byWeekNo', 'byYearDay', 'byMonthDay', 'byDay', 'byHour', 'byMinute', 'bySecond', 'bySetPosition']) {
        if (nonEmpty(rule[key])) {
            parts[key] = rule[key].slice();
        }
    }
    const start = new Date(startWall);
    const frequency = rule.frequency;
    const startDay = { day: WEEKDAYS[(start.getUTCDay() + 6) % 7] };
    if (!parts.bySecond && frequency !== 'secondly') {
        parts.bySecond = [start.getUTCSeconds()];
    }
    if (!parts.byMinute && frequency !== 'secondly' && frequency !== 'minutely') {
        parts.byMinute = [start.getUTCMinutes()];
    }
    if (!parts.byHour && !['secondly', 'minutely', 'hourly'].includes(frequency)) {
        parts.byHour = [start.getUTCHours()];
    }
    if (frequency === 'weekly' && !parts.byDay) {
        parts.byDay = [startDay];
    }
    // a monthly rule keeps its implicit day: the library applies skip to it, but not to an explicit
    // byMonthDay of a monthly rule
    if (frequency === 'yearly' && !parts.byYearDay) {
        const byMonthDay = parts.byMonthDay;
        if (!parts.byMonth && !parts.byWeekNo && (byMonthDay || !parts.byDay)) {
            parts.byMonth = [String(start.getUTCMonth() + 1)];
        }
        if (!byMonthDay && !parts.byWeekNo && !parts.byDay) {
            parts.byMonthDay = [start.getUTCDate()];
        }
        if (parts.byWeekNo && !byMonthDay && !parts.byDay) {
            parts.byDay = [startDay];
        }
    }
    // the leap second 60 never appears in a LocalDateTime
    if (parts.bySecond) {
        parts.bySecond = parts.bySecond.filter(second => second < 60);
    }
    return parts;
}

/**
 * Builds the library rule for an event, or marks the rule as generating nothing beyond the start
 * (count 0, until before the start, or bySecond holding only the leap second 60).
 */
function prepareRule(event, limits) {
    const rule = event.recurrenceRule;
    const startWall = parseLocal(event.start);
    const parts = explicitParts(rule, startWall);
    if (nonEmpty(parts.bySetPosition) && dailyDensity(parts) * Math.min(1, PERIOD_MS[rule.frequency] / DAY_MS) > MAX_SET_CANDIDATES) {
        // the library evaluates every candidate of a period before it selects by position
        throw new RecurrenceLimitError('Too many candidates for a set position');
    }
    const prepared = {
        rule,
        startWall,
        startLocal: event.start,
        limits,
        untilWall: null,
        onlyStart: false,
        addStart: false,
        density: dailyDensity(parts)
    };

    if (typeof rule.until === 'string' && !own(rule, 'count')) {
        prepared.untilWall = parseLocal(rule.until);
    }
    const untilBeforeStart = prepared.untilWall !== null && prepared.untilWall < startWall;
    const noSeconds = !!parts.bySecond && !parts.bySecond.length;
    if ((own(rule, 'count') && !(rule.count > 0)) || noSeconds || untilBeforeStart) {
        prepared.onlyStart = true;
        return prepared;
    }

    let frequency = rule.frequency;
    const skipping = rule.skip === 'backward' || rule.skip === 'forward';
    if (skipping && frequency === 'monthly' && parts.byMonthDay && !parts.bySetPosition && !(rule.interval > 1)) {
        // the library ignores skip for a monthly byMonthDay but applies it for a yearly one, and with
        // an interval of one month and no set position both give the same occurrences
        frequency = 'yearly';
        parts.byMonth = parts.byMonth || ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
    }

    const options = {
        freq: frequency.toUpperCase(),
        interval: Number.isInteger(rule.interval) && rule.interval > 0 ? rule.interval : 1,
        dtstart: asZoned(event.start),
        tzid: 'UTC',
        cache: false,
        temporal: STRING_TEMPORAL,
        maxIterations: limits.maxIterations,
        maxCandidateEvaluations: limits.maxIterations * 2,
        wkst: typeof rule.firstDayOfWeek === 'string' ? rule.firstDayOfWeek.toUpperCase() : 'MO'
    };
    if (own(rule, 'count')) {
        options.count = rule.count;
    } else if (prepared.untilWall !== null) {
        options.until = asZoned(rule.until);
    }
    if (parts.byDay) {
        options.byDay = parts.byDay.map(nday => `${nday.nthOfPeriod ? nday.nthOfPeriod : ''}${String(nday.day).toUpperCase()}`);
    }
    if (parts.byMonth) {
        // the library ignores month strings without an rscale, so Gregorian months go as numbers
        options.byMonth = parts.byMonth.map(month => Number(month));
    }
    for (const [from, to] of [
        ['byMonthDay', 'byMonthDay'],
        ['byYearDay', 'byYearDay'],
        ['byWeekNo', 'byWeekNo'],
        ['byHour', 'byHour'],
        ['byMinute', 'byMinute'],
        ['bySecond', 'bySecond'],
        ['bySetPosition', 'bySetPos']
    ]) {
        if (parts[from]) {
            options[to] = parts[from];
        }
    }
    if (skipping) {
        // skip needs an rscale in the library; only the Gregorian calendar is accepted at write time
        options.rscale = 'GREGORIAN';
        options.skip = rule.skip.toUpperCase();
    }

    // the start is the first occurrence and counts towards count (RFC 8984 4.3.3.1). The library's
    // includeDtstart is not applied on every code path (a yearly rule with nthOfPeriod drops it),
    // so the start is added here when the rule does not generate it itself.
    const generatesStart = startGenerated(event, rule, parts, options);
    if (!generatesStart) {
        prepared.addStart = true;
        if (own(rule, 'count')) {
            if (rule.count === 1) {
                prepared.onlyStart = true;
                return prepared;
            }
            options.count = rule.count - 1;
        }
    }
    prepared.options = options;
    prepared.library = new RRuleTemporal(options);
    return prepared;
}

/**
 * True when the library generates the start itself. A secondly to daily rule without date parts does
 * when its time parts hold the time of the start; any other rule is asked (which, for a rule with
 * thousands of time slots, costs a whole period of candidates).
 */
function startGenerated(event, rule, parts, options) {
    if (!rule.skip && ['secondly', 'minutely', 'hourly', 'daily'].includes(rule.frequency) && !DATE_PARTS.some(key => nonEmpty(parts[key]))) {
        const start = new Date(parseLocal(event.start));
        const holds = (list, value) => !list || list.some(entry => Number(entry) === value);
        return holds(parts.byHour, start.getUTCHours()) && holds(parts.byMinute, start.getUTCMinutes()) && holds(parts.bySecond, start.getUTCSeconds());
    }
    const probeOptions = Object.assign({}, options, { until: asZoned(event.start) });
    delete probeOptions.count;
    const probe = new RRuleTemporal(probeOptions);
    return libraryCall(() => probe.all()).some(value => value.slice(0, 19) === event.start);
}

function libraryCall(fn) {
    try {
        return fn();
    } catch (err) {
        if (err instanceof RecurrenceLimitError) {
            throw err;
        }
        if (err instanceof RangeError || /maximum|exceeded/i.test(err && err.message)) {
            const limitError = new RecurrenceLimitError(`Recurrence rule too expensive to expand: ${err.message}`);
            limitError.cause = err;
            throw limitError;
        }
        throw err;
    }
}

/**
 * Calls visit(local, wall) for every local date-time the rule (start included) generates within
 * [lo, hi] (wall milliseconds, inclusive, either may be null) in ascending order. visit may return
 * false to stop. Throws RecurrenceLimitError when a cap is hit.
 */
function generate(prepared, lo, hi, visit) {
    const { startWall, limits } = prepared;
    // local times have whole seconds, and so must the chunk edges
    const low = lo === null ? startWall : Math.max(Math.floor(lo / 1000) * 1000, startWall);
    hi = hi === null ? null : Math.ceil(hi / 1000) * 1000;
    if (hi !== null && hi < low) {
        return;
    }
    if (prepared.onlyStart) {
        if (startWall >= low && (hi === null || startWall <= hi)) {
            visit(prepared.startLocal, startWall);
        }
        return;
    }

    const rawCap = limits.maxIterations + limits.maxInstances;
    let raw = 0;
    let skipped = 0;
    let stopped = false;
    const accept = (value, upper) => {
        const local = value.slice(0, 19);
        const wall = parseLocal(local);
        if (upper !== null && wall > upper) {
            return false;
        }
        if (++raw > rawCap || (wall < low && ++skipped > limits.maxIterations)) {
            throw new RecurrenceLimitError();
        }
        if (wall >= low && visit(local, wall) === false) {
            stopped = true;
            return false;
        }
        return true;
    };

    if (prepared.addStart && startWall >= low && (hi === null || startWall <= hi)) {
        raw++;
        if (visit(prepared.startLocal, startWall) === false) {
            return;
        }
    }

    let high = hi;
    if (prepared.untilWall !== null) {
        high = high === null ? Math.max(prepared.untilWall, startWall) : Math.min(high, Math.max(prepared.untilWall, startWall));
    }

    if (own(prepared.rule, 'count') || high === null) {
        const counted = own(prepared.rule, 'count') ? prepared.rule.count : Infinity;
        // refused before the walk when it is certain to pass more occurrences before the window than
        // allowed, or (to the end of the rule) more than allowed in all
        if (Math.min(minOccurrences(prepared, startWall, low), counted) > limits.maxIterations + 1 || (high === null && counted > rawCap)) {
            throw new RecurrenceLimitError();
        }
        // count depends on every occurrence from the start, so walk from there; the library accepts
        // until next to count, which ends the walk at the window even when the rule matches rarely
        const library = high === null ? prepared.library : new RRuleTemporal(Object.assign({}, prepared.options, { until: asZoned(formatLocal(high)) }));
        libraryCall(() => library.all(value => accept(value, high)));
        return;
    }

    // a rule without count jumps to the window; chunks keep each library result below the cap
    const chunkBudget = Math.max(1, Math.min(limits.maxInstances, Math.floor(limits.maxIterations / 2)));
    const chunkMs = Math.max(1000, Math.floor((chunkBudget * DAY_MS) / prepared.density / 1000) * 1000);
    // with a set position the library evaluates every candidate of a whole period, however short the
    // chunk: the chunks of a dense rule with a set position are capped by the candidates they evaluate
    const evaluatedMs = nonEmpty(prepared.rule.bySetPosition) ? Math.max(chunkMs, periodMs(prepared.rule)) : chunkMs;
    const chunkWork = Math.max(1, (prepared.density * evaluatedMs) / DAY_MS);
    const maxChunks = Math.max(1, Math.min(Math.max(16, Math.floor(limits.maxIterations / 10)), Math.floor(MAX_CHUNK_WORK / chunkWork)));
    let chunks = 0;
    for (let chunkStart = low; chunkStart <= high && !stopped; chunkStart += chunkMs) {
        if (++chunks > maxChunks) {
            throw new RecurrenceLimitError();
        }
        const chunkEnd = Math.min(high, chunkStart + chunkMs - 1000);
        const values = libraryCall(() => prepared.library.between(new Date(chunkStart), new Date(chunkEnd), true));
        for (const value of values) {
            if (!accept(value, chunkEnd)) {
                break;
            }
        }
    }
}

// ---------------------------------------------------------------- instances

function makeInstance(event, recurrenceId, patch, floatingZone, baseStart) {
    const hasPatch = !!patch;
    const start = hasPatch && typeof patch.start === 'string' ? patch.start : baseStart;
    const zone = hasPatch && own(patch, 'timeZone') ? patch.timeZone || null : event.timeZone || null;
    const duration = hasPatch && typeof patch.duration === 'string' ? patch.duration : event.duration || 'PT0S';
    const effectiveZone = zone || floatingZone;
    const wall = parseLocal(start);
    const utcStart = wallToUtc(wall, effectiveZone);
    const parsed = parseDuration(duration);
    const utcEnd = parsed.days ? addDurationWall(wall, parsed, effectiveZone) : utcStart + parsed.seconds * 1000;
    return { recurrenceId, start, timeZone: zone, duration, utcStart, utcEnd, patch: hasPatch ? patch : null };
}

const isExcluded = patch => !!patch && typeof patch === 'object' && patch.excluded === true;
const overridesOf = event => (event.recurrenceOverrides && typeof event.recurrenceOverrides === 'object' ? event.recurrenceOverrides : {});
const isRecurring = event => !!event.recurrenceRule || Object.keys(overridesOf(event)).length > 0;

function compareInstances(a, b) {
    if (a.utcStart !== b.utcStart) {
        return a.utcStart - b.utcStart;
    }
    const ra = a.recurrenceId || '';
    const rb = b.recurrenceId || '';
    return ra < rb ? -1 : ra > rb ? 1 : 0;
}

/** Recurrence overrides with no rule behave as a rule generating only the start */
function prepareEvent(event, limits) {
    if (event.recurrenceRule) {
        return prepareRule(event, limits);
    }
    return { rule: {}, startWall: parseLocal(event.start), startLocal: event.start, limits, untilWall: null, onlyStart: true, density: 1 };
}

/**
 * The instances of an event overlapping [from, to) (epoch milliseconds, null for unbounded):
 * utcEnd > from and utcStart < to. Sorted by utcStart, then recurrenceId.
 */
function expandEvent(event, options) {
    options = options || {};
    const limits = resolveLimits(options);
    const floatingZone = options.timeZone || 'Etc/UTC';
    const from = typeof options.from === 'number' ? options.from : null;
    const to = typeof options.to === 'number' ? options.to : null;
    const overlaps = instance => (from === null || instance.utcEnd > from) && (to === null || instance.utcStart < to);

    if (!isRecurring(event)) {
        const single = makeInstance(event, event.recurrenceId || null, null, floatingZone, event.start);
        return { instances: overlaps(single) ? [single] : [], complete: true };
    }

    const zone = event.timeZone || floatingZone;
    const overrides = overridesOf(event);
    const prepared = prepareEvent(event, limits);
    const baseDuration = parseDuration(event.duration || 'PT0S');

    // the local window that can hold an unpatched instance overlapping the UTC window
    let lo = null;
    let hi = null;
    if (from !== null) {
        const edge = from - durationUpperMs(baseDuration);
        lo = edge + offsetRange([edge - DAY_MS, edge, edge + DAY_MS], zone).min - HOUR_MS;
    }
    if (to !== null) {
        hi = to + offsetRange([to - DAY_MS, to, to + DAY_MS], zone).max + HOUR_MS;
    }

    // a window certain to hold more instances than allowed is refused before the walk (with count
    // the rule may end before it, and the walk from the start is capped by itself)
    // the instants of the wall times in [a, b] are in the window: the edges moved in by the offsets
    // around them and two hours for a change of offset inside the window
    if (!own(prepared.rule, 'count')) {
        const a =
            from === null ? prepared.startWall : Math.max(from + offsetRange([from - DAY_MS, from, from + DAY_MS], zone).max + 2 * HOUR_MS, prepared.startWall);
        const b = to === null ? null : to + offsetRange([to - DAY_MS, to, to + DAY_MS], zone).min - 2 * HOUR_MS;
        const end = prepared.untilWall === null ? b : b === null ? prepared.untilWall : Math.min(b, prepared.untilWall);
        const certain = minOccurrences(prepared, a, end);
        // each override moves or excludes one of them, two more may meet at a DST change
        if (certain - Object.keys(overrides).length - 2 > limits.maxInstances) {
            throw new RecurrenceLimitError();
        }
    }
    const instances = [];
    let inWindow = 0;
    const seen = new Set();
    generate(prepared, lo, hi, local => {
        if (own(overrides, local)) {
            // handled below with the other overrides
            return true;
        }
        const instance = makeInstance(event, local, null, floatingZone, local);
        if (!overlaps(instance)) {
            return true;
        }
        if (++inWindow > limits.maxInstances) {
            throw new RecurrenceLimitError();
        }
        // two local times can meet at one instant around a DST gap; the earlier local time stays
        if (!seen.has(instance.utcStart)) {
            seen.add(instance.utcStart);
            instances.push(instance);
        }
        return true;
    });

    // overrides are placed by their patched start, wherever their key is
    for (const recurrenceId of Object.keys(overrides)) {
        const patch = overrides[recurrenceId];
        if (isExcluded(patch) || !LOCAL_RE.test(recurrenceId)) {
            continue;
        }
        const instance = makeInstance(event, recurrenceId, patch && typeof patch === 'object' ? patch : {}, floatingZone, recurrenceId);
        if (overlaps(instance)) {
            if (++inWindow > limits.maxInstances) {
                throw new RecurrenceLimitError();
            }
            instances.push(instance);
        }
    }

    instances.sort(compareInstances);
    return { instances, complete: true };
}

/**
 * Widening for local times near a DST change: a later local time of the rule can map to an earlier
 * instant than the start (and an earlier one to a later instant than the last) when the offset
 * grows in between. The offset an instance used is its wall time minus its instant.
 */
function startLowering(instance, zone) {
    const utc = instance.utcStart;
    const used = parseLocal(instance.start) - utc;
    return Math.max(0, offsetRange([utc, utc + DAY_MS, utc + 2 * DAY_MS], zone).max - used);
}

function endRaising(instance, zone) {
    const utc = instance.utcStart;
    const used = parseLocal(instance.start) - utc;
    return Math.max(0, used - offsetRange([utc, utc - DAY_MS, utc - 2 * DAY_MS], zone).min);
}

/**
 * The first start and the last end (epoch milliseconds) over all instances, for preselecting
 * candidates. Floating times are read as Etc/UTC. last is null for an unbounded rule. With until,
 * last is computed from the until itself (an upper bound: until plus the duration), not from the
 * last generated occurrence. Never narrower than the instances, possibly wider around DST changes.
 */
function bounds(event, options) {
    const limits = resolveLimits(options);
    const floatingZone = 'Etc/UTC';
    if (!isRecurring(event)) {
        const single = makeInstance(event, event.recurrenceId || null, null, floatingZone, event.start);
        return { first: single.utcStart, last: single.utcEnd };
    }

    const zone = event.timeZone || floatingZone;
    const startInstance = makeInstance(event, event.start, null, floatingZone, event.start);
    let first = startInstance.utcStart - startLowering(startInstance, zone);
    let last = null;

    const prepared = prepareEvent(event, limits);
    let lastLocal = null;
    if (prepared.onlyStart) {
        lastLocal = event.start;
    } else if (own(prepared.rule, 'count')) {
        generate(prepared, null, null, local => {
            lastLocal = local;
            return true;
        });
    } else if (prepared.untilWall !== null) {
        lastLocal = prepared.untilWall > prepared.startWall ? prepared.rule.until : event.start;
    }
    if (lastLocal !== null) {
        const lastInstance = makeInstance(event, lastLocal, null, floatingZone, lastLocal);
        last = Math.max(lastInstance.utcEnd + endRaising(lastInstance, zone), startInstance.utcEnd);
    }

    const overrides = overridesOf(event);
    for (const recurrenceId of Object.keys(overrides)) {
        const patch = overrides[recurrenceId];
        if (isExcluded(patch) || !LOCAL_RE.test(recurrenceId)) {
            continue;
        }
        const instance = makeInstance(event, recurrenceId, patch && typeof patch === 'object' ? patch : {}, floatingZone, recurrenceId);
        first = Math.min(first, instance.utcStart);
        if (last !== null) {
            last = Math.max(last, instance.utcEnd);
        }
    }
    return { first, last };
}

/**
 * 'excluded' when the override for recurrenceId excludes it, 'rule' when the rule (or the start)
 * generates it, 'added' when only an override key names it, null otherwise.
 */
function occurrenceKind(event, recurrenceId, options) {
    if (typeof recurrenceId !== 'string' || !LOCAL_RE.test(recurrenceId)) {
        return null;
    }
    const overrides = overridesOf(event);
    if (own(overrides, recurrenceId) && isExcluded(overrides[recurrenceId])) {
        return 'excluded';
    }
    if (!isRecurring(event)) {
        return recurrenceId === (event.recurrenceId || event.start) ? 'rule' : null;
    }
    if (recurrenceId === event.start) {
        return 'rule';
    }
    if (event.recurrenceRule) {
        const prepared = prepareRule(event, resolveLimits(options));
        const wall = parseLocal(recurrenceId);
        let found = false;
        generate(prepared, wall, wall, local => {
            found = found || local === recurrenceId;
            return !found;
        });
        if (found) {
            return 'rule';
        }
    }
    return own(overrides, recurrenceId) ? 'added' : null;
}

module.exports = {
    localToUtc,
    utcToLocal,
    parseDuration,
    formatDuration,
    addDuration,
    expandEvent,
    bounds,
    occurrenceKind,
    RecurrenceLimitError,
    DEFAULT_LIMITS
};
