/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
'use strict';

// Catalogue file calendars.yaml, phase 6, first part: the calendars capability and Calendar/get,
// /changes and /set (CAL). ParticipantIdentity is in participant-identity-test.js.
//
// Waiting for CalendarEvent (work packages 6.5 and 6.6), not registered here yet: CAL-008 (calls the
// CalendarEvent methods, and CalendarEventNotification/get of phase 7), CAL-013 (CalendarEvent/query),
// CAL-041 (CalendarEvent/set), CAL-060 and CAL-061 (CalendarEvent/get and /changes after a calendar is
// destroyed), CAL-075 and CAL-076 (event writes and CalendarEvent/changes). The scenarios that only need
// an event to exist seed it in the calendarevents collection.

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { scenario, accounts, seed, clock, jmap } = require('../harness');
const sse = require('../harness/sse');
const instance = require('../harness/instance');

const USING = [jmap.URN.core, jmap.URN.calendars];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
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
const RIGHTS = ['mayReadFreeBusy', 'mayReadItems', 'mayWriteAll', 'mayWriteOwn', 'mayUpdatePrivate', 'mayRSVP', 'mayShare', 'mayDelete'];
const DAY = 24 * 3600 * 1000;

async function setupUser(options) {
    const user = await accounts.createUser(options);
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

const method = (client, name, args = {}, using = USING) => client.method(name, args, using);
const calGet = (client, args = {}) => method(client, 'Calendar/get', Object.assign({ ids: null }, args));
const calSet = (client, args) => method(client, 'Calendar/set', args);
const calChanges = (client, sinceState, args = {}) => method(client, 'Calendar/changes', Object.assign({ sinceState }, args));
const calState = async client => (await calGet(client, { ids: [] })).state;
const defaultOf = async client => (await calGet(client)).list.find(calendar => calendar.isDefault);

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
    return err.response;
}

/** Creates calendars by name in one call, answers their ids in order */
async function createCalendars(client, ...objects) {
    const create = Object.fromEntries(objects.map((object, i) => [`c${i}`, typeof object === 'string' ? { name: object } : object]));
    const res = await calSet(client, { create });
    expect(res.notCreated, JSON.stringify(res.notCreated)).to.equal(null);
    return objects.map((object, i) => res.created[`c${i}`].id);
}

async function createOne(client, object) {
    const res = await calSet(client, { create: { k1: object } });
    return res.created ? res.created.k1 : res.notCreated.k1;
}

async function updateOne(client, id, patch) {
    const res = await calSet(client, { update: { [id]: patch } });
    return { res, updated: res.updated && Object.hasOwn(res.updated, id), error: res.notUpdated && res.notUpdated[id] };
}

const byId = async (client, id) => (await calGet(client, { ids: [id] })).list[0];
const objectIdOf = id => new seed.ObjectId(id.slice(1));

/** Puts an event in the calendarevents collection directly; CalendarEvent/set arrives with work package 6.5 */
async function seedEvent(user, calendarIds, extra = {}) {
    const db = await seed.db();
    const doc = Object.assign(
        {
            _id: new seed.ObjectId(),
            user: new seed.ObjectId(user.id),
            calendarIds: calendarIds.map(objectIdOf),
            uid: crypto.randomUUID(),
            createdSeq: 0,
            modSeq: 0
        },
        extra
    );
    await db.collection('calendarevents').insertOne(doc);
    return doc._id;
}

const eventExists = async id => !!(await (await seed.db()).collection('calendarevents').findOne({ _id: id }));
const userCalendars = async user => (await seed.db()).collection('calendars').countDocuments({ user: new seed.ObjectId(user.id) });

const alert = (offset, extra = {}) => Object.assign({ '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset } }, extra);

describe('Calendars (CAL)', function () {
    this.timeout(60000);

    describe('capability and session', () => {
        scenario('CAL-001', async () => {
            const { client } = await setupUser();
            const session = await client.session();
            expect(session.capabilities[jmap.URN.calendars]).to.deep.equal({});
            expect(session.primaryAccounts[jmap.URN.calendars]).to.equal(client.accountId);
        });

        scenario('CAL-002', async () => {
            const { client } = await setupUser();
            const session = await client.session();
            const capability = session.accounts[client.accountId].accountCapabilities[jmap.URN.calendars];
            expect(capability).to.have.all.keys(
                'maxCalendarsPerEvent',
                'minDateTime',
                'maxDateTime',
                'maxExpandedQueryDuration',
                'maxParticipantsPerEvent',
                'mayCreateCalendar'
            );
            for (const key of ['maxCalendarsPerEvent', 'maxParticipantsPerEvent']) {
                expect(capability[key] === null || (Number.isInteger(capability[key]) && capability[key] >= 1), key).to.be.true;
            }
            for (const key of ['minDateTime', 'maxDateTime']) {
                expect(capability[key]).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
            }
            expect(new Date(capability.minDateTime).getTime()).to.be.below(new Date(capability.maxDateTime).getTime());
            expect(capability.maxExpandedQueryDuration).to.match(/^P(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/);
            expect(capability.mayCreateCalendar).to.be.a('boolean');
        });

        scenario('CAL-003', async () => {
            const { client } = await setupUser();
            const session = await client.session();
            expect(session.accounts[client.accountId].accountCapabilities[jmap.URN.calendars].mayCreateCalendar).to.equal(true);
            const created = await createOne(client, { name: 'Mine' });
            expect(created.id).to.match(ID);
        });

        scenario('CAL-004', async () => {
            const { client } = await setupUser();
            await calGet(client);
            const responses = await client.call([['Calendar/get', { accountId: client.accountId, ids: null }, 'c0']], [jmap.URN.core]);
            expect(responses[0][0]).to.equal('error');
            expect(responses[0][1].type).to.equal('unknownMethod');
        });

        scenario('CAL-005', async () => {
            const { client } = await setupUser();
            const session = await client.session();
            const availability = 'urn:ietf:params:jmap:principals:availability';
            expect(session.capabilities).to.not.have.property(availability);
            expect(session.accounts[client.accountId].accountCapabilities).to.not.have.property(availability);
            await expectError(
                method(client, 'Principal/getAvailability', { id: 'x', utcStart: '2030-01-01T00:00:00Z', utcEnd: '2030-01-02T00:00:00Z' }),
                'unknownMethod'
            );
            const res = await client.request({
                using: [jmap.URN.core, jmap.URN.calendars, availability],
                methodCalls: [['Calendar/get', { accountId: client.accountId }, 'c0']]
            });
            expect(res.status).to.equal(400);
            expect(res.json.type).to.equal('urn:ietf:params:jmap:error:unknownCapability');
        });

        scenario('CAL-006', async () => {
            const { client } = await setupUser();
            const session = await client.session();
            expect(session.capabilities).to.not.have.property('urn:ietf:params:jmap:principals');
            expect(session.accounts[client.accountId].accountCapabilities).to.not.have.property('urn:ietf:params:jmap:principals');
            await createCalendars(client, 'Other');
            const { list } = await calGet(client);
            expect(list.every(calendar => calendar.shareWith === null)).to.be.true;
            const defaultId = list.find(calendar => calendar.isDefault).id;
            const { error } = await updateOne(client, defaultId, { shareWith: { P1: { mayReadItems: true } } });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['shareWith']);
            expect((await byId(client, defaultId)).shareWith).to.equal(null);
            const { updated } = await updateOne(client, defaultId, { shareWith: null });
            expect(updated).to.be.true;
        });

        scenario('CAL-007', async () => {
            const { client } = await setupUser();
            const session = await client.session();
            const parse = 'urn:ietf:params:jmap:calendars:parse';
            expect(session.capabilities).to.not.have.property(parse);
            expect(session.accounts[client.accountId].accountCapabilities).to.not.have.property(parse);
            await expectError(method(client, 'CalendarEvent/parse', { blobIds: ['Bxyz'] }), 'unknownMethod');
        });

        scenario('CAL-009', async () => {
            const { client } = await setupUser();
            await calGet(client);
            await expectError(method(client, 'Calendar/query', { filter: {} }), 'unknownMethod');
        });
    });

    describe('Calendar/get', () => {
        scenario('CAL-010', async () => {
            const { client } = await setupUser();
            const res = await calGet(client);
            expect(res.list).to.have.length(1);
            const [calendar] = res.list;
            expect(calendar.isDefault).to.equal(true);
            expect(calendar.name).to.be.a('string').and.not.equal('');
            expect(calendar.isSubscribed).to.equal(true);
            expect(calendar.isVisible).to.equal(true);
            expect(calendar.shareWith).to.equal(null);
            expect(res.notFound).to.deep.equal([]);
        });

        scenario('CAL-011', async () => {
            const { user, client } = await setupUser();
            await client.method('Mailbox/get', { ids: null });
            await client.method('Email/query', {});
            expect(await userCalendars(user)).to.equal(0);
            await calGet(client);
            expect(await userCalendars(user)).to.equal(1);
        });

        scenario('CAL-012', async () => {
            const { user, client } = await setupUser();
            // the shared test server allows 8 concurrent requests per user; this worker allows the ten
            const { app, url } = await instance.startInstance({ limits: Object.assign({}, config.jmap.limits, { maxConcurrentRequests: 16 }) });
            try {
                const request = async () => {
                    const res = await jmap.forUser(user).raw(`${url}/jmap/api/`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ using: USING, methodCalls: [['Calendar/get', { accountId: client.accountId, ids: null }, 'c0']] })
                    });
                    expect(res.status).to.equal(200);
                    const [[name, args]] = res.json.methodResponses;
                    expect(name, JSON.stringify(args)).to.equal('Calendar/get');
                    return args;
                };
                const results = await Promise.all(Array.from({ length: 10 }, request));
                const ids = results.map(res => res.list.map(calendar => calendar.id));
                for (const list of ids) {
                    expect(list).to.deep.equal(ids[0]);
                    expect(list).to.have.length(1);
                }
            } finally {
                await instance.stopInstance(app);
            }
            const later = await calGet(client);
            expect(later.list).to.have.length(1);
            expect(later.list.filter(calendar => calendar.isDefault)).to.have.length(1);
        });

        scenario('CAL-014', async () => {
            const { client } = await setupUser();
            const res = await calGet(client, { properties: null });
            for (const calendar of res.list) {
                expect(calendar).to.have.all.keys(...PROPERTIES);
                expect(calendar.id).to.be.a('string');
                expect(calendar.name).to.be.a('string');
                expect(calendar.sortOrder).to.be.a('number');
                for (const key of ['isSubscribed', 'isVisible', 'isDefault']) {
                    expect(calendar[key]).to.be.a('boolean');
                }
                expect(calendar.myRights).to.be.an('object');
            }
            const [calendar] = res.list;
            expect(calendar.description).to.equal(null);
            expect(calendar.sortOrder).to.equal(0);
            expect(calendar.isVisible).to.equal(true);
            expect(calendar.includeInAvailability).to.equal('all');
            expect(calendar.timeZone).to.equal(null);
            expect(calendar.shareWith).to.equal(null);
            expect(calendar.color).to.equal(null);
            expect(calendar.defaultAlertsWithTime).to.equal(null);
            expect(calendar.defaultAlertsWithoutTime).to.equal(null);
        });

        scenario('CAL-015', async () => {
            const { client } = await setupUser();
            await createCalendars(client, 'A', 'B');
            const { list } = await calGet(client, { properties: ['myRights'] });
            expect(list).to.have.length(3);
            for (const calendar of list) {
                expect(calendar.myRights).to.have.all.keys(...RIGHTS);
                expect(Object.values(calendar.myRights).every(value => value === true)).to.be.true;
            }
        });

        scenario('CAL-016', async () => {
            const { client } = await setupUser();
            const [idA] = await createCalendars(client, 'A', 'B');
            const res = await calGet(client, { ids: [idA, 'Zmissing'] });
            expect(res.list.map(calendar => calendar.id)).to.deep.equal([idA]);
            expect(res.list[0].name).to.equal('A');
            expect(res.notFound).to.deep.equal(['Zmissing']);
            expect(res.state).to.be.a('string').and.not.equal('');
        });

        scenario('CAL-017', async () => {
            const { client } = await setupUser();
            await createCalendars(client, 'A', 'B');
            const { list } = await calGet(client, { properties: ['name', 'color'] });
            expect(list).to.have.length(3);
            for (const calendar of list) {
                expect(calendar).to.have.all.keys('id', 'name', 'color');
            }
        });

        scenario('CAL-018', async () => {
            const { client } = await setupUser();
            await expectError(calGet(client, { properties: ['name', 'noSuchProperty'] }), 'invalidArguments');
        });

        scenario('CAL-019', async () => {
            const { client } = await setupUser();
            const session = await client.session();
            const max = session.capabilities[jmap.URN.core].maxObjectsInGet;
            const ids = Array.from({ length: max + 1 }, (v, i) => `K${String(i).padStart(24, '0')}`);
            await expectError(calGet(client, { ids }), 'requestTooLarge');
        });

        scenario('CAL-020', async () => {
            const { client } = await setupUser();
            const [idA] = await createCalendars(client, 'A', 'B');
            await updateOne(client, idA, { name: 'A renamed' });
            const { list } = await calGet(client);
            expect(list.find(calendar => calendar.id === idA).name).to.equal('A renamed');
            for (const calendar of list) {
                expect(calendar.id).to.match(ID);
            }
        });
    });

    describe('Calendar/set create', () => {
        scenario('CAL-021', async () => {
            const { client } = await setupUser();
            const created = await createOne(client, { name: 'Work' });
            expect(created.id).to.match(ID);
            expect(created.isDefault).to.equal(false);
            expect(created.myRights).to.be.an('object');
            expect(created.sortOrder).to.equal(0);
            expect(created.isVisible).to.equal(true);
            expect(created.isSubscribed).to.equal(true);
            expect(created.includeInAvailability).to.equal('all');
            expect(created).to.not.have.property('name');
            const calendar = await byId(client, created.id);
            expect(calendar.name).to.equal('Work');
            expect(calendar.description).to.equal(null);
            expect(calendar.color).to.equal(null);
            expect(calendar.timeZone).to.equal(null);
            expect(calendar.shareWith).to.equal(null);
        });

        scenario('CAL-022', async () => {
            const { client } = await setupUser();
            const values = {
                name: 'Team',
                description: 'Shared plans',
                color: '#1a2b3c',
                sortOrder: 7,
                isSubscribed: true,
                isVisible: false,
                includeInAvailability: 'attending',
                timeZone: 'Europe/Tallinn',
                defaultAlertsWithTime: { a1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } },
                defaultAlertsWithoutTime: null
            };
            const created = await createOne(client, values);
            expect(created.id, JSON.stringify(created)).to.match(ID);
            const calendar = await byId(client, created.id);
            for (const [key, value] of Object.entries(values)) {
                expect(calendar[key], key).to.deep.equal(value);
            }
        });

        scenario('CAL-023', async () => {
            const { client } = await setupUser();
            const error = await createOne(client, { color: 'red' });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['name']);
        });

        scenario('CAL-024', async () => {
            const { client } = await setupUser();
            const error = await createOne(client, { name: '' });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['name']);
            const [id] = await createCalendars(client, 'Old');
            const update = await updateOne(client, id, { name: '' });
            expect(update.error.type).to.equal('invalidProperties');
            expect(update.error.properties).to.deep.equal(['name']);
            expect((await byId(client, id)).name).to.equal('Old');
        });

        scenario('CAL-025', async () => {
            const { client } = await setupUser();
            const longest = '€'.repeat(85);
            expect(Buffer.byteLength(longest)).to.equal(255);
            const created = await createOne(client, { name: longest });
            expect(created.id).to.match(ID);
            expect((await byId(client, created.id)).name).to.equal(longest);
            const error = await createOne(client, { name: 'x'.repeat(256) });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['name']);
        });

        scenario('CAL-026', async () => {
            const { client } = await setupUser();
            const first = await createOne(client, { name: 'Work' });
            const second = await createOne(client, { name: 'Work' });
            expect(first.id).to.match(ID);
            expect(second.id).to.match(ID);
            expect(first.id).to.not.equal(second.id);
        });

        scenario('CAL-027', async () => {
            const { client } = await setupUser();
            for (const color of ['SteelBlue', 'steelblue', '#01aafF', '#0af']) {
                const created = await createOne(client, { name: color, color });
                expect(created.id, `${color}: ${JSON.stringify(created)}`).to.match(ID);
                expect((await byId(client, created.id)).color).to.equal(color);
            }
        });

        scenario('CAL-028', async () => {
            const { client } = await setupUser();
            const [id] = await createCalendars(client, { name: 'Colour', color: '#01aaff' });
            for (const color of ['foo', '#foofoo', '#01aAfFF', '#01aaff80', ['steelblue']]) {
                const { error } = await updateOne(client, id, { color });
                expect(error, JSON.stringify(color)).to.exist;
                expect(error.type).to.equal('invalidProperties');
                expect(error.properties).to.deep.equal(['color']);
            }
            expect((await byId(client, id)).color).to.equal('#01aaff');
        });

        scenario('CAL-029', async () => {
            const { client } = await setupUser();
            const [id] = await createCalendars(client, { name: 'Red', color: 'red' });
            const { updated } = await updateOne(client, id, { color: null });
            expect(updated).to.be.true;
            expect((await byId(client, id)).color).to.equal(null);
        });

        scenario('CAL-030', async () => {
            const { client } = await setupUser();
            for (const sortOrder of [0, 2147483647]) {
                const created = await createOne(client, { name: `s${sortOrder}`, sortOrder });
                expect(created.id).to.match(ID);
                expect((await byId(client, created.id)).sortOrder).to.equal(sortOrder);
            }
            for (const sortOrder of [-1, 2147483648, 1.5, '3']) {
                const error = await createOne(client, { name: 'bad', sortOrder });
                expect(error.type, String(sortOrder)).to.equal('invalidProperties');
                expect(error.properties).to.deep.equal(['sortOrder']);
            }
        });

        scenario('CAL-031', async () => {
            const { client } = await setupUser();
            const created = await createOne(client, { name: 'Flags', isSubscribed: false, isVisible: true });
            let calendar = await byId(client, created.id);
            expect(calendar.isSubscribed).to.equal(false);
            expect(calendar.isVisible).to.equal(true);
            await updateOne(client, created.id, { isSubscribed: true, isVisible: false });
            calendar = await byId(client, created.id);
            expect(calendar.isSubscribed).to.equal(true);
            expect(calendar.isVisible).to.equal(false);
            for (const property of ['isSubscribed', 'isVisible']) {
                const error = await createOne(client, { name: 'bad', [property]: 'yes' });
                expect(error.type).to.equal('invalidProperties');
                expect(error.properties).to.deep.equal([property]);
                const update = await updateOne(client, created.id, { [property]: 1 });
                expect(update.error.properties).to.deep.equal([property]);
            }
        });

        scenario('CAL-032', async () => {
            const { client } = await setupUser();
            for (const includeInAvailability of ['all', 'attending', 'none']) {
                const created = await createOne(client, { name: includeInAvailability, includeInAvailability });
                expect((await byId(client, created.id)).includeInAvailability).to.equal(includeInAvailability);
            }
            const error = await createOne(client, { name: 'sometimes', includeInAvailability: 'sometimes' });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['includeInAvailability']);
        });

        scenario('CAL-033', async () => {
            const { client } = await setupUser();
            for (const timeZone of ['Australia/Melbourne', 'Etc/UTC', null]) {
                const created = await createOne(client, { name: String(timeZone), timeZone });
                expect(created.id, String(timeZone)).to.match(ID);
                expect((await byId(client, created.id)).timeZone).to.equal(timeZone);
            }
            for (const timeZone of ['Mars/Olympus_Mons', '+02:00', 'EET-2EEST']) {
                const error = await createOne(client, { name: 'bad', timeZone });
                expect(error.type, timeZone).to.equal('invalidProperties');
                expect(error.properties).to.deep.equal(['timeZone']);
            }
        });

        scenario('CAL-034', async () => {
            const { client } = await setupUser();
            const defaultCalendar = await defaultOf(client);
            const { updated } = await updateOne(client, defaultCalendar.id, { defaultAlertsWithTime: { d34: alert('-PT30M') } });
            expect(updated).to.be.true;
            const created = await createOne(client, { name: 'Plain' });
            const calendar = await byId(client, created.id);
            expect(calendar.defaultAlertsWithTime).to.equal(null);
            expect(calendar.defaultAlertsWithoutTime).to.equal(null);
        });

        scenario('CAL-035', async () => {
            const { client } = await setupUser();
            const [id] = await createCalendars(client, 'A');
            const withTime = { t1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT10M', relativeTo: 'start' } } };
            const withoutTime = { d1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: 'PT9H' } } };
            const { updated } = await updateOne(client, id, { defaultAlertsWithTime: withTime, defaultAlertsWithoutTime: withoutTime });
            expect(updated).to.be.true;
            let calendar = await byId(client, id);
            expect(calendar.defaultAlertsWithTime).to.deep.equal(withTime);
            expect(calendar.defaultAlertsWithoutTime).to.deep.equal(withoutTime);
            await updateOne(client, id, { defaultAlertsWithTime: null });
            calendar = await byId(client, id);
            expect(calendar.defaultAlertsWithTime).to.equal(null);
            expect(calendar.defaultAlertsWithoutTime).to.deep.equal(withoutTime);
        });

        scenario('CAL-036', async () => {
            const { client } = await setupUser();
            const [id] = await createCalendars(client, { name: 'A', defaultAlertsWithTime: { keep: alert('-PT5M') } });
            const absolute = { x: { '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: '2030-01-01T00:00:00Z' } } };
            for (const property of ['defaultAlertsWithTime', 'defaultAlertsWithoutTime']) {
                const { error } = await updateOne(client, id, { [property]: absolute });
                expect(error.type).to.equal('invalidProperties');
                expect(error.properties).to.deep.equal([property]);
            }
            const calendar = await byId(client, id);
            expect(calendar.defaultAlertsWithTime).to.deep.equal({ keep: alert('-PT5M') });
            expect(calendar.defaultAlertsWithoutTime).to.equal(null);
        });

        scenario('CAL-037', async () => {
            const { client } = await setupUser();
            const [idA, idB] = await createCalendars(client, { name: 'A', defaultAlertsWithTime: { dup: alert('-PT5M') } }, 'B');
            let result = await updateOne(client, idB, { defaultAlertsWithoutTime: { dup: alert('PT9H') } });
            expect(result.error.type).to.equal('invalidProperties');
            expect(result.error.properties).to.deep.equal(['defaultAlertsWithoutTime']);
            result = await updateOne(client, idA, { defaultAlertsWithoutTime: { dup: alert('PT9H') } });
            expect(result.error.type).to.equal('invalidProperties');
            expect(result.error.properties).to.deep.equal(['defaultAlertsWithoutTime']);
            result = await updateOne(client, idB, { defaultAlertsWithoutTime: { other: alert('PT9H') } });
            expect(result.updated).to.be.true;
        });

        scenario('CAL-038', async () => {
            const { client } = await setupUser();
            const [id] = await createCalendars(client, { name: 'A', defaultAlertsWithTime: { t1: alert('-PT10M'), t2: alert('-PT1H') } });
            const { updated } = await updateOne(client, id, { 'defaultAlertsWithTime/t1/trigger/offset': '-PT5M', 'defaultAlertsWithTime/t2': null });
            expect(updated).to.be.true;
            expect((await byId(client, id)).defaultAlertsWithTime).to.deep.equal({ t1: alert('-PT5M') });
        });

        scenario('CAL-039', async () => {
            const { client } = await setupUser();
            const cases = [
                [{ name: 'X', isDefault: true }, 'isDefault'],
                [{ name: 'X', id: 'Cmine' }, 'id'],
                [{ name: 'X', myRights: { mayDelete: false } }, 'myRights']
            ];
            for (const [object, property] of cases) {
                const error = await createOne(client, object);
                expect(error.type).to.equal('invalidProperties');
                expect(error.properties).to.deep.equal([property]);
            }
            // the value the server would set is accepted
            const allRights = Object.fromEntries(RIGHTS.map(right => [right, true]));
            const created = await createOne(client, { name: 'X', isDefault: false, myRights: allRights });
            expect(created.id).to.match(ID);
        });

        scenario('CAL-040', async () => {
            const { client } = await setupUser();
            const error = await createOne(client, { name: 'X', flavour: 'mint' });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['flavour']);
        });
    });

    describe('Calendar/set default calendar', () => {
        async function defaultAndA() {
            const setup = await setupUser();
            const idD = (await defaultOf(setup.client)).id;
            const [idA] = await createCalendars(setup.client, { name: 'A', sortOrder: 1 });
            return Object.assign(setup, { idD, idA });
        }

        scenario('CAL-042', async () => {
            const { client, idD, idA } = await defaultAndA();
            const res = await calSet(client, { onSuccessSetIsDefault: idA });
            expect(res.updated).to.deep.equal({ [idA]: { isDefault: true }, [idD]: { isDefault: false } });
            const defaults = (await calGet(client)).list.filter(calendar => calendar.isDefault);
            expect(defaults.map(calendar => calendar.id)).to.deep.equal([idA]);
            expect(res.newState).to.not.equal(res.oldState);
        });

        scenario('CAL-043', async () => {
            const { client } = await setupUser();
            const idD = (await defaultOf(client)).id;
            const res = await calSet(client, { create: { k1: { name: 'Main' } }, onSuccessSetIsDefault: '#k1' });
            expect(res.created.k1.isDefault).to.equal(true);
            expect(res.updated[idD]).to.deep.equal({ isDefault: false });
            const defaults = (await calGet(client)).list.filter(calendar => calendar.isDefault);
            expect(defaults.map(calendar => calendar.id)).to.deep.equal([res.created.k1.id]);
        });

        scenario('CAL-044', async () => {
            const { client, idD, idA } = await defaultAndA();
            const res = await calSet(client, { update: { [idA]: { name: 'Renamed' } }, onSuccessSetIsDefault: 'Znope' });
            expect(Object.keys(res.updated)).to.deep.equal([idA]);
            expect(res.notUpdated).to.equal(null);
            expect((await byId(client, idA)).name).to.equal('Renamed');
            expect((await defaultOf(client)).id).to.equal(idD);
        });

        scenario('CAL-045', async () => {
            const { client, idD, idA } = await defaultAndA();
            const res = await calSet(client, { create: { bad: { name: '' } }, onSuccessSetIsDefault: idA });
            expect(res.notCreated.bad.type).to.equal('invalidProperties');
            expect(res.updated === null || Object.keys(res.updated).length === 0).to.be.true;
            expect((await defaultOf(client)).id).to.equal(idD);
        });

        scenario('CAL-046', async () => {
            const { client, idD, idA } = await defaultAndA();
            const res = await calSet(client, { update: { [idA]: { color: 'red' } }, onSuccessSetIsDefault: idA });
            expect(Object.keys(res.updated).sort()).to.deep.equal([idA, idD].sort());
            expect(res.updated[idA].isDefault).to.equal(true);
            expect(res.updated[idD]).to.deep.equal({ isDefault: false });
            expect(res.notUpdated).to.equal(null);
        });

        scenario('CAL-047', async () => {
            const { client } = await setupUser();
            const idD = (await defaultOf(client)).id;
            const res = await calSet(client, { onSuccessSetIsDefault: idD });
            expect(res.updated === null || Object.keys(res.updated).length === 0).to.be.true;
            expect(res.newState).to.equal(res.oldState);
        });

        scenario('CAL-048', async () => {
            const { client, idD, idA } = await defaultAndA();
            const { error } = await updateOne(client, idA, { isDefault: true });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['isDefault']);
            expect((await defaultOf(client)).id).to.equal(idD);
        });

        scenario('CAL-049', async () => {
            const { user, client, idA } = await defaultAndA();
            await calSet(client, { onSuccessSetIsDefault: idA });
            await createCalendars(client, 'Another');
            await updateOne(client, idA, { name: 'A again' });
            // a JMAP worker started now knows nothing of the earlier requests
            const { app, url } = await instance.startInstance();
            try {
                const res = await jmap.forUser(user).raw(`${url}/jmap/api/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ using: USING, methodCalls: [['Calendar/get', { accountId: client.accountId, ids: null }, 'c0']] })
                });
                const [[name, args]] = res.json.methodResponses;
                expect(name).to.equal('Calendar/get');
                expect(args.list.filter(calendar => calendar.isDefault).map(calendar => calendar.id)).to.deep.equal([idA]);
            } finally {
                await instance.stopInstance(app);
            }
        });

        scenario('CAL-065', async () => {
            const { client } = await setupUser();
            const s1 = await calState(client);
            const idD = (await defaultOf(client)).id;
            const res = await calSet(client, { destroy: [idD] });
            expect(res.destroyed).to.deep.equal([idD]);
            const { list } = await calGet(client);
            expect(list).to.have.length(1);
            expect(list[0].isDefault).to.equal(true);
            expect(list[0].id).to.not.equal(idD);
            const changes = await calChanges(client, s1);
            expect(changes.destroyed).to.deep.equal([idD]);
            expect(changes.created).to.deep.equal([list[0].id]);
        });

        scenario('CAL-066', async () => {
            const { client } = await setupUser();
            const idD = (await defaultOf(client)).id;
            const [idA, idB] = await createCalendars(client, { name: 'A', sortOrder: 1 }, { name: 'B', sortOrder: 2 });
            const res = await calSet(client, { destroy: [idD] });
            expect(res.destroyed).to.deep.equal([idD]);
            expect(res.updated).to.deep.equal({ [idA]: { isDefault: true } });
            const { list } = await calGet(client);
            expect(list.filter(calendar => calendar.isDefault).map(calendar => calendar.id)).to.deep.equal([idA]);
            expect(list.map(calendar => calendar.id).sort()).to.deep.equal([idA, idB].sort());
        });
    });

    describe('Calendar/set update and destroy', () => {
        async function threeCalendars() {
            const setup = await setupUser();
            const idD = (await defaultOf(setup.client)).id;
            const [idA, idB] = await createCalendars(setup.client, 'A', 'B');
            return Object.assign(setup, { idD, idA, idB });
        }

        scenario('CAL-050', async () => {
            const { client, idA } = await threeCalendars();
            const { res } = await updateOne(client, idA, { name: 'Renamed' });
            const entry = res.updated[idA];
            expect(entry === null || !Object.hasOwn(entry, 'name')).to.be.true;
            expect((await byId(client, idA)).name).to.equal('Renamed');
            expect(res.newState).to.not.equal(res.oldState);
        });

        scenario('CAL-051', async () => {
            const { client, idA } = await threeCalendars();
            await updateOne(client, idA, { defaultAlertsWithTime: { w51: alert('-PT5M') } });
            const values = {
                description: 'About A',
                color: 'teal',
                sortOrder: 42,
                isVisible: false,
                timeZone: 'America/New_York',
                includeInAvailability: 'none'
            };
            const { updated } = await updateOne(client, idA, values);
            expect(updated).to.be.true;
            const calendar = await byId(client, idA);
            for (const [key, value] of Object.entries(values)) {
                expect(calendar[key], key).to.equal(value);
            }
            expect(calendar.name).to.equal('A');
            expect(calendar.defaultAlertsWithTime).to.deep.equal({ w51: alert('-PT5M') });
        });

        scenario('CAL-052', async () => {
            const { client } = await setupUser();
            const { error } = await updateOne(client, 'Zmissing', { name: 'X' });
            expect(error.type).to.equal('notFound');
        });

        scenario('CAL-053', async () => {
            const { client } = await setupUser();
            const [idA] = await createCalendars(client, 'A');
            const { error } = await updateOne(client, idA, { name: 'Valid', color: 'nocolour' });
            expect(error.type).to.equal('invalidProperties');
            expect(error.properties).to.deep.equal(['color']);
            expect((await byId(client, idA)).name).to.equal('A');
        });

        scenario('CAL-054', async () => {
            const { client } = await setupUser();
            const [idA] = await createCalendars(client, 'A');
            const { error } = await updateOne(client, idA, { 'defaultAlertsWithTime/x/trigger/offset': '-PT5M' });
            expect(error.type).to.equal('invalidPatch');
        });

        scenario('CAL-055', async () => {
            const { client, idA } = await threeCalendars();
            const stale = await calState(client);
            await updateOne(client, idA, { name: 'first' });
            await expectError(calSet(client, { ifInState: stale, update: { [idA]: { name: 'second' } } }), 'stateMismatch');
            expect((await byId(client, idA)).name).to.equal('first');
            const current = await calState(client);
            const res = await calSet(client, { ifInState: current, update: { [idA]: { name: 'third' } } });
            expect(res.oldState).to.equal(current);
            expect((await byId(client, idA)).name).to.equal('third');
        });

        scenario('CAL-056', async () => {
            const { user, client } = await setupUser();
            const session = await client.session();
            const max = session.capabilities[jmap.URN.core].maxObjectsInSet;
            const create = Object.fromEntries(Array.from({ length: max + 1 }, (v, i) => [`c${i}`, { name: `n${i}` }]));
            await expectError(calSet(client, { create }), 'requestTooLarge');
            expect(await userCalendars(user)).to.be.at.most(1);
        });

        scenario('CAL-057', async () => {
            const { client } = await setupUser();
            const idD = (await defaultOf(client)).id;
            const { updated } = await updateOne(client, idD, { name: 'Home', color: 'navy', sortOrder: 3 });
            expect(updated).to.be.true;
            const calendar = await byId(client, idD);
            expect(calendar.name).to.equal('Home');
            expect(calendar.color).to.equal('navy');
            expect(calendar.sortOrder).to.equal(3);
            expect(calendar.isDefault).to.equal(true);
        });

        scenario('CAL-058', async () => {
            const { client } = await setupUser();
            const [idA] = await createCalendars(client, 'A');
            const res = await calSet(client, { destroy: [idA] });
            expect(res.destroyed).to.deep.equal([idA]);
            expect(res.newState).to.not.equal(res.oldState);
            expect((await calGet(client, { ids: [idA] })).notFound).to.deep.equal([idA]);
        });

        scenario('CAL-059', async () => {
            const { user, client } = await setupUser();
            const [idA] = await createCalendars(client, 'A');
            const event = await seedEvent(user, [idA]);
            for (const args of [{}, { onDestroyRemoveEvents: false }]) {
                const res = await calSet(client, Object.assign({ destroy: [idA] }, args));
                expect(res.notDestroyed[idA].type).to.equal('calendarHasEvent');
                expect(res.destroyed).to.equal(null);
            }
            expect((await calGet(client, { ids: [idA] })).list).to.have.length(1);
            expect(await eventExists(event)).to.be.true;
        });

        scenario('CAL-062', async () => {
            const { user, client } = await setupUser();
            const [idA, idB] = await createCalendars(client, 'A', 'B');
            await seedEvent(user, [idA, idB]);
            const res = await calSet(client, { destroy: [idA] });
            expect(res.notDestroyed[idA].type).to.equal('calendarHasEvent');
        });

        scenario('CAL-063', async () => {
            const { user, client } = await setupUser();
            const [idA] = await createCalendars(client, 'A');
            await seedEvent(user, [idA], { isDraft: true });
            const res = await calSet(client, { destroy: [idA] });
            expect(res.notDestroyed[idA].type).to.equal('calendarHasEvent');
        });

        scenario('CAL-064', async () => {
            const { client } = await setupUser();
            const res = await calSet(client, { destroy: ['Zmissing'] });
            expect(res.notDestroyed.Zmissing.type).to.equal('notFound');
        });

        scenario('CAL-067', async () => {
            const { client, idA, idB } = await threeCalendars();
            const before = await calState(client);
            const res = await calSet(client, { create: { n: { name: 'New' } }, update: { [idA]: { color: 'nocolour' } }, destroy: [idB] });
            expect(res.created.n.id).to.match(ID);
            expect(res.notUpdated[idA].type).to.equal('invalidProperties');
            expect(res.destroyed).to.deep.equal([idB]);
            expect(res.oldState).to.equal(before);
            const changes = await calChanges(client, before);
            expect(changes.newState).to.equal(res.newState);
            expect(changes.created).to.deep.equal([res.created.n.id]);
            expect(changes.destroyed).to.deep.equal([idB]);
            expect(changes.updated).to.deep.equal([]);
        });
    });

    describe('Calendar/changes', () => {
        scenario('CAL-068', async () => {
            const { client } = await setupUser();
            const s1 = await calState(client);
            const res = await calChanges(client, s1);
            expect(res.oldState).to.equal(s1);
            expect(res.newState).to.equal(s1);
            expect(res.hasMoreChanges).to.equal(false);
            expect(res.created).to.deep.equal([]);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
        });

        scenario('CAL-069', async () => {
            const { client } = await setupUser();
            const [idA, idB] = await createCalendars(client, 'A', 'B');
            const s1 = await calState(client);
            const [idC] = await createCalendars(client, 'C');
            await updateOne(client, idA, { name: 'A2' });
            await calSet(client, { destroy: [idB] });
            const res = await calChanges(client, s1);
            expect(res.created).to.deep.equal([idC]);
            expect(res.updated).to.deep.equal([idA]);
            expect(res.destroyed).to.deep.equal([idB]);
            expect(res.newState).to.equal(await calState(client));
        });

        scenario('CAL-070', async () => {
            const { client } = await setupUser();
            const s1 = await calState(client);
            const [idT] = await createCalendars(client, 'T');
            await calSet(client, { destroy: [idT] });
            const res = await calChanges(client, s1);
            expect([...res.created, ...res.updated, ...res.destroyed]).to.not.include(idT);
            expect(res.newState).to.not.equal(s1);
        });

        scenario('CAL-071', async () => {
            const { client } = await setupUser();
            const s1 = await calState(client);
            const ids = await createCalendars(client, '1', '2', '3', '4', '5');
            const seen = [];
            let since = s1;
            for (let round = 0; round < 10; round++) {
                const res = await calChanges(client, since, { maxChanges: 2 });
                expect(res.created.length + res.updated.length + res.destroyed.length).to.be.at.most(2);
                seen.push(...res.created);
                since = res.newState;
                if (!res.hasMoreChanges) {
                    break;
                }
                expect(res.hasMoreChanges).to.equal(true);
            }
            expect(seen.sort()).to.deep.equal([...ids].sort());
            expect(new Set(seen).size).to.equal(seen.length);
        });

        scenario('CAL-072', async () => {
            const { client } = await setupUser();
            await calGet(client);
            await expectError(calChanges(client, 'nonsense'), 'cannotCalculateChanges');
        });

        scenario('CAL-073', async () => {
            const { user, client } = await setupUser();
            const db = await seed.db();
            const age = days =>
                db.collection('jmapstate').updateOne({ _id: new seed.ObjectId(user.id) }, { $set: { 'seqTime.Calendar': new Date(Date.now() - days * DAY) } });
            // a state taken 29 days ago, then the destroy
            const [idA, idB] = await createCalendars(client, 'A', 'B');
            await age(29);
            const s1 = await calState(client);
            await calSet(client, { destroy: [idA] });
            expect((await calChanges(client, s1)).destroyed).to.deep.equal([idA]);
            // a state older than the retention: correct changes or cannotCalculateChanges, never an empty set
            await age(31);
            const s2 = await calState(client);
            await calSet(client, { destroy: [idB] });
            const res = await calChanges(client, s2).catch(err => err);
            if (res instanceof Error) {
                expect(res.type).to.equal('cannotCalculateChanges');
            } else {
                expect(res.destroyed).to.deep.equal([idB]);
            }
        });

        scenario('CAL-074', async () => {
            const { client } = await setupUser();
            const idD = (await defaultOf(client)).id;
            const [idA] = await createCalendars(client, 'A');
            const s1 = await calState(client);
            await calSet(client, { onSuccessSetIsDefault: idA });
            const res = await calChanges(client, s1);
            expect(res.updated.sort()).to.deep.equal([idA, idD].sort());
        });
    });

    describe('push', () => {
        scenario('CAL-077', async () => {
            const { user, client } = await setupUser();
            await calGet(client);
            const es = await sse.open('/jmap/eventsource/?types=Calendar&closeafter=no&ping=0', { authorization: jmap.basic(user.username, user.password) });
            try {
                expect(es.status).to.equal(200);
                await es.until(() => es.comments[0], 5000, 'stream not connected');
                const res = await calSet(client, { create: { k: { name: 'Pushed' } } });
                const event = await es.until(
                    () => es.states().find(state => state.json.changed[client.accountId] && state.json.changed[client.accountId].Calendar === res.newState),
                    10000,
                    'no Calendar state pushed'
                );
                expect(event.json.changed[client.accountId]).to.not.have.property('CalendarEvent');
                expect(Object.keys(event.json.changed[client.accountId])).to.deep.equal(['Calendar']);
            } finally {
                es.close();
            }
            await clock.delay(10);
        });
    });
});
