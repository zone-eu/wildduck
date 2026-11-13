/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global after */
'use strict';

// Catalogue file calendars.yaml, phase 6: CalendarEvent/get and /set of single events, the create
// rules, time zones and UTC times, links and blobs (CEV-001 to CEV-066). The rest of CEV is in
// calendar-event-set-test.js.

const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { scenario, seed, clock, jmap } = require('../harness');
const instance = require('../harness/instance');
const StorageHandler = require('../../../lib/storage-handler');
const h = require('./calendar-event-helpers');

const { LUNCH } = h;
const NOW_SLACK = 10000;
const near = value => expect(Math.abs(Date.parse(value) - Date.now()), `${value} is not now`).to.be.below(NOW_SLACK);

async function upload(ctx, body, type) {
    const res = await ctx.client.raw(`/jmap/upload/${ctx.client.accountId}/`, { method: 'POST', headers: { 'Content-Type': type }, body });
    expect(res.status).to.equal(200);
    return res.json.blobId;
}

const download = (ctx, blobId) => ctx.client.raw(`/jmap/download/${ctx.client.accountId}/${blobId}/file?accept=application/octet-stream`);

describe('CalendarEvent get and set (CEV, part 1)', function () {
    this.timeout(60000);

    after(() => h.stopMulti());

    scenario('CEV-001', async () => {
        const ctx = await h.setupUser();
        const before = await h.evState(ctx);
        const { res, created } = await h.tryCreate(ctx, LUNCH);
        expect(created.id).to.match(h.ID);
        expect(created['@type']).to.equal('Event');
        expect(created.version).to.equal('2.0');
        expect(created.uid).to.be.a('string').and.not.equal('');
        expect(created.created).to.equal(created.updated);
        near(created.created);
        expect(created.isOrigin).to.equal(true);
        expect(created.isDraft).to.equal(false);
        expect(created.useDefaultAlerts).to.equal(false);
        expect(res.newState).to.not.equal(res.oldState);
        expect(res.oldState).to.equal(before);
    });

    scenario('CEV-002', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, LUNCH);
        const object = await h.fetch1(ctx, id, { properties: null });
        for (const property of [
            '@type',
            'uid',
            'version',
            'created',
            'updated',
            'title',
            'start',
            'timeZone',
            'duration',
            'id',
            'calendarIds',
            'isOrigin',
            'isDraft',
            'useDefaultAlerts'
        ]) {
            expect(object, property).to.have.property(property);
        }
        expect(object.calendarIds).to.deep.equal({ [ctx.calendar]: true });
        for (const property of ['utcStart', 'utcEnd', 'iCalendar', 'baseEventId', 'method']) {
            expect(object, property).to.not.have.property(property);
        }
    });

    scenario('CEV-003', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, LUNCH);
        const res = await h.evGet(ctx, [id, 'Zmissing'], { properties: ['title', 'start'] });
        expect(res.list).to.have.length(1);
        expect(res.list[0]).to.deep.equal({ id, title: 'Lunch', start: LUNCH.start });
        expect(res.notFound).to.deep.equal(['Zmissing']);
        expect(res.state).to.be.a('string').and.not.equal('');
    });

    scenario('CEV-004', async () => {
        const ctx = await h.setupUser();
        const other = await h.createCalendar(ctx, { name: 'Other' });
        const ids = [];
        ids.push((await h.createEvent(ctx, LUNCH)).id);
        ids.push((await h.createEvent(ctx, Object.assign({}, LUNCH, { title: 'Two' }))).id);
        ids.push((await h.createEvent(ctx, Object.assign({}, LUNCH, { title: 'Three', calendarIds: { [other]: true } }))).id);
        const res = await h.evGet(ctx, null);
        expect(res.list.map(object => object.id).sort()).to.deep.equal(ids.sort());
        // an instance where the account holds more events than maxObjectsInGet
        const { app, url } = await instance.startInstance({ limits: Object.assign({}, config.jmap.limits, { maxObjectsInGet: 2 }) });
        try {
            const client = jmap.forUser(ctx.user);
            const raw = client.raw.bind(client);
            client.raw = (path, init) => raw(path.startsWith('http') ? path : url + path, init);
            await h.expectError(client.method('CalendarEvent/get', { ids: null }, h.USING), 'requestTooLarge');
        } finally {
            await instance.stopInstance(app);
        }
    });

    scenario('CEV-005', async () => {
        const ctx = await h.setupUser();
        for (const type of ['Task', 'Group']) {
            const { error } = await h.tryCreate(ctx, Object.assign({ '@type': type }, LUNCH));
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal(['@type']);
        }
    });

    scenario('CEV-006', async () => {
        const ctx = await h.setupUser();
        const first = await h.createEvent(ctx, LUNCH);
        const second = await h.createEvent(ctx, Object.assign({ version: '2.0' }, LUNCH));
        for (const id of [first.id, second.id]) {
            expect((await h.fetch1(ctx, id)).version).to.equal('2.0');
        }
        const { error } = await h.tryCreate(ctx, Object.assign({ version: '9.0' }, LUNCH));
        h.expectInvalid(error);
        expect(error.properties).to.deep.equal(['version']);
    });

    scenario('CEV-007', async () => {
        const ctx = await h.setupUser();
        const { error } = await h.tryCreate(ctx, { title: 'No start' });
        h.expectInvalid(error);
        expect(error.properties).to.deep.equal(['start']);
    });

    scenario('CEV-008', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, { start: '2026-03-10T12:00:00' });
        const object = await h.fetch1(ctx, id);
        expect(object.title === undefined || object.title === '').to.equal(true);
        expect(object.duration === undefined || object.duration === 'PT0S').to.equal(true);
        expect(object.timeZone === undefined || object.timeZone === null).to.equal(true);
    });

    scenario('CEV-009', async () => {
        const ctx = await h.setupUser();
        for (const calendarIds of [undefined, {}, null]) {
            const object = Object.assign({}, LUNCH, calendarIds === undefined ? {} : { calendarIds });
            const res = await h.evSet(ctx, { create: { k: object } });
            h.expectInvalid(res.notCreated.k);
            expect(res.notCreated.k.properties).to.deep.equal(['calendarIds']);
        }
    });

    scenario('CEV-010', async () => {
        const ctx = await h.setupUser();
        for (const calendarIds of [{ Znope: true }, { [ctx.calendar]: false }]) {
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { calendarIds }));
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal(['calendarIds']);
        }
        expect((await h.evGet(ctx, null)).list).to.have.length(0);
    });

    scenario('CEV-011', async () => {
        const ctx = await h.setupUser();
        const session = await ctx.client.session();
        const n = session.accounts[ctx.client.accountId].accountCapabilities[jmap.URN.calendars].maxCalendarsPerEvent;
        expect(n).to.be.a('number').and.at.least(1);
        const calendars = [ctx.calendar];
        while (calendars.length < n + 1) {
            calendars.push(await h.createCalendar(ctx));
        }
        const ok = await h.createEvent(ctx, Object.assign({}, LUNCH, { calendarIds: Object.fromEntries(calendars.slice(0, n).map(id => [id, true])) }));
        expect(Object.keys((await h.fetch1(ctx, ok.id)).calendarIds).sort()).to.deep.equal(calendars.slice(0, n).sort());
        const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { calendarIds: Object.fromEntries(calendars.map(id => [id, true])) }));
        h.expectInvalid(error);
        expect(error.properties).to.deep.equal(['calendarIds']);
    });

    scenario('CEV-012', async () => {
        const ctx = await h.setupUser();
        const res = await h.evSet(ctx, {
            create: {
                a: Object.assign({ calendarIds: { [ctx.calendar]: true } }, LUNCH),
                b: Object.assign({ calendarIds: { [ctx.calendar]: true } }, LUNCH),
                c: Object.assign({ calendarIds: { [ctx.calendar]: true }, uid: '5d5776f6-ff8e-4bfd-ab3e-fe2fe5d4fa91' }, LUNCH)
            }
        });
        expect(res.created.a.uid).to.be.a('string').and.not.equal('');
        expect(res.created.b.uid).to.be.a('string').and.not.equal(res.created.a.uid);
        expect(res.created.c).to.not.have.property('uid');
        expect((await h.fetch1(ctx, res.created.c.id)).uid).to.equal('5d5776f6-ff8e-4bfd-ab3e-fe2fe5d4fa91');
    });

    scenario('CEV-013', async () => {
        const ctx = await h.setupUser();
        const uid = 'weird uid/with spaces@example.com';
        const first = await h.createEvent(ctx, Object.assign({ uid }, LUNCH));
        await h.evSet(ctx, { destroy: [first.id] });
        const second = await h.createEvent(ctx, Object.assign({ uid }, LUNCH));
        for (const { id } of [first, second]) {
            expect(id).to.match(h.ID);
            expect(Buffer.byteLength(id)).to.be.at.most(255);
        }
        expect(second.id).to.not.equal(first.id);
        expect((await h.fetch1(ctx, second.id)).uid).to.equal(uid);
    });

    scenario('CEV-014', async () => {
        const ctx = await h.setupUser();
        const c2 = await h.createCalendar(ctx);
        const original = await h.createEvent(ctx, Object.assign({ uid: 'u-1' }, LUNCH));
        const before = await h.fetch1(ctx, original.id);
        for (const calendar of [ctx.calendar, c2]) {
            const { error } = await h.tryCreate(ctx, Object.assign({ uid: 'u-1', calendarIds: { [calendar]: true } }, LUNCH));
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal(['uid']);
        }
        expect(await h.fetch1(ctx, original.id)).to.deep.equal(before);
    });

    scenario('CEV-015', async () => {
        const ctx = await h.setupUser();
        const object = Object.assign({ calendarIds: { [ctx.calendar]: true }, uid: 'u-2' }, LUNCH);
        const res = await h.evSet(ctx, { create: { a: object, b: object } });
        expect(Object.keys(res.created || {})).to.have.length(1);
        const failed = Object.values(res.notCreated || {});
        expect(failed).to.have.length(1);
        h.expectInvalid(failed[0]);
        expect(failed[0].properties).to.deep.equal(['uid']);
    });

    scenario('CEV-016', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, Object.assign({ uid: 'u-1' }, LUNCH));
        const { error } = await h.tryUpdate(ctx, id, { uid: 'u-other' });
        h.expectInvalid(error);
        expect(error.properties).to.deep.equal(['uid']);
        // the unchanged uid is accepted
        await h.update(ctx, id, { uid: 'u-1', title: 'Same uid' });
    });

    const standalone = (recurrenceId, extra = {}) =>
        Object.assign(
            {
                uid: 'series-1',
                recurrenceIdTimeZone: 'Europe/Tallinn',
                recurrenceId,
                title: 'Instance',
                start: recurrenceId,
                timeZone: 'Europe/Tallinn',
                duration: 'PT1H'
            },
            extra
        );

    scenario('CEV-017', async () => {
        const ctx = await h.setupUser();
        const a = await h.createEvent(ctx, standalone('2026-01-05T09:00:00'));
        const b = await h.createEvent(ctx, standalone('2026-01-12T09:00:00'));
        expect(a.id).to.not.equal(b.id);
        const res = await h.evGet(ctx, [a.id, b.id]);
        expect(res.list.map(object => object.recurrenceId)).to.deep.equal(['2026-01-05T09:00:00', '2026-01-12T09:00:00']);
        for (const object of res.list) {
            expect(object).to.not.have.property('recurrenceRule');
            expect(object).to.not.have.property('recurrenceOverrides');
        }
    });

    scenario('CEV-018', async () => {
        const ctx = await h.setupUser();
        await h.createEvent(ctx, standalone('2026-01-05T09:00:00'));
        const duplicate = await h.tryCreate(ctx, standalone('2026-01-05T09:00:00'));
        h.expectInvalid(duplicate.error);
        expect(duplicate.error.properties).to.include('uid');
        const base = await h.tryCreate(ctx, { uid: 'series-1', title: 'Base', start: '2026-01-05T09:00:00', recurrenceRule: { frequency: 'weekly' } });
        h.expectInvalid(base.error);
        expect(base.error.properties).to.deep.equal(['uid']);
    });

    scenario('CEV-019', async () => {
        const ctx = await h.setupUser();
        const cases = [
            [{ recurrenceId: '2026-01-05T09:00:00', start: '2026-01-05T09:00:00' }, 'recurrenceIdTimeZone'],
            [{ recurrenceIdTimeZone: 'Europe/Tallinn', start: '2026-01-05T09:00:00' }, 'recurrenceIdTimeZone'],
            [
                { recurrenceId: '2026-01-05T09:00:00', recurrenceIdTimeZone: null, start: '2026-01-05T09:00:00', recurrenceRule: { frequency: 'daily' } },
                'recurrenceRule'
            ]
        ];
        for (const [values, property] of cases) {
            const { error } = await h.tryCreate(ctx, values);
            h.expectInvalid(error, property);
        }
        // recurrenceIdTimeZone null is a floating series and valid
        await h.createEvent(ctx, { recurrenceId: '2026-01-05T09:00:00', recurrenceIdTimeZone: null, start: '2026-01-05T09:00:00' });
    });

    scenario('CEV-020', async () => {
        const ctx = await h.setupUser();
        const i1 = await h.createEvent(ctx, standalone('2026-01-05T09:00:00'));
        const i2 = await h.createEvent(ctx, standalone('2026-01-12T09:00:00'));
        const s1 = await h.evState(ctx);
        const res = await h.evSet(ctx, {
            destroy: [i1.id, i2.id],
            create: { base: Object.assign({ calendarIds: { [ctx.calendar]: true }, uid: 'series-1' }, h.WEEKLY) }
        });
        expect(res.notCreated).to.equal(null);
        expect(res.notDestroyed).to.equal(null);
        expect(res.destroyed.sort()).to.deep.equal([i1.id, i2.id].sort());
        const changes = await h.evChanges(ctx, s1);
        expect(changes.destroyed.sort()).to.deep.equal([i1.id, i2.id].sort());
        expect(changes.created).to.deep.equal([res.created.base.id]);
    });

    scenario('CEV-021', async () => {
        const ctx = await h.setupUser();
        const i1 = await h.createEvent(ctx, standalone('2026-01-05T09:00:00'));
        const i2 = await h.createEvent(ctx, standalone('2026-01-12T09:00:00'));
        await h.update(ctx, i1.id, { title: 'Changed' });
        const res = await h.evGet(ctx, [i1.id, i2.id], { properties: ['title'] });
        expect(res.list.map(object => object.title)).to.deep.equal(['Changed', 'Instance']);
        await h.evSet(ctx, { destroy: [i1.id] });
        const after = await h.evGet(ctx, [i1.id, i2.id]);
        expect(after.notFound).to.deep.equal([i1.id]);
        expect(after.list.map(object => object.id)).to.deep.equal([i2.id]);
    });

    scenario('CEV-022', async () => {
        const ctx = await h.setupUser();
        const first = await h.createEvent(ctx, LUNCH);
        near(first.created);
        const second = await h.createEvent(ctx, Object.assign({ created: '2020-01-01T00:00:00Z' }, LUNCH));
        const object = await h.fetch1(ctx, second.id);
        expect(object.created).to.equal('2020-01-01T00:00:00Z');
        near(object.updated);
    });

    scenario('CEV-023', async () => {
        const ctx = await h.setupUser();
        const created = await h.createEvent(ctx, Object.assign({ created: '2099-01-01T00:00:00Z', updated: '2099-01-01T00:00:00Z' }, LUNCH));
        near(created.created);
        near(created.updated);
        const object = await h.fetch1(ctx, created.id);
        expect(object.created).to.equal(created.created);
        expect(object.updated).to.equal(created.updated);
    });

    scenario('CEV-024', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, LUNCH);
        const before = await h.fetch1(ctx, id);
        await clock.delay(1100);
        const updated = await h.update(ctx, id, { title: 'Late lunch', updated: '2001-01-01T00:00:00Z' });
        near(updated.updated);
        expect(Date.parse(updated.updated)).to.be.above(Date.parse(before.updated));
        const after = await h.fetch1(ctx, id);
        expect(after.updated).to.equal(updated.updated);
        expect(after.created).to.equal(before.created);
    });

    const external = (extra = {}) =>
        Object.assign(
            {
                title: 'Remote meeting',
                start: '2026-03-10T12:00:00',
                timeZone: 'Europe/Tallinn',
                organizerCalendarAddress: 'mailto:boss@remote.example',
                participants: {
                    boss: { '@type': 'Participant', calendarAddress: 'mailto:boss@remote.example', roles: { owner: true } },
                    me: { '@type': 'Participant', calendarAddress: 'MAILTO_SELF', roles: { attendee: true }, participationStatus: 'needs-action' }
                }
            },
            extra
        );
    const externalFor = (ctx, extra) => {
        const values = external(extra);
        values.participants.me.calendarAddress = `mailto:${ctx.user.address}`;
        return values;
    };

    scenario('CEV-025', async () => {
        const ctx = await h.setupUser();
        const created = await h.createEvent(ctx, externalFor(ctx, { updated: '2026-01-01T00:00:00Z', keywords: { seed: true } }));
        expect(created.isOrigin).to.equal(false);
        await h.update(ctx, created.id, { 'keywords/work': true });
        expect((await h.fetch1(ctx, created.id)).updated).to.equal('2026-01-01T00:00:00Z');
        await h.update(ctx, created.id, { title: 'Changed locally' });
        expect((await h.fetch1(ctx, created.id)).updated).to.equal('2026-01-01T00:00:00Z');
        const bare = await h.createEvent(ctx, externalFor(ctx));
        expect(await h.fetch1(ctx, bare.id)).to.not.have.property('updated');
    });

    scenario('CEV-026', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, Object.assign({ sequence: 0 }, LUNCH));
        expect((await h.update(ctx, id, { title: 'New' })).sequence).to.equal(1);
        expect((await h.update(ctx, id, { start: '2026-03-10T13:00:00', sequence: 0 })).sequence).to.equal(2);
        expect((await h.fetch1(ctx, id)).sequence).to.equal(2);
    });

    scenario('CEV-027', async () => {
        const ctx = await h.setupUser();
        const c2 = await h.createCalendar(ctx);
        const { id } = await h.createEvent(ctx, Object.assign({ sequence: 3, keywords: { seed: true }, alerts: {} }, LUNCH));
        const patches = [
            { 'keywords/x': true },
            { color: 'red' },
            { freeBusyStatus: 'free' },
            { useDefaultAlerts: true },
            { 'alerts/a1': { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } },
            { calendarIds: { [c2]: true } },
            { updated: '2026-01-01T00:00:00Z' }
        ];
        for (const patch of patches) {
            await h.update(ctx, id, patch);
            expect((await h.fetch1(ctx, id)).sequence, JSON.stringify(patch)).to.equal(3);
        }
    });

    scenario('CEV-028', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, Object.assign({ sequence: 1 }, LUNCH));
        await h.update(ctx, id, { title: 'X', sequence: 5 });
        expect((await h.fetch1(ctx, id)).sequence).to.equal(5);
    });

    scenario('CEV-029', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, externalFor(ctx, { sequence: 2 }));
        await h.update(ctx, id, { 'participants/me/participationStatus': 'accepted' });
        expect((await h.fetch1(ctx, id)).sequence).to.equal(2);
        await h.update(ctx, id, { title: 'Renamed' });
        expect((await h.fetch1(ctx, id)).sequence).to.equal(2);
    });

    scenario('CEV-030', async () => {
        const ctx = await h.setupUser();
        const { error } = await h.tryCreate(ctx, Object.assign({ method: 'request' }, LUNCH));
        h.expectInvalid(error);
        expect(error.properties).to.deep.equal(['method']);
        const { id } = await h.createEvent(ctx, LUNCH);
        const updated = await h.tryUpdate(ctx, id, { method: 'cancel' });
        h.expectInvalid(updated.error);
        expect(updated.error.properties).to.deep.equal(['method']);
        expect(await h.fetch1(ctx, id)).to.not.have.property('method');
        expect((await h.evGet(ctx, null)).list.every(object => !Object.hasOwn(object, 'method'))).to.equal(true);
    });

    scenario('CEV-031', async () => {
        const ctx = await h.setupUser();
        const nulls = { description: null, locations: null, alerts: null, recurrenceRule: null, participants: null, descriptionContentType: null };
        const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, nulls));
        const object = await h.fetch1(ctx, id);
        for (const property of Object.keys(nulls)) {
            expect(object, property).to.not.have.property(property);
        }
    });

    scenario('CEV-032', async () => {
        const ctx = await h.setupUser();
        const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { locations: { l1: { '@type': 'Location', name: null } } }));
        h.expectInvalid(error, 'locations/l1/name');
    });

    scenario('CEV-033', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, LUNCH);
        for (const [patch, property] of [
            [{ id: 'Zother' }, 'id'],
            [{ isOrigin: false }, 'isOrigin'],
            [{ baseEventId: 'Zbase' }, 'baseEventId']
        ]) {
            const { error } = await h.tryUpdate(ctx, id, patch);
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal([property]);
        }
        const create = await h.tryCreate(ctx, Object.assign({ baseEventId: id }, LUNCH));
        h.expectInvalid(create.error);
        expect(create.error.properties).to.deep.equal(['baseEventId']);
        // unchanged values are accepted
        await h.update(ctx, id, { id, isOrigin: true, title: 'Same' });
    });

    scenario('CEV-034', async () => {
        const ctx = await h.setupUser();
        const d = await h.createEvent(ctx, Object.assign({ isDraft: true }, LUNCH));
        const n = await h.createEvent(ctx, LUNCH);
        const flags = async () => (await h.evGet(ctx, [d.id, n.id], { properties: ['isDraft'] })).list.map(object => object.isDraft);
        expect(await flags()).to.deep.equal([true, false]);
        await h.update(ctx, d.id, { title: 'D' });
        await h.update(ctx, n.id, { title: 'N' });
        expect(await flags()).to.deep.equal([true, false]);
    });

    scenario('CEV-035', async () => {
        const ctx = await h.setupUser();
        const d = await h.createEvent(ctx, Object.assign({ isDraft: true }, LUNCH));
        const n = await h.createEvent(ctx, LUNCH);
        await h.update(ctx, d.id, { isDraft: false });
        for (const id of [d.id, n.id]) {
            const { error } = await h.tryUpdate(ctx, id, { isDraft: true });
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal(['isDraft']);
        }
    });

    scenario('CEV-036', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, h.WEEKLY);
        const { error } = await h.tryUpdate(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': { isDraft: true } } });
        h.expectInvalidAt(error, 'recurrenceOverrides');
    });

    scenario('CEV-037', async () => {
        const ctx = await h.setupUser();
        for (const start of ['2026-03-10T12:00:00Z', '2026-03-10T12:00:00+02:00', '2026-03-10', '2026-02-30T10:00:00', '2026-03-10T25:00:00']) {
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { start }));
            h.expectInvalid(error);
            expect(error.properties, start).to.deep.equal(['start']);
        }
    });

    scenario('CEV-038', async () => {
        const ctx = await h.setupUser();
        for (const values of [{ start: '2026-06-01T08:00:00', timeZone: null }, { start: '2026-06-01T08:00:00' }]) {
            const { id } = await h.createEvent(ctx, values);
            const object = await h.fetch1(ctx, id);
            expect(object.start).to.equal('2026-06-01T08:00:00');
            expect(object.timeZone === undefined || object.timeZone === null).to.equal(true);
        }
    });

    scenario('CEV-039', async () => {
        const ctx = await h.setupUser();
        for (const timeZone of ['Europe/Atlantis', 'GMT+2']) {
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { timeZone }));
            h.expectInvalid(error);
            expect(error.properties, timeZone).to.deep.equal(['timeZone']);
        }
    });

    scenario('CEV-040', async () => {
        const ctx = await h.setupUser();
        const expected = { 'US/Eastern': '2026-03-10T16:00:00Z', 'Asia/Calcutta': '2026-03-10T06:30:00Z' };
        for (const [timeZone, utcStart] of Object.entries(expected)) {
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { timeZone }));
            const object = await h.fetch1(ctx, id, { properties: ['timeZone', 'utcStart'] });
            expect(object.timeZone).to.equal(timeZone);
            expect(object.utcStart, timeZone).to.equal(utcStart);
        }
    });

    scenario('CEV-041', async () => {
        const ctx = await h.setupUser();
        const values = { start: '2026-07-01T00:00:00', duration: 'P1D', showWithoutTime: true };
        const { id } = await h.createEvent(ctx, values);
        const object = await h.fetch1(ctx, id);
        expect(object).to.include(values);
        expect(object.timeZone === undefined || object.timeZone === null).to.equal(true);
        const other = await h.fetch1(ctx, (await h.createEvent(ctx, LUNCH)).id);
        expect(other.showWithoutTime === undefined || other.showWithoutTime === false).to.equal(true);
    });

    scenario('CEV-042', async () => {
        const ctx = await h.setupUser();
        for (const duration of ['PT1H30M', 'P1W', 'P1DT2H', 'PT0S']) {
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { duration }));
            expect((await h.fetch1(ctx, id)).duration).to.equal(duration);
        }
        for (const duration of ['-PT1H', '1h', 'P1M']) {
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { duration }));
            h.expectInvalid(error);
            expect(error.properties, duration).to.deep.equal(['duration']);
        }
    });

    scenario('CEV-043', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, { start: '2026-05-01T22:00:00', timeZone: 'Europe/London', duration: 'PT9H', endTimeZone: 'Asia/Tokyo' });
        const object = await h.fetch1(ctx, id, { properties: ['endTimeZone', 'utcStart', 'utcEnd'] });
        expect(object.endTimeZone).to.equal('Asia/Tokyo');
        expect(object.utcStart).to.equal('2026-05-01T21:00:00Z');
        expect(object.utcEnd).to.equal('2026-05-02T06:00:00Z');
    });

    scenario('CEV-044', async () => {
        const ctx = await h.setupUser();
        const session = await ctx.client.session();
        const capability = session.accounts[ctx.client.accountId].accountCapabilities[jmap.URN.calendars];
        const local = (ms, shift) => new Date(ms + shift).toISOString().slice(0, 19);
        const min = Date.parse(capability.minDateTime);
        const max = Date.parse(capability.maxDateTime);
        const day = 24 * 3600 * 1000;
        const before = await h.tryCreate(ctx, { start: local(min, -day), timeZone: 'Etc/UTC' });
        h.expectInvalid(before.error);
        expect(before.error.properties).to.deep.equal(['start']);
        const afterMax = await h.tryCreate(ctx, { start: local(max, day), timeZone: 'Etc/UTC' });
        h.expectInvalid(afterMax.error);
        expect(afterMax.error.properties).to.deep.equal(['start']);
        const until = await h.tryCreate(ctx, {
            start: '2026-01-01T09:00:00',
            timeZone: 'Etc/UTC',
            recurrenceRule: { frequency: 'daily', until: local(max, day) }
        });
        h.expectInvalid(until.error);
        expect(until.error.properties).to.deep.equal(['recurrenceRule/until']);
        await h.createEvent(ctx, { start: local(min, 0), timeZone: 'Etc/UTC' });
    });

    scenario('CEV-045', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, LUNCH);
        expect(await h.fetch1(ctx, id, { properties: ['utcStart', 'utcEnd', 'start'] })).to.deep.equal({
            id,
            utcStart: '2026-03-10T10:00:00Z',
            utcEnd: '2026-03-10T11:00:00Z',
            start: LUNCH.start
        });
        const all = await h.fetch1(ctx, id, { properties: null });
        expect(all).to.not.have.property('utcStart');
        expect(all).to.not.have.property('utcEnd');
    });

    scenario('CEV-046', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, { start: '2026-07-01T09:00:00', duration: 'PT30M' });
        const cases = [
            [undefined, '2026-07-01T09:00:00Z', '2026-07-01T09:30:00Z'],
            ['America/New_York', '2026-07-01T13:00:00Z', '2026-07-01T13:30:00Z'],
            ['Asia/Tokyo', '2026-07-01T00:00:00Z', '2026-07-01T00:30:00Z']
        ];
        for (const [timeZone, utcStart, utcEnd] of cases) {
            const object = await h.fetch1(ctx, id, Object.assign({ properties: ['utcStart', 'utcEnd'] }, timeZone ? { timeZone } : {}));
            expect(object, timeZone).to.deep.equal({ id, utcStart, utcEnd });
        }
    });

    scenario('CEV-047', async () => {
        const ctx = await h.setupUser();
        const zoned = await h.createEvent(ctx, LUNCH);
        const floating = await h.createEvent(ctx, { start: '2026-07-01T09:00:00' });
        const res = await h.evGet(ctx, [zoned.id, floating.id], { timeZone: 'Asia/Tokyo', properties: ['start', 'timeZone'] });
        expect(res.list[0]).to.deep.equal({ id: zoned.id, start: LUNCH.start, timeZone: 'Europe/Tallinn' });
        expect(res.list[1].start).to.equal('2026-07-01T09:00:00');
        expect(res.list[1].timeZone === undefined || res.list[1].timeZone === null).to.equal(true);
        const utc = await h.fetch1(ctx, zoned.id, { timeZone: 'Asia/Tokyo', properties: ['utcStart'] });
        expect(utc.utcStart).to.equal('2026-03-10T10:00:00Z');
    });

    scenario('CEV-048', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, h.WEEKLY);
        for (const property of ['utcStart', 'utcEnd']) {
            await h.expectError(h.evGet(ctx, [id], { properties: [property, 'recurrenceOverrides'] }), 'invalidArguments');
        }
    });

    scenario('CEV-049', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, LUNCH);
        await h.expectError(h.evGet(ctx, [id], { timeZone: 'Nowhere/City', properties: ['utcStart'] }), 'invalidArguments');
    });

    scenario('CEV-050', async () => {
        const ctx = await h.setupUser();
        const a = await h.createEvent(ctx, { start: '2026-03-28T09:00:00', timeZone: 'Europe/Tallinn' });
        const b = await h.createEvent(ctx, { start: '2026-03-29T09:00:00', timeZone: 'Europe/Tallinn' });
        const res = await h.evGet(ctx, [a.id, b.id], { properties: ['utcStart'] });
        expect(res.list.map(object => object.utcStart)).to.deep.equal(['2026-03-28T07:00:00Z', '2026-03-29T06:00:00Z']);
    });

    scenario('CEV-051', async () => {
        const ctx = await h.setupUser();
        const created = await h.createEvent(ctx, { utcStart: '2026-03-10T10:00:00Z', timeZone: 'Europe/Tallinn', duration: 'PT1H' });
        expect(created.start).to.equal('2026-03-10T12:00:00');
        const object = await h.fetch1(ctx, created.id);
        expect(object.start).to.equal('2026-03-10T12:00:00');
        expect(object.timeZone).to.equal('Europe/Tallinn');
        expect(object).to.not.have.property('utcStart');
    });

    scenario('CEV-052', async () => {
        const ctx = await h.setupUser();
        const a = await h.createCalendar(ctx, { name: 'A', timeZone: 'Australia/Melbourne' });
        const b = await h.createCalendar(ctx, { name: 'B', timeZone: null });
        const inA = await h.createEvent(ctx, { calendarIds: { [a]: true }, utcStart: '2026-01-10T00:00:00Z' });
        expect(inA.timeZone).to.equal('Australia/Melbourne');
        expect(inA.start).to.equal('2026-01-10T11:00:00');
        const inB = await h.createEvent(ctx, { calendarIds: { [b]: true }, utcStart: '2026-01-10T00:00:00Z' });
        expect(inB.timeZone).to.equal('Etc/UTC');
        expect(inB.start).to.equal('2026-01-10T00:00:00');
    });

    scenario('CEV-053', async () => {
        const { url } = await h.multiInstance();
        const ctx = await h.setupUser({}, url);
        const a = await h.createCalendar(ctx, { name: 'A', timeZone: 'Australia/Melbourne' });
        const b = await h.createCalendar(ctx, { name: 'B', timeZone: 'Europe/Tallinn' });
        const created = await h.createEvent(ctx, { calendarIds: { [a]: true, [b]: true }, utcStart: '2026-01-10T00:00:00Z' });
        expect(created.timeZone).to.equal('Etc/UTC');
        expect(created.start).to.equal('2026-01-10T00:00:00');
    });

    scenario('CEV-054', async () => {
        const ctx = await h.setupUser();
        const both = await h.tryCreate(ctx, { start: '2026-03-10T12:00:00', utcStart: '2026-03-10T10:00:00Z', timeZone: 'Europe/Tallinn' });
        h.expectInvalid(both.error);
        expect(both.error.properties.some(property => ['utcStart', 'start'].includes(property))).to.equal(true);
        const end = await h.tryCreate(ctx, { utcStart: '2026-03-10T10:00:00Z', utcEnd: '2026-03-10T11:00:00Z', duration: 'PT1H', timeZone: 'Europe/Tallinn' });
        h.expectInvalid(end.error);
        expect(end.error.properties.some(property => ['utcEnd', 'duration'].includes(property))).to.equal(true);
    });

    scenario('CEV-055', async () => {
        const ctx = await h.setupUser();
        const created = await h.createEvent(ctx, { utcStart: '2026-03-10T10:00:00Z', utcEnd: '2026-03-10T11:30:00Z', timeZone: 'Europe/Tallinn' });
        expect((await h.fetch1(ctx, created.id)).duration).to.equal('PT1H30M');
        const { error } = await h.tryCreate(ctx, { utcStart: '2026-03-10T10:00:00Z', utcEnd: '2026-03-10T09:00:00Z', timeZone: 'Europe/Tallinn' });
        h.expectInvalid(error, 'utcEnd');
    });

    scenario('CEV-056', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, LUNCH);
        const updated = await h.update(ctx, id, { utcStart: '2026-03-11T08:00:00Z', utcEnd: '2026-03-11T10:00:00Z' });
        expect(updated.start).to.equal('2026-03-11T10:00:00');
        expect(updated.duration).to.equal('PT2H');
        const object = await h.fetch1(ctx, id);
        expect(object).to.include({ start: '2026-03-11T10:00:00', duration: 'PT2H', timeZone: 'Europe/Tallinn' });
    });

    scenario('CEV-057', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(ctx, h.WEEKLY);
        for (const patch of [{ utcStart: '2026-01-12T10:00:00Z' }, { utcEnd: '2026-01-12T11:00:00Z' }]) {
            const { error } = await h.tryUpdate(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': patch } });
            h.expectInvalidAt(error, 'recurrenceOverrides');
        }
    });

    scenario('CEV-058', async () => {
        const ctx = await h.setupUser();
        const html = await h.createEvent(ctx, Object.assign({}, LUNCH, { description: '<b>Agenda</b>', descriptionContentType: 'text/html' }));
        expect(await h.fetch1(ctx, html.id)).to.include({ description: '<b>Agenda</b>', descriptionContentType: 'text/html' });
        const plain = await h.fetch1(ctx, (await h.createEvent(ctx, Object.assign({}, LUNCH, { description: 'Plain' }))).id);
        expect(plain.descriptionContentType === undefined || plain.descriptionContentType === 'text/plain').to.equal(true);
        const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { description: 'x', descriptionContentType: 'application/pdf' }));
        h.expectInvalid(error);
        expect(error.properties).to.deep.equal(['descriptionContentType']);
    });

    scenario('CEV-059', async () => {
        const ctx = await h.setupUser();
        const locations = { l1: { '@type': 'Location', name: 'Room 4' }, l2: { '@type': 'Location', name: 'Harbour', coordinates: 'geo:59.44,24.75' } };
        const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { locations }));
        expect((await h.fetch1(ctx, id)).locations).to.deep.equal(locations);
    });

    scenario('CEV-060', async () => {
        const ctx = await h.setupUser();
        const virtualLocations = { v1: { '@type': 'VirtualLocation', name: 'Call', uri: 'https://meet.example.com/abc' } };
        const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { virtualLocations }));
        expect((await h.fetch1(ctx, id)).virtualLocations).to.deep.equal(virtualLocations);
        const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { virtualLocations: { v1: { '@type': 'VirtualLocation', name: 'Call' } } }));
        h.expectInvalid(error, 'virtualLocations/v1/uri');
    });

    scenario('CEV-061', async () => {
        const ctx = await h.setupUser();
        const links = { a: { '@type': 'Link', href: 'https://example.com/agenda.pdf', contentType: 'application/pdf', rel: 'describedby', title: 'Agenda' } };
        const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { links }));
        expect((await h.fetch1(ctx, id)).links).to.deep.equal(links);
    });

    scenario('CEV-062', async () => {
        const ctx = await h.setupUser();
        const pdf = Buffer.from('%PDF-1.4 notes');
        const blobId = await upload(ctx, pdf, 'application/pdf');
        const link = { '@type': 'Link', rel: 'enclosure', blobId, contentType: 'application/pdf', title: 'notes.pdf' };
        const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { links: { att: link } }));
        expect((await h.fetch1(ctx, id)).links.att).to.deep.equal(link);
        const res = await download(ctx, blobId);
        expect(res.status).to.equal(200);
        expect(res.body.equals(pdf)).to.equal(true);
    });

    scenario('CEV-063', async () => {
        const ctx = await h.setupUser();
        const unknown = await h.tryCreate(ctx, Object.assign({}, LUNCH, { links: { att: { '@type': 'Link', rel: 'enclosure', blobId: 'Bnope' } } }));
        h.expectInvalidAt(unknown.error, 'links/att');
        const empty = await h.tryCreate(ctx, Object.assign({}, LUNCH, { links: { att: { '@type': 'Link', rel: 'enclosure' } } }));
        h.expectInvalidAt(empty.error, 'links/att');
    });

    scenario('CEV-064', async () => {
        const ctx = await h.setupUser();
        const blobId = await upload(ctx, Buffer.from('kept while referenced'), 'text/plain');
        const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { links: { att: { '@type': 'Link', rel: 'enclosure', blobId } } }));
        const db = await instance.connect();
        const storage = new StorageHandler({ database: db.database, gridfs: db.gridfs });
        const later = days => ({
            'metadata.user': new seed.ObjectId(ctx.user.id),
            'metadata.expires': { $lt: new Date(Date.now() + days * 24 * 3600 * 1000) }
        });
        // the clock past the upload expiry (one day): the GC removes what expired by then
        await storage.removeUploads(later(2));
        expect((await download(ctx, blobId)).status).to.equal(200);
        await h.evSet(ctx, { destroy: [id] });
        await storage.removeUploads(later(2));
        expect((await download(ctx, blobId)).status).to.equal(404);
    });

    scenario('CEV-065', async () => {
        const ctx = await h.setupUser();
        const { id } = await h.createEvent(
            ctx,
            Object.assign({}, LUNCH, { links: { att: { '@type': 'Link', rel: 'enclosure', href: 'data:text/plain;base64,aGVsbG8=' } } })
        );
        const link = (await h.fetch1(ctx, id)).links.att;
        expect(link.blobId).to.be.a('string');
        expect(link.contentType).to.equal('text/plain');
        expect(link).to.not.have.property('href');
        const res = await download(ctx, link.blobId);
        expect(res.status).to.equal(200);
        expect(res.body.toString()).to.equal('hello');
    });

    scenario('CEV-066', async () => {
        const ctx = await h.setupUser();
        const blobId = await upload(ctx, Buffer.from('looked up'), 'text/plain');
        const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { links: { att: { '@type': 'Link', rel: 'enclosure', blobId } } }));
        const res = await ctx.client.method('Blob/lookup', { typeNames: ['CalendarEvent'], ids: [blobId] }, [jmap.URN.core, jmap.URN.blob, jmap.URN.calendars]);
        expect(res.list).to.deep.equal([{ id: blobId, matchedIds: { CalendarEvent: [id] } }]);
    });

    describe('links of locations and participants, data: URI uploads', () => {
        const uploadsOf = async ctx =>
            (await instance.connect()).gridfs.collection('storage.files').countDocuments({ 'metadata.user': new seed.ObjectId(ctx.user.id) });
        const dataLink = { '@type': 'Link', rel: 'enclosure', href: 'data:text/plain;base64,aGVsbG8=' };

        describe('links in recurrence overrides (R-2)', () => {
            const RID = '2026-01-12T09:00:00';
            const linkOf = blobId => ({ '@type': 'Link', rel: 'enclosure', blobId });
            const expired = ctx => ({
                'metadata.user': new seed.ObjectId(ctx.user.id),
                'metadata.expires': { $lt: new Date(Date.now() + 2 * 24 * 3600 * 1000) }
            });
            const storage = async () => {
                const db = await instance.connect();
                return new StorageHandler({ database: db.database, gridfs: db.gridfs });
            };

            it('uploads named by override links in every form stay pinned', async () => {
                const ctx = await h.setupUser();
                const ids = [];
                for (const name of ['map', 'pointer', 'nested', 'leaf']) {
                    ids.push(await upload(ctx, Buffer.from(`override ${name}`), 'text/plain'));
                }
                const base = Object.assign({}, h.WEEKLY, {
                    links: { att: { '@type': 'Link', rel: 'enclosure', href: 'https://example.com/a' } },
                    locations: { l1: { '@type': 'Location', name: 'Room' } }
                });
                const { id } = await h.createEvent(ctx, base);
                // a patch may not hold a pointer and one below it, so each form gets an instance of its own
                const overrides = {
                    '2026-01-12T09:00:00': { links: { m: linkOf(ids[0]) } },
                    '2026-01-19T09:00:00': { 'links/p': linkOf(ids[1]) },
                    '2026-01-26T09:00:00': { 'locations/l1/links': { n: linkOf(ids[2]) } },
                    '2026-02-02T09:00:00': { 'links/att/blobId': ids[3] }
                };
                const { error } = await h.tryUpdate(ctx, id, { recurrenceOverrides: overrides });
                expect(error, JSON.stringify(error)).to.not.exist;
                await (await storage()).removeUploads(expired(ctx));
                for (const blobId of ids) {
                    expect((await download(ctx, blobId)).status, blobId).to.equal(200);
                }
            });

            it('an unknown blobId in an override answers invalidProperties', async () => {
                const ctx = await h.setupUser();
                const other = await h.setupUser();
                const foreign = await upload(other, Buffer.from('not yours'), 'text/plain');
                const { id } = await h.createEvent(ctx, h.WEEKLY);
                for (const patch of [{ 'links/x': linkOf('Bnope') }, { links: { x: linkOf(foreign) } }, { 'links/x/blobId': 'Bnope' }]) {
                    const { error } = await h.tryUpdate(ctx, id, { recurrenceOverrides: { [RID]: patch } });
                    h.expectInvalidAt(error, `recurrenceOverrides/${RID}`);
                }
            });
        });

        it('a participant link must name an upload of the account', async () => {
            const ctx = await h.setupUser();
            const other = await h.setupUser();
            const foreign = await upload(other, Buffer.from('not yours'), 'text/plain');
            const participants = { p: { '@type': 'Participant', calendarAddress: 'mailto:p@example.net', links: { l: { '@type': 'Link', blobId: foreign } } } };
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { participants }));
            h.expectInvalid(error, ['participants/p/links/l/blobId']);
        });

        it('no upload is made from a data: URI when another link of the event is invalid', async () => {
            const ctx = await h.setupUser();
            const links = { a: dataLink, b: { '@type': 'Link', rel: 'enclosure', blobId: 'Bnope' } };
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { links }));
            h.expectInvalid(error, ['links/b/blobId']);
            expect(await uploadsOf(ctx)).to.equal(0);
        });

        it('a data: URI counts against the upload quota', async () => {
            const small = await instance.startInstance({ limits: Object.assign({}, config.jmap.limits, { uploadQuota: 4 }), alerts: { enabled: false } });
            try {
                const ctx = await h.setupUser({}, small.url);
                const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { links: { a: dataLink } }));
                expect(error.type).to.equal('overQuota');
                expect(await uploadsOf(ctx)).to.equal(0);
            } finally {
                await instance.stopInstance(small.app);
            }
        });
    });
});
