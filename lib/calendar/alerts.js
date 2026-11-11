'use strict';

// Calendar alerts (draft-ietf-jmap-calendars-33 5.5, 7; JSCalendar bis 3.5).
//
// Scheduling. Every event keeps the next time the scheduler must look at it (`alertAt`, the earliest
// trigger still to come) and the time up to which its alerts were handled (`alertFrom`); both are
// computed when the event is written (lib/jmap/types/calendar-event.js), with alertFrom no earlier
// than the moment of the write, so alerts whose time had passed when they were written never fire.
// One worker at a time (a Redis lock) reads the due events on the partial {alertAt} index in batches,
// fires the triggers in (alertFrom, now], and moves both fields on, claiming the event with a
// conditional update so a trigger fires once. Nothing ever scans all events.
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
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// how far ahead the next trigger is looked for
const HORIZON = 300 * 366 * 24 * HOUR;
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

/** The largest distances triggers can lie before a start and after an end, over the base and the overrides */
function triggerSpan(event, calendars) {
    let before = 0;
    let after = 0;
    const consider = alertMap => {
        for (const alert of Object.values(alertMap || {})) {
            const offset = isObject(alert) ? offsetOf(alert.trigger) : null;
            if (offset !== null) {
                before = Math.max(before, -offset);
                after = Math.max(after, offset);
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
    return { before, after };
}

const hasAlerts = (event, calendars) =>
    Object.keys(event.alerts || {}).length > 0 ||
    (event.useDefaultAlerts && calendars.some(calendar => calendar.defaultAlertsWithTime || calendar.defaultAlertsWithoutTime)) ||
    Object.values(event.recurrenceOverrides || {}).some(patch => Object.keys(patch || {}).some(key => key === 'alerts' || key.startsWith('alerts/')));

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
        if (at > from && at <= to && !(alert.acknowledged && Date.parse(alert.acknowledged) >= at)) {
            triggers.push({ alertId, recurrenceId, at, action: alert.action || 'display', alert });
        }
    };
    const recurring = !!(event.recurrenceRule || event.recurrenceOverrides);
    // absolute triggers fire once per event
    for (const [id, alert] of Object.entries(effectiveAlerts(event, calendars))) {
        const at = isObject(alert) ? absoluteOf(alert.trigger) : null;
        if (at !== null) {
            add(id, alert, at, event.recurrenceId || null);
        }
    }
    const span = triggerSpan(event, calendars);
    const zone = floatingZone(calendars);
    const { instances } = recurrence.expandEvent(event, { timeZone: zone, from: from - span.after - 1, to: to + span.before + 1 });
    for (const instance of instances) {
        const values = recurring && instance.recurrenceId ? instanceOf(event, instance.recurrenceId) : event;
        if (values.isDraft === true) {
            continue;
        }
        for (const [id, alert] of Object.entries(effectiveAlerts(values, calendars))) {
            const offset = isObject(alert) ? offsetOf(alert.trigger) : null;
            if (offset !== null) {
                const anchor = alert.trigger.relativeTo === 'end' ? instance.utcEnd : instance.utcStart;
                add(id, alert, anchor + offset, recurring ? instance.recurrenceId : event.recurrenceId || null);
            }
        }
    }
    return triggers.sort((a, b) => a.at - b.at || String(a.alertId).localeCompare(String(b.alertId)));
}

/**
 * The first trigger in (from, to]. A window with too many instances to expand is split in halves, so a
 * dense rule (minutely) still finds its next trigger; below a minute the search gives up.
 */
function firstTrigger(event, calendars, from, to) {
    try {
        const [first] = triggersBetween(event, calendars, from, to);
        return first ? first.at : null;
    } catch (err) {
        if (err.code !== 'cannotCalculateOccurrences' || to - from <= MINUTE) {
            if (err.code === 'cannotCalculateOccurrences') {
                return null;
            }
            throw err;
        }
        const middle = from + Math.floor((to - from) / 2);
        const early = firstTrigger(event, calendars, from, middle);
        return early !== null ? early : firstTrigger(event, calendars, middle, to);
    }
}

/** The first trigger after `after`, or null: windows growing from an hour up to the horizon */
function nextTrigger(event, calendars, after) {
    if (event.isDraft === true || !hasAlerts(event, calendars)) {
        return null;
    }
    let start = after;
    for (let size = HOUR; start < after + HORIZON; size *= 4) {
        const at = firstTrigger(event, calendars, start, start + size);
        if (at !== null) {
            return at;
        }
        start += size;
    }
    return null;
}

/**
 * The scheduling fields of an event being written: handled up to `from`, next look at the first
 * trigger after it.
 *
 * @returns {{alertAt: Date|null, alertFrom: Date}}
 */
function scheduleFields(event, calendars, from) {
    const next = nextTrigger(event, calendars, from);
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

/** Delivers an email alert into the user's INBOX and acknowledges the alert on the event */
async function sendEmailAlert(deps, doc, event, trigger, userData, now) {
    const inbox = await deps.database.collection('mailboxes').findOne({ user: doc.user, path: 'INBOX' }, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS });
    if (!inbox || !userData.address) {
        return false;
    }
    const raw = await alertMessage(userData, event, trigger);
    await deps.messageHandler.addAsync({
        user: doc.user,
        mailbox: inbox._id,
        meta: { source: 'JMAP', from: '', origin: '', transtype: 'CALENDAR-ALERT', time: new Date() },
        date: new Date(),
        flags: [],
        raw
    });
    await acknowledge(deps, doc, trigger, now);
    return true;
}

/** Sets acknowledged of a fired alert on the base event (draft 5.5): a change of the event */
async function acknowledge(deps, doc, trigger, now) {
    const current = await deps.database
        .collection(COLLECTION)
        .findOne({ _id: doc._id, user: doc.user }, { projection: { data: true }, maxTimeMS: MAX_TIME_MS });
    if (!current || !current.data) {
        return;
    }
    const event = JSON.parse(current.data);
    if (!isObject(event.alerts) || !isObject(event.alerts[trigger.alertId])) {
        return;
    }
    event.alerts[trigger.alertId].acknowledged = formatUTCDate(now, { seconds: true });
    await new EventStore({ database: deps.database }).replace(doc.user, doc._id, event, [].concat(doc.calendarIds || []), {});
    if (deps.notifier) {
        deps.notifier.fire(doc.user);
    }
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

/** Users that can get alerts: existing, not disabled, not suspended */
async function activeUsers(deps, users) {
    const docs = await deps.users
        .collection('users')
        .find({ _id: { $in: users } }, { projection: { address: true, disabled: true, suspended: true }, maxTimeMS: MAX_TIME_MS })
        .toArray();
    return new Map(docs.filter(doc => !doc.disabled && !doc.suspended).map(doc => [doc._id.toString(), doc]));
}

async function calendarsByUser(deps, users) {
    const docs = await deps.database
        .collection('calendars')
        .find({ user: { $in: users } }, { maxTimeMS: MAX_TIME_MS })
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
    const next = nextTrigger(entry.event, eventCalendars, effectiveNow);
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

/**
 * One scheduler run: the events whose next look is due, a batch at a time.
 *
 * @param {Object} deps {database, users, redis, notifier, messageHandler, push}
 * @param {Object} [options] {now: epoch ms, settings, user: limit to a user or a list of users (tests)}
 * @returns {Promise<Object[]>} the fired triggers
 */
async function processDue(deps, options = {}) {
    const settings = settingsOf(options.settings || deps.alertSettings);
    const now = options.now === undefined ? Date.now() : options.now;
    const query = { alertAt: { $type: 'date', $lte: new Date(now + settings.jitter * 1000) } };
    if (options.user) {
        query.user = Array.isArray(options.user) ? { $in: options.user } : options.user;
    }
    const docs = await deps.database.collection(COLLECTION).find(query, { maxTimeMS: MAX_TIME_MS }).sort({ alertAt: 1 }).limit(settings.batch).toArray();
    if (!docs.length) {
        return [];
    }
    const userIds = [...new Map(docs.map(doc => [doc.user.toString(), doc.user])).values()];
    const [users, calendars] = await Promise.all([activeUsers(deps, userIds), calendarsByUser(deps, userIds)]);
    const fired = [];
    for (const doc of docs) {
        try {
            fired.push(...(await processEvent(deps, doc, { now, settings, users, calendars })));
        } catch (err) {
            log.error('JMAP', 'calendar alert event=%s error=%s', doc._id, err.message);
        }
    }
    return fired;
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
    const cursor = collection.find(
        { user, calendarIds: calendarId },
        { projection: { data: true, calendarIds: true, alertFrom: true }, maxTimeMS: MAX_TIME_MS }
    );
    const now = Date.now();
    for await (const doc of cursor) {
        const entry = fromDocument(doc);
        if (entry.event.useDefaultAlerts !== true) {
            continue;
        }
        const eventCalendars = calendars.filter(calendar => entry.calendarIds.some(id => id.equals(calendar.id)));
        const fields = scheduleFields(entry.event, eventCalendars, Math.max(now, doc.alertFrom ? doc.alertFrom.getTime() : 0));
        await collection.updateOne({ _id: doc._id, user }, { $set: fields });
    }
}

/**
 * Starts the alert scheduler of a JMAP worker: a run every `interval` seconds by whichever worker holds
 * the lock.
 *
 * @returns {Function} stops the scheduler
 */
function startScheduler(deps, options) {
    const settings = settingsOf(options);
    const identity = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
    let stopped = false;
    let timer = null;
    const tick = async () => {
        try {
            const locked = await deps.redis.set(LOCK_KEY, identity, 'PX', settings.interval * 3000, 'NX');
            if (locked) {
                try {
                    await processDue(deps, { settings });
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
