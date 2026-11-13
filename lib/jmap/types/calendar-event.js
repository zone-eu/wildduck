'use strict';

// CalendarEvent/get, /changes, /set and /copy (draft-ietf-jmap-calendars-33 5), and the
// CalendarEventNotification methods (draft 6), which answer empty results: without sharing and
// scheduling nothing creates a notification.
//
// Storage is lib/calendar/events.js, the object model lib/jmap/calendar-event-model.js. An instance
// of a recurring event has a synthetic id (the base id and its recurrence id); updating it writes an
// override of the base event, destroying it excludes the occurrence. /changes only ever reports stored
// events. Writes go through the owned change log (type CalendarEvent).

const crypto = require('crypto');
const { URN } = require('../capabilities');
const { formatId, parseId, parseBlobId, blobId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { requireAccount, checkArguments, isObject } = require('./common');
const { changeLogFor } = require('../changelog');
const { applyPatch } = require('../patch');
const { runSet, resolveId } = require('../set');
const { maxChangesOf } = require('../state');
const { parseUTCDate } = require('../utcdate');
const { loadCalendars } = require('./calendar');
const { calendarAddressOf } = require('./participant-identity');
const { calendarLimits } = require('../../calendar-handler');
const { EventStore, blobsOf, MAX_TIME_MS } = require('../../calendar/events');
const recurrence = require('../../calendar/recurrence');
const alerts = require('../../calendar/alerts');
const { isTimeZoneId } = require('../../schemas/jscalendar');
const model = require('../calendar-event-model');

const TYPE = 'CalendarEvent';
const COLLECTION = 'calendars.events';
// largest stored event (JSON octets); [jmap.calendars] maxEventSize
const MAX_EVENT_SIZE = 256 * 1024;
// the time the recurrence expansions of one CalendarEvent/query may take in all (ms); [jmap.calendars] maxQueryExpansionTime
const MAX_QUERY_EXPANSION_TIME = 1000;
// largest data: URI turned into a blob
const MAX_DATA_URI = 4 * 1024 * 1024;
// uploads named by an event do not expire while it exists
const PINNED = new Date('9999-01-01T00:00:00Z');

// ---------------------------------------------------------------- request scoped helpers

function storeFor(context) {
    if (!context.deps.eventStore) {
        context.deps.eventStore = new EventStore({ database: context.deps.database });
    }
    return context.deps.eventStore;
}

const limitsOf = context =>
    Object.assign(
        { maxEventSize: MAX_EVENT_SIZE, maxQueryExpansionTime: MAX_QUERY_EXPANSION_TIME },
        calendarLimits(context.options && context.options.calendars)
    );

/** The user's addresses in lower case and the main address, read once per request */
function ownAddresses(context) {
    if (!context.cache.ownAddresses) {
        const user = context.account.user;
        context.cache.ownAddresses = Promise.all([
            context.deps.users
                .collection('addresses')
                .find({ user }, { projection: { address: true }, maxTimeMS: MAX_TIME_MS })
                .limit(5000)
                .toArray(),
            context.deps.users.collection('users').findOne({ _id: user }, { projection: { address: true }, maxTimeMS: MAX_TIME_MS })
        ]).then(([addresses, userData]) => ({
            all: new Set(addresses.map(entry => String(entry.address).toLowerCase())),
            main: userData && userData.address
        }));
    }
    return context.cache.ownAddresses;
}

const state = context => changeLogFor(context).state(context.account.user, context.account.id, TYPE);

const calendarIdsMap = ids => Object.fromEntries(ids.map(id => [formatId('calendar', id), true]));

/** The calendars (handler values) an event is in */
const calendarsOf = (calendars, ids) => ids.map(id => calendars.find(calendar => calendar.id.equals(id))).filter(Boolean);

// ---------------------------------------------------------------- reading

/**
 * The CalendarEvent object of a stored event or of one of its instances.
 *
 * @returns {Object|null} null for an instance that does not exist
 */
function eventObject(entry, recurrenceId, addresses) {
    let object;
    if (recurrenceId) {
        const kind = model.occurrenceOf(entry.event, recurrenceId);
        if (kind !== 'rule' && kind !== 'added') {
            return null;
        }
        object = model.instanceOf(entry.event, recurrenceId);
        object.id = model.instanceId(entry.id, recurrenceId);
        object.baseEventId = formatId('calendarEvent', entry.id);
    } else {
        object = model.clone(entry.event);
        object.id = formatId('calendarEvent', entry.id);
    }
    object.calendarIds = calendarIdsMap(entry.calendarIds);
    object.isOrigin = model.isOriginOf(object, addresses);
    return object;
}

/** recurrenceOverridesBefore and recurrenceOverridesAfter (draft 5.7): keys by their time in the event's zone */
function filterOverrides(object, options, timeZone) {
    if (!isObject(object.recurrenceOverrides) || (options.after === null && options.before === null)) {
        return;
    }
    const zone = object.timeZone || timeZone || 'Etc/UTC';
    object.recurrenceOverrides = Object.fromEntries(
        Object.entries(object.recurrenceOverrides).filter(([key]) => {
            const at = recurrence.localToUtc(key, zone);
            return (options.after === null || at >= options.after) && (options.before === null || at < options.before);
        })
    );
}

/** The returned properties of an object: every stored one, or the requested ones */
function pickProperties(object, properties, instance) {
    if (!properties) {
        return object;
    }
    const result = { id: object.id };
    for (const property of properties) {
        if (Object.hasOwn(object, property)) {
            result[property] = object[property];
        } else if (instance && ['recurrenceRule', 'recurrenceOverrides'].includes(property)) {
            result[property] = null;
        } else if (!instance && property === 'baseEventId') {
            result[property] = null;
        }
    }
    return result;
}

const optionalUTC = (value, name) => {
    if (value === undefined || value === null) {
        return null;
    }
    const date = parseUTCDate(value);
    if (!date) {
        throw invalidArguments(`${name} must be a UTCDateTime`);
    }
    return date.getTime();
};

function getOptions(args) {
    const properties = args.properties === undefined || args.properties === null ? null : args.properties;
    if (properties !== null && !(Array.isArray(properties) && properties.every(property => typeof property === 'string'))) {
        throw invalidArguments('properties must be a list of property names');
    }
    if (properties && properties.includes('iCalendar')) {
        // the JSCalendar to iCalendar conversion arrives with scheduling (phase 7)
        throw invalidArguments('iCalendar is not supported');
    }
    const utc = !!properties && (properties.includes('utcStart') || properties.includes('utcEnd'));
    if (utc && properties.includes('recurrenceOverrides')) {
        throw invalidArguments('recurrenceOverrides can not be requested together with utcStart or utcEnd');
    }
    if (args.timeZone !== undefined && args.timeZone !== null && !isTimeZoneId(args.timeZone)) {
        throw invalidArguments('unknown timeZone');
    }
    if (args.reduceParticipants !== undefined && args.reduceParticipants !== null && typeof args.reduceParticipants !== 'boolean') {
        throw invalidArguments('reduceParticipants must be a boolean');
    }
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    return {
        properties: properties && ['id', ...new Set(properties.filter(property => property !== 'id'))],
        utc,
        timeZone: args.timeZone || null,
        reduce: args.reduceParticipants === true,
        overrides: {
            after: optionalUTC(args.recurrenceOverridesAfter, 'recurrenceOverridesAfter'),
            before: optionalUTC(args.recurrenceOverridesBefore, 'recurrenceOverridesBefore')
        }
    };
}

/** The objects of stored events and instances as the get options ask for them */
function render(entry, recurrenceId, options, addresses) {
    const object = eventObject(entry, recurrenceId, addresses);
    if (!object) {
        return null;
    }
    if (options.reduce) {
        model.reduceParticipants(object, addresses);
    }
    filterOverrides(object, options.overrides, options.timeZone);
    if (options.utc) {
        Object.assign(object, model.utcTimes(object, options.timeZone));
    }
    return pickProperties(object, options.properties, !!recurrenceId);
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties', 'recurrenceOverridesBefore', 'recurrenceOverridesAfter', 'reduceParticipants', 'timeZone']);
    requireAccount(args, context);
    const options = getOptions(args);
    if (args.ids && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    await loadCalendars(context);
    const user = context.account.user;
    const store = storeFor(context);
    const [currentState, { all: addresses }] = await Promise.all([state(context), ownAddresses(context)]);
    const result = { accountId: context.account.id, state: currentState, list: [], notFound: [] };

    if (args.ids === undefined || args.ids === null) {
        const entries = await store.all(user, context.limits.maxObjectsInGet);
        if (entries.length > context.limits.maxObjectsInGet) {
            // CalendarEvent/query pages through larger accounts
            throw new MethodError('requestTooLarge', { description: `more than ${context.limits.maxObjectsInGet} events` });
        }
        result.list = entries.map(entry => render(entry, null, options, addresses));
        return result;
    }

    const refs = args.ids.map(reference => ({ reference, parsed: model.parseEventId(resolveId(context, reference)) }));
    const ids = [...new Map(refs.filter(ref => ref.parsed).map(ref => [ref.parsed.id.toString(), ref.parsed.id])).values()];
    const entries = await store.byIds(user, ids);
    for (const { reference, parsed } of refs) {
        const entry = parsed && entries.get(parsed.id.toString());
        const object = entry && render(entry, parsed.recurrenceId, options, addresses);
        if (object) {
            result.list.push(object);
        } else {
            result.notFound.push(reference);
        }
    }
    return result;
}

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const maxChanges = maxChangesOf(args);
    await loadCalendars(context);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: TYPE,
        collection: COLLECTION,
        sinceState: args.sinceState,
        maxChanges: Math.min(maxChanges, 1000),
        formatId: id => formatId('calendarEvent', id)
    });
    return Object.assign({ accountId: context.account.id }, result);
}

// ---------------------------------------------------------------- set: shared steps

/** calendarIds of a create or patch result: ObjectIds of known calendars, at most maxCalendarsPerEvent */
function checkCalendarIds(value, context, calendars, limits) {
    if (!isObject(value) || !Object.keys(value).length || Object.keys(value).length > limits.maxCalendarsPerEvent) {
        return null;
    }
    const ids = [];
    for (const [key, flag] of Object.entries(value)) {
        const id = flag === true && parseId('calendar', resolveId(context, key));
        const calendar = id && calendars.find(entry => entry.id.equals(id));
        if (!calendar) {
            return null;
        }
        if (!ids.some(other => other.equals(calendar.id))) {
            ids.push(calendar.id);
        }
    }
    return ids;
}

/** The zone utcStart is read in when the event names none: the calendars' common zone, else Etc/UTC (draft 5.2) */
function calendarZone(calendars) {
    const zones = [...new Set(calendars.map(calendar => calendar.timeZone || null))];
    return zones.length === 1 && zones[0] ? zones[0] : 'Etc/UTC';
}

/**
 * Turns utcStart and utcEnd into start, timeZone and duration (draft 5.2).
 *
 * @param {Object} event the event being built, changed in place
 * @param {Set<String>} given the properties the client gave
 * @param {Object[]} calendars the event's calendars
 * @param {Object} reported server set values, filled in
 * @returns {String[]} problems
 */
function applyUtc(event, given, calendars, reported) {
    const problems = [];
    if (Object.hasOwn(event, 'utcStart')) {
        const at = parseUTCDate(event.utcStart);
        if (given.has('start') || !at) {
            problems.push('utcStart');
        } else {
            if (!event.timeZone) {
                event.timeZone = reported.timeZone = calendarZone(calendars);
            }
            event.start = reported.start = recurrence.utcToLocal(at.getTime(), event.timeZone);
        }
        delete event.utcStart;
    }
    if (Object.hasOwn(event, 'utcEnd')) {
        const at = parseUTCDate(event.utcEnd);
        const start = typeof event.start === 'string' && !problems.length ? recurrence.localToUtc(event.start, event.timeZone || 'Etc/UTC') : null;
        if (given.has('duration') || !at || start === null || at.getTime() < start) {
            problems.push('utcEnd');
        } else {
            event.duration = reported.duration = recurrence.formatDuration(Math.round((at.getTime() - start) / 1000));
        }
        delete event.utcEnd;
    }
    return problems;
}

/** organizerCalendarAddress for an event that gets participants (draft 5.2): the owner that is the user, else the main address */
function defaultOrganizer(event, owned) {
    const participants = Object.values(isObject(event.participants) ? event.participants : {});
    if (!participants.length || Object.hasOwn(event, 'organizerCalendarAddress')) {
        return null;
    }
    const own = participants.find(
        participant => participant && participant.roles && participant.roles.owner && model.isOwnAddress(participant.calendarAddress, owned.all)
    );
    if (own) {
        return own.calendarAddress;
    }
    return owned.main ? calendarAddressOf(owned.main) : null;
}

/** Top level nulls mean "not set" on create and after a patch; recurrenceIdTimeZone null means floating */
function dropNulls(event) {
    for (const key of Object.keys(event)) {
        if (event[key] === null && key !== 'recurrenceIdTimeZone') {
            delete event[key];
        }
    }
}

/** Removes the computed properties; answers the problems of those that were changed */
function stripComputed(event, before) {
    const problems = [];
    for (const key of model.COMPUTED) {
        if (Object.hasOwn(event, key) && key !== 'calendarIds' && key !== 'utcStart' && key !== 'utcEnd') {
            const unchanged = (before && model.same(event[key], before[key])) || (key === 'baseEventId' && event[key] === null);
            if (!unchanged) {
                problems.push(key);
            }
            delete event[key];
        }
    }
    return problems;
}

/** The links of an event and of its locations and participants (the ones blobsOf() reads), with their paths */
const linkEntries = event => {
    const entries = [];
    const collect = (links, path) => {
        for (const [id, link] of Object.entries(isObject(links) ? links : {})) {
            if (isObject(link)) {
                entries.push({ link, path: `${path}/${model.escapeToken(id)}` });
            }
        }
    };
    collect(event.links, 'links');
    for (const property of ['locations', 'participants']) {
        for (const [id, value] of Object.entries(isObject(event[property]) ? event[property] : {})) {
            collect(value && value.links, `${property}/${model.escapeToken(id)}/links`);
        }
    }
    return entries;
};

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** A data: URI (RFC 2397) as {contentType, content}, or null when it is not one */
function parseDataUri(href) {
    const comma = href.indexOf(',');
    if (comma < 0) {
        return null;
    }
    const parameters = href.slice(5, comma).split(';');
    const base64 = parameters[parameters.length - 1].toLowerCase() === 'base64';
    const type = parameters[0].trim().toLowerCase();
    const data = href.slice(comma + 1);
    let content;
    try {
        content = base64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf-8');
    } catch {
        return null;
    }
    return { contentType: MEDIA_TYPE.test(type) ? type : 'text/plain', content };
}

/** The problem of one link, or null; a data: URI is parsed into `uploads` */
async function linkProblem(context, link, path, uploads) {
    if (typeof link.blobId === 'string') {
        const parsed = parseBlobId(resolveId(context, link.blobId) || link.blobId);
        const found =
            parsed &&
            parsed.kind === 'upload' &&
            (await context.deps.storageHandler.findOwned(context.account.user, parsed.id, { temporary: true }).then(
                () => true,
                () => false
            ));
        if (!found) {
            return `${path}/blobId`;
        }
        link.blobId = blobId.upload(parsed.id);
    } else if (typeof link.href === 'string' && /^data:/i.test(link.href)) {
        const parsed = parseDataUri(link.href);
        if (!parsed || parsed.content.length > MAX_DATA_URI) {
            return `${path}/href`;
        }
        uploads.push(Object.assign({ link }, parsed));
    }
    return null;
}

/**
 * Links naming blobs must name uploads of the account; data: URIs become uploads (draft 5.3). Every link
 * is checked before any upload is made. The uploads count against the upload quota like any other and
 * expire as usual unless the write of the event succeeds (updatePins() keeps them then).
 *
 * @returns {Promise<String[]>} the paths of invalid links
 * @throws {SetError} overQuota when the uploads do not fit in the upload quota
 */
async function resolveLinks(context, event) {
    const problems = [];
    const uploads = [];
    for (const { link, path } of linkEntries(event)) {
        const problem = await linkProblem(context, link, path, uploads);
        if (problem) {
            problems.push(problem);
        }
    }
    if (problems.length) {
        return problems;
    }
    const { storageHandler } = context.deps;
    const user = context.account.user;
    const expires = new Date(Date.now() + (context.limits.uploadTtl || 24 * 3600) * 1000);
    for (const { link, contentType, content } of uploads) {
        // checked against the upload quota before and after it is stored
        const id = await storageHandler
            .add(user, {
                filename: 'attachment',
                contentType,
                content,
                expires,
                quota: context.limits.uploadQuota,
                maxUploads: context.limits.maxUploads,
                size: content.length
            })
            .catch(err => Promise.reject(err.code === 'OverQuota' ? new SetError('overQuota', 'the data: URI does not fit in the upload quota') : err));
        delete link.href;
        link.blobId = blobId.upload(id);
        link.contentType = link.contentType || contentType;
        link.size = content.length;
    }
    return problems;
}

/** Keeps uploads named by the event alive; releases the ones no event names any more */
async function updatePins(context, store, before, after, eventId) {
    const files = context.deps.gridfs.collection('storage.files');
    const user = context.account.user;
    const added = after.filter(id => !before.some(other => other.equals(id)));
    const removed = before.filter(id => !after.some(other => other.equals(id)));
    if (added.length) {
        await files.updateMany({ _id: { $in: added }, 'metadata.user': user, 'metadata.expires': { $exists: true } }, { $set: { 'metadata.expires': PINNED } });
    }
    for (const id of removed) {
        if (!(await store.references(user, id, eventId))) {
            const expires = new Date(Date.now() + (context.limits.uploadTtl || 24 * 3600) * 1000);
            await files.updateOne({ _id: id, 'metadata.user': user, 'metadata.expires': PINNED }, { $set: { 'metadata.expires': expires } });
        }
    }
}

/** created and updated on a create (draft 5.2, bis 3.1.6) */
function setTimes(event, origin, reported, now) {
    if (typeof event.created !== 'string' || Date.parse(event.created) > Date.parse(now)) {
        event.created = reported.created = now;
    }
    if (origin) {
        if (event.updated !== now) {
            event.updated = reported.updated = now;
        }
    } else if (typeof event.updated === 'string' && Date.parse(event.updated) > Date.parse(now)) {
        event.updated = reported.updated = now;
    }
    if (typeof event.updated === 'string' && Date.parse(event.created) > Date.parse(event.updated)) {
        event.created = reported.created = event.updated;
    }
}

/**
 * The uid rules (draft 5): one event per uid, or standalone instances with distinct recurrence ids and
 * the same privacy. Siblings destroyed in the same call do not count.
 */
async function uidProblems(context, event, ownId, pending) {
    const siblings = (await storeFor(context).byUid(context.account.user, event.uid)).filter(
        doc => !(ownId && doc._id.equals(ownId)) && !pending.destroyed.has(doc._id.toString())
    );
    const recurrenceId = event.recurrenceId || null;
    if (siblings.some(doc => !recurrenceId || !doc.recurrenceId || doc.recurrenceId === recurrenceId)) {
        return ['uid'];
    }
    const privacy = event.privacy || 'public';
    const privacyOf = doc => {
        const replaced = pending.events.get(doc._id.toString());
        return (replaced || JSON.parse(doc.data || '{}')).privacy || 'public';
    };
    return siblings.some(doc => privacyOf(doc) !== privacy) ? ['privacy'] : [];
}

/** sendSchedulingMessages true can not be honoured before scheduling exists (phase 7) */
function checkScheduling(args, event, owned) {
    if (args.sendSchedulingMessages !== true) {
        return;
    }
    const others = Object.values(isObject(event.participants) ? event.participants : {}).filter(
        participant => participant && participant.calendarAddress && !model.isOwnAddress(participant.calendarAddress, owned.all)
    );
    if (others.length) {
        throw new SetError('noSupportedScheduleMethods', 'scheduling messages can not be sent');
    }
}

/** tooLarge for an event over the size limit */
function checkSize(event, limits) {
    if (Buffer.byteLength(JSON.stringify(event)) > limits.maxEventSize) {
        throw new SetError('tooLarge', `an event is at most ${limits.maxEventSize} octets of JSON`);
    }
}

// ---------------------------------------------------------------- set handlers
//
// The steps of one CalendarEvent/set call share a `call` object: {args, context, user, store, limits,
// pending}, pending holding the stored ids the call destroys, the replacement values of updated events
// (the uid rules see them) and the ids changed together with their instances.

/** Scheduling fields of the alert scheduler for an event */
async function scheduleOf(call, event, calendarIds, previous) {
    const calendars = calendarsOf(await loadCalendars(call.context), calendarIds);
    const from = Math.max(Date.now(), previous ? previous.getTime() : 0);
    return alerts.scheduleFields(event, calendars, from);
}

/** Replaces (or with null removes) the override of an instance */
function setOverride(event, recurrenceId, patch) {
    const overrides = Object.assign({}, event.recurrenceOverrides || {});
    if (patch === null) {
        delete overrides[recurrenceId];
    } else {
        overrides[recurrenceId] = patch;
    }
    if (Object.keys(overrides).length) {
        event.recurrenceOverrides = overrides;
    } else {
        delete event.recurrenceOverrides;
    }
}

const stripOverrides = event => {
    if (isObject(event.recurrenceOverrides)) {
        event.recurrenceOverrides = Object.fromEntries(Object.entries(event.recurrenceOverrides).map(([key, patch]) => [key, model.stripIgnored(patch)]));
    }
};

// ---- creates

/** The event a create stores, with the values the server set: {event, calendarIds, reported, origin, owned} */
async function buildCreated(call, object) {
    const { context, limits } = call;
    const event = model.clone(object);
    const given = new Set(Object.keys(object));
    const wantedOrigin = event.isOrigin;
    delete event.isOrigin;
    const problems = stripComputed(event, null);
    if (Object.hasOwn(event, 'method')) {
        problems.push('method');
    }
    dropNulls(event);
    const calendars = await loadCalendars(context);
    const calendarIds = checkCalendarIds(object.calendarIds, context, calendars, limits);
    delete event.calendarIds;
    if (!calendarIds) {
        problems.push('calendarIds');
    }
    const reported = {};
    problems.push(...applyUtc(event, given, calendarsOf(calendars, calendarIds || []), reported));
    const owned = await ownAddresses(context);
    for (const [property, value] of [
        ['@type', 'Event'],
        ['version', '2.0'],
        ['uid', crypto.randomUUID()],
        ['isDraft', false],
        ['useDefaultAlerts', false]
    ]) {
        if (!Object.hasOwn(event, property)) {
            event[property] = reported[property] = value;
        }
    }
    const organizer = defaultOrganizer(event, owned);
    if (organizer) {
        event.organizerCalendarAddress = reported.organizerCalendarAddress = organizer;
    }
    const origin = model.isOriginOf(event, owned.all);
    if (wantedOrigin !== undefined && wantedOrigin !== null && wantedOrigin !== origin) {
        problems.push('isOrigin');
    }
    setTimes(event, origin, reported, model.nowUTC());
    stripOverrides(event);
    problems.push(...model.problemsOf(event, limits));
    if (problems.length) {
        throw invalidProperties([...new Set(problems)], 'invalid event properties');
    }
    return { event, calendarIds, reported, origin, owned };
}

async function createEvent(call, object) {
    const { context, user, store, limits, pending } = call;
    const { event, calendarIds, reported, origin, owned } = await buildCreated(call, object);
    checkSize(event, limits);
    const uidIssues = await uidProblems(context, event, null, pending);
    if (uidIssues.length) {
        throw invalidProperties(uidIssues, 'the uid is used by another event');
    }
    checkScheduling(call.args, event, owned);
    if ((await store.count(user, limits.maxEventsPerAccount)) >= limits.maxEventsPerAccount) {
        throw new SetError('overQuota', `an account has at most ${limits.maxEventsPerAccount} events`);
    }
    const linkProblems = await resolveLinks(context, event);
    if (linkProblems.length) {
        throw invalidProperties(linkProblems, 'unknown blob');
    }
    let id;
    try {
        id = await store.insert(user, event, calendarIds, await scheduleOf(call, event, calendarIds, null));
    } catch (err) {
        if (err.code === 'UidExists') {
            throw invalidProperties(['uid'], err.message);
        }
        throw err;
    }
    await updatePins(context, store, [], blobsOf(event), id);
    return Object.assign({ id: formatId('calendarEvent', id) }, reported, { isOrigin: origin });
}

// ---- updates

/** The sequence and updated rules of draft 5.2 for a changed event; fills `reported` */
function finishChange(before, after, touched, owned, reported) {
    const origin = model.isOriginOf(after, owned.all);
    if (origin && model.sharedChange(before, after)) {
        const current = before.sequence || 0;
        if (!(touched.has('sequence') && Number.isInteger(after.sequence) && after.sequence > current)) {
            after.sequence = reported.sequence = current + 1;
        }
    }
    if (origin) {
        after.updated = reported.updated = model.nowUTC();
    } else if (!touched.has('updated')) {
        if (before.updated === undefined) {
            delete after.updated;
        } else {
            after.updated = before.updated;
        }
    }
    if (model.isOriginOf(before, owned.all) !== origin) {
        reported.isOrigin = origin;
    }
}

/** A patch of a stored event: answers {event, calendarIds, reported, touched} */
async function patchStored(call, entry, current, patch, owned) {
    const { context, limits } = call;
    const calendars = await loadCalendars(context);
    const before = Object.assign(model.clone(current.event), {
        id: formatId('calendarEvent', entry.id),
        calendarIds: calendarIdsMap(current.calendarIds),
        isOrigin: model.isOriginOf(current.event, owned.all)
    });
    const { object: patched, properties: touched } = applyPatch(before, patch);
    const problems = stripComputed(patched, before);
    let calendarIds = current.calendarIds;
    if (touched.has('calendarIds')) {
        calendarIds = checkCalendarIds(patched.calendarIds, context, calendars, limits);
        if (!calendarIds) {
            problems.push('calendarIds');
        }
    }
    delete patched.calendarIds;
    for (const property of ['uid', 'recurrenceId'].filter(name => touched.has(name) && !model.same(patched[name], current.event[name]))) {
        problems.push(property);
    }
    if (touched.has('method') && patched.method !== undefined && patched.method !== null) {
        problems.push('method');
    }
    if (current.event.isDraft === false && patched.isDraft === true) {
        problems.push('isDraft');
    }
    dropNulls(patched);
    const reported = {};
    problems.push(...applyUtc(patched, touched, calendarsOf(calendars, calendarIds || []), reported));
    if (!Object.keys(isObject(current.event.participants) ? current.event.participants : {}).length) {
        const organizer = defaultOrganizer(patched, owned);
        if (organizer) {
            patched.organizerCalendarAddress = reported.organizerCalendarAddress = organizer;
        }
    }
    stripOverrides(patched);
    problems.push(...model.problemsOf(patched, limits));
    if (problems.length) {
        throw invalidProperties([...new Set(problems)], 'invalid event properties');
    }
    return { event: patched, calendarIds, reported, touched };
}

/**
 * The patch of an instance in two: acknowledgements that go to the base alert, because this instance
 * does not override the alert (draft 5.5), and the rest, which goes to the instance.
 */
function splitInstancePatch(patch, override) {
    const toBase = {};
    const toInstance = {};
    for (const [key, value] of Object.entries(patch)) {
        const match = /^alerts\/([^/]+)\/acknowledged$/.exec(key);
        const overridden =
            match &&
            Object.keys(override).some(pointer => pointer === 'alerts' || pointer === `alerts/${match[1]}` || pointer.startsWith(`alerts/${match[1]}/`));
        (match && !overridden ? toBase : toInstance)[key] = value;
    }
    return { toBase, toInstance };
}

/** The override an instance patch gives: the difference of the patched instance to the occurrence of the base */
function instanceOverride(current, recurrenceId, instance, toInstance) {
    const { object: patched, properties: touched } = applyPatch(instance, toInstance);
    const problems = model.INSTANCE_FIXED.filter(property => touched.has(property) && !model.same(patched[property], instance[property]));
    if (problems.length) {
        throw invalidProperties(problems, 'this property can not differ per occurrence');
    }
    dropNulls(patched);
    const reported = {};
    const utcProblems = applyUtc(patched, touched, [], reported);
    if (utcProblems.length) {
        throw invalidProperties(utcProblems, 'invalid event properties');
    }
    for (const key of [...model.COMPUTED, 'recurrenceId', 'recurrenceIdTimeZone']) {
        delete patched[key];
    }
    const base = model.occurrenceBase(current.event, recurrenceId);
    for (const key of ['sequence', 'updated', 'created']) {
        patched[key] = base[key];
        if (patched[key] === undefined) {
            delete patched[key];
        }
    }
    return { override: model.stripIgnored(model.diffPatch(base, patched)), reported, touched };
}

/** A patch of an instance: becomes an override of the base event (draft 5.2) */
async function patchInstance(call, entry, current, recurrenceId, patch, owned) {
    const kind = model.occurrenceOf(current.event, recurrenceId);
    if (kind !== 'rule' && kind !== 'added') {
        throw new SetError('notFound');
    }
    const { toBase, toInstance } = splitInstancePatch(patch, (current.event.recurrenceOverrides || {})[recurrenceId] || {});
    const instance = eventObject({ id: entry.id, event: current.event, calendarIds: current.calendarIds }, recurrenceId, owned.all);
    const { override, reported, touched } = instanceOverride(current, recurrenceId, instance, toInstance);
    const event = model.clone(current.event);
    setOverride(event, recurrenceId, !Object.keys(override).length && kind === 'rule' ? null : override);
    const withBase = Object.keys(toBase).length ? applyPatch(event, toBase).object : event;
    const pathProblems = model.problemsOf(withBase, call.limits);
    if (pathProblems.length) {
        throw invalidProperties(pathProblems, 'invalid event properties');
    }
    return { event: withBase, calendarIds: current.calendarIds, reported, touched };
}

/** One group of updates of a stored event (itself, or some of its instances) */
async function updateGroup(call, entry, items, owned, results) {
    let current = { event: entry.event, calendarIds: entry.calendarIds };
    const touchedAll = new Set();
    const reportedAll = {};
    let changed = false;
    for (const item of items) {
        try {
            const next = item.recurrenceId
                ? await patchInstance(call, entry, current, item.recurrenceId, item.patch, owned)
                : await patchStored(call, entry, current, item.patch, owned);
            checkSize(next.event, call.limits);
            if (!model.same(next.event, current.event) || !model.same(next.calendarIds, current.calendarIds)) {
                changed = true;
            }
            current = { event: next.event, calendarIds: next.calendarIds };
            next.touched.forEach(property => touchedAll.add(property));
            item.reported = next.reported;
            Object.assign(reportedAll, next.reported);
            results.set(item, null);
        } catch (err) {
            results.set(item, err);
        }
    }
    if (!changed) {
        return null;
    }
    const reported = {};
    finishChange(entry.event, current.event, touchedAll, owned, reported);
    return { entry, event: current.event, calendarIds: current.calendarIds, reported: Object.assign(reportedAll, reported), items };
}

/** A base event changed together with one of its instances is undefined (draft 5.2): all of them are refused */
function markConflicts(call, items) {
    const direct = new Set(items.filter(item => !item.invalid && !item.recurrenceId).map(item => item.id.toString()));
    for (const item of items.filter(entry => !entry.invalid && entry.recurrenceId)) {
        const key = item.id.toString();
        if (direct.has(key) || call.pending.destroyed.has(key)) {
            call.pending.conflicts.add(key);
        }
    }
}

/** The updates by stored event; the ones that can not be made get their SetError in `results` */
function groupUpdates(call, items, entries, results) {
    const groups = new Map();
    for (const item of items) {
        const key = item.invalid ? null : item.id.toString();
        if (!key || !entries.has(key)) {
            results.set(item, new SetError('notFound'));
        } else if (call.pending.conflicts.has(key)) {
            results.set(item, invalidProperties(['id'], 'an event and its instances can not be changed in one call'));
        } else {
            groups.set(key, (groups.get(key) || []).concat(item));
        }
    }
    return groups;
}

async function updateAll(call, batch) {
    const owned = await ownAddresses(call.context);
    const items = batch.map(({ id, patch }) => Object.assign({ id, patch }, model.parseEventId(id) || { id: null, recurrenceId: null, invalid: true }));
    const entries = await call.store.byIds(
        call.user,
        items.filter(item => !item.invalid).map(item => item.id)
    );
    markConflicts(call, items);
    const results = new Map();
    const outcomes = [];
    for (const [key, group] of groupUpdates(call, items, entries, results)) {
        const outcome = await updateGroup(call, entries.get(key), group, owned, results);
        if (outcome) {
            outcomes.push(outcome);
            call.pending.events.set(key, outcome.event);
        }
    }
    for (const outcome of outcomes) {
        await writeOutcome(call, outcome, results);
    }
    return items.map(item => {
        const result = results.get(item);
        if (result instanceof Error) {
            return result;
        }
        const outcome = outcomes.find(entry => entry.items.includes(item));
        const values = Object.assign({}, item.reported || {}, outcome ? outcome.reported : {});
        return Object.keys(values).length ? values : null;
    });
}

/** Checks what needs the other changes of the call (privacy of standalone instances) and stores */
async function writeOutcome(call, outcome, results) {
    const { context, user, store, pending } = call;
    const fail = err => {
        outcome.failed = true;
        outcome.items.filter(item => !(results.get(item) instanceof Error)).forEach(item => results.set(item, err));
        pending.events.delete(outcome.entry.id.toString());
    };
    const { entry, event, calendarIds } = outcome;
    if (event.recurrenceId && (event.privacy || 'public') !== (entry.event.privacy || 'public')) {
        const issues = await uidProblems(context, event, entry.id, pending);
        if (issues.length) {
            return fail(invalidProperties(issues, 'all instances of an event share its privacy'));
        }
    }
    try {
        const linkProblems = await resolveLinks(context, event);
        if (linkProblems.length) {
            return fail(invalidProperties(linkProblems, 'unknown blob'));
        }
    } catch (err) {
        return fail(err);
    }
    const schedule = await scheduleOf(call, event, calendarIds, entry.alertFrom);
    if (!(await store.replace(user, entry.id, event, calendarIds, schedule))) {
        return fail(new SetError('notFound'));
    }
    await updatePins(context, store, entry.doc.blobs || [], blobsOf(event), entry.id);
}

// ---- destroys

async function destroyEvent(call, reference) {
    const { context, user, store, pending } = call;
    const parsed = model.parseEventId(reference);
    if (!parsed) {
        throw new SetError('notFound');
    }
    if (pending.conflicts.has(parsed.id.toString())) {
        throw invalidProperties(['id'], 'an event and its instances can not be changed in one call');
    }
    if (!parsed.recurrenceId) {
        const doc = await store.remove(user, parsed.id);
        if (!doc) {
            throw new SetError('notFound');
        }
        await updatePins(context, store, doc.blobs || [], [], parsed.id);
        return;
    }
    const entry = (await store.byIds(user, [parsed.id])).get(parsed.id.toString());
    const kind = entry && model.occurrenceOf(entry.event, parsed.recurrenceId);
    if (kind !== 'rule' && kind !== 'added') {
        throw new SetError('notFound');
    }
    // an occurrence of the rule is excluded, an added one is taken out (draft 5.2)
    const event = model.clone(entry.event);
    setOverride(event, parsed.recurrenceId, kind === 'rule' ? { excluded: true } : null);
    finishChange(entry.event, event, new Set(['recurrenceOverrides']), await ownAddresses(context), {});
    await store.replace(user, parsed.id, event, entry.calendarIds, await scheduleOf(call, event, entry.calendarIds, entry.alertFrom));
}

function setHandlers(args, context) {
    const call = {
        args,
        context,
        user: context.account.user,
        store: storeFor(context),
        limits: limitsOf(context),
        pending: { destroyed: new Set(), events: new Map(), conflicts: new Set() }
    };
    for (const reference of Array.isArray(args.destroy) ? args.destroy : []) {
        const parsed = model.parseEventId(resolveId(context, reference));
        if (parsed && !parsed.recurrenceId) {
            call.pending.destroyed.add(parsed.id.toString());
        }
    }
    return {
        arguments: ['sendSchedulingMessages'],
        state: () => state(context),
        prepare: async () => {
            if (![undefined, null].includes(args.sendSchedulingMessages) && typeof args.sendSchedulingMessages !== 'boolean') {
                throw invalidArguments('sendSchedulingMessages must be a boolean');
            }
            await loadCalendars(context);
        },
        create: object => createEvent(call, object),
        updateAll: batch => updateAll(call, batch),
        destroy: reference => destroyEvent(call, reference)
    };
}

const set = (args, context) => runSet(args, context, setHandlers(args, context));

// ---------------------------------------------------------------- copy

/** CalendarEvent/copy (draft 5.9): there is one account per user, so every copy fails in the RFC 8620 5.4 order */
async function copy(args, context) {
    checkArguments(args, ['fromAccountId', 'ifFromInState', 'accountId', 'ifInState', 'create', 'onSuccessDestroyOriginal', 'destroyFromIfInState']);
    requireAccount(args, context);
    if (typeof args.fromAccountId !== 'string') {
        throw invalidArguments('fromAccountId is required');
    }
    if (args.fromAccountId === context.account.id) {
        throw invalidArguments('fromAccountId and accountId must name different accounts');
    }
    throw new MethodError('fromAccountNotFound');
}

// ---------------------------------------------------------------- CalendarEventNotification

const NOTIFICATION = 'CalendarEventNotification';
const notificationState = context => changeLogFor(context).state(context.account.user, context.account.id, NOTIFICATION);

async function notificationGet(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    return { accountId: context.account.id, state: await notificationState(context), list: [], notFound: args.ids || [] };
}

async function notificationChanges(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    maxChangesOf(args);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: NOTIFICATION,
        collection: COLLECTION,
        sinceState: args.sinceState,
        maxChanges: 1,
        formatId: id => id.toString()
    });
    return Object.assign({ accountId: context.account.id }, result);
}

async function notificationQuery(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal']);
    requireAccount(args, context);
    const result = { accountId: context.account.id, queryState: await notificationState(context), canCalculateChanges: false, position: 0, ids: [] };
    if (args.calculateTotal) {
        result.total = 0;
    }
    return result;
}

async function notificationSet(args, context) {
    return runSet(args, context, {
        state: () => notificationState(context),
        update: async () => {
            throw new SetError('notFound');
        },
        destroy: async () => {
            throw new SetError('notFound');
        }
    });
}

// ---------------------------------------------------------------- Blob/lookup and push

/** The events of the account that name one of the upload blob ids: blob id -> [CalendarEvent ids] */
async function eventsReferencing(context, ids) {
    const files = new Map();
    for (const id of ids) {
        const parsed = parseBlobId(id);
        if (parsed && parsed.kind === 'upload') {
            files.set(id, parsed.id);
        }
    }
    if (!files.size) {
        return new Map();
    }
    const found = await storeFor(context).referencing(context.account.user, [...files.values()]);
    return new Map([...files].map(([id, file]) => [id, (found.get(file.toString()) || []).map(eventId => formatId('calendarEvent', eventId))]));
}

module.exports = {
    capability: URN.calendars,
    methods: {
        'CalendarEvent/get': get,
        'CalendarEvent/changes': changes,
        'CalendarEvent/set': set,
        'CalendarEvent/copy': copy,
        'CalendarEventNotification/get': notificationGet,
        'CalendarEventNotification/changes': notificationChanges,
        'CalendarEventNotification/query': notificationQuery,
        'CalendarEventNotification/set': notificationSet
    },
    storeFor,
    ownAddresses,
    eventObject,
    calendarsOf,
    calendarIdsMap,
    limitsOf,
    eventsReferencing
};
