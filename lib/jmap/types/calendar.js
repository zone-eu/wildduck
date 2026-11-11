'use strict';

// Calendar/get, Calendar/changes and Calendar/set (draft-ietf-jmap-calendars-33 4), and the account
// capability object of urn:ietf:params:jmap:calendars (1.5.1).
//
// Storage and the default calendar rules live in lib/calendar-handler.js: the default calendar is
// created on the first calendar method call of a user, and exactly one calendar is the default. There
// is no sharing (RFC 9670 is out of scope): shareWith is always null and the owner has every right.
// Changes are in the owned change log under the type Calendar.

const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { requireAccount, checkArguments, isObject } = require('./common');
const { changeLogFor, ownedPushStates } = require('../changelog');
const { applyPatch } = require('../patch');
const { runSet, resolveId } = require('../set');
const { maxChangesOf } = require('../state');
const { CalendarHandler, CALENDAR_DEFAULTS, calendarLimits } = require('../../calendar-handler');
const { validateAlert, isColor, isTimeZoneId, isId } = require('../../schemas/jscalendar');
const alerts = require('../../calendar/alerts');

const TYPE = 'Calendar';
const PROPERTIES = [
    'id',
    'name',
    'description',
    'color',
    'sortOrder',
    'isSubscribed',
    'isVisible',
    'isDefault',
    'includeInAvailability',
    'defaultAlertsWithTime',
    'defaultAlertsWithoutTime',
    'timeZone',
    'shareWith',
    'myRights'
];
const WRITABLE = Object.keys(CALENDAR_DEFAULTS);
const ALERT_PROPERTIES = ['defaultAlertsWithTime', 'defaultAlertsWithoutTime'];
// the owner of the account has every right on its calendars (draft 4)
const RIGHTS = Object.freeze({
    mayReadFreeBusy: true,
    mayReadItems: true,
    mayWriteAll: true,
    mayWriteOwn: true,
    mayUpdatePrivate: true,
    mayRSVP: true,
    mayShare: true,
    mayDelete: true
});
// what a null in a patch resets a property to (RFC 8620 5.3); name has no default
const RESET = { sortOrder: 0, isSubscribed: true, isVisible: true, includeInAvailability: 'all' };
// maxAlertsSize: octets of one default alert map as JSON
const LIMITS = { maxName: 255, maxDescription: 64 * 1024, maxDefaultAlerts: 32, maxAlertsSize: 16 * 1024 };
const MAX_SORT_ORDER = 2 ** 31 - 1;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The calendar handler of the service, created once per set of dependencies */
function calendarHandlerFor(context) {
    if (!context.deps.calendarHandler) {
        context.deps.calendarHandler = new CalendarHandler({
            database: context.deps.database,
            gridfs: context.deps.gridfs,
            uploadTtl: context.limits && context.limits.uploadTtl,
            limits: context.options.calendars
        });
    }
    return context.deps.calendarHandler;
}

/** The calendars of the account, loaded once per request; creates the default calendar on first use */
function loadCalendars(context) {
    if (!context.cache.calendars) {
        context.cache.calendars = calendarHandlerFor(context).list(context.account.user);
    }
    return context.cache.calendars;
}

function toCalendar(calendar, properties) {
    const values = Object.assign({}, calendar, {
        id: formatId('calendar', calendar.id),
        shareWith: null,
        myRights: Object.assign({}, RIGHTS)
    });
    return Object.fromEntries(properties.map(property => [property, values[property]]));
}

const state = context => changeLogFor(context).state(context.account.user, context.account.id, TYPE);

// ---------------------------------------------------------------- get and changes

/**
 * A standard /get (RFC 8620 5.1) over a list loaded for the request. Shared by the calendar types.
 *
 * @param {Object} args
 * @param {Object} context
 * @param {Object} options {properties: all property names, load: async () => objects, toObject: (object, properties) => JMAP
 *   object, idOf: object => JMAP id, state: async () => state}
 */
async function getObjects(args, context, options) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const properties = args.properties === undefined || args.properties === null ? options.properties : args.properties;
    if (!Array.isArray(properties) || properties.some(property => !options.properties.includes(property))) {
        throw invalidArguments('unknown property');
    }
    const list = ['id', ...new Set(properties.filter(property => property !== 'id'))];
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    if (args.ids && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    const objects = await options.load();
    const result = { accountId: context.account.id, state: await options.state(), list: [], notFound: [] };
    if (args.ids === undefined || args.ids === null) {
        result.list = objects.map(object => options.toObject(object, list));
        return result;
    }
    const byId = new Map(objects.map(object => [options.idOf(object), object]));
    for (const reference of args.ids) {
        const id = resolveId(context, reference);
        const object = id && byId.get(id);
        if (object) {
            result.list.push(options.toObject(object, list));
        } else {
            result.notFound.push(reference);
        }
    }
    return result;
}

const get = (args, context) =>
    getObjects(args, context, {
        properties: PROPERTIES,
        load: () => loadCalendars(context),
        toObject: toCalendar,
        idOf: calendar => formatId('calendar', calendar.id),
        state: () => state(context)
    });

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const maxChanges = maxChangesOf(args);
    await loadCalendars(context);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: TYPE,
        collection: 'calendars',
        sinceState: args.sinceState,
        maxChanges: Math.min(maxChanges, 1000),
        formatId: id => formatId('calendar', id)
    });
    return Object.assign({ accountId: context.account.id }, result);
}

// ---------------------------------------------------------------- validation

function checkAlerts(value) {
    if (value === null) {
        return true;
    }
    return (
        isObject(value) &&
        Object.keys(value).length <= LIMITS.maxDefaultAlerts &&
        Buffer.byteLength(JSON.stringify(value)) <= LIMITS.maxAlertsSize &&
        Object.entries(value).every(([id, alert]) => isId(id) && validateAlert(alert, { absolute: false }).valid)
    );
}

const CHECKS = {
    name: value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= LIMITS.maxName && !value.includes('\x00'),
    description: value => value === null || (typeof value === 'string' && Buffer.byteLength(value) <= LIMITS.maxDescription),
    // CSS Color Level 3 4.2.1 has both the three and the six digit hexadecimal form
    color: value => value === null || isColor(value, { short: true }),
    sortOrder: value => Number.isInteger(value) && value >= 0 && value <= MAX_SORT_ORDER,
    isSubscribed: value => typeof value === 'boolean',
    isVisible: value => typeof value === 'boolean',
    includeInAvailability: value => ['all', 'attending', 'none'].includes(value),
    timeZone: value => value === null || isTimeZoneId(value),
    defaultAlertsWithTime: checkAlerts,
    defaultAlertsWithoutTime: checkAlerts
};

/** The properties of `values` (writable ones) that are not valid */
const invalidOf = values => Object.keys(values).filter(property => !CHECKS[property](values[property]));

/**
 * Default alert ids are unique across the account (draft 4). The changed alert properties of a calendar
 * whose ids are used by another calendar, or by the other default alert property of the same calendar.
 */
function duplicateAlerts(calendar, changed, calendars) {
    const used = new Set();
    for (const other of calendars) {
        if (!calendar.id || !other.id.equals(calendar.id)) {
            ALERT_PROPERTIES.forEach(property => Object.keys(other[property] || {}).forEach(id => used.add(id)));
        }
    }
    // an unchanged map of this calendar counts first, then the changed ones in order
    const order = ALERT_PROPERTIES.filter(property => !changed.includes(property)).concat(ALERT_PROPERTIES.filter(property => changed.includes(property)));
    const duplicates = [];
    for (const property of order) {
        const ids = Object.keys(calendar[property] || {});
        if (changed.includes(property) && ids.some(id => used.has(id))) {
            duplicates.push(property);
        }
        ids.forEach(id => used.add(id));
    }
    return duplicates;
}

/** Server set properties in a create are allowed only with the value the server would set (RFC 8620 5.3) */
function serverSetProblems(object) {
    const problems = [];
    if ('id' in object) {
        problems.push('id');
    }
    if ('isDefault' in object && object.isDefault !== false) {
        problems.push('isDefault');
    }
    if ('myRights' in object && !same(object.myRights, RIGHTS)) {
        problems.push('myRights');
    }
    if ('shareWith' in object && object.shareWith !== null) {
        // sharing is not offered
        problems.push('shareWith');
    }
    return problems;
}

// ---------------------------------------------------------------- set

function setHandlers(args, context) {
    const user = context.account.user;
    const handler = calendarHandlerFor(context);
    const owned = async id => {
        const objectId = parseId('calendar', id);
        const calendars = await loadCalendars(context);
        const calendar = objectId && calendars.find(entry => entry.id.equals(objectId));
        if (!calendar) {
            throw new SetError('notFound');
        }
        return calendar;
    };
    let destroyedDefault = false;

    return {
        arguments: ['onDestroyRemoveEvents', 'onSuccessSetIsDefault'],
        state: () => state(context),
        prepare: async () => {
            if (![undefined, null].includes(args.onDestroyRemoveEvents) && typeof args.onDestroyRemoveEvents !== 'boolean') {
                throw invalidArguments('onDestroyRemoveEvents must be a boolean');
            }
            if (![undefined, null].includes(args.onSuccessSetIsDefault) && typeof args.onSuccessSetIsDefault !== 'string') {
                throw invalidArguments('onSuccessSetIsDefault must be an id');
            }
            await loadCalendars(context);
        },

        async create(object) {
            const unknown = Object.keys(object).filter(key => !PROPERTIES.includes(key));
            const problems = unknown.concat(serverSetProblems(object));
            const values = Object.fromEntries(WRITABLE.filter(property => property in object).map(property => [property, object[property]]));
            if (!('name' in object)) {
                problems.push('name');
            }
            problems.push(...invalidOf(values));
            if (problems.length) {
                throw invalidProperties([...new Set(problems)], 'invalid calendar properties');
            }
            const calendars = await loadCalendars(context);
            const candidate = Object.assign({}, CALENDAR_DEFAULTS, values);
            const duplicates = duplicateAlerts(candidate, Object.keys(values), calendars);
            if (duplicates.length) {
                throw invalidProperties(duplicates, 'default alert ids must be unique in the account');
            }
            let calendar;
            try {
                calendar = await handler.create(user, values);
            } catch (err) {
                if (err.code === 'CalendarLimit') {
                    throw new SetError('overQuota', err.message);
                }
                throw err;
            }
            calendars.push(calendar);
            // the server set and defaulted properties the client did not give
            const created = toCalendar(calendar, PROPERTIES);
            return Object.fromEntries(Object.entries(created).filter(([key]) => key === 'id' || !(key in object)));
        },

        async update(id, patch) {
            const calendar = await owned(id);
            const current = toCalendar(calendar, PROPERTIES);
            const { object: patched, properties } = applyPatch(current, patch, { properties: PROPERTIES });
            const reset = {};
            for (const property of Object.keys(RESET).filter(name => properties.has(name) && patched[name] === null)) {
                patched[property] = reset[property] = RESET[property];
            }
            // server set properties keep their value; shareWith stays null, there is no sharing
            const readOnly = ['id', 'isDefault', 'myRights', 'shareWith'].filter(
                property => properties.has(property) && !same(patched[property], current[property])
            );
            const changed = WRITABLE.filter(property => properties.has(property) && !same(patched[property], current[property]));
            const values = Object.fromEntries(changed.map(property => [property, patched[property]]));
            const problems = readOnly.concat(invalidOf(values));
            if (problems.length) {
                throw invalidProperties(problems, 'invalid calendar properties');
            }
            if (!changed.length) {
                return null;
            }
            const duplicates = duplicateAlerts(Object.assign({}, calendar, values), changed, await loadCalendars(context));
            if (duplicates.length) {
                throw invalidProperties(duplicates, 'default alert ids must be unique in the account');
            }
            if (!(await handler.update(user, calendar.id, values))) {
                throw new SetError('notFound');
            }
            Object.assign(calendar, values);
            if (changed.some(property => ALERT_PROPERTIES.includes(property))) {
                // events using the default alerts of this calendar get their next alert time again
                await alerts.rescheduleCalendar(context.deps, user, calendar.id, await loadCalendars(context));
            }
            return Object.keys(reset).length ? reset : null;
        },

        async destroy(id) {
            const calendar = await owned(id);
            try {
                const { wasDefault } = await handler.destroy(user, calendar.id, { removeEvents: args.onDestroyRemoveEvents === true });
                destroyedDefault = destroyedDefault || wasDefault;
            } catch (err) {
                if (err.code === 'CalendarHasEvent') {
                    throw new SetError('calendarHasEvent', 'The calendar has events');
                }
                if (err.code === 'CalendarNotFound') {
                    throw new SetError('notFound');
                }
                throw err;
            }
            const calendars = await loadCalendars(context);
            calendars.splice(calendars.indexOf(calendar), 1);
        },

        finish: response => applyDefault(args, context, response, destroyedDefault)
    };
}

/**
 * onSuccessSetIsDefault (draft 4.3), applied when every change of the call succeeded; or, when the default
 * calendar was destroyed, the promotion of another one. Both calendars are reported with their new
 * isDefault value. An id that is unknown or already the default is ignored without an error.
 */
async function applyDefault(args, context, response, destroyedDefault) {
    const handler = calendarHandlerFor(context);
    const user = context.account.user;
    const failed = response.notCreated || response.notUpdated || response.notDestroyed;
    let change = null;
    if (typeof args.onSuccessSetIsDefault === 'string' && !failed) {
        const target = parseId('calendar', resolveId(context, args.onSuccessSetIsDefault));
        const result = target && (await handler.setDefault(user, target));
        change = result && { id: target, previous: result.previous };
    }
    if (!change && destroyedDefault) {
        const remaining = await handler.find(user);
        if (remaining.length && !remaining.some(calendar => calendar.isDefault)) {
            change = { id: await handler.promote(user, remaining), previous: null };
        }
    }
    if (!change) {
        return {};
    }
    context.cache.calendars = null;
    const report = (id, isDefault) => {
        const jmapId = formatId('calendar', id);
        const creation = Object.keys(response.created || {}).find(key => response.created[key].id === jmapId);
        if (creation) {
            response.created[creation].isDefault = isDefault;
            return;
        }
        response.updated = response.updated || {};
        response.updated[jmapId] = Object.assign({}, response.updated[jmapId] || {}, { isDefault });
    };
    report(change.id, true);
    if (change.previous && !(response.destroyed || []).includes(formatId('calendar', change.previous))) {
        report(change.previous, false);
    }
    const otherChanges = response.newState !== response.oldState;
    response.newState = await state(context);
    if (!otherChanges && context.deps.notifier) {
        context.deps.notifier.fire(user);
    }
    return { created: response.created, updated: response.updated, newState: response.newState };
}

const set = (args, context) => runSet(args, context, setHandlers(args, context));

// ---------------------------------------------------------------- capability and push

function accountCapability(context) {
    const limits = calendarLimits(context.options && context.options.calendars);
    return {
        maxCalendarsPerEvent: limits.maxCalendarsPerEvent,
        minDateTime: limits.minDateTime,
        maxDateTime: limits.maxDateTime,
        maxExpandedQueryDuration: limits.maxExpandedQueryDuration,
        maxParticipantsPerEvent: limits.maxParticipantsPerEvent,
        // one account per user, owned by the user; Calendar/set create answers overQuota at maxCalendars
        mayCreateCalendar: true
    };
}

const PUSH_TYPES = ['Calendar', 'ParticipantIdentity', 'CalendarEvent'];

/** The states of the calendar types; creates nothing */
const pushStates = context => ownedPushStates(context, PUSH_TYPES);

module.exports = {
    capability: URN.calendars,
    accountCapability,
    methods: { 'Calendar/get': get, 'Calendar/changes': changes, 'Calendar/set': set },
    pushTypes: PUSH_TYPES,
    pushStates,
    getObjects,
    loadCalendars,
    calendarHandlerFor
};
