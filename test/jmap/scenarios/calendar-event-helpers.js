/* eslint no-unused-expressions: 0 */
'use strict';

// Shared helpers of the CalendarEvent scenario files (calendar-event-*-test.js, calendar-alert-test.js).

const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { accounts, jmap } = require('../harness');
const instance = require('../harness/instance');

const USING = [jmap.URN.core, jmap.URN.calendars];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
// the weekly event most scenarios start from
const WEEKLY = Object.freeze({
    title: 'Standup',
    start: '2026-01-05T09:00:00',
    timeZone: 'Europe/Tallinn',
    duration: 'PT1H',
    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' }
});
const LUNCH = Object.freeze({ title: 'Lunch', start: '2026-03-10T12:00:00', timeZone: 'Europe/Tallinn', duration: 'PT1H' });
const JANUARY = { after: '2026-01-01T00:00:00', before: '2026-02-01T00:00:00' };

const model = values => JSON.parse(JSON.stringify(values));

/** A new user with a JMAP client; `jmapUrl` points the client at another instance */
async function setupUser(options = {}, jmapUrl = null) {
    const user = await accounts.createUser(options);
    const client = jmap.forUser(user);
    if (jmapUrl) {
        const raw = client.raw.bind(client);
        client.raw = (path, init) => raw(path.startsWith('http') ? path : jmapUrl + path, init);
    }
    await client.session();
    const ctx = { user, client };
    ctx.calendar = await defaultCalendar(ctx);
    return ctx;
}

const method = (ctx, name, args = {}) => ctx.client.method(name, args, USING);
const call = (ctx, calls) => ctx.client.call(calls, USING);

async function defaultCalendar(ctx) {
    const res = await method(ctx, 'Calendar/get', { ids: null });
    return res.list.find(calendar => calendar.isDefault).id;
}

async function createCalendar(ctx, values = {}) {
    const res = await method(ctx, 'Calendar/set', { create: { c: Object.assign({ name: `Calendar ${Date.now()}` }, values) } });
    expect(res.notCreated, JSON.stringify(res.notCreated)).to.equal(null);
    return res.created.c.id;
}

const evSet = (ctx, args) => method(ctx, 'CalendarEvent/set', args);
const evGet = (ctx, ids, args = {}) => method(ctx, 'CalendarEvent/get', Object.assign({ ids }, args));
const evQuery = (ctx, args = {}) => method(ctx, 'CalendarEvent/query', args);
const evChanges = (ctx, sinceState, args = {}) => method(ctx, 'CalendarEvent/changes', Object.assign({ sinceState }, args));
const evState = async ctx => (await evGet(ctx, [])).state;

/** Creates one event (in the default calendar unless calendarIds is given); answers the created object */
async function createEvent(ctx, values = {}, args = {}) {
    const object = Object.assign({ calendarIds: { [ctx.calendar]: true } }, model(values));
    const res = await evSet(ctx, Object.assign({ create: { k: object } }, args));
    expect(res.notCreated, JSON.stringify(res.notCreated)).to.equal(null);
    return res.created.k;
}

/** Tries a create; answers {created, error, res} */
async function tryCreate(ctx, values, args = {}) {
    const object = Object.assign({ calendarIds: { [ctx.calendar]: true } }, model(values));
    const res = await evSet(ctx, Object.assign({ create: { k: object } }, args));
    return { res, created: res.created ? res.created.k : undefined, error: res.notCreated ? res.notCreated.k : undefined };
}

/** Tries an update; answers {updated (the server set values or null), error, res} */
async function tryUpdate(ctx, id, patch, args = {}) {
    const res = await evSet(ctx, Object.assign({ update: { [id]: patch } }, args));
    return {
        res,
        ok: !!res.updated && Object.hasOwn(res.updated, id),
        updated: res.updated ? res.updated[id] : undefined,
        error: res.notUpdated ? res.notUpdated[id] : undefined
    };
}

async function update(ctx, id, patch) {
    const result = await tryUpdate(ctx, id, patch);
    expect(result.error, JSON.stringify(result.error)).to.equal(undefined);
    expect(result.ok).to.equal(true);
    return result.updated;
}

const fetch1 = async (ctx, id, args = {}) => (await evGet(ctx, [id], args)).list[0];

/** Expanded instance ids of a window, sorted by start */
async function expand(ctx, filter = JANUARY, args = {}) {
    const res = await evQuery(ctx, Object.assign({ filter, expandRecurrences: true, sort: [{ property: 'start' }] }, args));
    return res.ids;
}

/** Start and recurrence id of instances */
async function startsOf(ctx, ids, properties = ['start', 'recurrenceId']) {
    if (!ids.length) {
        return [];
    }
    const res = await evGet(ctx, ids, { properties });
    return ids.map(id => res.list.find(object => object.id === id));
}

const expectInvalid = (error, properties) => {
    expect(error, 'expected an error').to.exist;
    expect(error.type).to.equal('invalidProperties');
    if (properties) {
        for (const property of [].concat(properties)) {
            expect(error.properties, JSON.stringify(error)).to.include(property);
        }
    }
};

/** Expects some property path of the error to start with prefix */
const expectInvalidAt = (error, prefix) => {
    expect(error, 'expected an error').to.exist;
    expect(error.type).to.equal('invalidProperties');
    expect(
        error.properties.some(path => path === prefix || path.startsWith(`${prefix}/`)),
        JSON.stringify(error)
    ).to.equal(true);
};

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
    return err.response;
}

/** An in process instance allowing several calendars per event */
let multi = null;
async function multiInstance() {
    if (!multi) {
        multi = await instance.startInstance({ calendars: Object.assign({}, config.jmap.calendars, { maxCalendarsPerEvent: 3 }), alerts: { enabled: false } });
    }
    return multi;
}

async function stopMulti() {
    if (multi) {
        await instance.stopInstance(multi.app);
        multi = null;
    }
}

module.exports = {
    USING,
    ID,
    WEEKLY,
    LUNCH,
    JANUARY,
    setupUser,
    method,
    call,
    defaultCalendar,
    createCalendar,
    evSet,
    evGet,
    evQuery,
    evChanges,
    evState,
    createEvent,
    tryCreate,
    tryUpdate,
    update,
    fetch1,
    expand,
    startsOf,
    expectInvalid,
    expectInvalidAt,
    expectError,
    multiInstance,
    stopMulti
};
