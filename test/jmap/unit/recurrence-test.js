/* eslint no-unused-expressions: 0, no-invalid-this: 0, no-bitwise: 0 */
'use strict';

// lib/calendar/recurrence.js: JSCalendar recurrence expansion (RFC 8984 4.3.3, bis 3.3.3) on top of
// rrule-temporal. These tests pin the library behaviour too, so an upgrade that changes semantics
// fails here (docs/jmap/recurrence-options.md, test strategy).

const { expect } = require('chai');
const recurrence = require('../../../lib/calendar/recurrence');

const { localToUtc, utcToLocal, parseDuration, formatDuration, addDuration, expandEvent, bounds, occurrenceKind, RecurrenceLimitError, DEFAULT_LIMITS } =
    recurrence;

const ZONES = [null, 'Etc/UTC', 'Europe/Tallinn', 'America/New_York', 'America/Los_Angeles', 'Australia/Melbourne', 'Australia/Lord_Howe', 'Asia/Kolkata'];
const DURATIONS = ['PT0S', 'PT30M', 'PT1H', 'P1D', 'PT25H'];
const HORIZON = { yearly: 40 * 366, monthly: 6 * 366, weekly: 2 * 366, daily: 366, hourly: 20, minutely: 2, secondly: 1 };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
const utc = value => Date.parse(value);
const DAY = 24 * 3600 * 1000;

const event = (start, rule, extra) => Object.assign({ '@type': 'Event', start, recurrenceRule: Object.assign({ '@type': 'RecurrenceRule' }, rule) }, extra);
const starts = (ev, options) => expandEvent(ev, options || {}).instances.map(instance => instance.start);
const dates = list => list.map(value => value.slice(0, 10));

/** Finishes under budget with RecurrenceLimitError or an empty result */
function withinBudget(fn, budget) {
    const started = Date.now();
    let outcome;
    try {
        const result = fn();
        outcome = result && result.instances ? result.instances.length : result;
    } catch (err) {
        expect(err).to.be.instanceOf(RecurrenceLimitError);
        expect(err.code).to.equal('cannotCalculateOccurrences');
        outcome = 'limit';
    }
    expect(Date.now() - started, 'time budget').to.be.below(budget || 1000);
    return outcome;
}

// ---------------------------------------------------------------- seeded PRNG

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------- brute force oracle (RFC 8984 4.3.3.1)

const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const pad = (value, width) => String(value).padStart(width || 2, '0');
const dayNumber = (year, month, day) => Math.floor(Date.UTC(year, month - 1, day) / DAY);
const fromDayNumber = number => {
    const date = new Date(number * DAY);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};
const weekdayOf = number => (new Date(number * DAY).getUTCDay() + 6) % 7;
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const daysInYear = year => dayNumber(year + 1, 1, 1) - dayNumber(year, 1, 1);

function parseWall(local) {
    const [, year, month, day, hour, minute, second] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(local).map(Number);
    return { year, month, day, hour, minute, second, dayNum: dayNumber(year, month, day), secOfDay: hour * 3600 + minute * 60 + second };
}

const wallSeconds = (dayNum, secOfDay) => dayNum * 86400 + secOfDay;
function formatWall(seconds) {
    const dayNum = Math.floor(seconds / 86400);
    const rest = seconds - dayNum * 86400;
    const { year, month, day } = fromDayNumber(dayNum);
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(Math.floor(rest / 3600))}:${pad(Math.floor(rest / 60) % 60)}:${pad(rest % 60)}`;
}

/** Start of week 1 of a year: the week (starting on wkst) holding January 4 */
const weekOneStart = (year, wkst) => {
    const jan4 = dayNumber(year, 1, 4);
    return jan4 - ((weekdayOf(jan4) - wkst + 7) % 7);
};

/**
 * Every occurrence (local date-time strings) with a local date-time not later than horizon, by
 * literal enumeration of each period: implicit parts, by* filters as membership tests (the expand
 * and limit table of RFC 5545 3.3.10 reduces to membership for the valid combinations), skip,
 * bySetPosition, then start inclusion, until and count.
 */
function oracle(rule, startLocal, horizonLocal) {
    const start = parseWall(startLocal);
    const startSec = wallSeconds(start.dayNum, start.secOfDay);
    const horizon = parseWall(horizonLocal);
    const horizonSec = wallSeconds(horizon.dayNum, horizon.secOfDay);
    const freq = rule.frequency;
    const interval = rule.interval || 1;
    const wkst = DAYS.indexOf(rule.firstDayOfWeek || 'mo');
    const skip = rule.skip || 'omit';
    const subDaily = ['hourly', 'minutely', 'secondly'].includes(freq);

    let byMonth = rule.byMonth ? rule.byMonth.map(Number) : null;
    let byMonthDay = rule.byMonthDay || null;
    const byYearDay = rule.byYearDay || null;
    const byWeekNo = rule.byWeekNo || null;
    let byDay = rule.byDay || null;
    let byHour = rule.byHour || null;
    let byMinute = rule.byMinute || null;
    let bySecond = rule.bySecond || null;
    if (!bySecond && freq !== 'secondly') {
        bySecond = [start.second];
    }
    if (!byMinute && !['secondly', 'minutely'].includes(freq)) {
        byMinute = [start.minute];
    }
    if (!byHour && !subDaily) {
        byHour = [start.hour];
    }
    if (freq === 'weekly' && !byDay) {
        byDay = [{ day: DAYS[weekdayOf(start.dayNum)] }];
    }
    if (freq === 'monthly' && !byDay && !byMonthDay) {
        byMonthDay = [start.day];
    }
    if (freq === 'yearly' && !byYearDay) {
        if (!byMonth && !byWeekNo && (byMonthDay || !byDay)) {
            byMonth = [start.month];
        }
        if (!byMonthDay && !byWeekNo && !byDay) {
            byMonthDay = [start.day];
        }
        if (byWeekNo && !byMonthDay && !byDay) {
            byDay = [{ day: DAYS[weekdayOf(start.dayNum)] }];
        }
    }

    const nthOk = (dayNum, nth) => {
        // the nth weekday within the month (monthly, or yearly with byMonth) or the year
        const { year, month } = fromDayNumber(dayNum);
        const withinMonth = freq === 'monthly' || (freq === 'yearly' && byMonth);
        const first = withinMonth ? dayNumber(year, month, 1) : dayNumber(year, 1, 1);
        const last = withinMonth ? dayNumber(year, month, daysInMonth(year, month)) : dayNumber(year, 12, 31);
        const index = nth > 0 ? Math.floor((dayNum - first) / 7) + 1 : -(Math.floor((last - dayNum) / 7) + 1);
        return index === nth;
    };
    const dateMatches = dayNum => {
        const { year, month, day } = fromDayNumber(dayNum);
        if (byMonth && !byMonth.includes(month)) {
            return false;
        }
        if (byWeekNo) {
            // the week of the day in its own week numbering year (week 1 holds January 4)
            let weekYear = year;
            if (dayNum < weekOneStart(year, wkst)) {
                weekYear = year - 1;
            } else if (dayNum >= weekOneStart(year + 1, wkst)) {
                weekYear = year + 1;
            }
            const w1 = weekOneStart(weekYear, wkst);
            const weeks = (weekOneStart(weekYear + 1, wkst) - w1) / 7;
            const week = Math.floor((dayNum - w1) / 7) + 1;
            if (!byWeekNo.some(n => (n > 0 ? n : weeks + n + 1) === week)) {
                return false;
            }
        }
        if (byYearDay) {
            const yd = dayNum - dayNumber(year, 1, 1) + 1;
            const len = daysInYear(year);
            if (!byYearDay.some(n => (n > 0 ? n : len + n + 1) === yd)) {
                return false;
            }
        }
        if (byMonthDay) {
            const dim = daysInMonth(year, month);
            if (!byMonthDay.some(n => (n > 0 ? n : dim + n + 1) === day)) {
                return false;
            }
        }
        if (byDay) {
            const wd = DAYS[weekdayOf(dayNum)];
            if (!byDay.some(nday => nday.day === wd && (!nday.nthOfPeriod || nthOk(dayNum, nday.nthOfPeriod)))) {
                return false;
            }
        }
        return true;
    };
    const timeMatches = secOfDay => {
        const hour = Math.floor(secOfDay / 3600);
        const minute = Math.floor(secOfDay / 60) % 60;
        const second = secOfDay % 60;
        return (!byHour || byHour.includes(hour)) && (!byMinute || byMinute.includes(minute)) && (!bySecond || bySecond.includes(second));
    };
    const sortedUnique = list => Array.from(new Set(list)).sort((a, b) => a - b);
    const times = () => {
        const out = [];
        for (const hour of byHour) {
            for (const minute of byMinute) {
                for (const second of bySecond) {
                    out.push(hour * 3600 + minute * 60 + second);
                }
            }
        }
        return sortedUnique(out);
    };

    // days of the months of a period that do not exist, moved by skip (RFC 7529)
    const skipped = months => {
        const out = [];
        if (skip === 'omit' || !byMonthDay) {
            return out;
        }
        for (const [year, month] of months) {
            if (byMonth && !byMonth.includes(month)) {
                continue;
            }
            const dim = daysInMonth(year, month);
            for (const n of byMonthDay) {
                if (n > dim) {
                    out.push(skip === 'backward' ? dayNumber(year, month, dim) : dayNumber(year, month, dim) + 1);
                }
            }
        }
        return out;
    };

    function periodCandidates(k) {
        if (subDaily) {
            const unit = freq === 'hourly' ? 3600 : freq === 'minutely' ? 60 : 1;
            const base = startSec - (startSec % unit) + k * interval * unit;
            let offsets = [0];
            if (freq === 'hourly') {
                offsets = [];
                for (const minute of byMinute || [0]) {
                    for (const second of bySecond || [0]) {
                        offsets.push(minute * 60 + second);
                    }
                }
            } else if (freq === 'minutely') {
                offsets = (bySecond || [0]).slice();
            }
            const list = sortedUnique(offsets.map(offset => base + offset));
            return {
                first: base,
                list: list.filter(value => dateMatches(Math.floor(value / 86400)) && timeMatches(value % 86400))
            };
        }
        let days = [];
        let months = [];
        if (freq === 'daily') {
            days = [start.dayNum + k * interval];
        } else if (freq === 'weekly') {
            const weekStart = start.dayNum - ((weekdayOf(start.dayNum) - wkst + 7) % 7) + k * interval * 7;
            for (let i = 0; i < 7; i++) {
                days.push(weekStart + i);
            }
        } else if (freq === 'monthly') {
            const index = start.year * 12 + start.month - 1 + k * interval;
            const year = Math.floor(index / 12);
            const month = (index % 12) + 1;
            months = [[year, month]];
            for (let day = 1; day <= daysInMonth(year, month); day++) {
                days.push(dayNumber(year, month, day));
            }
        } else {
            const year = start.year + k * interval;
            for (let month = 1; month <= 12; month++) {
                months.push([year, month]);
            }
            for (let day = dayNumber(year, 1, 1); day < dayNumber(year + 1, 1, 1); day++) {
                days.push(day);
            }
        }
        const matching = sortedUnique(days.filter(dateMatches).concat(skipped(months)));
        const list = [];
        const slots = times();
        for (const day of matching) {
            for (const slot of slots) {
                list.push(wallSeconds(day, slot));
            }
        }
        return { first: days[0] * 86400, list };
    }

    const untilSec = rule.until ? wallSeconds(parseWall(rule.until).dayNum, parseWall(rule.until).secOfDay) : null;
    const out = [startSec];
    const limit = typeof rule.count === 'number' ? rule.count : Infinity;
    for (let k = 0; out.length < limit; k++) {
        const period = periodCandidates(k);
        if (period.first > horizonSec || (untilSec !== null && period.first > untilSec)) {
            break;
        }
        let list = period.list;
        if (rule.bySetPosition) {
            list = sortedUnique(rule.bySetPosition.map(pos => (pos > 0 ? list[pos - 1] : list[list.length + pos])).filter(value => value !== undefined));
        }
        for (const value of list) {
            if (value <= startSec || (untilSec !== null && value > untilSec)) {
                continue;
            }
            if (out.length >= limit) {
                break;
            }
            out.push(value);
        }
    }
    return out.filter(value => value <= horizonSec).map(formatWall);
}

/** Oracle instances of an event, converted with the same Intl rule, colliding instants dropped */
function oracleInstances(ev, horizonLocal, floatingZone) {
    const zone = ev.timeZone || floatingZone || 'Etc/UTC';
    const seen = new Set();
    const out = [];
    for (const local of oracle(ev.recurrenceRule, ev.start, horizonLocal)) {
        const utcStart = localToUtc(local, zone);
        if (seen.has(utcStart)) {
            continue;
        }
        seen.add(utcStart);
        out.push({ recurrenceId: local, utcStart, utcEnd: addDuration(local, ev.duration || 'PT0S', zone) });
    }
    return out.sort((a, b) => a.utcStart - b.utcStart || (a.recurrenceId < b.recurrenceId ? -1 : 1));
}

const summary = instances => instances.map(instance => `${instance.recurrenceId} ${iso(instance.utcStart)} ${iso(instance.utcEnd)}`);

// ---------------------------------------------------------------- tests

describe('Calendar recurrence', function () {
    this.timeout(20000);

    describe('time zone conversion', () => {
        it('converts local times with gaps and overlaps per RFC 8984 1.4.5', () => {
            // Tallinn: 2026-03-29 03:00 jumps to 04:00, 2026-10-25 04:00 goes back to 03:00
            expect(iso(localToUtc('2026-03-29T03:30:00', 'Europe/Tallinn'))).to.equal('2026-03-29T01:30:00Z');
            expect(iso(localToUtc('2026-03-29T04:30:00', 'Europe/Tallinn'))).to.equal('2026-03-29T01:30:00Z');
            expect(iso(localToUtc('2026-03-29T02:59:59', 'Europe/Tallinn'))).to.equal('2026-03-29T00:59:59Z');
            expect(iso(localToUtc('2026-10-25T03:30:00', 'Europe/Tallinn'))).to.equal('2026-10-25T00:30:00Z');
            expect(iso(localToUtc('2026-10-25T04:00:00', 'Europe/Tallinn'))).to.equal('2026-10-25T02:00:00Z');
            // Los Angeles: gap 02:00 to 03:00 on 2026-03-08, overlap 01:00 to 02:00 on 2026-11-01
            expect(iso(localToUtc('2026-03-08T02:30:00', 'America/Los_Angeles'))).to.equal('2026-03-08T10:30:00Z');
            expect(iso(localToUtc('2026-11-01T01:30:00', 'America/Los_Angeles'))).to.equal('2026-11-01T08:30:00Z');
            // Lord Howe: 30 minute shifts
            expect(iso(localToUtc('2026-10-04T02:15:00', 'Australia/Lord_Howe'))).to.equal('2026-10-03T15:45:00Z');
            expect(iso(localToUtc('2026-04-05T01:45:00', 'Australia/Lord_Howe'))).to.equal('2026-04-04T14:45:00Z');
            // floating
            expect(iso(localToUtc('2026-03-29T03:30:00'))).to.equal('2026-03-29T03:30:00Z');
            expect(iso(localToUtc('2026-03-29T03:30:00', null))).to.equal('2026-03-29T03:30:00Z');
        });

        it('converts instants to local times, before 1970 and up to 2199', () => {
            expect(utcToLocal(utc('2026-10-25T00:30:00Z'), 'Europe/Tallinn')).to.equal('2026-10-25T03:30:00');
            expect(utcToLocal(utc('2026-10-25T01:30:00Z'), 'Europe/Tallinn')).to.equal('2026-10-25T03:30:00');
            expect(utcToLocal(utc('2026-10-25T01:30:00.999Z'), 'Europe/Tallinn')).to.equal('2026-10-25T03:30:00');
            expect(utcToLocal(utc('1950-06-01T12:00:00Z'), 'America/New_York')).to.equal('1950-06-01T08:00:00');
            expect(utcToLocal(utc('1900-01-01T00:00:00Z'))).to.equal('1900-01-01T00:00:00');
            expect(utcToLocal(utc('2199-12-31T23:59:59Z'), 'Pacific/Kiritimati')).to.equal('2200-01-01T13:59:59');
            expect(iso(localToUtc('1900-01-01T00:00:00', 'Etc/UTC'))).to.equal('1900-01-01T00:00:00Z');
            expect(iso(localToUtc('1969-12-31T19:00:00', 'America/New_York'))).to.equal('1970-01-01T00:00:00Z');
        });

        it('round trips random instants in many zones (1900 to 2199)', () => {
            const random = mulberry32(1234);
            const zones = [
                'Europe/Tallinn',
                'America/New_York',
                'America/Los_Angeles',
                'Australia/Melbourne',
                'Australia/Lord_Howe',
                'Asia/Kolkata',
                'Pacific/Apia',
                'Etc/UTC'
            ];
            for (let i = 0; i < 400; i++) {
                const zone = zones[i % zones.length];
                const instant =
                    Math.floor((utc('1900-01-01T00:00:00Z') + random() * (utc('2199-12-31T00:00:00Z') - utc('1900-01-01T00:00:00Z'))) / 1000) * 1000;
                const local = utcToLocal(instant, zone);
                const back = localToUtc(local, zone);
                // an overlap maps to the earlier instant, always within 24 hours
                expect(back, `${zone} ${local}`).to.be.at.most(instant);
                expect(instant - back).to.be.below(DAY);
                expect(utcToLocal(back, zone)).to.equal(local);
            }
        });

        it('applies the earlier offset to every gap time (brute force over transitions)', () => {
            const zones = ['Europe/Tallinn', 'America/New_York', 'Australia/Lord_Howe', 'Australia/Melbourne'];
            let gaps = 0;
            for (const zone of zones) {
                // walk 2026 in 30 minute steps: a local time that does not round trip is in a gap
                for (let wall = utc('2026-01-01T00:00:00Z'); wall < utc('2027-01-01T00:00:00Z'); wall += 1800 * 1000) {
                    const local = iso(wall).slice(0, 19);
                    const result = localToUtc(local, zone);
                    if (utcToLocal(result, zone) !== local) {
                        gaps++;
                        // the offset before the transition: the zone had it one day earlier
                        const offsetBefore = parseWallMs(utcToLocal(wall - DAY, zone)) - (wall - DAY);
                        expect(result, `${zone} ${local}`).to.equal(wall - offsetBefore);
                    }
                }
            }
            // 03:00 and 03:30 in Tallinn and Melbourne, 02:00 and 02:30 in New York, 02:00 in Lord Howe
            expect(gaps).to.equal(7);
        });
    });

    describe('durations', () => {
        it('parses and formats', () => {
            expect(parseDuration('PT0S')).to.deep.equal({ days: 0, seconds: 0 });
            expect(parseDuration('P1W')).to.deep.equal({ days: 7, seconds: 0 });
            expect(parseDuration('P1W2DT3H4M5S')).to.deep.equal({ days: 9, seconds: 3 * 3600 + 4 * 60 + 5 });
            expect(parseDuration('-PT15M')).to.deep.equal({ days: 0, seconds: -900 });
            expect(parseDuration('+P1D')).to.deep.equal({ days: 1, seconds: 0 });
            expect(() => parseDuration('P1H')).to.throw(TypeError);
            expect(() => parseDuration('PT')).to.throw(TypeError);
            expect(formatDuration(0)).to.equal('PT0S');
            expect(formatDuration(5400)).to.equal('PT1H30M');
            expect(formatDuration(86400 + 7200)).to.equal('P1DT2H');
            expect(formatDuration(86400 * 3)).to.equal('P3D');
            expect(formatDuration(61)).to.equal('PT1M1S');
            expect(() => formatDuration(-1)).to.throw(TypeError);
        });

        it('adds nominal days in local time and exact time after', () => {
            // New York 2026-03-08 springs forward: one nominal day is 23 hours
            expect(iso(addDuration('2026-03-07T09:00:00', 'P1D', 'America/New_York'))).to.equal('2026-03-08T13:00:00Z');
            expect(iso(addDuration('2026-03-07T09:00:00', 'PT24H', 'America/New_York'))).to.equal('2026-03-08T14:00:00Z');
            expect(iso(addDuration('2026-03-07T09:00:00', 'P1DT1H', 'America/New_York'))).to.equal('2026-03-08T14:00:00Z');
            expect(iso(addDuration('2026-03-07T09:00:00', { days: 0, seconds: -900 }, 'America/New_York'))).to.equal('2026-03-07T13:45:00Z');
            expect(iso(addDuration('2026-03-07T09:00:00', 'PT1H'))).to.equal('2026-03-07T10:00:00Z');
        });
    });

    describe('RFC 5545 3.8.5.3 examples', () => {
        const NY = { timeZone: 'America/New_York' };
        const ny = (start, rule, extra) => event(start, rule, Object.assign({}, NY, extra));

        it('daily for 10 occurrences', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'daily', count: 10 });
            expect(dates(starts(ev))).to.deep.equal(['02', '03', '04', '05', '06', '07', '08', '09', '10', '11'].map(d => `1997-09-${d}`));
        });

        it('daily until December 24, 1997', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'daily', until: '1997-12-23T19:00:00' });
            const list = expandEvent(ev, {}).instances;
            expect(list).to.have.length(113);
            expect(list[list.length - 1].start).to.equal('1997-12-23T09:00:00');
            // EDT then EST
            expect(iso(list[0].utcStart)).to.equal('1997-09-02T13:00:00Z');
            expect(iso(list[list.length - 1].utcStart)).to.equal('1997-12-23T14:00:00Z');
        });

        it('every other day, forever', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'daily', interval: 2 });
            const list = starts(ev, { from: utc('1997-09-01T00:00:00Z'), to: utc('1997-09-10T00:00:00Z') });
            expect(dates(list)).to.deep.equal(['1997-09-02', '1997-09-04', '1997-09-06', '1997-09-08']);
        });

        it('every 10 days, 5 occurrences', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'daily', interval: 10, count: 5 });
            expect(dates(starts(ev))).to.deep.equal(['1997-09-02', '1997-09-12', '1997-09-22', '1997-10-02', '1997-10-12']);
        });

        it('every day in January, for 3 years (yearly and daily forms)', () => {
            const all = DAYS.map(day => ({ day }));
            const yearly = ny('1998-01-01T09:00:00', { frequency: 'yearly', byMonth: ['1'], byDay: all, until: '2000-01-31T09:00:00' });
            const daily = ny('1998-01-01T09:00:00', { frequency: 'daily', byMonth: ['1'], until: '2000-01-31T09:00:00' });
            const list = starts(yearly);
            expect(list).to.have.length(93);
            expect(starts(daily)).to.deep.equal(list);
            expect(list[31]).to.equal('1999-01-01T09:00:00');
        });

        it('weekly for 10 occurrences', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'weekly', count: 10 });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-02',
                '1997-09-09',
                '1997-09-16',
                '1997-09-23',
                '1997-09-30',
                '1997-10-07',
                '1997-10-14',
                '1997-10-21',
                '1997-10-28',
                '1997-11-04'
            ]);
        });

        it('weekly on Tuesday and Thursday for five weeks', () => {
            const ev = ny('1997-09-02T09:00:00', {
                frequency: 'weekly',
                until: '1997-10-07T00:00:00',
                firstDayOfWeek: 'su',
                byDay: [{ day: 'tu' }, { day: 'th' }]
            });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-02',
                '1997-09-04',
                '1997-09-09',
                '1997-09-11',
                '1997-09-16',
                '1997-09-18',
                '1997-09-23',
                '1997-09-25',
                '1997-09-30',
                '1997-10-02'
            ]);
        });

        it('every other week on Monday, Wednesday and Friday until December 24, 1997', () => {
            const ev = ny('1997-09-01T09:00:00', {
                frequency: 'weekly',
                interval: 2,
                until: '1997-12-23T19:00:00',
                firstDayOfWeek: 'su',
                byDay: [{ day: 'mo' }, { day: 'we' }, { day: 'fr' }]
            });
            const list = dates(starts(ev));
            expect(list).to.have.length(25);
            expect(list.slice(0, 7)).to.deep.equal(['1997-09-01', '1997-09-03', '1997-09-05', '1997-09-15', '1997-09-17', '1997-09-19', '1997-09-29']);
            expect(list.slice(-3)).to.deep.equal(['1997-12-10', '1997-12-12', '1997-12-22']);
        });

        it('every other week on Tuesday and Thursday, for 8 occurrences', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'weekly', interval: 2, count: 8, firstDayOfWeek: 'su', byDay: [{ day: 'tu' }, { day: 'th' }] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-02',
                '1997-09-04',
                '1997-09-16',
                '1997-09-18',
                '1997-09-30',
                '1997-10-02',
                '1997-10-14',
                '1997-10-16'
            ]);
        });

        it('monthly on the first Friday for 10 occurrences', () => {
            const ev = ny('1997-09-05T09:00:00', { frequency: 'monthly', count: 10, byDay: [{ day: 'fr', nthOfPeriod: 1 }] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-05',
                '1997-10-03',
                '1997-11-07',
                '1997-12-05',
                '1998-01-02',
                '1998-02-06',
                '1998-03-06',
                '1998-04-03',
                '1998-05-01',
                '1998-06-05'
            ]);
        });

        it('every other month on the first and last Sunday for 10 occurrences', () => {
            const ev = ny('1997-09-07T09:00:00', {
                frequency: 'monthly',
                interval: 2,
                count: 10,
                byDay: [
                    { day: 'su', nthOfPeriod: 1 },
                    { day: 'su', nthOfPeriod: -1 }
                ]
            });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-07',
                '1997-09-28',
                '1997-11-02',
                '1997-11-30',
                '1998-01-04',
                '1998-01-25',
                '1998-03-01',
                '1998-03-29',
                '1998-05-03',
                '1998-05-31'
            ]);
        });

        it('monthly on the second-to-last Monday for 6 months', () => {
            const ev = ny('1997-09-22T09:00:00', { frequency: 'monthly', count: 6, byDay: [{ day: 'mo', nthOfPeriod: -2 }] });
            expect(dates(starts(ev))).to.deep.equal(['1997-09-22', '1997-10-20', '1997-11-17', '1997-12-22', '1998-01-19', '1998-02-16']);
        });

        it('monthly on the third-to-the-last day of the month, forever', () => {
            const ev = ny('1997-09-28T09:00:00', { frequency: 'monthly', byMonthDay: [-3] });
            const list = starts(ev, { from: utc('1997-09-01T00:00:00Z'), to: utc('1998-03-01T00:00:00Z') });
            expect(dates(list)).to.deep.equal(['1997-09-28', '1997-10-29', '1997-11-28', '1997-12-29', '1998-01-29', '1998-02-26']);
        });

        it('monthly on the 2nd and 15th for 10 occurrences', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'monthly', count: 10, byMonthDay: [2, 15] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-02',
                '1997-09-15',
                '1997-10-02',
                '1997-10-15',
                '1997-11-02',
                '1997-11-15',
                '1997-12-02',
                '1997-12-15',
                '1998-01-02',
                '1998-01-15'
            ]);
        });

        it('monthly on the first and last day of the month for 10 occurrences', () => {
            const ev = ny('1997-09-30T09:00:00', { frequency: 'monthly', count: 10, byMonthDay: [1, -1] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-30',
                '1997-10-01',
                '1997-10-31',
                '1997-11-01',
                '1997-11-30',
                '1997-12-01',
                '1997-12-31',
                '1998-01-01',
                '1998-01-31',
                '1998-02-01'
            ]);
        });

        it('every 18 months on the 10th thru 15th for 10 occurrences', () => {
            const ev = ny('1997-09-10T09:00:00', { frequency: 'monthly', interval: 18, count: 10, byMonthDay: [10, 11, 12, 13, 14, 15] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-09-10',
                '1997-09-11',
                '1997-09-12',
                '1997-09-13',
                '1997-09-14',
                '1997-09-15',
                '1999-03-10',
                '1999-03-11',
                '1999-03-12',
                '1999-03-13'
            ]);
        });

        it('every Tuesday, every other month', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'monthly', interval: 2, byDay: [{ day: 'tu' }] });
            const list = starts(ev, { from: utc('1997-09-01T00:00:00Z'), to: utc('1998-01-31T00:00:00Z') });
            expect(dates(list)).to.deep.equal([
                '1997-09-02',
                '1997-09-09',
                '1997-09-16',
                '1997-09-23',
                '1997-09-30',
                '1997-11-04',
                '1997-11-11',
                '1997-11-18',
                '1997-11-25',
                '1998-01-06',
                '1998-01-13',
                '1998-01-20',
                '1998-01-27'
            ]);
        });

        it('yearly in June and July for 10 occurrences', () => {
            const ev = ny('1997-06-10T09:00:00', { frequency: 'yearly', count: 10, byMonth: ['6', '7'] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-06-10',
                '1997-07-10',
                '1998-06-10',
                '1998-07-10',
                '1999-06-10',
                '1999-07-10',
                '2000-06-10',
                '2000-07-10',
                '2001-06-10',
                '2001-07-10'
            ]);
        });

        it('every other year on January, February, and March for 10 occurrences', () => {
            const ev = ny('1997-03-10T09:00:00', { frequency: 'yearly', interval: 2, count: 10, byMonth: ['1', '2', '3'] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-03-10',
                '1999-01-10',
                '1999-02-10',
                '1999-03-10',
                '2001-01-10',
                '2001-02-10',
                '2001-03-10',
                '2003-01-10',
                '2003-02-10',
                '2003-03-10'
            ]);
        });

        it('every third year on the 1st, 100th, and 200th day for 10 occurrences', () => {
            const ev = ny('1997-01-01T09:00:00', { frequency: 'yearly', interval: 3, count: 10, byYearDay: [1, 100, 200] });
            expect(dates(starts(ev))).to.deep.equal([
                '1997-01-01',
                '1997-04-10',
                '1997-07-19',
                '2000-01-01',
                '2000-04-09',
                '2000-07-18',
                '2003-01-01',
                '2003-04-10',
                '2003-07-19',
                '2006-01-01'
            ]);
        });

        it('every 20th Monday of the year, forever', () => {
            const ev = ny('1997-05-19T09:00:00', { frequency: 'yearly', byDay: [{ day: 'mo', nthOfPeriod: 20 }] });
            const list = starts(ev, { from: utc('1997-01-01T00:00:00Z'), to: utc('2000-01-01T00:00:00Z') });
            expect(dates(list)).to.deep.equal(['1997-05-19', '1998-05-18', '1999-05-17']);
        });

        it('Monday of week number 20, forever', () => {
            const ev = ny('1997-05-12T09:00:00', { frequency: 'yearly', byWeekNo: [20], byDay: [{ day: 'mo' }] });
            const list = starts(ev, { from: utc('1997-01-01T00:00:00Z'), to: utc('2000-01-01T00:00:00Z') });
            expect(dates(list)).to.deep.equal(['1997-05-12', '1998-05-11', '1999-05-17']);
        });

        it('every Thursday in March, forever', () => {
            const ev = ny('1997-03-13T09:00:00', { frequency: 'yearly', byMonth: ['3'], byDay: [{ day: 'th' }] });
            const list = starts(ev, { from: utc('1997-01-01T00:00:00Z'), to: utc('1999-03-05T00:00:00Z') });
            expect(dates(list)).to.deep.equal(['1997-03-13', '1997-03-20', '1997-03-27', '1998-03-05', '1998-03-12', '1998-03-19', '1998-03-26', '1999-03-04']);
        });

        it('every Thursday, but only during June, July, and August', () => {
            const ev = ny('1997-06-05T09:00:00', { frequency: 'yearly', byDay: [{ day: 'th' }], byMonth: ['6', '7', '8'] });
            const list = starts(ev, { from: utc('1997-01-01T00:00:00Z'), to: utc('1998-01-01T00:00:00Z') });
            expect(list).to.have.length(13);
            expect(dates(list).slice(0, 4)).to.deep.equal(['1997-06-05', '1997-06-12', '1997-06-19', '1997-06-26']);
            expect(dates(list).slice(-1)).to.deep.equal(['1997-08-28']);
        });

        it('every Friday the 13th, forever (start excluded through an override)', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'monthly', byDay: [{ day: 'fr' }], byMonthDay: [13] });
            const window = { from: utc('1997-01-01T00:00:00Z'), to: utc('2000-12-31T00:00:00Z') };
            // the start is always an occurrence in JSCalendar
            expect(dates(starts(ev, window))).to.deep.equal(['1997-09-02', '1998-02-13', '1998-03-13', '1998-11-13', '1999-08-13', '2000-10-13']);
            ev.recurrenceOverrides = { '1997-09-02T09:00:00': { excluded: true } };
            expect(dates(starts(ev, window))).to.deep.equal(['1998-02-13', '1998-03-13', '1998-11-13', '1999-08-13', '2000-10-13']);
        });

        it('the first Saturday that follows the first Sunday of the month, forever', () => {
            const ev = ny('1997-09-13T09:00:00', { frequency: 'monthly', byDay: [{ day: 'sa' }], byMonthDay: [7, 8, 9, 10, 11, 12, 13] });
            const list = starts(ev, { from: utc('1997-09-01T00:00:00Z'), to: utc('1998-06-30T00:00:00Z') });
            expect(dates(list)).to.deep.equal([
                '1997-09-13',
                '1997-10-11',
                '1997-11-08',
                '1997-12-13',
                '1998-01-10',
                '1998-02-07',
                '1998-03-07',
                '1998-04-11',
                '1998-05-09',
                '1998-06-13'
            ]);
        });

        it('U.S. Presidential Election day', () => {
            const ev = ny('1996-11-05T09:00:00', {
                frequency: 'yearly',
                interval: 4,
                byMonth: ['11'],
                byDay: [{ day: 'tu' }],
                byMonthDay: [2, 3, 4, 5, 6, 7, 8]
            });
            const list = starts(ev, { from: utc('1996-01-01T00:00:00Z'), to: utc('2005-01-01T00:00:00Z') });
            expect(dates(list)).to.deep.equal(['1996-11-05', '2000-11-07', '2004-11-02']);
        });

        it('the third instance of Tuesday, Wednesday or Thursday, for the next 3 months', () => {
            const ev = ny('1997-09-04T09:00:00', { frequency: 'monthly', count: 3, byDay: [{ day: 'tu' }, { day: 'we' }, { day: 'th' }], bySetPosition: [3] });
            expect(dates(starts(ev))).to.deep.equal(['1997-09-04', '1997-10-07', '1997-11-06']);
        });

        it('the second-to-last weekday of the month', () => {
            const weekdays = ['mo', 'tu', 'we', 'th', 'fr'].map(day => ({ day }));
            const ev = ny('1997-09-29T09:00:00', { frequency: 'monthly', byDay: weekdays, bySetPosition: [-2] });
            const list = starts(ev, { from: utc('1997-09-01T00:00:00Z'), to: utc('1998-03-31T00:00:00Z') });
            expect(dates(list)).to.deep.equal(['1997-09-29', '1997-10-30', '1997-11-27', '1997-12-30', '1998-01-29', '1998-02-26', '1998-03-30']);
        });

        it('every 3 hours from 09:00 to 17:00 on a specific day', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'hourly', interval: 3, until: '1997-09-02T17:00:00' });
            expect(starts(ev)).to.deep.equal(['1997-09-02T09:00:00', '1997-09-02T12:00:00', '1997-09-02T15:00:00']);
        });

        it('every 15 minutes for 6 occurrences', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'minutely', interval: 15, count: 6 });
            expect(starts(ev).map(value => value.slice(11))).to.deep.equal(['09:00:00', '09:15:00', '09:30:00', '09:45:00', '10:00:00', '10:15:00']);
        });

        it('every hour and a half for 4 occurrences', () => {
            const ev = ny('1997-09-02T09:00:00', { frequency: 'minutely', interval: 90, count: 4 });
            expect(starts(ev).map(value => value.slice(11))).to.deep.equal(['09:00:00', '10:30:00', '12:00:00', '13:30:00']);
        });

        it('every 20 minutes from 9:00 to 16:40 every day (daily and minutely forms)', () => {
            const hours = [9, 10, 11, 12, 13, 14, 15, 16];
            const daily = ny('1997-09-02T09:00:00', { frequency: 'daily', byHour: hours, byMinute: [0, 20, 40] });
            const minutely = ny('1997-09-02T09:00:00', { frequency: 'minutely', interval: 20, byHour: hours });
            const window = { from: utc('1997-09-02T00:00:00Z'), to: utc('1997-09-04T00:00:00Z') };
            const list = starts(daily, window);
            expect(list).to.have.length(48);
            expect(list[0]).to.equal('1997-09-02T09:00:00');
            expect(list[23]).to.equal('1997-09-02T16:40:00');
            expect(starts(minutely, window)).to.deep.equal(list);
        });

        it('firstDayOfWeek changes the result (wkst example)', () => {
            const byDay = [{ day: 'tu' }, { day: 'su' }];
            const mo = ny('1997-08-05T09:00:00', { frequency: 'weekly', interval: 2, count: 4, byDay, firstDayOfWeek: 'mo' });
            const su = ny('1997-08-05T09:00:00', { frequency: 'weekly', interval: 2, count: 4, byDay, firstDayOfWeek: 'su' });
            expect(dates(starts(mo))).to.deep.equal(['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']);
            expect(dates(starts(su))).to.deep.equal(['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']);
        });

        it('invalid dates are ignored (monthly on the 15th and 30th)', () => {
            const ev = ny('2007-01-15T09:00:00', { frequency: 'monthly', count: 5, byMonthDay: [15, 30] });
            expect(dates(starts(ev))).to.deep.equal(['2007-01-15', '2007-01-30', '2007-02-15', '2007-03-15', '2007-03-30']);
        });
    });

    describe('JSCalendar semantics', () => {
        it('counts the start as the first occurrence even when the rule does not match it', () => {
            // 2026-11-09 is a Monday
            const ev = event('2026-11-09T10:00:00', { frequency: 'weekly', byDay: [{ day: 'we' }], count: 3 });
            expect(starts(ev)).to.deep.equal(['2026-11-09T10:00:00', '2026-11-11T10:00:00', '2026-11-18T10:00:00']);
            expect(occurrenceKind(ev, '2026-11-09T10:00:00')).to.equal('rule');
        });

        it('counts excluded occurrences towards count', () => {
            const ev = event('2026-01-01T10:00:00', { frequency: 'daily', count: 4 }, { recurrenceOverrides: { '2026-01-02T10:00:00': { excluded: true } } });
            expect(starts(ev)).to.deep.equal(['2026-01-01T10:00:00', '2026-01-03T10:00:00', '2026-01-04T10:00:00']);
        });

        it('treats until as inclusive local time', () => {
            const ev = event('2026-01-01T10:00:00', { frequency: 'daily', until: '2026-01-03T10:00:00' }, { timeZone: 'Asia/Tokyo' });
            expect(starts(ev)).to.deep.equal(['2026-01-01T10:00:00', '2026-01-02T10:00:00', '2026-01-03T10:00:00']);
            ev.recurrenceRule.until = '2026-01-03T09:59:59';
            expect(starts(ev)).to.deep.equal(['2026-01-01T10:00:00', '2026-01-02T10:00:00']);
            // the start stays even after until
            ev.recurrenceRule.until = '2025-01-01T00:00:00';
            expect(starts(ev)).to.deep.equal(['2026-01-01T10:00:00']);
        });

        it('skip omit, backward and forward (monthly from January 31)', () => {
            const make = skip => event('2025-01-31T10:00:00', { frequency: 'monthly', count: 4, skip });
            expect(dates(starts(make('omit')))).to.deep.equal(['2025-01-31', '2025-03-31', '2025-05-31', '2025-07-31']);
            expect(dates(starts(make('backward')))).to.deep.equal(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30']);
            expect(dates(starts(make('forward')))).to.deep.equal(['2025-01-31', '2025-03-01', '2025-03-31', '2025-05-01']);
        });

        it('skip omit, backward and forward (yearly from 2024-02-29)', () => {
            const make = skip => event('2024-02-29T10:00:00', { frequency: 'yearly', count: 3, skip });
            expect(dates(starts(make('omit')))).to.deep.equal(['2024-02-29', '2028-02-29', '2032-02-29']);
            expect(dates(starts(make('backward')))).to.deep.equal(['2024-02-29', '2025-02-28', '2026-02-28']);
            expect(dates(starts(make('forward')))).to.deep.equal(['2024-02-29', '2025-03-01', '2026-03-01']);
        });

        it('bySetPosition -1 gives the last weekday of the month', () => {
            const weekdays = ['mo', 'tu', 'we', 'th', 'fr'].map(day => ({ day }));
            const ev = event('2026-01-30T17:00:00', { frequency: 'monthly', byDay: weekdays, bySetPosition: [-1], count: 6 });
            expect(dates(starts(ev))).to.deep.equal(['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29', '2026-06-30']);
        });

        it('byWeekNo 20 Mondays', () => {
            const ev = event('2026-05-11T09:00:00', { frequency: 'yearly', byWeekNo: [20], byDay: [{ day: 'mo' }], count: 2 });
            expect(dates(starts(ev))).to.deep.equal(['2026-05-11', '2027-05-17']);
        });

        it('byYearDay with interval 3', () => {
            const ev = event('2026-01-01T09:00:00', { frequency: 'yearly', interval: 3, byYearDay: [1, -1], count: 5 });
            expect(dates(starts(ev))).to.deep.equal(['2026-01-01', '2026-12-31', '2029-01-01', '2029-12-31', '2032-01-01']);
        });

        it('sub daily rules', () => {
            const hourly = event('2026-01-01T01:00:00', { frequency: 'hourly', interval: 6, count: 5 });
            expect(starts(hourly)).to.deep.equal([
                '2026-01-01T01:00:00',
                '2026-01-01T07:00:00',
                '2026-01-01T13:00:00',
                '2026-01-01T19:00:00',
                '2026-01-02T01:00:00'
            ]);
            const daily = event('2026-01-01T09:00:00', { frequency: 'daily', byHour: [9, 17], byMinute: [0, 30], count: 6 });
            expect(starts(daily)).to.deep.equal([
                '2026-01-01T09:00:00',
                '2026-01-01T09:30:00',
                '2026-01-01T17:00:00',
                '2026-01-01T17:30:00',
                '2026-01-02T09:00:00',
                '2026-01-02T09:30:00'
            ]);
        });

        it('ignores the leap second in bySecond and handles count 0 as the start only', () => {
            expect(starts(event('2026-01-01T09:00:00', { frequency: 'minutely', bySecond: [60], count: 3 }))).to.deep.equal(['2026-01-01T09:00:00']);
            expect(starts(event('2026-01-01T09:00:00', { frequency: 'minutely', bySecond: [0, 60], count: 3 }))).to.deep.equal([
                '2026-01-01T09:00:00',
                '2026-01-01T09:01:00',
                '2026-01-01T09:02:00'
            ]);
            expect(starts(event('2026-01-01T09:00:00', { frequency: 'daily', count: 0 }))).to.deep.equal(['2026-01-01T09:00:00']);
        });

        it('RFC 8984 6.4 floating recurring event', () => {
            const yoga = event('2018-01-01T07:00:00', { frequency: 'daily' }, { duration: 'PT30M' });
            const window = { from: utc('2018-01-01T00:00:00Z'), to: utc('2018-01-03T00:00:00Z') };
            const instances = expandEvent(yoga, Object.assign({ timeZone: 'America/Los_Angeles' }, window)).instances;
            expect(instances.map(instance => iso(instance.utcStart))).to.deep.equal(['2018-01-01T15:00:00Z', '2018-01-02T15:00:00Z']);
            expect(instances[0].timeZone).to.equal(null);
            expect(instances[0].duration).to.equal('PT30M');
            expect(expandEvent(yoga, window).instances.map(instance => iso(instance.utcEnd))).to.deep.equal(['2018-01-01T07:30:00Z', '2018-01-02T07:30:00Z']);
        });

        it('RFC 8984 6.5 recurring event with overrides', () => {
            const course = event(
                '2020-01-08T09:00:00',
                { frequency: 'weekly', until: '2020-06-24T09:00:00' },
                {
                    timeZone: 'Europe/London',
                    duration: 'PT1H30M',
                    recurrenceOverrides: {
                        '2020-01-07T14:00:00': { title: 'Introduction to Calculus I (optional)' },
                        '2020-04-01T09:00:00': { excluded: true },
                        '2020-06-25T09:00:00': { title: 'Calculus I Exam', start: '2020-06-25T10:00:00', duration: 'PT2H' }
                    }
                }
            );
            const instances = expandEvent(course, {}).instances;
            expect(instances).to.have.length(26);
            expect(instances[0].recurrenceId).to.equal('2020-01-07T14:00:00');
            expect(instances[0].patch).to.deep.equal({ title: 'Introduction to Calculus I (optional)' });
            expect(instances[1].patch).to.equal(null);
            expect(instances.some(instance => instance.recurrenceId === '2020-04-01T09:00:00')).to.be.false;
            const exam = instances[instances.length - 1];
            expect(exam).to.deep.include({ recurrenceId: '2020-06-25T09:00:00', start: '2020-06-25T10:00:00', duration: 'PT2H', timeZone: 'Europe/London' });
            expect(iso(exam.utcStart)).to.equal('2020-06-25T09:00:00Z');
            expect(iso(exam.utcEnd)).to.equal('2020-06-25T11:00:00Z');
            expect(occurrenceKind(course, '2020-01-07T14:00:00')).to.equal('added');
            expect(occurrenceKind(course, '2020-04-01T09:00:00')).to.equal('excluded');
            expect(occurrenceKind(course, '2020-04-08T09:00:00')).to.equal('rule');
            expect(occurrenceKind(course, '2020-06-25T09:00:00')).to.equal('added');
            expect(occurrenceKind(course, '2020-07-01T09:00:00')).to.equal(null);
            const range = bounds(course);
            expect(iso(range.first)).to.equal('2020-01-07T14:00:00Z');
            expect(range.last).to.be.at.least(utc('2020-06-25T11:00:00Z'));
        });
    });

    describe('daylight saving time', () => {
        const utcStarts = (ev, options) => expandEvent(ev, options || {}).instances.map(instance => iso(instance.utcStart));

        it('Europe/Tallinn gap and overlap', () => {
            const spring = event('2026-03-28T03:30:00', { frequency: 'daily', count: 3 }, { timeZone: 'Europe/Tallinn' });
            expect(utcStarts(spring)).to.deep.equal(['2026-03-28T01:30:00Z', '2026-03-29T01:30:00Z', '2026-03-30T00:30:00Z']);
            const autumn = event('2026-10-24T03:30:00', { frequency: 'daily', count: 3 }, { timeZone: 'Europe/Tallinn' });
            expect(utcStarts(autumn)).to.deep.equal(['2026-10-24T00:30:00Z', '2026-10-25T00:30:00Z', '2026-10-26T01:30:00Z']);
        });

        it('deduplicates local times that meet at one instant (hourly across a gap)', () => {
            const ev = event('2026-03-29T01:30:00', { frequency: 'hourly', count: 5 }, { timeZone: 'Europe/Tallinn' });
            const instances = expandEvent(ev, {}).instances;
            expect(instances.map(instance => instance.recurrenceId)).to.deep.equal([
                '2026-03-29T01:30:00',
                '2026-03-29T02:30:00',
                '2026-03-29T03:30:00',
                '2026-03-29T05:30:00'
            ]);
            expect(instances.map(instance => iso(instance.utcStart))).to.deep.equal([
                '2026-03-28T23:30:00Z',
                '2026-03-29T00:30:00Z',
                '2026-03-29T01:30:00Z',
                '2026-03-29T02:30:00Z'
            ]);
            // the repeated hour in autumn is visited once, local times stay unique
            const autumn = event('2026-10-25T02:30:00', { frequency: 'hourly', count: 3 }, { timeZone: 'Europe/Tallinn' });
            expect(utcStarts(autumn)).to.deep.equal(['2026-10-24T23:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T02:30:00Z']);
        });

        it('America/New_York and America/Los_Angeles', () => {
            const ny = event('2026-03-07T09:00:00', { frequency: 'daily', count: 2 }, { timeZone: 'America/New_York' });
            expect(utcStarts(ny)).to.deep.equal(['2026-03-07T14:00:00Z', '2026-03-08T13:00:00Z']);
            const la = event('2026-03-07T02:30:00', { frequency: 'daily', count: 3 }, { timeZone: 'America/Los_Angeles' });
            expect(utcStarts(la)).to.deep.equal(['2026-03-07T10:30:00Z', '2026-03-08T10:30:00Z', '2026-03-09T09:30:00Z']);
            const laFall = event('2026-10-31T01:30:00', { frequency: 'daily', count: 3 }, { timeZone: 'America/Los_Angeles' });
            expect(utcStarts(laFall)).to.deep.equal(['2026-10-31T08:30:00Z', '2026-11-01T08:30:00Z', '2026-11-02T09:30:00Z']);
        });

        it('Australia/Melbourne and Australia/Lord_Howe', () => {
            const melbourne = event('2026-10-03T02:30:00', { frequency: 'daily', count: 3 }, { timeZone: 'Australia/Melbourne' });
            expect(utcStarts(melbourne)).to.deep.equal(['2026-10-02T16:30:00Z', '2026-10-03T16:30:00Z', '2026-10-04T15:30:00Z']);
            const melbourneAutumn = event('2026-04-04T02:30:00', { frequency: 'daily', count: 3 }, { timeZone: 'Australia/Melbourne' });
            expect(utcStarts(melbourneAutumn)).to.deep.equal(['2026-04-03T15:30:00Z', '2026-04-04T15:30:00Z', '2026-04-05T16:30:00Z']);
            const lordHowe = event('2026-10-03T02:15:00', { frequency: 'daily', count: 3 }, { timeZone: 'Australia/Lord_Howe' });
            expect(utcStarts(lordHowe)).to.deep.equal(['2026-10-02T15:45:00Z', '2026-10-03T15:45:00Z', '2026-10-04T15:15:00Z']);
            const lordHoweAutumn = event('2026-04-04T01:45:00', { frequency: 'daily', count: 3 }, { timeZone: 'Australia/Lord_Howe' });
            expect(utcStarts(lordHoweAutumn)).to.deep.equal(['2026-04-03T14:45:00Z', '2026-04-04T14:45:00Z', '2026-04-05T15:15:00Z']);
        });

        it('nominal day durations across a transition', () => {
            const ev = event('2026-03-28T12:00:00', { frequency: 'daily', count: 2 }, { timeZone: 'Europe/Tallinn', duration: 'P1D' });
            const instances = expandEvent(ev, {}).instances;
            expect(instances[0].utcEnd - instances[0].utcStart).to.equal(23 * 3600 * 1000);
            expect(instances[1].utcEnd - instances[1].utcStart).to.equal(24 * 3600 * 1000);
        });
    });

    describe('windows', () => {
        it('uses the strict overlap rule', () => {
            const ev = event('2026-01-01T10:00:00', { frequency: 'daily', count: 3 }, { duration: 'PT1H' });
            // ending exactly at from is out, starting exactly at to is out
            expect(starts(ev, { from: utc('2026-01-02T11:00:00Z'), to: utc('2026-01-03T10:00:00Z') })).to.deep.equal([]);
            expect(starts(ev, { from: utc('2026-01-02T10:59:59Z'), to: utc('2026-01-03T10:00:01Z') })).to.deep.equal([
                '2026-01-02T10:00:00',
                '2026-01-03T10:00:00'
            ]);
            const zero = event('2026-01-01T10:00:00', { frequency: 'daily', count: 3 });
            expect(starts(zero, { from: utc('2026-01-02T10:00:00Z'), to: utc('2026-01-02T10:00:01Z') })).to.deep.equal([]);
            expect(starts(zero, { from: utc('2026-01-02T09:59:59Z'), to: utc('2026-01-02T10:00:00Z') })).to.deep.equal([]);
            expect(starts(zero, { from: utc('2026-01-02T09:59:59Z'), to: utc('2026-01-02T10:00:01Z') })).to.deep.equal(['2026-01-02T10:00:00']);
        });

        it('returns non recurring events and standalone instances', () => {
            const single = { '@type': 'Event', start: '2026-01-01T10:00:00', timeZone: 'Europe/Tallinn', duration: 'PT1H' };
            const result = expandEvent(single, { from: utc('2026-01-01T00:00:00Z'), to: utc('2026-01-02T00:00:00Z') });
            expect(result.complete).to.be.true;
            expect(result.instances).to.deep.equal([
                {
                    recurrenceId: null,
                    start: '2026-01-01T10:00:00',
                    timeZone: 'Europe/Tallinn',
                    duration: 'PT1H',
                    utcStart: utc('2026-01-01T08:00:00Z'),
                    utcEnd: utc('2026-01-01T09:00:00Z'),
                    patch: null
                }
            ]);
            expect(expandEvent(single, { from: utc('2026-01-01T09:00:00Z') }).instances).to.deep.equal([]);
            const standalone = Object.assign({}, single, { recurrenceId: '2025-12-31T10:00:00' });
            expect(expandEvent(standalone, {}).instances[0].recurrenceId).to.equal('2025-12-31T10:00:00');
            expect(bounds(single)).to.deep.equal({ first: utc('2026-01-01T08:00:00Z'), last: utc('2026-01-01T09:00:00Z') });
        });

        it('is cheap far from the start', () => {
            const ev = event('1900-01-01T09:00:00', { frequency: 'daily' }, { timeZone: 'Europe/Tallinn' });
            const started = Date.now();
            expect(starts(ev, { from: utc('2150-01-01T00:00:00Z'), to: utc('2150-01-03T00:00:00Z') })).to.deep.equal([
                '2150-01-01T09:00:00',
                '2150-01-02T09:00:00'
            ]);
            const minutely = event('2026-01-01T00:00:00', { frequency: 'minutely', count: 20000 });
            const list = starts(minutely, { from: utc('2026-01-13T12:00:00Z'), to: utc('2026-01-13T13:00:00Z') });
            expect(list).to.have.length(59);
            expect(list[0]).to.equal('2026-01-13T12:01:00');
            // the 20000th occurrence is the last one
            expect(starts(minutely, { from: utc('2026-01-14T21:18:30Z'), to: utc('2026-01-15T00:00:00Z') })).to.deep.equal(['2026-01-14T21:19:00']);
            expect(Date.now() - started).to.be.below(500);
        });

        it('places overrides by their patched start', () => {
            const ev = event(
                '2026-01-05T10:00:00',
                { frequency: 'weekly' },
                {
                    timeZone: 'Europe/Tallinn',
                    duration: 'PT1H',
                    recurrenceOverrides: {
                        // moved out of the January 12 week into March
                        '2026-01-12T10:00:00': { start: '2026-03-03T15:00:00' },
                        // moved from far away into the January 12 week
                        '2026-06-01T10:00:00': { start: '2026-01-14T08:00:00', duration: 'PT2H' },
                        '2026-01-19T10:00:00': { excluded: true },
                        // added, in another zone
                        '2026-01-15T12:00:00': { timeZone: 'America/New_York', title: 'Extra' },
                        // a different zone for one instance
                        '2026-01-26T10:00:00': { timeZone: 'Asia/Tokyo', 'participants/p1/name': 'x' }
                    }
                }
            );
            const week = expandEvent(ev, { from: utc('2026-01-11T22:00:00Z'), to: utc('2026-01-18T22:00:00Z') }).instances;
            expect(week.map(instance => [instance.recurrenceId, instance.start, iso(instance.utcStart), iso(instance.utcEnd)])).to.deep.equal([
                ['2026-06-01T10:00:00', '2026-01-14T08:00:00', '2026-01-14T06:00:00Z', '2026-01-14T08:00:00Z'],
                ['2026-01-15T12:00:00', '2026-01-15T12:00:00', '2026-01-15T17:00:00Z', '2026-01-15T18:00:00Z']
            ]);
            expect(week[1].timeZone).to.equal('America/New_York');
            const march = starts(ev, { from: utc('2026-03-03T00:00:00Z'), to: utc('2026-03-04T00:00:00Z') });
            expect(march).to.deep.equal(['2026-03-03T15:00:00']);
            const later = expandEvent(ev, { from: utc('2026-01-18T22:00:00Z'), to: utc('2026-02-01T22:00:00Z') }).instances;
            expect(later.map(instance => [instance.recurrenceId, instance.timeZone, iso(instance.utcStart)])).to.deep.equal([
                ['2026-01-26T10:00:00', 'Asia/Tokyo', '2026-01-26T01:00:00Z']
            ]);
            // the June occurrence moved away
            expect(starts(ev, { from: utc('2026-06-01T00:00:00Z'), to: utc('2026-06-02T00:00:00Z') })).to.deep.equal([]);
            expect(occurrenceKind(ev, '2026-06-01T10:00:00')).to.equal('rule');
            expect(occurrenceKind(ev, '2026-01-15T12:00:00')).to.equal('added');
            expect(occurrenceKind(ev, '2026-01-19T10:00:00')).to.equal('excluded');
            expect(occurrenceKind(ev, '2026-01-20T10:00:00')).to.equal(null);
            expect(occurrenceKind(ev, '2025-12-29T10:00:00')).to.equal(null);
            // a floating override may take a zone, and a zoned one may become floating
            const floating = event(
                '2026-01-05T10:00:00',
                { frequency: 'daily', count: 2 },
                { recurrenceOverrides: { '2026-01-06T10:00:00': { timeZone: 'Asia/Tokyo' } } }
            );
            expect(expandEvent(floating, { timeZone: 'Europe/Tallinn' }).instances.map(instance => [instance.timeZone, iso(instance.utcStart)])).to.deep.equal([
                [null, '2026-01-05T08:00:00Z'],
                ['Asia/Tokyo', '2026-01-06T01:00:00Z']
            ]);
        });

        it('keeps windows consistent (random rules, split windows)', () => {
            const random = mulberry32(99);
            for (let i = 0; i < 40; i++) {
                const { ev, horizonStart, horizonEnd } = randomCase(random);
                const span = horizonEnd - horizonStart;
                const a = horizonStart + Math.floor(random() * span * 0.3);
                const c = a + Math.floor(random() * span * 0.6) + 1000;
                const b = a + Math.floor(random() * (c - a));
                const whole = expandEvent(ev, { from: a, to: c }).instances;
                const left = expandEvent(ev, { from: a, to: b }).instances;
                const right = expandEvent(ev, { from: b, to: c }).instances;
                const joined = new Map();
                for (const instance of left.concat(right)) {
                    joined.set(instance.recurrenceId, instance);
                }
                expect(
                    summary(Array.from(joined.values()).sort((x, y) => x.utcStart - y.utcStart || (x.recurrenceId < y.recurrenceId ? -1 : 1))),
                    JSON.stringify(ev)
                ).to.deep.equal(summary(whole));
                // only instances spanning b are in both halves
                for (const instance of left) {
                    if (right.some(other => other.recurrenceId === instance.recurrenceId)) {
                        expect(instance.utcStart < b && instance.utcEnd > b).to.be.true;
                    }
                }
                if (typeof ev.recurrenceRule.count === 'number') {
                    // the unbounded expansion of a count rule agrees with every window (unless the
                    // count can not be reached within the caps)
                    let all = null;
                    try {
                        all = expandEvent(ev, {}).instances;
                    } catch (err) {
                        expect(err).to.be.instanceOf(RecurrenceLimitError);
                    }
                    if (all) {
                        expect(summary(all.filter(instance => instance.utcEnd > a && instance.utcStart < c))).to.deep.equal(summary(whole));
                    }
                }
            }
        });
    });

    describe('property test against a brute force oracle', () => {
        it('matches the oracle for random rules, starts, zones and windows', () => {
            // RECURRENCE_SEED and RECURRENCE_CASES widen the search locally; CI uses the defaults
            const random = mulberry32(Number(process.env.RECURRENCE_SEED) || 20261112);
            let compared = 0;
            for (let i = 0; i < (Number(process.env.RECURRENCE_CASES) || 300); i++) {
                const { ev, horizonLocal, horizonStart, horizonEnd, floatingZone } = randomCase(random);
                const expected = oracleInstances(ev, horizonLocal, floatingZone);
                if (expected.length > DEFAULT_LIMITS.maxInstances * 0.8) {
                    // windows could exceed the instance cap
                    continue;
                }
                for (let w = 0; w < 3; w++) {
                    const span = horizonEnd - horizonStart;
                    const from = horizonStart + Math.floor(random() * span * 0.8);
                    const to = from + Math.floor(random() * (horizonEnd - from)) + 1000;
                    const actual = expandEvent(ev, { from, to, timeZone: floatingZone }).instances;
                    const wanted = expected.filter(instance => instance.utcEnd > from && instance.utcStart < to);
                    expect(summary(actual), `${JSON.stringify(ev)} ${iso(from)} ${iso(to)}`).to.deep.equal(summary(wanted));
                    compared += wanted.length;
                }
            }
            expect(compared).to.be.above(1000);
        });
    });

    describe('bounds and occurrenceKind', () => {
        it('computes bounds', () => {
            const counted = event('2026-01-01T10:00:00', { frequency: 'daily', count: 3 }, { timeZone: 'Europe/Tallinn', duration: 'PT1H' });
            expect(bounds(counted)).to.deep.equal({ first: utc('2026-01-01T08:00:00Z'), last: utc('2026-01-03T09:00:00Z') });
            const unbounded = event('2026-01-01T10:00:00', { frequency: 'daily' }, { duration: 'PT1H' });
            expect(bounds(unbounded)).to.deep.equal({ first: utc('2026-01-01T10:00:00Z'), last: null });
            // until: the until itself plus the duration
            const until = event('2026-01-01T10:00:00', { frequency: 'weekly', until: '2026-01-20T00:00:00' }, { duration: 'PT1H' });
            const range = bounds(until);
            expect(range.first).to.equal(utc('2026-01-01T10:00:00Z'));
            expect(range.last).to.be.at.least(utc('2026-01-15T11:00:00Z'));
            expect(range.last).to.equal(utc('2026-01-20T01:00:00Z'));
            // overrides extend both ends; excluded ones do not
            counted.recurrenceOverrides = {
                '2026-01-02T10:00:00': { start: '2026-02-01T10:00:00' },
                '2025-12-01T10:00:00': { title: 'added' },
                '2024-01-01T10:00:00': { excluded: true }
            };
            expect(bounds(counted)).to.deep.equal({ first: utc('2025-12-01T08:00:00Z'), last: utc('2026-02-01T09:00:00Z') });
            // a start in a gap: a later local time of the rule can come earlier in UTC
            const gap = event('2026-03-29T03:30:00', { frequency: 'minutely', count: 60 }, { timeZone: 'Europe/Tallinn' });
            const gapRange = bounds(gap);
            const instances = expandEvent(gap, {}).instances;
            expect(gapRange.first).to.be.at.most(Math.min(...instances.map(instance => instance.utcStart)));
            expect(gapRange.last).to.be.at.least(Math.max(...instances.map(instance => instance.utcEnd)));
        });

        it('never gives bounds narrower than the instances (random rules)', () => {
            const random = mulberry32(4242);
            for (let i = 0; i < 60; i++) {
                const { ev } = randomCase(random);
                if (!own(ev.recurrenceRule, 'count') && !own(ev.recurrenceRule, 'until')) {
                    expect(bounds(ev).last).to.equal(null);
                    continue;
                }
                let instances;
                let range;
                try {
                    instances = expandEvent(ev, {}).instances;
                    range = bounds(ev);
                } catch (err) {
                    // a count the rule can not reach within the caps
                    expect(err).to.be.instanceOf(RecurrenceLimitError);
                    continue;
                }
                expect(range.first, JSON.stringify(ev)).to.be.at.most(Math.min(...instances.map(instance => instance.utcStart)));
                if (range.last !== null) {
                    expect(range.last, JSON.stringify(ev)).to.be.at.least(Math.max(...instances.map(instance => instance.utcEnd)));
                }
            }
        });

        it('classifies recurrence ids cheaply far from the start', () => {
            const ev = event('1900-01-01T09:00:00', { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'th' }] }, { timeZone: 'Europe/Tallinn' });
            const started = Date.now();
            expect(occurrenceKind(ev, '2150-01-05T09:00:00')).to.equal('rule');
            expect(occurrenceKind(ev, '2150-01-06T09:00:00')).to.equal(null);
            expect(occurrenceKind(ev, '2150-01-05T09:00:01')).to.equal(null);
            expect(occurrenceKind(ev, '1899-12-28T09:00:00')).to.equal(null);
            expect(occurrenceKind(ev, 'not a date')).to.equal(null);
            expect(Date.now() - started).to.be.below(200);
            const counted = event('2026-01-01T09:00:00', { frequency: 'daily', count: 3 });
            expect(occurrenceKind(counted, '2026-01-03T09:00:00')).to.equal('rule');
            expect(occurrenceKind(counted, '2026-01-04T09:00:00')).to.equal(null);
            const single = { start: '2026-01-01T09:00:00' };
            expect(occurrenceKind(single, '2026-01-01T09:00:00')).to.equal('rule');
            expect(occurrenceKind(single, '2026-01-02T09:00:00')).to.equal(null);
        });
    });

    describe('rrule-temporal 2.2.8 deviations (pinned, the random rules avoid them)', () => {
        // Each expectation below is the library's current, wrong answer, with the JSCalendar answer in
        // the comment. When an upgrade fixes one, update the expectation and widen randomCase.

        it('a yearly byYearDay ignores byDay and byMonthDay', () => {
            // JSCalendar: byDay limits the year days, so only Mondays on day 100 or 200
            const byDay = event('2026-01-01T09:00:00', { frequency: 'yearly', byYearDay: [100, 200], byDay: [{ day: 'mo' }], count: 3 });
            expect(dates(starts(byDay))).to.deep.equal(['2026-01-01', '2026-04-10', '2026-07-19']);
            // JSCalendar: 2026-01-01, 2027-01-01, 2028-01-01
            const byMonthDay = event('2026-01-01T09:00:00', { frequency: 'yearly', byYearDay: [1, 100], byMonthDay: [1], count: 3 });
            expect(dates(starts(byMonthDay))).to.deep.equal(['2026-01-01', '2026-04-10', '2027-01-01']);
        });

        it('byWeekNo ignores byMonthDay', () => {
            // JSCalendar: no first day of a month falls in week 2, so only the start
            const ev = event('2026-01-05T09:00:00', { frequency: 'yearly', byWeekNo: [2], byMonthDay: [1], count: 3 });
            expect(dates(starts(ev))).to.deep.equal(['2026-01-05', '2027-01-11', '2028-01-10']);
        });

        it('skip acts only when no byMonthDay value is valid in the month', () => {
            // JSCalendar: 2025-02-28 between 02-25 and 03-25
            const ev = event('2025-01-25T09:00:00', { frequency: 'monthly', byMonthDay: [25, 30], skip: 'backward', count: 5 });
            expect(dates(starts(ev))).to.deep.equal(['2025-01-25', '2025-01-30', '2025-02-25', '2025-03-25', '2025-03-30']);
        });

        it('skip is ignored for an explicit monthly byMonthDay with an interval or a set position', () => {
            // JSCalendar: 2025-04-30 second, as with the implicit day
            const explicit = event('2025-01-31T09:00:00', { frequency: 'monthly', interval: 3, byMonthDay: [31], skip: 'backward', count: 3 });
            expect(dates(starts(explicit))).to.deep.equal(['2025-01-31', '2025-07-31', '2025-10-31']);
            const implicit = event('2025-01-31T09:00:00', { frequency: 'monthly', interval: 3, skip: 'backward', count: 3 });
            expect(dates(starts(implicit))).to.deep.equal(['2025-01-31', '2025-04-30', '2025-07-31']);
        });
    });

    describe('caps', () => {
        it('exports frozen defaults and the error', () => {
            expect(DEFAULT_LIMITS).to.deep.equal({ maxInstances: 10000, maxIterations: 20000 });
            expect(Object.isFrozen(DEFAULT_LIMITS)).to.be.true;
            const err = new RecurrenceLimitError();
            expect(err).to.be.instanceOf(Error);
            expect(err.code).to.equal('cannotCalculateOccurrences');
        });

        it('stops never matching rules', () => {
            const feb30 = event('2026-01-01T00:00:00', { frequency: 'secondly', byMonth: ['2'], byMonthDay: [30] });
            expect(withinBudget(() => expandEvent(feb30, { from: utc('2026-02-01T00:00:00Z'), to: utc('2026-03-01T00:00:00Z') }))).to.be.oneOf([0, 'limit']);
            expect(withinBudget(() => expandEvent(feb30, { from: utc('2026-01-01T00:00:00Z'), to: utc('2027-01-01T00:00:00Z') }))).to.be.oneOf([1, 'limit']);
            const yearly = event('2026-01-01T00:00:00', { frequency: 'yearly', byMonth: ['2'], byMonthDay: [30] });
            expect(withinBudget(() => expandEvent(yearly, { from: utc('2026-02-01T00:00:00Z'), to: utc('2126-03-01T00:00:00Z') }))).to.be.oneOf([0, 'limit']);
            const counted = event('2026-01-01T00:00:00', { frequency: 'secondly', byMonth: ['2'], byMonthDay: [30], byHour: [1], count: 5 });
            expect(withinBudget(() => expandEvent(counted, { from: utc('2026-02-01T00:00:00Z'), to: utc('2026-03-01T00:00:00Z') }))).to.be.oneOf([0, 'limit']);
            expect(withinBudget(() => bounds(counted))).to.equal('limit');
            const minutely = event('1900-01-01T00:00:00', { frequency: 'minutely', byYearDay: [366], byMonth: ['2'], count: 4 });
            expect(withinBudget(() => expandEvent(minutely, {}))).to.equal('limit');
            expect(withinBudget(() => occurrenceKind(minutely, '2026-02-01T00:00:00'))).to.be.oneOf([null, 'limit']);
        });

        it('stops huge counts from a far past start', () => {
            const ev = event('1900-01-01T09:00:00', { frequency: 'daily', count: 1000000000 }, { timeZone: 'Europe/Tallinn' });
            expect(withinBudget(() => expandEvent(ev, { from: utc('2026-01-01T00:00:00Z'), to: utc('2026-01-02T00:00:00Z') }))).to.equal('limit');
            expect(withinBudget(() => bounds(ev))).to.equal('limit');
            const minutely = event('1900-01-01T00:00:00', { frequency: 'minutely', count: 100000000 });
            expect(withinBudget(() => expandEvent(minutely, { from: utc('2026-01-01T00:00:00Z'), to: utc('2026-01-01T01:00:00Z') }))).to.equal('limit');
            expect(withinBudget(() => occurrenceKind(minutely, '2026-01-01T00:00:00'))).to.equal('limit');
        });

        it('stops dense secondly and time slot rules', () => {
            const secondly = event('2026-01-01T00:00:00', { frequency: 'secondly' });
            expect(withinBudget(() => expandEvent(secondly, { from: utc('2026-02-01T00:00:00Z'), to: utc('2026-02-02T00:00:00Z') }))).to.equal('limit');
            expect(withinBudget(() => expandEvent(secondly, { from: utc('2026-02-01T00:00:00Z') }))).to.equal('limit');
            expect(withinBudget(() => expandEvent(secondly, {}))).to.equal('limit');
            // one hour of a secondly rule is fine
            expect(withinBudget(() => expandEvent(secondly, { from: utc('2026-02-01T00:00:00Z'), to: utc('2026-02-01T01:00:00Z') }))).to.equal(3599);
            const hours = Array.from({ length: 24 }, (_, i) => i);
            const sixty = Array.from({ length: 60 }, (_, i) => i);
            const slots = event('1900-01-01T00:00:00', { frequency: 'daily', byHour: hours, byMinute: sixty, bySecond: sixty });
            expect(withinBudget(() => expandEvent(slots, { from: utc('2026-01-01T00:00:00Z'), to: utc('2027-01-01T00:00:00Z') }))).to.equal('limit');
            const setPos = event('1900-01-01T00:00:00', {
                frequency: 'daily',
                byHour: hours,
                byMinute: sixty,
                bySecond: sixty,
                bySetPosition: [-1],
                count: 100000
            });
            expect(withinBudget(() => expandEvent(setPos, { from: utc('2026-01-01T00:00:00Z'), to: utc('2026-01-02T00:00:00Z') }))).to.equal('limit');
            // without count the rule jumps to the window, but every chunk evaluates a whole day of slots
            const setPosOpen = event('2000-01-01T00:00:00', { frequency: 'daily', byHour: hours, byMinute: sixty, bySecond: sixty, bySetPosition: [-1] });
            const year = { timeZone: 'Europe/Tallinn', from: utc('2026-01-01T00:00:00Z'), to: utc('2027-01-01T00:00:00Z') };
            expect(withinBudget(() => expandEvent(Object.assign({}, setPosOpen, { timeZone: 'Europe/Tallinn' }), year), 500)).to.equal('limit');
            const minuteSlots = event('2000-01-01T00:00:00', { frequency: 'daily', byHour: hours, byMinute: sixty, bySetPosition: [-1] });
            expect(withinBudget(() => expandEvent(minuteSlots, year), 500)).to.equal(365);
            const yearly = event('1900-01-01T00:00:00', {
                frequency: 'yearly',
                byDay: DAYS.map(day => ({ day })),
                byHour: hours,
                byMinute: sixty,
                bySetPosition: [-1, 2]
            });
            expect(withinBudget(() => expandEvent(yearly, { from: utc('2026-01-01T00:00:00Z'), to: utc('2027-01-01T00:00:00Z') }))).to.be.oneOf([2, 'limit']);
        });

        it('honours caller limits', () => {
            const ev = event('2026-01-01T09:00:00', { frequency: 'daily' });
            const window = { from: utc('2026-01-01T00:00:00Z'), to: utc('2026-01-11T00:00:00Z') };
            expect(starts(ev, Object.assign({ maxInstances: 10 }, window))).to.have.length(10);
            expect(() => expandEvent(ev, Object.assign({ maxInstances: 9 }, window))).to.throw(RecurrenceLimitError);
            const counted = event('2026-01-01T09:00:00', { frequency: 'daily', count: 500 });
            expect(() => expandEvent(counted, { from: utc('2027-01-01T00:00:00Z'), to: utc('2027-01-02T00:00:00Z'), maxIterations: 100 })).to.throw(
                RecurrenceLimitError
            );
            expect(starts(counted, { from: utc('2027-01-01T00:00:00Z'), to: utc('2027-01-02T00:00:00Z') })).to.deep.equal(['2027-01-01T09:00:00']);
        });
    });
});

// ---------------------------------------------------------------- random cases

function parseWallMs(local) {
    const wall = parseWall(local);
    return wallSeconds(wall.dayNum, wall.secOfDay) * 1000;
}

function randomCase(random) {
    const int = (min, max) => min + Math.floor(random() * (max - min + 1));
    const chance = p => random() < p;
    const pick = list => list[Math.floor(random() * list.length)];
    const some = (count, make) => {
        const out = new Set();
        const wanted = int(1, count);
        while (out.size < wanted) {
            out.add(make());
        }
        return Array.from(out);
    };
    const nonZero = (min, max) => {
        let value = 0;
        while (!value) {
            value = int(min, max);
        }
        return value;
    };

    const frequency = pick(['yearly', 'monthly', 'monthly', 'weekly', 'weekly', 'daily', 'daily', 'hourly', 'minutely', 'secondly']);
    const subDaily = ['hourly', 'minutely', 'secondly'].includes(frequency);
    const rule = { frequency };
    if (chance(0.5)) {
        rule.interval = frequency === 'secondly' ? int(1, 90) : frequency === 'minutely' ? int(1, 30) : int(1, 4);
    }
    if (frequency === 'secondly') {
        // keeps a day of occurrences below the instance cap
        rule.interval = int(15, 90);
    }
    const skipCase = (frequency === 'monthly' || frequency === 'yearly') && chance(0.2);
    if (skipCase) {
        rule.skip = pick(['omit', 'backward', 'forward']);
        if (frequency === 'monthly') {
            // library deviation: skip with an explicit monthly byMonthDay needs interval 1
            delete rule.interval;
        }
        if (chance(0.6)) {
            // library deviation: with several byMonthDay values skip only acts when none is valid
            rule.byMonthDay = [int(25, 31)];
        }
        if (chance(0.3)) {
            rule.byMonth = some(3, () => String(int(1, 12)));
        }
    } else {
        if (chance(0.2)) {
            rule.byMonth = some(3, () => String(int(1, 12)));
        }
        if (frequency !== 'weekly' && chance(0.25)) {
            rule.byMonthDay = some(3, () => nonZero(-31, 31));
        }
        if (['yearly', 'hourly', 'minutely', 'secondly'].includes(frequency) && chance(0.15)) {
            rule.byYearDay = some(3, () => nonZero(-366, 366));
            if (frequency === 'yearly') {
                // library deviation: a yearly byYearDay ignores byMonthDay and byDay
                delete rule.byMonthDay;
            }
        }
        if (frequency === 'yearly' && !rule.byYearDay && chance(0.15)) {
            rule.byWeekNo = some(2, () => nonZero(-53, 53));
            // library deviation: byWeekNo ignores byMonthDay
            delete rule.byMonthDay;
        }
        if (!(frequency === 'yearly' && rule.byYearDay) && chance(0.35)) {
            const nth = (frequency === 'monthly' || frequency === 'yearly') && !rule.byWeekNo && chance(0.4);
            rule.byDay = some(3, () => pick(DAYS)).map(day => (nth ? { day, nthOfPeriod: nonZero(-5, 5) } : { day }));
        }
    }
    if (chance(0.3)) {
        rule.byHour = some(3, () => int(0, 23));
    }
    if (chance(0.3)) {
        rule.byMinute = some(3, () => int(0, 59));
    }
    if (chance(subDaily ? 0.3 : 0.15)) {
        rule.bySecond = some(2, () => int(0, 59));
    }
    if (!skipCase && chance(0.2)) {
        rule.bySetPosition = some(2, () => nonZero(-3, 3));
    }
    if (chance(0.3)) {
        rule.firstDayOfWeek = pick(DAYS);
    }

    const startWall = utc('1990-01-01T00:00:00Z') + Math.floor((random() * (utc('2040-01-01T00:00:00Z') - utc('1990-01-01T00:00:00Z'))) / 1000) * 1000;
    const start = iso(startWall).slice(0, 19);
    const horizonWall = startWall + Math.round(HORIZON[frequency] * DAY);
    const horizonLocal = iso(horizonWall).slice(0, 19);
    const roll = random();
    if (roll < 0.5) {
        rule.count = int(1, 25);
    } else if (roll < 0.8) {
        rule.until = iso(startWall + Math.floor((random() * (horizonWall - startWall)) / 1000) * 1000).slice(0, 19);
    }

    const ev = event(start, rule, { duration: pick(DURATIONS) });
    const zone = pick(ZONES);
    if (zone) {
        ev.timeZone = zone;
    }
    const floatingZone = pick(['Etc/UTC', 'Europe/Tallinn', 'America/Los_Angeles']);
    // the oracle is complete up to horizon; windows end 12 hours inside it (no zone here is ahead more)
    return { ev, horizonLocal, horizonStart: startWall - DAY, horizonEnd: horizonWall - 12 * 3600 * 1000, floatingZone };
}
