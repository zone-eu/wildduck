'use strict';

// Calendar storage (draft-ietf-jmap-calendars-33 4 and 5), usable by any front end.
//
// A user's calendars live in `calendars`, the events in `calendarevents`, each event naming its
// calendars in `calendarIds` (an array of calendar ObjectIds). Every write takes a number of the
// per user change sequence of its type (lib/jmap/changelog.js), so JMAP /changes sees changes made
// by any writer. Calendars are created lazily: a user gets the default calendar on the first
// calendar access, never before. Exactly one calendar of a user is the default; a unique partial
// index keeps two concurrent first accesses from creating two.

const { ObjectId } = require('mongodb');
const { changeWriter } = require('./jmap/changelog');
const consts = require('./consts');

const CALENDARS = 'calendars';
const EVENTS = 'calendarevents';
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
// events are removed from a destroyed calendar in batches of this size
const EVENT_BATCH = 1000;

// the defaults of plan 1.3; all of them can be changed in [jmap.calendars]
const DEFAULT_LIMITS = Object.freeze({
    maxCalendars: 1000,
    maxCalendarsPerEvent: 1,
    maxEventsPerAccount: 50000,
    maxParticipantsPerEvent: 500,
    minDateTime: '1900-01-01T00:00:00Z',
    maxDateTime: '2199-12-31T23:59:59Z',
    maxExpandedQueryDuration: 'P366D',
    defaultName: 'Calendar'
});

// the properties a calendar stores, and their defaults on create
const CALENDAR_DEFAULTS = Object.freeze({
    name: '',
    description: null,
    color: null,
    sortOrder: 0,
    isSubscribed: true,
    isVisible: true,
    includeInAvailability: 'all',
    timeZone: null,
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null
});
// alert maps are stored as JSON text: their keys are client chosen and may hold vendor property names
const JSON_FIELDS = ['defaultAlertsWithTime', 'defaultAlertsWithoutTime'];

// a time zone of null means UTC, as there are no principals to inherit one from (plan 1.3)
const effectiveTimeZone = calendar => (calendar && calendar.timeZone) || 'Etc/UTC';

const calendarLimits = options => Object.assign({}, DEFAULT_LIMITS, options || {});

function toDocument(values) {
    const doc = {};
    for (const [key, value] of Object.entries(values)) {
        if (Object.hasOwn(CALENDAR_DEFAULTS, key)) {
            doc[key] = JSON_FIELDS.includes(key) && value !== null ? JSON.stringify(value) : value;
        }
    }
    return doc;
}

/** The stored calendar as plain values: {id, user, isDefault, createdSeq, modSeq, ...CALENDAR_DEFAULTS keys} */
function fromDocument(doc) {
    const calendar = { id: doc._id, user: doc.user, isDefault: doc.isDefault === true, createdSeq: doc.createdSeq, modSeq: doc.modSeq };
    for (const [key, fallback] of Object.entries(CALENDAR_DEFAULTS)) {
        const value = doc[key] === undefined ? fallback : doc[key];
        calendar[key] = JSON_FIELDS.includes(key) && typeof value === 'string' ? JSON.parse(value) : value;
    }
    return calendar;
}

const calendarError = (code, message) => Object.assign(new Error(message), { code });
const isDuplicate = err => err && err.code === 11000;

class CalendarHandler {
    /**
     * @param {Object} options
     * @param {Db} options.database
     * @param {Object} [options.limits] overrides of DEFAULT_LIMITS
     */
    constructor(options) {
        this.database = options.database;
        this.limits = calendarLimits(options.limits);
        this.log = changeWriter(this.database);
    }

    collection() {
        return this.database.collection(CALENDARS);
    }

    async find(user) {
        const docs = await this.collection()
            .find({ user }, { maxTimeMS: MAX_TIME_MS })
            .sort({ sortOrder: 1, _id: 1 })
            .limit(this.limits.maxCalendars + 1)
            .toArray();
        return docs.map(fromDocument);
    }

    /**
     * The calendars of a user, in display order, after making sure exactly one of them is the default:
     * a user without calendars gets the default calendar, a user without a default gets one promoted.
     *
     * @param {ObjectId} user
     * @returns {Promise<Object[]>} calendars, see fromDocument()
     */
    async list(user) {
        const calendars = await this.find(user);
        if (calendars.some(calendar => calendar.isDefault)) {
            return calendars;
        }
        try {
            if (!calendars.length) {
                await this.insert(user, { name: this.limits.defaultName }, true);
            } else {
                await this.promote(user, calendars);
            }
        } catch (err) {
            // a concurrent request made a default first
            if (!isDuplicate(err)) {
                throw err;
            }
        }
        return this.find(user);
    }

    // the first of the calendars in display order (lowest sortOrder, then oldest) becomes the default
    async promote(user, calendars) {
        const [first] = calendars;
        const seq = await this.log.next(user, 'Calendar');
        await this.collection().updateOne({ _id: first.id, user }, { $set: { isDefault: true, modSeq: seq } });
        return first.id;
    }

    async insert(user, values, isDefault) {
        const seq = await this.log.next(user, 'Calendar');
        const doc = Object.assign({ _id: new ObjectId(), user }, CALENDAR_DEFAULTS, toDocument(values), { created: new Date(), createdSeq: seq, modSeq: seq });
        if (isDefault) {
            doc.isDefault = true;
        }
        await this.collection().insertOne(doc);
        return fromDocument(doc);
    }

    /**
     * Creates a calendar.
     *
     * @param {ObjectId} user
     * @param {Object} values calendar properties (CALENDAR_DEFAULTS keys), validated by the caller
     * @returns {Promise<Object>} the calendar
     * @throws {Error} code CalendarLimit when the user has maxCalendars calendars
     */
    async create(user, values) {
        const count = await this.collection().countDocuments({ user }, { limit: this.limits.maxCalendars, maxTimeMS: MAX_TIME_MS });
        if (count >= this.limits.maxCalendars) {
            throw calendarError('CalendarLimit', `An account has at most ${this.limits.maxCalendars} calendars`);
        }
        return this.insert(user, values, false);
    }

    /**
     * Changes properties of a calendar.
     *
     * @returns {Promise<Boolean>} false when the calendar does not exist
     */
    async update(user, id, values) {
        const seq = await this.log.next(user, 'Calendar');
        const res = await this.collection().updateOne({ _id: id, user }, { $set: Object.assign(toDocument(values), { modSeq: seq }) });
        return res.matchedCount > 0;
    }

    /**
     * Makes a calendar the default (draft 4.3 onSuccessSetIsDefault).
     *
     * @returns {Promise<{previous: ObjectId|null}|null>} the calendar that was the default, or null when
     *   nothing changed (already the default, or the calendar does not exist)
     */
    async setDefault(user, id) {
        const [target, current] = await Promise.all([
            this.collection().findOne({ _id: id, user }, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS }),
            this.collection().findOne({ user, isDefault: true }, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS })
        ]);
        if (!target || (current && current._id.equals(id))) {
            return null;
        }
        const seq = await this.log.next(user, 'Calendar', 2);
        if (current) {
            await this.collection().updateOne({ _id: current._id, user }, { $unset: { isDefault: true }, $set: { modSeq: seq } });
        }
        try {
            const res = await this.collection().updateOne({ _id: id, user }, { $set: { isDefault: true, modSeq: seq + 1 } });
            if (!res.matchedCount) {
                throw calendarError('CalendarNotFound', 'The calendar is gone');
            }
        } catch (err) {
            // the calendar went away, or a concurrent request promoted another one: the next list() repairs
            if (isDuplicate(err) || err.code === 'CalendarNotFound') {
                return null;
            }
            throw err;
        }
        return { previous: current ? current._id : null };
    }

    /** True when at least one event is in the calendar */
    async hasEvents(user, id) {
        return !!(await this.database.collection(EVENTS).findOne({ user, calendarIds: id }, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS }));
    }

    /**
     * Destroys a calendar (draft 4.3).
     *
     * @param {ObjectId} user
     * @param {ObjectId} id
     * @param {Object} [options] {removeEvents: also take the events out of it, destroying those in no other calendar}
     * @returns {Promise<{wasDefault: Boolean}>}
     * @throws {Error} code CalendarNotFound, or CalendarHasEvent when it has events and removeEvents is not set
     */
    async destroy(user, id, options = {}) {
        const doc = await this.collection().findOne({ _id: id, user }, { projection: { isDefault: true, createdSeq: true }, maxTimeMS: MAX_TIME_MS });
        if (!doc) {
            throw calendarError('CalendarNotFound', 'No such calendar');
        }
        if (await this.hasEvents(user, id)) {
            if (!options.removeEvents) {
                throw calendarError('CalendarHasEvent', 'The calendar has events');
            }
            await this.removeEvents(user, id);
        }
        const seq = await this.log.next(user, 'Calendar');
        const res = await this.collection().deleteOne({ _id: id, user });
        if (!res.deletedCount) {
            throw calendarError('CalendarNotFound', 'No such calendar');
        }
        await this.log.destroyed(user, 'Calendar', [{ id, createdSeq: doc.createdSeq }], seq);
        return { wasDefault: doc.isDefault === true };
    }

    /**
     * Takes every event out of a calendar: an event in no other calendar is destroyed, any other loses
     * the calendar from its calendarIds. Bounded batches, each change in the CalendarEvent change log.
     */
    async removeEvents(user, id) {
        const events = this.database.collection(EVENTS);
        for (;;) {
            const batch = await events
                .find({ user, calendarIds: id }, { projection: { _id: true, createdSeq: true, calendarIds: true }, maxTimeMS: MAX_TIME_MS })
                .limit(EVENT_BATCH)
                .toArray();
            if (!batch.length) {
                return;
            }
            // an event whose only calendar this is goes away; [].concat() also takes a lone id
            const destroyed = batch.filter(event => [].concat(event.calendarIds).length <= 1);
            const kept = batch.filter(event => [].concat(event.calendarIds).length > 1);
            const seq = await this.log.next(user, 'CalendarEvent', batch.length);
            if (destroyed.length) {
                await events.deleteMany({ user, _id: { $in: destroyed.map(event => event._id) } });
                await this.log.destroyed(
                    user,
                    'CalendarEvent',
                    destroyed.map(event => ({ id: event._id, createdSeq: event.createdSeq })),
                    seq
                );
            }
            if (kept.length) {
                await events.bulkWrite(
                    kept.map((event, i) => ({
                        updateOne: { filter: { _id: event._id, user }, update: { $pull: { calendarIds: id }, $set: { modSeq: seq + destroyed.length + i } } }
                    })),
                    { ordered: false }
                );
            }
        }
    }
}

module.exports = { CalendarHandler, DEFAULT_LIMITS, CALENDAR_DEFAULTS, calendarLimits, effectiveTimeZone, fromDocument, CALENDARS, EVENTS };
