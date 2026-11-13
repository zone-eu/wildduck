'use strict';

// Calendar event storage (draft-ietf-jmap-calendars-33 5), usable by any front end.
//
// One document per stored event in `calendars.events`: a base event (with or without a recurrence rule)
// or a standalone instance (recurrenceId set, its base not stored). The JSCalendar object is kept as JSON
// text in `data`, because its keys are client chosen (vendor names hold dots and colons). Next to it the
// document holds what the server needs to find events without parsing them:
//
//   calendarIds   the calendars (ObjectIds); the unique index on {user, uid, recurrenceId} keeps one
//                 event per uid and recurrence id
//   first, last   the first start and the last end of all instances in UTC, a floating event read in
//                 Etc/UTC; last is LAST_UNBOUNDED for a rule without end. CalendarEvent/query preselects
//                 on them with a margin of a day, which covers any reading of a floating event
//   startAt, endAt  the exact start and end of the event itself, read the same way: a query answers
//                 single events and sorts by start without parsing the JSCalendar text
//   search        lower case text of the string filters, base event and overrides together
//   blobs         uploads the links name, kept alive while referenced
//   alertAt       the next time the alert scheduler looks at the event (lib/calendar/alerts.js), with
//   alertFrom     the time up to which alerts were handled
//   defaultAlerts true when the event uses the default alerts of its calendars (rescheduled when they change)
//
// Every write takes a number of the CalendarEvent change sequence (lib/jmap/changelog.js).

const { ObjectId } = require('mongodb');
const { changeWriter } = require('../jmap/changelog');
const recurrence = require('./recurrence');
const consts = require('../consts');

const COLLECTION = 'calendars.events';
const TYPE = 'CalendarEvent';
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
// the last end of an event without an end of its recurrence
const LAST_UNBOUNDED = new Date('9999-12-31T00:00:00Z');
// lower case text kept per search field
const MAX_SEARCH = 16 * 1024;

const lower = values =>
    values
        .filter(value => typeof value === 'string' && value)
        .join('\n')
        .toLowerCase()
        .slice(0, MAX_SEARCH);

const objectValues = value => (value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : []);

/** The values one instance (base event or patched) gives to the search fields */
function searchValues(event, out) {
    out.title.push(event.title);
    out.description.push(event.description);
    for (const location of objectValues(event.locations)) {
        out.location.push(location && location.name);
    }
    for (const location of objectValues(event.virtualLocations)) {
        out.location.push(location && location.name);
    }
    for (const participant of objectValues(event.participants)) {
        if (!participant) {
            continue;
        }
        const values = [participant.name, participant.email, participant.calendarAddress];
        out.participant.push(...values);
        if (participant.roles && participant.roles.owner === true) {
            out.owner.push(...values);
        }
    }
}

/** The values a JSON pointer patch of an override gives: top level and second level text */
function patchValues(patch, out) {
    for (const [key, value] of Object.entries(patch || {})) {
        const tokens = key.split('/');
        if (tokens.length === 1 && ['title', 'description'].includes(key)) {
            out[key].push(value);
        } else if (['locations', 'virtualLocations'].includes(tokens[0])) {
            const values = tokens.length === 1 ? objectValues(value) : tokens.length === 2 ? [value] : [];
            values.forEach(location => out.location.push(location && location.name));
            if (tokens.length === 3 && tokens[2] === 'name') {
                out.location.push(value);
            }
        } else if (tokens[0] === 'participants') {
            const values = tokens.length === 1 ? objectValues(value) : tokens.length === 2 ? [value] : [];
            searchValues({ participants: Object.assign({}, values) }, out);
            if (tokens.length === 3 && ['name', 'email'].includes(tokens[2])) {
                out.participant.push(value);
            }
        }
    }
}

/** Lower case text of the string filters (draft 5.8.1) over the base event and every override */
function searchOf(event) {
    const out = { title: [], description: [], location: [], participant: [], owner: [] };
    searchValues(event, out);
    for (const patch of objectValues(event.recurrenceOverrides)) {
        patchValues(patch, out);
    }
    return Object.fromEntries(Object.entries(out).map(([key, values]) => [key, lower(values)]));
}

/** The upload ids the links of an event (and of its locations) name: B + u + 24 hex */
function blobsOf(event) {
    const ids = new Set();
    const collect = links => {
        for (const link of objectValues(links)) {
            if (link && typeof link.blobId === 'string' && /^Bu[0-9a-f]{24}$/.test(link.blobId)) {
                ids.add(link.blobId.slice(2));
            }
        }
    };
    collect(event.links);
    objectValues(event.locations).forEach(location => collect(location && location.links));
    objectValues(event.participants).forEach(participant => collect(participant && participant.links));
    return [...ids].map(id => new ObjectId(id));
}

/**
 * The first start and last end of all instances, a floating event read in Etc/UTC. A rule that can
 * not be expanded within the limits counts as unbounded.
 */
function boundsOf(event) {
    try {
        const { first, last } = recurrence.bounds(event, {});
        return { first: new Date(first), last: last === null ? LAST_UNBOUNDED : new Date(last) };
    } catch (err) {
        if (err.code !== 'cannotCalculateOccurrences') {
            throw err;
        }
        return { first: new Date(recurrence.localToUtc(event.start, event.timeZone || null)), last: LAST_UNBOUNDED };
    }
}

/** The exact UTC start and end of the event itself (its first occurrence), a floating one read in Etc/UTC */
function timesOf(event) {
    const zone = event.timeZone || 'Etc/UTC';
    return {
        startAt: new Date(recurrence.localToUtc(event.start, zone)),
        endAt: new Date(recurrence.addDuration(event.start, event.duration || 'PT0S', zone))
    };
}

const dateOf = value => (typeof value === 'string' ? new Date(value) : null);

/**
 * The stored fields of an event besides user, ids and sequences.
 *
 * @param {Object} event the JSCalendar object to store (no JMAP only properties)
 * @param {ObjectId[]} calendarIds
 */
function fieldsOf(event, calendarIds) {
    const data = JSON.stringify(event);
    return Object.assign(
        {
            calendarIds,
            uid: event.uid,
            recurrenceId: typeof event.recurrenceId === 'string' ? event.recurrenceId : null,
            data,
            size: Buffer.byteLength(data),
            recurring: !!event.recurrenceRule || !!event.recurrenceOverrides,
            floating: !event.timeZone,
            isDraft: event.isDraft === true,
            defaultAlerts: event.useDefaultAlerts === true,
            created: dateOf(event.created),
            updated: dateOf(event.updated),
            search: searchOf(event),
            blobs: blobsOf(event)
        },
        boundsOf(event),
        timesOf(event)
    );
}

/** The stored event as plain values: {id, user, calendarIds, event, createdSeq, modSeq, alertAt, alertFrom} */
function fromDocument(doc) {
    return {
        id: doc._id,
        user: doc.user,
        calendarIds: [].concat(doc.calendarIds || []),
        event: doc.data ? JSON.parse(doc.data) : { uid: doc.uid },
        createdSeq: doc.createdSeq || 0,
        modSeq: doc.modSeq || 0,
        alertAt: doc.alertAt || null,
        alertFrom: doc.alertFrom || null,
        doc
    };
}

const isDuplicate = err => err && err.code === 11000;

class EventStore {
    /**
     * @param {Object} options
     * @param {Db} options.database
     */
    constructor(options) {
        this.database = options.database;
        this.log = changeWriter(this.database);
    }

    collection() {
        return this.database.collection(COLLECTION);
    }

    /** Events of a user by id (ObjectIds); answers a Map of hex id to fromDocument() values */
    async byIds(user, ids, options = {}) {
        if (!ids.length) {
            return new Map();
        }
        const docs = await this.collection()
            .find({ user, _id: { $in: ids } }, { projection: options.projection, maxTimeMS: MAX_TIME_MS })
            .toArray();
        return new Map(docs.map(doc => [doc._id.toString(), fromDocument(doc)]));
    }

    /** All events of a user, at most `limit` (answers limit + 1 documents when there are more) */
    async all(user, limit) {
        const docs = await this.collection()
            .find({ user }, { maxTimeMS: MAX_TIME_MS })
            .limit(limit + 1)
            .toArray();
        return docs.map(fromDocument);
    }

    /** Events matching a query of the user's events, raw documents */
    find(user, query, options = {}) {
        return this.collection()
            .find(Object.assign({}, query, { user }), { projection: options.projection, maxTimeMS: MAX_TIME_MS })
            .limit(options.limit || 0)
            .toArray();
    }

    /** The events sharing a uid: {_id, recurrenceId, data} */
    async byUid(user, uid) {
        return this.collection()
            .find({ user, uid }, { projection: { _id: true, recurrenceId: true, data: true, createdSeq: true }, maxTimeMS: MAX_TIME_MS })
            .limit(1000)
            .toArray();
    }

    count(user, limit) {
        return this.collection().countDocuments({ user }, { limit, maxTimeMS: MAX_TIME_MS });
    }

    /**
     * Stores a new event.
     *
     * @returns {Promise<ObjectId>}
     * @throws {Error} code UidExists when the uid and recurrenceId pair is taken
     */
    async insert(user, event, calendarIds, extra = {}) {
        const seq = await this.log.next(user, TYPE);
        const doc = Object.assign({ _id: new ObjectId(), user }, fieldsOf(event, calendarIds), extra, { createdSeq: seq, modSeq: seq });
        try {
            await this.collection().insertOne(doc);
        } catch (err) {
            if (isDuplicate(err)) {
                throw Object.assign(new Error('An event with this uid exists'), { code: 'UidExists' });
            }
            throw err;
        }
        return doc._id;
    }

    /**
     * Replaces the stored object of an event.
     *
     * @param {Object} [options] {modSeq: replace only while the event is at this modSeq}
     * @returns {Promise<Boolean>} false when the event is gone, or changed since modSeq
     */
    async replace(user, id, event, calendarIds, extra = {}, options = {}) {
        const seq = await this.log.next(user, TYPE);
        const filter = options.modSeq === undefined ? { _id: id, user } : { _id: id, user, modSeq: options.modSeq };
        const fields = Object.assign(fieldsOf(event, calendarIds), extra, { modSeq: seq });
        const update = { $set: fields };
        if (fields.alertFrom instanceof Date) {
            // alerts handled up to a time stay handled: a scheduler run that claimed the event after it was
            // read for this write may have moved alertFrom further already
            update.$max = { alertFrom: fields.alertFrom };
            delete fields.alertFrom;
        }
        const res = await this.collection().updateOne(filter, update);
        return res.matchedCount > 0;
    }

    /**
     * Destroys an event.
     *
     * @returns {Promise<Object|null>} the removed document, null when it did not exist
     */
    async remove(user, id) {
        const doc = await this.collection().findOneAndDelete({ _id: id, user }, { projection: { _id: true, createdSeq: true, blobs: true } });
        if (!doc) {
            return null;
        }
        const seq = await this.log.next(user, TYPE);
        await this.log.destroyed(user, TYPE, [{ id, createdSeq: doc.createdSeq || 0 }], seq);
        return doc;
    }

    /** True when an event of the user names the upload */
    async references(user, fileId, exceptId) {
        const query = { user, blobs: fileId };
        if (exceptId) {
            query._id = { $ne: exceptId };
        }
        return !!(await this.collection().findOne(query, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS }));
    }

    /** The events of the user that name one of the uploads: {fileId hex: [event ids]} */
    async referencing(user, fileIds) {
        const docs = await this.collection()
            .find({ user, blobs: { $in: fileIds } }, { projection: { _id: true, blobs: true }, maxTimeMS: MAX_TIME_MS })
            .limit(1000)
            .toArray();
        const result = new Map();
        for (const doc of docs) {
            for (const blob of doc.blobs || []) {
                const key = blob.toString();
                result.set(key, (result.get(key) || []).concat(doc._id));
            }
        }
        return result;
    }
}

module.exports = { EventStore, fromDocument, fieldsOf, searchOf, blobsOf, COLLECTION, TYPE, LAST_UNBOUNDED, MAX_TIME_MS };
