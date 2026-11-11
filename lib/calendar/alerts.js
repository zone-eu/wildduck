'use strict';

// Calendar alerts (draft-ietf-jmap-calendars-33 5.5, 7; JSCalendar bis 3.5).
//
// Scheduling. Every event keeps the next time the scheduler must look at it (`alertAt`, the earliest
// trigger still to come) and the time up to which its alerts were handled (`alertFrom`); both are
// computed when the event is written (lib/jmap/types/calendar-event.js), with alertFrom no earlier
// than the moment of the write, so alerts whose time had passed when they were written never fire.
// One worker at a time (a Redis lock, renewed while it works) reads the due events on the partial
// {alertAt} index in batches, fires the triggers in (alertFrom, now], and moves both fields on, claiming
// the event with a conditional update so a trigger fires once. A run takes batches while they come full,
// within a time budget; an event that fails leaves the queue. Nothing ever scans all events.
//
// The next trigger is looked for per range of close alert offsets, in windows of instances that start
// at the first instance that can have one and hold a bounded number of rule periods, so a dense rule
// (minutely) with a reminder a week ahead costs a narrow expansion. A search that runs out of windows
// answers the time up to which it found no trigger, and the scheduler looks again then.
//
// Firing. A display alert is pushed as a CalendarAlert to the account's event source connections
// (through the notifier, like every change) and to Web Push subscriptions that ask for the type. An
// email alert is delivered into the user's own INBOX and acknowledged on the event. Both are rate
// limited per user (ttlcounter). Each user's alerts fire up to `jitter` seconds early, by an offset
// derived from the user id, so many alerts at one full hour are spread out and never late. Drafts,
// events in no subscribed calendar and disabled or suspended users fire nothing.

const crypto = require('crypto');
const log = require('npmlog');
const MimeNode = require('nodemailer/lib/mime-node');
const recurrence = require('./recurrence');
const { fromDocument, EventStore } = require('./events');
const { formatId } = require('../jmap/ids');
const { formatUTCDate } = require('../jmap/utcdate');
const { instanceOf } = require('../jmap/calendar-event-model');
const { fromDocument: calendarFromDocument } = require('../calendar-handler');
const consts = require('../consts');

const COLLECTION = 'calendarevents';
const LOCK_KEY = 'jmap:calendar:alerts:lock';
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
const DEFAULTS = Object.freeze({
    // seconds between two scheduler runs, and how many due events one run reads
    interval: 10,
    batch: 500,
    // alerts of a user fire up to this many seconds early
    jitter: 30,
    // display alerts pushed per user and window (seconds), email alerts per user and window
    pushLimit: 120,
    pushWindow: 3600,
    emailLimit: 30,
    emailWindow: 86400
});
// reads and conditional writes one acknowledgement tries against concurrent changes of the event
const ACK_ATTEMPTS = 5;
// due events whose JSCalendar text is read at once
const EVENT_CHUNK = 50;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// how far ahead the next trigger is looked for
const HORIZON = 300 * 366 * DAY;
// the next trigger is looked for separately per range of close offsets, in at most this many ranges
const MAX_OFFSET_GROUPS = 4;
// windows one search of a range expands, and the rule periods one window holds at most
const SEARCH_STEPS = 16;
const SEARCH_PERIODS = 5000;
// the length of a period of each frequency (months and years at their longest)
const PERIODS = { secondly: 1000, minutely: MINUTE, hourly: HOUR, daily: DAY, weekly: 7 * DAY, monthly: 31 * DAY, yearly: 366 * DAY };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_DATE = new Date('9999-12-31T00:00:00Z');

const settingsOf = options => Object.assign({}, DEFAULTS, options || {});

/** A deterministic offset in ms in [0, jitter seconds) for a user */
function jitterOf(user, settings) {
    if (!settings.jitter) {
        return 0;
    }
    const hash = crypto.createHash('sha256').update(String(user)).digest();
    return hash.readUInt32BE(0) % (settings.jitter * 1000);
}

// ---------------------------------------------------------------- triggers

const isSnooze = alert =>
    isObject(alert.relatedTo) && Object.values(alert.relatedTo).some(relation => relation && relation.relation && relation.relation.snooze === true);

/**
 * The alerts that apply to an instance (draft 5.5): its own, or with useDefaultAlerts the default alerts
 * of its subscribed calendars plus its snooze alerts; an alert of the event with the id of a default
 * alert carries the acknowledgement of that default alert.
 */
function effectiveAlerts(instance, calendars) {
    const own = isObject(instance.alerts) ? instance.alerts : {};
    if (!instance.useDefaultAlerts) {
        return own;
    }
    const property = instance.showWithoutTime ? 'defaultAlertsWithoutTime' : 'defaultAlertsWithTime';
    const result = {};
    for (const calendar of calendars.filter(entry => entry.isSubscribed !== false)) {
        for (const [id, alert] of Object.entries(calendar[property] || {})) {
            result[id] = Object.assign({}, alert, own[id] && own[id].acknowledged ? { acknowledged: own[id].acknowledged } : {});
        }
    }
    for (const [id, alert] of Object.entries(own)) {
        if (isObject(alert) && isSnooze(alert)) {
            result[id] = alert;
        }
    }
    return result;
}

/** The signed offset of an OffsetTrigger in ms (days as 24 hours), null when it is not one */
function offsetOf(trigger) {
    if (!isObject(trigger) || (trigger['@type'] !== undefined && trigger['@type'] !== 'OffsetTrigger') || typeof trigger.offset !== 'string') {
        return null;
    }
    const { days, seconds } = recurrence.parseDuration(trigger.offset);
    return (days * 86400 + seconds) * 1000;
}

const absoluteOf = trigger =>
    isObject(trigger) && trigger['@type'] === 'AbsoluteTrigger' && typeof trigger.when === 'string' ? Date.parse(trigger.when) : null;

/** The zone a floating event is read in for alerts: the first of its calendars with a time zone, else Etc/UTC */
const floatingZone = calendars => (calendars.find(calendar => calendar.timeZone) || {}).timeZone || 'Etc/UTC';

/** The distinct offsets (ms) of the OffsetTriggers over the base event, the overrides and the default alerts, sorted */
function offsetsOf(event, calendars) {
    const offsets = new Set();
    const consider = alertMap => {
        for (const alert of Object.values(alertMap || {})) {
            const offset = isObject(alert) ? offsetOf(alert.trigger) : null;
            if (offset !== null) {
                offsets.add(offset);
            }
        }
    };
    consider(event.alerts);
    for (const calendar of calendars) {
        consider(calendar.defaultAlertsWithTime);
        consider(calendar.defaultAlertsWithoutTime);
    }
    for (const patch of Object.values(event.recurrenceOverrides || {})) {
        for (const [key, value] of Object.entries(patch || {})) {
            if (key === 'alerts') {
                consider(value);
            } else if (key.startsWith('alerts/') && key.split('/').length === 2) {
                consider({ x: value });
            } else if (/^alerts\/[^/]+\/trigger(\/offset)?$/.test(key)) {
                consider({ x: { trigger: key.endsWith('/offset') ? { offset: value } : value } });
            }
        }
    }
    return [...offsets].sort((a, b) => a - b);
}

/**
 * Sorted offsets as at most MAX_OFFSET_GROUPS ranges {min, max}, cut at the widest gaps. The instances
 * whose triggers can fall in a window are looked for per range, so far apart offsets (a reminder a
 * week before and one at the start) never make one wide expansion.
 */
function offsetGroups(offsets) {
    const cuts = offsets
        .slice(1)
        .map((offset, i) => ({ at: i + 1, gap: offset - offsets[i] }))
        .sort((a, b) => b.gap - a.gap)
        .slice(0, MAX_OFFSET_GROUPS - 1)
        .map(cut => cut.at)
        .sort((a, b) => a - b);
    const groups = [];
    let first = 0;
    for (const at of [...cuts, offsets.length]) {
        if (at > first) {
            groups.push({ min: offsets[first], max: offsets[at - 1] });
        }
        first = at;
    }
    return groups;
}

const hasAlerts = (event, calendars) =>
    Object.keys(event.alerts || {}).length > 0 ||
    (event.useDefaultAlerts && calendars.some(calendar => calendar.defaultAlertsWithTime || calendar.defaultAlertsWithoutTime)) ||
    Object.values(event.recurrenceOverrides || {}).some(patch => Object.keys(patch || {}).some(key => key === 'alerts' || key.startsWith('alerts/')));

const acknowledgedAt = (alert, at) => !!alert.acknowledged && Date.parse(alert.acknowledged) >= at;

/** The absolute triggers of an event (they fire once per event): add(alertId, alert, at, recurrenceId) */
function absoluteTriggers(event, calendars, add) {
    for (const [id, alert] of Object.entries(effectiveAlerts(event, calendars))) {
        const at = isObject(alert) ? absoluteOf(alert.trigger) : null;
        if (at !== null) {
            add(id, alert, at, event.recurrenceId || null);
        }
    }
}

/** The offset triggers of one instance with an offset in the group: add(alertId, alert, at, recurrenceId) */
function instanceTriggers(event, calendars, instance, group, add) {
    const recurring = !!(event.recurrenceRule || event.recurrenceOverrides);
    const values = recurring && instance.recurrenceId ? instanceOf(event, instance.recurrenceId) : event;
    if (values.isDraft === true) {
        return;
    }
    for (const [id, alert] of Object.entries(effectiveAlerts(values, calendars))) {
        const offset = isObject(alert) ? offsetOf(alert.trigger) : null;
        if (offset !== null && offset >= group.min && offset <= group.max) {
            const anchor = alert.trigger.relativeTo === 'end' ? instance.utcEnd : instance.utcStart;
            add(id, alert, anchor + offset, recurring ? instance.recurrenceId : event.recurrenceId || null);
        }
    }
}

/**
 * The triggers of an event in (from, to], in order.
 *
 * @param {Object} event stored JSCalendar values
 * @param {Object[]} calendars the event's calendars (calendar handler values)
 * @returns {Array<{alertId, recurrenceId, at, action, alert}>}
 * @throws {Error} code cannotCalculateOccurrences when the window holds too many instances
 */
function triggersBetween(event, calendars, from, to) {
    if (event.isDraft === true || !(to > from) || !hasAlerts(event, calendars)) {
        return [];
    }
    const triggers = [];
    const add = (alertId, alert, at, recurrenceId) => {
        if (at > from && at <= to && !acknowledgedAt(alert, at)) {
            triggers.push({ alertId, recurrenceId, at, action: alert.action || 'display', alert });
        }
    };
    absoluteTriggers(event, calendars, add);
    const timeZone = floatingZone(calendars);
    for (const group of offsetGroups(offsetsOf(event, calendars))) {
        // a trigger at anchor + offset in (from, to] needs an instance ending after from - offset and starting by to - offset
        const { instances } = recurrence.expandEvent(event, { timeZone, from: from - group.max - 1, to: to - group.min + 1 });
        for (const instance of instances) {
            instanceTriggers(event, calendars, instance, group, add);
        }
    }
    return triggers.sort((a, b) => a.at - b.at || String(a.alertId).localeCompare(String(b.alertId)));
}

/** The length of one period of the rule in ms (the interval included); the library does work per period */
function periodOf(event) {
    const rule = event.recurrenceRule;
    if (!isObject(rule) || !PERIODS[rule.frequency]) {
        return HORIZON;
    }
    return PERIODS[rule.frequency] * (Number.isInteger(rule.interval) && rule.interval > 0 ? rule.interval : 1);
}

/**
 * The first start and the last end of all instances in ms, floating times read in Etc/UTC (null: none
 * known): the stored values (lib/calendar/events.js) when given, else computed.
 */
function boundsOf(event, options) {
    if (options.first !== undefined && options.last !== undefined) {
        const time = value => (value instanceof Date && value < MAX_DATE ? value.getTime() : null);
        return { first: time(options.first), last: time(options.last) };
    }
    try {
        return recurrence.bounds(event, {});
    } catch (err) {
        if (err.code !== 'cannotCalculateOccurrences') {
            throw err;
        }
        return { first: null, last: null };
    }
}

/**
 * The first trigger after `after` of the offsets of one group, from instances found in windows that move
 * forward from the first instance that can have one. Each window holds at most SEARCH_PERIODS periods of
 * the rule and is sized for about a thousand instances, so a dense rule (minutely, secondly) never makes
 * a large expansion. When the budget of windows runs out, or a window can not be expanded, the answer is
 * the time up to which the group is known to have no trigger (a time to look again), or null when that
 * is less than an hour ahead.
 */
function groupFirst(search, group) {
    const { event, calendars, after, first, end, timeZone, maxWindow } = search;
    let best = null;
    const add = (alertId, alert, at) => {
        if (at > after && !acknowledgedAt(alert, at) && (best === null || at < best)) {
            best = at;
        }
    };
    const lookAgain = lo => (lo + group.min >= after + HOUR ? lo + group.min : null);
    // an instance ending before this has its triggers of the group at or before `after`; no instance
    // starts before the first (a floating one read in another zone a day earlier at most)
    let lo = Math.max(after - group.max - 1, first === null ? -Infinity : first - DAY);
    // the first window holds a few dozen periods at most: the next trigger is usually close
    let size = Math.min(HOUR, Math.floor(maxWindow / 64));
    for (let steps = 0; lo + group.min < end; steps++) {
        if (steps >= SEARCH_STEPS) {
            return lookAgain(lo);
        }
        const hi = lo + size;
        let instances;
        try {
            instances = recurrence.expandEvent(event, { timeZone, from: lo, to: hi }).instances;
        } catch (err) {
            if (err.code !== 'cannotCalculateOccurrences') {
                throw err;
            }
            if (size <= MINUTE) {
                return lookAgain(lo);
            }
            size = Math.max(MINUTE, Math.floor(size / 16));
            continue;
        }
        for (const instance of instances) {
            instanceTriggers(event, calendars, instance, group, add);
        }
        // instances not seen yet start at hi or later, so their triggers of the group come at hi + min or later
        if (best !== null && best <= hi + group.min) {
            return best;
        }
        lo = hi;
        if (instances.length > 1000) {
            size = Math.max(MINUTE, Math.floor(size / 2));
        } else if (instances.length < 100) {
            size = Math.min(size * 4, maxWindow);
        }
    }
    return best;
}

/**
 * The time the scheduler must look at an event next: its first trigger after `after`, or for a rule too
 * dense to search far ahead an earlier time up to which it has none. Null when there is none.
 *
 * @param {Object} [options] {first, last: the stored first start and last end of the event (Dates), save computing them}
 */
function nextTrigger(event, calendars, after, options = {}) {
    if (event.isDraft === true || !hasAlerts(event, calendars)) {
        return null;
    }
    let best = null;
    const consider = at => {
        if (at !== null && at > after && (best === null || at < best)) {
            best = at;
        }
    };
    absoluteTriggers(event, calendars, (alertId, alert, at) => consider(acknowledgedAt(alert, at) ? null : at));
    const offsets = offsetsOf(event, calendars);
    if (!offsets.length) {
        return best;
    }
    // no trigger after the last end plus the largest offset; a floating event may be read a day later
    const { first, last } = boundsOf(event, options);
    const end = Math.min(after + HORIZON, last === null ? Infinity : last + DAY + Math.max(0, offsets[offsets.length - 1]) + 1);
    const search = { event, calendars, after, first, end, timeZone: floatingZone(calendars), maxWindow: periodOf(event) * SEARCH_PERIODS };
    for (const group of offsetGroups(offsets)) {
        consider(groupFirst(search, group));
    }
    return best;
}

/**
 * The scheduling fields of an event being written: handled up to `from`, next look at the first
 * trigger after it.
 *
 * @param {Object} [options] see nextTrigger()
 * @returns {{alertAt: Date|null, alertFrom: Date}}
 */
function scheduleFields(event, calendars, from, options) {
    const next = nextTrigger(event, calendars, from, options);
    return { alertAt: next === null ? null : new Date(next), alertFrom: new Date(from) };
}

// ---------------------------------------------------------------- firing

/** The CalendarAlert object (draft 7) */
const alertObject = (doc, event, trigger) => ({
    '@type': 'CalendarAlert',
    accountId: formatId('account', doc.user),
    calendarEventId: formatId('calendarEvent', doc._id),
    uid: event.uid,
    recurrenceId: trigger.recurrenceId || null,
    alertId: trigger.alertId
});

async function underLimit(deps, key, limit, window) {
    if (!limit || !deps.messageHandler || !deps.messageHandler.counters) {
        return true;
    }
    const res = await deps.messageHandler.counters.asyncTTLCounter(key, 1, limit, window);
    return res.success;
}

/** The text of an alert email */
function alertMessage(userData, event, trigger) {
    const zone = event.timeZone || 'Etc/UTC';
    const start = trigger.recurrenceId && event.recurrenceRule ? trigger.recurrenceId : event.start;
    const title = typeof event.title === 'string' && event.title ? event.title : '(no title)';
    const when = `${String(start).replace('T', ' ')}${event.timeZone ? ` (${zone})` : ''}`;
    const root = new MimeNode('text/plain; charset=utf-8');
    root.setHeader({
        from: `Calendar <${userData.address}>`,
        to: userData.address,
        subject: `Reminder: ${title.replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
        date: new Date(),
        'Auto-Submitted': 'auto-generated'
    });
    root.setContent(`Reminder: ${title}\nStarts: ${when}\n`);
    return new Promise((resolve, reject) => root.build((err, raw) => (err ? reject(err) : resolve(raw))));
}

/** The storage quota of a user as Email/set and Email/import read it: the user's own, else the default */
async function storageQuota(deps, userData) {
    return userData.quota || (deps.settingsHandler ? await deps.settingsHandler.get('const:max:storage') : 0) || 0;
}

/** Delivers an email alert into the user's INBOX within the storage quota and acknowledges the alert on the event */
async function sendEmailAlert(deps, doc, event, trigger, userData, now) {
    const inbox = await deps.database.collection('mailboxes').findOne({ user: doc.user, path: 'INBOX' }, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS });
    if (!inbox || !userData.address) {
        return false;
    }
    const raw = await alertMessage(userData, event, trigger);
    const quota = await storageQuota(deps, userData);
    if (quota && (userData.storageUsed || 0) + raw.length > quota) {
        log.info('JMAP', 'calendar alert email user=%s event=%s skipped: over quota', doc.user, doc._id);
        return false;
    }
    await deps.messageHandler.addAsync({
        user: doc.user,
        mailbox: inbox._id,
        meta: { source: 'JMAP', from: '', origin: '', transtype: 'CALENDAR-ALERT', time: new Date() },
        date: new Date(),
        flags: [],
        raw
    });
    // the usage is read once per batch; later alerts of the user in it count this one
    userData.storageUsed = (userData.storageUsed || 0) + raw.length;
    await acknowledge(deps, doc, trigger, now);
    return true;
}

/**
 * Sets acknowledged of a fired alert on the base event (draft 5.5): a change of the event. The write is
 * conditional on the modSeq read, so a concurrent CalendarEvent/set is never overwritten; a lost race
 * reads the event again.
 */
async function acknowledge(deps, doc, trigger, now) {
    const store = new EventStore({ database: deps.database });
    for (let attempt = 0; attempt < ACK_ATTEMPTS; attempt++) {
        const current = await store
            .collection()
            .findOne({ _id: doc._id, user: doc.user }, { projection: { data: true, calendarIds: true, modSeq: true }, maxTimeMS: MAX_TIME_MS });
        if (!current || !current.data) {
            return;
        }
        const event = JSON.parse(current.data);
        if (!isObject(event.alerts) || !isObject(event.alerts[trigger.alertId])) {
            return;
        }
        event.alerts[trigger.alertId].acknowledged = formatUTCDate(now, { seconds: true });
        if (
            await store.replace(
                doc.user,
                doc._id,
                event,
                [].concat(current.calendarIds || []),
                {},
                { modSeq: current.modSeq === undefined ? null : current.modSeq }
            )
        ) {
            if (deps.notifier) {
                deps.notifier.fire(doc.user);
            }
            return;
        }
    }
    log.info('JMAP', 'calendar alert acknowledgement user=%s event=%s lost to concurrent changes', doc.user, doc._id);
}

/** Pushes a CalendarAlert to the event source streams and the Web Push subscriptions of the account */
function pushAlert(deps, user, alert) {
    if (deps.notifier) {
        deps.notifier.fire(user, { command: 'CALENDARALERT', alert });
    }
    if (deps.push && typeof deps.push.queueAlert === 'function') {
        deps.push.queueAlert(user, alert).catch(err => log.error('JMAP', 'calendar alert push user=%s error=%s', user, err.message));
    }
}

/** Fires the triggers of one claimed event; answers what was fired */
async function fireTriggers(deps, doc, event, triggers, userData, settings, now) {
    const fired = [];
    for (const trigger of triggers) {
        const record = {
            user: doc.user.toString(),
            eventId: doc._id.toString(),
            alertId: trigger.alertId,
            recurrenceId: trigger.recurrenceId,
            at: trigger.at,
            firedAt: now,
            action: trigger.action,
            delivered: false
        };
        if (trigger.action === 'display') {
            if (await underLimit(deps, `jmap:alert:push:${doc.user}`, settings.pushLimit, settings.pushWindow)) {
                pushAlert(deps, doc.user, alertObject(doc, event, trigger));
                record.delivered = true;
            }
        } else if (trigger.action === 'email') {
            if (await underLimit(deps, `jmap:alert:mail:${doc.user}`, settings.emailLimit, settings.emailWindow)) {
                record.delivered = await sendEmailAlert(deps, doc, event, trigger, userData, now).catch(err => {
                    log.error('JMAP', 'calendar alert email user=%s event=%s error=%s', doc.user, doc._id, err.message);
                    return false;
                });
            }
        }
        fired.push(record);
    }
    return fired;
}

/** Users that can get alerts: existing, not disabled, not suspended; with the storage usage for email alerts */
async function activeUsers(deps, users) {
    const docs = await deps.users
        .collection('users')
        .find(
            { _id: { $in: users } },
            { projection: { address: true, disabled: true, suspended: true, quota: true, storageUsed: true }, maxTimeMS: MAX_TIME_MS }
        )
        .toArray();
    return new Map(docs.filter(doc => !doc.disabled && !doc.suspended).map(doc => [doc._id.toString(), doc]));
}

/** The calendars the events of a batch are in, by user */
async function calendarsByUser(deps, users, ids) {
    const docs = await deps.database
        .collection('calendars')
        .find({ _id: { $in: ids }, user: { $in: users } }, { maxTimeMS: MAX_TIME_MS })
        .toArray();
    const result = new Map();
    for (const doc of docs) {
        const key = doc.user.toString();
        result.set(key, (result.get(key) || []).concat(calendarFromDocument(doc)));
    }
    return result;
}

/** Handles one due event: claims it, then fires its triggers */
async function processEvent(deps, doc, context) {
    const { now, settings, users, calendars } = context;
    const effectiveNow = now + jitterOf(doc.user, settings);
    if (doc.alertAt.getTime() > effectiveNow) {
        return [];
    }
    const entry = fromDocument(doc);
    const ids = entry.calendarIds;
    const eventCalendars = (calendars.get(doc.user.toString()) || []).filter(calendar => ids.some(id => id.equals(calendar.id)));
    // nothing is due before alertAt; a long gap since the last write is not expanded
    const from = Math.max(doc.alertFrom ? doc.alertFrom.getTime() : 0, doc.alertAt.getTime() - 1);
    let triggers = [];
    try {
        triggers = triggersBetween(entry.event, eventCalendars, from, effectiveNow);
    } catch (err) {
        if (err.code !== 'cannotCalculateOccurrences') {
            throw err;
        }
    }
    const next = nextTrigger(entry.event, eventCalendars, effectiveNow, { first: doc.first || null, last: doc.last || null });
    const claimed = await deps.database
        .collection(COLLECTION)
        .updateOne(
            { _id: doc._id, user: doc.user, alertAt: doc.alertAt, alertFrom: doc.alertFrom || null },
            { $set: { alertAt: next === null ? null : new Date(next), alertFrom: new Date(effectiveNow) } }
        );
    if (!claimed.modifiedCount) {
        // the event changed meanwhile, or another worker took it
        return [];
    }
    const userData = users.get(doc.user.toString());
    if (!userData || !eventCalendars.some(calendar => calendar.isSubscribed !== false)) {
        return [];
    }
    return fireTriggers(deps, doc, entry.event, triggers, userData, settings, effectiveNow);
}

/** An event that fails to process leaves the head of the queue (until it is written again), so it never blocks the others */
async function park(deps, doc, err) {
    log.error('JMAP', 'calendar alert event=%s error=%s', doc._id, err.message);
    await deps.database
        .collection(COLLECTION)
        .updateOne({ _id: doc._id, user: doc.user, alertAt: doc.alertAt }, { $set: { alertAt: null } })
        .catch(() => false);
}

/**
 * One batch: the due events in alertAt order, read first without their JSCalendar text, which is then
 * read EVENT_CHUNK events at a time, so a batch of large events never sits in memory at once.
 *
 * @returns {Promise<{count: Number, handled: Number, fired: Object[]}>} events due, events handled, fired triggers
 */
async function processBatch(deps, options, settings, now) {
    const collection = deps.database.collection(COLLECTION);
    const query = { alertAt: { $type: 'date', $lte: new Date(now + settings.jitter * 1000) } };
    if (options.user) {
        query.user = Array.isArray(options.user) ? { $in: options.user } : options.user;
    }
    const heads = await collection
        .find(query, { projection: { _id: true, user: true, calendarIds: true, alertAt: true }, maxTimeMS: MAX_TIME_MS })
        .sort({ alertAt: 1 })
        .limit(settings.batch)
        .toArray();
    const result = { count: heads.length, handled: 0, fired: [] };
    // events of a user whose jitter has not come yet wait for a later run
    const due = heads.filter(head => head.alertAt.getTime() <= now + jitterOf(head.user, settings));
    if (!due.length) {
        return result;
    }
    const userIds = [...new Map(due.map(doc => [doc.user.toString(), doc.user])).values()];
    const calendarIds = [...new Map(due.flatMap(doc => [].concat(doc.calendarIds || [])).map(id => [id.toString(), id])).values()];
    const [users, calendars] = await Promise.all([activeUsers(deps, userIds), calendarsByUser(deps, userIds, calendarIds)]);
    const context = { now, settings, users, calendars };
    for (let i = 0; i < due.length; i += EVENT_CHUNK) {
        const docs = await collection
            .find(
                { _id: { $in: due.slice(i, i + EVENT_CHUNK).map(doc => doc._id) }, user: { $in: userIds }, alertAt: { $type: 'date' } },
                { maxTimeMS: MAX_TIME_MS }
            )
            .toArray();
        for (const doc of docs) {
            try {
                result.fired.push(...(await processEvent(deps, doc, context)));
            } catch (err) {
                await park(deps, doc, err);
            }
            result.handled++;
        }
        if (options.renew) {
            await options.renew();
        }
    }
    return result;
}

/**
 * One scheduler run: the events whose next look is due, a batch at a time, while full batches come and
 * the run is within its time budget.
 *
 * @param {Object} deps {database, users, redis, notifier, messageHandler, settingsHandler, push}
 * @param {Object} [options] {now: epoch ms, settings, user: limit to a user or a list of users (tests),
 *   budget: ms a run may take (default the interval), renew: called between chunks to keep the lock}
 * @returns {Promise<Object[]>} the fired triggers
 */
async function processDue(deps, options = {}) {
    const settings = settingsOf(options.settings || deps.alertSettings);
    const now = options.now === undefined ? Date.now() : options.now;
    const deadline = Date.now() + (options.budget === undefined ? settings.interval * 1000 : options.budget);
    const fired = [];
    for (;;) {
        const batch = await processBatch(deps, options, settings, now);
        fired.push(...batch.fired);
        if (batch.count < settings.batch || !batch.handled || Date.now() >= deadline) {
            return fired;
        }
    }
}

/**
 * Computes the next alert time again for the events of a calendar that use its default alerts, after
 * the defaults changed. Not a change of the events (draft 5.5: clients learn it from the Calendar).
 *
 * @param {Object} deps {database}
 * @param {ObjectId} user
 * @param {ObjectId} calendarId
 * @param {Object[]} calendars all calendars of the user (calendar handler values, defaults already changed)
 */
async function rescheduleCalendar(deps, user, calendarId, calendars) {
    const collection = deps.database.collection(COLLECTION);
    // only events using the default alerts are read (defaultAlerts, see lib/calendar/events.js)
    const cursor = collection.find(
        { user, calendarIds: calendarId, defaultAlerts: true },
        { projection: { data: true, calendarIds: true, alertFrom: true, first: true, last: true }, maxTimeMS: MAX_TIME_MS, batchSize: EVENT_CHUNK }
    );
    const now = Date.now();
    let writes = [];
    for await (const doc of cursor) {
        const entry = fromDocument(doc);
        const eventCalendars = calendars.filter(calendar => entry.calendarIds.some(id => id.equals(calendar.id)));
        const fields = scheduleFields(entry.event, eventCalendars, Math.max(now, doc.alertFrom ? doc.alertFrom.getTime() : 0), {
            first: doc.first || null,
            last: doc.last || null
        });
        writes.push({ updateOne: { filter: { _id: doc._id, user }, update: { $set: fields } } });
        if (writes.length >= EVENT_CHUNK) {
            await collection.bulkWrite(writes, { ordered: false });
            writes = [];
        }
    }
    if (writes.length) {
        await collection.bulkWrite(writes, { ordered: false });
    }
}

/**
 * Starts the alert scheduler of a JMAP worker: a run every `interval` seconds by whichever worker holds
 * the lock. A run renews the lock while it works, so no second worker starts on the same due events.
 *
 * @returns {Function} stops the scheduler
 */
function startScheduler(deps, options) {
    const settings = settingsOf(options);
    const identity = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
    const lockSeconds = settings.interval * 3;
    const counters = deps.messageHandler && deps.messageHandler.counters;
    const renew = counters ? () => counters.processlock(LOCK_KEY, identity, lockSeconds).catch(() => false) : null;
    let stopped = false;
    let timer = null;
    const tick = async () => {
        try {
            const locked = await deps.redis.set(LOCK_KEY, identity, 'PX', lockSeconds * 1000, 'NX');
            if (locked) {
                try {
                    await processDue(deps, { settings, renew });
                } finally {
                    if ((await deps.redis.get(LOCK_KEY)) === identity) {
                        await deps.redis.del(LOCK_KEY);
                    }
                }
            }
        } catch (err) {
            log.error('JMAP', 'calendar alert run failed: %s', err.message);
        }
        if (!stopped) {
            timer = setTimeout(tick, settings.interval * 1000);
            timer.unref();
        }
    };
    timer = setTimeout(tick, settings.interval * 1000);
    timer.unref();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}

module.exports = {
    effectiveAlerts,
    triggersBetween,
    nextTrigger,
    scheduleFields,
    processDue,
    rescheduleCalendar,
    startScheduler,
    jitterOf,
    alertObject,
    settingsOf,
    DEFAULTS,
    MAX_DATE
};
