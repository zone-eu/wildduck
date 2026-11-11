/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
'use strict';

// Catalogue file calendars.yaml, phase 6: CalendarEvent/query and /queryChanges, filters, sorts,
// paging and recurrence expansion (CEQ).

const { expect } = require('chai');
const { scenario, jmap } = require('../harness');
const config = require('@zone-eu/wild-config');
const instance = require('../harness/instance');
const h = require('./calendar-event-helpers');

const { WEEKLY, JANUARY } = h;
const utc = (title, start, duration, extra = {}) => Object.assign({ title, start, timeZone: 'Etc/UTC', duration }, extra);
const sortByStart = [{ property: 'start' }];

/** Calendar A with "Budget review" and "Team lunch", calendar B with "Dentist" (the CEQ fixture) */
async function fixture() {
    const ctx = await h.setupUser();
    const a = ctx.calendar;
    const b = await h.createCalendar(ctx, { name: 'B' });
    const budget = (await h.createEvent(ctx, utc('Budget review', '2026-01-10T10:00:00', 'PT1H'))).id;
    const lunch = (await h.createEvent(ctx, utc('Team lunch', '2026-01-15T12:00:00', 'PT1H'))).id;
    const dentist = await h.createEvent(ctx, utc('Dentist', '2026-02-03T08:00:00', 'PT30M', { calendarIds: { [b]: true } }));
    return Object.assign(ctx, { a, b, budget, lunch, dentist: dentist.id, dentistUid: dentist.uid });
}

const ids = async (ctx, args) => (await h.evQuery(ctx, args)).ids;
const sorted = list => [...list].sort();

/** Expanded starts of a window: [{start, recurrenceId, id}] in start order */
async function expandedStarts(ctx, filter, args = {}) {
    return h.startsOf(ctx, await h.expand(ctx, filter, args));
}

const startsIn = async (ctx, filter, args) => (await expandedStarts(ctx, filter, args)).map(object => object.start);

describe('CalendarEvent/query and /queryChanges (CEQ)', function () {
    this.timeout(60000);

    describe('filters', () => {
        scenario('CEQ-001', async () => {
            const ctx = await fixture();
            for (const args of [{}, { filter: {} }]) {
                const res = await h.evQuery(ctx, args);
                expect(sorted(res.ids)).to.deep.equal(sorted([ctx.budget, ctx.lunch, ctx.dentist]));
                expect(res.position).to.equal(0);
                expect(res.queryState).to.be.a('string');
                expect(res.canCalculateChanges).to.be.a('boolean');
                expect(res).to.not.have.property('total');
            }
        });

        scenario('CEQ-002', async () => {
            const ctx = await fixture();
            expect(sorted(await ids(ctx, { filter: { inCalendar: ctx.a } }))).to.deep.equal(sorted([ctx.budget, ctx.lunch]));
            expect(await ids(ctx, { filter: { inCalendar: ctx.b } })).to.deep.equal([ctx.dentist]);
        });

        scenario('CEQ-003', async () => {
            const ctx = await fixture();
            await h.method(ctx, 'Calendar/set', { destroy: [ctx.b], onDestroyRemoveEvents: true });
            expect(await ids(ctx, { filter: { inCalendar: ctx.b } })).to.deep.equal([]);
            expect(await ids(ctx, { filter: { inCalendar: 'Znope' } })).to.deep.equal([]);
        });

        scenario('CEQ-004', async () => {
            const ctx = await fixture();
            expect(sorted(await ids(ctx, { filter: { after: '2026-01-10T10:30:00', before: '2026-01-15T12:30:00' } }))).to.deep.equal(
                sorted([ctx.budget, ctx.lunch])
            );
        });

        scenario('CEQ-005', async () => {
            const ctx = await fixture();
            expect(await ids(ctx, { filter: { after: '2026-01-10T11:00:00' } })).to.not.include(ctx.budget);
            expect(await ids(ctx, { filter: { before: '2026-01-10T10:00:00' } })).to.not.include(ctx.budget);
            expect(await ids(ctx, { filter: { after: '2026-01-10T10:59:59' } })).to.include(ctx.budget);
            expect(await ids(ctx, { filter: { before: '2026-01-10T10:00:01' } })).to.include(ctx.budget);
        });

        scenario('CEQ-006', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, utc('Late', '2025-12-31T20:00:00', 'PT1H'));
            const filter = { after: '2026-01-01T00:00:00', before: '2026-02-01T00:00:00' };
            expect(await ids(ctx, { filter })).to.deep.equal([]);
            expect(await ids(ctx, { filter, timeZone: 'Australia/Melbourne' })).to.deep.equal([id]);
        });

        scenario('CEQ-007', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, { title: 'Floating', start: '2026-01-01T02:00:00', duration: 'PT1H' });
            for (const timeZone of ['Etc/UTC', 'Asia/Tokyo']) {
                expect(await ids(ctx, { filter: { after: '2026-01-01T00:00:00', before: '2026-01-01T06:00:00' }, timeZone }), timeZone).to.deep.equal([id]);
                expect(await ids(ctx, { filter: { before: '2026-01-01T02:30:00' }, timeZone }), timeZone).to.deep.equal([id]);
            }
        });

        scenario('CEQ-008', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, { title: 'NY', start: '2026-01-01T02:00:00', timeZone: 'America/New_York', duration: 'PT1H' });
            const filter = { after: '2026-01-01T00:00:00', before: '2026-01-01T06:00:00' };
            expect(await ids(ctx, { filter, timeZone: 'Etc/UTC' })).to.deep.equal([]);
            expect(await ids(ctx, { filter, timeZone: 'America/New_York' })).to.deep.equal([id]);
        });

        scenario('CEQ-009', async () => {
            const ctx = await fixture();
            await h.expectError(h.evQuery(ctx, { timeZone: 'Not/AZone' }), 'invalidArguments');
            await h.expectError(h.evQuery(ctx, { filter: { after: '2026-01-01T00:00:00Z' } }), 'invalidArguments');
            await h.expectError(h.evQuery(ctx, { filter: { before: '2026-01-01' } }), 'invalidArguments');
        });

        scenario('CEQ-010', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, Object.assign({}, WEEKLY, { recurrenceRule: { frequency: 'weekly', count: 8 } }));
            for (const expandRecurrences of [false, undefined]) {
                const args = { filter: { after: '2026-02-01T00:00:00', before: '2026-02-08T00:00:00' } };
                if (expandRecurrences !== undefined) {
                    args.expandRecurrences = expandRecurrences;
                }
                expect(await ids(ctx, args)).to.deep.equal([id]);
            }
        });

        scenario('CEQ-011', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(
                ctx,
                Object.assign({}, WEEKLY, {
                    recurrenceRule: { frequency: 'weekly', count: 4 },
                    recurrenceOverrides: { '2026-01-12T09:00:00': { excluded: true } }
                })
            );
            expect(await ids(ctx, { filter: { after: '2026-02-01T00:00:00', before: '2026-03-01T00:00:00' } })).to.deep.equal([]);
            expect(await ids(ctx, { filter: { after: '2026-01-12T00:00:00', before: '2026-01-13T00:00:00' } })).to.deep.equal([]);
        });

        scenario('CEQ-012', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': { start: '2026-01-14T09:00:00' } } })
            );
            expect(await ids(ctx, { filter: { after: '2026-01-14T00:00:00', before: '2026-01-15T00:00:00' }, timeZone: 'Europe/Tallinn' })).to.deep.equal([id]);
            expect(await ids(ctx, { filter: { after: '2026-01-12T00:00:00', before: '2026-01-13T00:00:00' }, timeZone: 'Europe/Tallinn' })).to.deep.equal([]);
        });

        scenario('CEQ-013', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, utc('Yearly', '2026-06-01T10:00:00', 'PT1H', { recurrenceRule: { frequency: 'yearly' } }));
            expect(await ids(ctx, { filter: { after: '2090-05-31T00:00:00', before: '2090-06-02T00:00:00' } })).to.deep.equal([id]);
        });

        scenario('CEQ-014', async () => {
            const ctx = await fixture();
            expect(await ids(ctx, { filter: { uid: ctx.dentistUid } })).to.deep.equal([ctx.dentist]);
            expect(await ids(ctx, { filter: { uid: ctx.dentistUid.toUpperCase() } })).to.deep.equal([]);
            expect(await ids(ctx, { filter: { uid: ctx.dentistUid.slice(0, 8) } })).to.deep.equal([]);
        });

        scenario('CEQ-015', async () => {
            const ctx = await h.setupUser();
            const instance = recurrenceId => ({ uid: 'series-1', recurrenceId, recurrenceIdTimeZone: 'Etc/UTC', start: recurrenceId, timeZone: 'Etc/UTC' });
            const a = await h.createEvent(ctx, instance('2026-01-12T09:00:00'));
            const b = await h.createEvent(ctx, instance('2026-01-19T09:00:00'));
            expect(sorted(await ids(ctx, { filter: { uid: 'series-1' } }))).to.deep.equal(sorted([a.id, b.id]));
        });

        scenario('CEQ-016', async () => {
            const ctx = await h.setupUser();
            const x = await h.createEvent(
                ctx,
                utc('Quarterly planning', '2026-01-10T10:00:00', 'PT1H', {
                    description: 'Bring the roadmap',
                    locations: { l: { '@type': 'Location', name: 'Harbour room' } }
                })
            );
            const y = await h.createEvent(
                ctx,
                utc('Roadmap', '2026-01-11T10:00:00', 'PT1H', { description: 'Quarterly', locations: { l: { '@type': 'Location', name: 'Planning office' } } })
            );
            expect(await ids(ctx, { filter: { title: 'roadmap' } })).to.deep.equal([y.id]);
            expect(await ids(ctx, { filter: { description: 'roadmap' } })).to.deep.equal([x.id]);
            expect(await ids(ctx, { filter: { location: 'harbour' } })).to.deep.equal([x.id]);
            expect(await ids(ctx, { filter: { location: 'planning' } })).to.deep.equal([y.id]);
        });

        scenario('CEQ-017', async () => {
            const ctx = await h.setupUser();
            const person = (name, address) => ({ '@type': 'Participant', name, calendarAddress: `mailto:${address}`, email: address });
            const with1 = extra => utc('Event', '2026-01-10T10:00:00', 'PT1H', extra);
            const matching = [];
            matching.push((await h.createEvent(ctx, with1({ title: 'Feed the zebra' }))).id);
            matching.push((await h.createEvent(ctx, with1({ description: 'A zebra crossing' }))).id);
            matching.push((await h.createEvent(ctx, with1({ locations: { l: { '@type': 'Location', name: 'Zebra hall' } } }))).id);
            matching.push((await h.createEvent(ctx, with1({ participants: { p: person('Zebra Person', 'zp@example.net') } }))).id);
            matching.push((await h.createEvent(ctx, with1({ participants: { p: person('Someone', 'zebra@example.com') } }))).id);
            await h.createEvent(ctx, with1({ title: 'Lion' }));
            expect(sorted(await ids(ctx, { filter: { text: 'zebra' } }))).to.deep.equal(sorted(matching));
        });

        scenario('CEQ-018', async () => {
            const ctx = await h.setupUser();
            const person = (name, address, roles) => ({ '@type': 'Participant', name, email: address, calendarAddress: `mailto:${address}`, roles });
            const x = await h.createEvent(
                ctx,
                utc('X', '2026-01-10T10:00:00', 'PT1H', {
                    participants: {
                        c: person('Carol King', 'carol@example.net', { owner: true }),
                        b: person('Bob Stone', 'bob@example.net', { attendee: true })
                    }
                })
            );
            const y = await h.createEvent(
                ctx,
                utc('Y', '2026-01-11T10:00:00', 'PT1H', {
                    participants: { b: person('Bob Stone', 'bob@example.net', { owner: true }), d: person('Dave', 'dave@example.net', { attendee: true }) }
                })
            );
            await h.createEvent(ctx, utc('Z', '2026-01-12T10:00:00', 'PT1H'));
            expect(sorted(await ids(ctx, { filter: { participant: 'bob' } }))).to.deep.equal(sorted([x.id, y.id]));
            expect(await ids(ctx, { filter: { owner: 'bob' } })).to.deep.equal([y.id]);
            expect(await ids(ctx, { filter: { owner: 'carol@example.net' } })).to.deep.equal([x.id]);
            expect(await ids(ctx, { filter: { participant: 'nobody' } })).to.deep.equal([]);
        });

        scenario('CEQ-019', async () => {
            const ctx = await h.setupUser();
            const x = await h.createEvent(ctx, utc('big red bus', '2026-01-10T10:00:00', 'PT1H'));
            const y = await h.createEvent(ctx, utc('red big buses', '2026-01-11T10:00:00', 'PT1H'));
            const z = await h.createEvent(ctx, utc('business', '2026-01-12T10:00:00', 'PT1H'));
            expect(await ids(ctx, { filter: { title: '"big red"' } })).to.deep.equal([x.id]);
            expect(sorted(await ids(ctx, { filter: { title: 'red big' } }))).to.deep.equal(sorted([x.id, y.id]));
            const bus = await ids(ctx, { filter: { title: 'bus' } });
            expect(bus).to.include(x.id);
            expect(bus).to.not.include(z.id);
        });

        scenario('CEQ-020', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign({}, WEEKLY, {
                    recurrenceOverrides: { '2026-01-12T09:00:00': { title: 'Retrospective', locations: { l9: { '@type': 'Location', name: 'Rooftop' } } } }
                })
            );
            for (const filter of [{ title: 'retrospective' }, { location: 'rooftop' }, { text: 'retrospective' }]) {
                expect(await ids(ctx, { filter }), JSON.stringify(filter)).to.deep.equal([id]);
            }
        });

        scenario('CEQ-021', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': { title: 'Retrospective' } } }));
            const filter = { title: 'retrospective', after: '2026-01-19T00:00:00', before: '2026-01-20T00:00:00' };
            expect(await ids(ctx, { filter, expandRecurrences: false })).to.deep.equal([id]);
            expect(await ids(ctx, { filter, expandRecurrences: true })).to.deep.equal([]);
        });

        scenario('CEQ-022', async () => {
            const ctx = await fixture();
            expect(sorted(await ids(ctx, { filter: { operator: 'OR', conditions: [{ title: 'budget' }, { inCalendar: ctx.b }] } }))).to.deep.equal(
                sorted([ctx.budget, ctx.dentist])
            );
            expect(
                await ids(ctx, { filter: { operator: 'AND', conditions: [{ inCalendar: ctx.a }, { operator: 'NOT', conditions: [{ title: 'lunch' }] }] } })
            ).to.deep.equal([ctx.budget]);
        });

        scenario('CEQ-023', async () => {
            const ctx = await fixture();
            expect(await ids(ctx, { filter: { inCalendar: ctx.a, title: 'lunch' } })).to.deep.equal([ctx.lunch]);
            expect(await ids(ctx, { filter: { inCalendar: ctx.b, title: 'lunch' } })).to.deep.equal([]);
        });

        scenario('CEQ-024', async () => {
            const ctx = await fixture();
            for (const filter of [{ colour: 'red' }, { inCalendar: 5 }, { operator: 'XOR', conditions: [] }]) {
                await h.expectError(h.evQuery(ctx, { filter }), 'invalidArguments');
            }
        });

        scenario('CEQ-025', async () => {
            const ctx = await h.setupUser();
            const draft = await h.createEvent(ctx, utc('Draft', '2026-01-10T10:00:00', 'PT1H', { isDraft: true }));
            const normal = await h.createEvent(ctx, utc('Normal', '2026-01-11T10:00:00', 'PT1H'));
            expect(sorted(await ids(ctx, { filter: JANUARY }))).to.deep.equal(sorted([draft.id, normal.id]));
        });

        scenario('CEQ-026', async () => {
            const ctx = await h.setupUser();
            const session = await ctx.client.session();
            expect(Date.parse(session.accounts[ctx.client.accountId].accountCapabilities[jmap.URN.calendars].minDateTime)).to.be.below(
                Date.parse('1960-01-01T00:00:00Z')
            );
            const { id } = await h.createEvent(ctx, utc('Old', '1960-06-01T10:00:00', 'PT1H'));
            expect(await ids(ctx, { filter: { after: '1960-01-01T00:00:00', before: '1961-01-01T00:00:00' }, sort: sortByStart })).to.deep.equal([id]);
        });
    });

    describe('sorting and paging', () => {
        scenario('CEQ-027', async () => {
            const ctx = await h.setupUser();
            const ny = await h.createEvent(ctx, { title: 'NY', start: '2026-06-01T09:00:00', timeZone: 'America/New_York' });
            const la = await h.createEvent(ctx, { title: 'LA', start: '2026-06-01T09:00:00', timeZone: 'America/Los_Angeles' });
            const early = await h.createEvent(ctx, utc('EARLY', '2026-06-01T12:30:00', 'PT0S'));
            expect(await ids(ctx, { sort: sortByStart })).to.deep.equal([early.id, ny.id, la.id]);
            expect(await ids(ctx, { sort: [{ property: 'start', isAscending: false }] })).to.deep.equal([la.id, ny.id, early.id]);
        });

        scenario('CEQ-028', async () => {
            const ctx = await h.setupUser();
            const f = await h.createEvent(ctx, { title: 'F', start: '2026-06-01T10:00:00' });
            const u = await h.createEvent(ctx, utc('U', '2026-06-01T12:00:00', 'PT0S'));
            expect(await ids(ctx, { sort: sortByStart })).to.deep.equal([f.id, u.id]);
            expect(await ids(ctx, { sort: sortByStart, timeZone: 'America/New_York' })).to.deep.equal([u.id, f.id]);
        });

        scenario('CEQ-029', async () => {
            const ctx = await h.setupUser();
            const made = {};
            for (const uid of ['b', 'a', 'c']) {
                made[uid] = (await h.createEvent(ctx, utc(uid, '2026-06-01T10:00:00', 'PT0S', { uid }))).id;
            }
            expect(await ids(ctx, { sort: [{ property: 'uid' }] })).to.deep.equal([made.a, made.b, made.c]);
            expect(await ids(ctx, { sort: [{ property: 'uid', isAscending: false }] })).to.deep.equal([made.c, made.b, made.a]);
            expect(await ids(ctx, { sort: [{ property: 'id' }] })).to.deep.equal(sorted(Object.values(made)));
        });

        scenario('CEQ-030', async () => {
            const ctx = await h.setupUser();
            const e1 = await h.createEvent(ctx, utc('E1', '2026-06-01T10:00:00', 'PT0S', { created: '2026-01-01T00:00:00Z' }));
            const e2 = await h.createEvent(ctx, utc('E2', '2026-06-01T10:00:00', 'PT0S', { created: '2026-01-02T00:00:00Z' }));
            const e3 = await h.createEvent(ctx, utc('E3', '2026-06-01T10:00:00', 'PT0S', { created: '2026-01-03T00:00:00Z' }));
            await new Promise(resolve => setTimeout(resolve, 1100));
            await h.update(ctx, e1.id, { title: 'E1 changed' });
            expect(await ids(ctx, { sort: [{ property: 'created' }] })).to.deep.equal([e1.id, e2.id, e3.id]);
            expect((await ids(ctx, { sort: [{ property: 'updated', isAscending: false }] }))[0]).to.equal(e1.id);
        });

        scenario('CEQ-031', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, utc('Any', '2026-06-01T10:00:00', 'PT0S'));
            for (const property of ['title', 'nonsense']) {
                await h.expectError(h.evQuery(ctx, { sort: [{ property }] }), 'unsupportedSort');
            }
        });

        scenario('CEQ-032', async () => {
            const ctx = await h.setupUser();
            const made = {};
            for (const uid of ['b', 'a', 'c']) {
                made[uid] = (await h.createEvent(ctx, utc(uid, '2026-06-01T10:00:00', 'PT1H', { uid }))).id;
            }
            for (let i = 0; i < 2; i++) {
                expect(await ids(ctx, { sort: [{ property: 'start' }, { property: 'uid' }] })).to.deep.equal([made.a, made.b, made.c]);
            }
            expect(await ids(ctx, { sort: sortByStart })).to.deep.equal(await ids(ctx, { sort: sortByStart }));
        });

        scenario('CEQ-033', async () => {
            const ctx = await h.setupUser();
            const e = await h.createEvent(ctx, { title: 'E', start: '2026-01-08T09:00:00', timeZone: 'Europe/Tallinn' });
            const r1 = await h.createEvent(ctx, WEEKLY);
            expect(await ids(ctx, { sort: sortByStart, expandRecurrences: false })).to.deep.equal([r1.id, e.id]);
        });

        async function tenDays() {
            const ctx = await h.setupUser();
            const list = [];
            for (let day = 1; day <= 10; day++) {
                list.push((await h.createEvent(ctx, utc(`Day ${day}`, `2026-01-${String(day).padStart(2, '0')}T10:00:00`, 'PT1H'))).id);
            }
            return { ctx, list };
        }

        scenario('CEQ-034', async () => {
            const { ctx, list } = await tenDays();
            const res = await h.evQuery(ctx, { sort: sortByStart, position: 3, limit: 4, calculateTotal: true });
            expect(res.ids).to.deep.equal(list.slice(3, 7));
            expect(res.position).to.equal(3);
            expect(res.total).to.equal(10);
        });

        scenario('CEQ-035', async () => {
            const { ctx, list } = await tenDays();
            const last = await h.evQuery(ctx, { sort: sortByStart, position: -3 });
            expect(last.ids).to.deep.equal(list.slice(7));
            expect(last.position).to.equal(7);
            const clamped = await h.evQuery(ctx, { sort: sortByStart, position: -50 });
            expect(clamped.ids).to.deep.equal(list);
            expect(clamped.position).to.equal(0);
            expect((await h.evQuery(ctx, { sort: sortByStart, position: 50 })).ids).to.deep.equal([]);
        });

        scenario('CEQ-036', async () => {
            const { ctx, list } = await tenDays();
            const first = await h.evQuery(ctx, { sort: sortByStart, anchor: list[4], limit: 2 });
            expect(first.ids).to.deep.equal([list[4], list[5]]);
            expect(first.position).to.equal(4);
            const second = await h.evQuery(ctx, { sort: sortByStart, anchor: list[4], anchorOffset: -2, limit: 3 });
            expect(second.ids).to.deep.equal([list[2], list[3], list[4]]);
            expect(second.position).to.equal(2);
            await h.expectError(h.evQuery(ctx, { sort: sortByStart, anchor: 'Zmissing' }), 'anchorNotFound');
        });

        scenario('CEQ-037', async () => {
            const ctx = await h.setupUser();
            const max = 1000;
            for (let start = 0; start <= max; start += 500) {
                const count = Math.min(500, max + 1 - start);
                const create = Object.fromEntries(
                    Array.from({ length: count }, (value, i) => [
                        `c${i}`,
                        Object.assign({ calendarIds: { [ctx.calendar]: true } }, utc(`E${start + i}`, '2026-01-10T10:00:00', 'PT0S'))
                    ])
                );
                const res = await h.evSet(ctx, { create });
                expect(res.notCreated).to.equal(null);
            }
            await h.expectError(h.evQuery(ctx, { limit: -1 }), 'invalidArguments');
            expect((await h.evQuery(ctx, { limit: 0 })).ids).to.deep.equal([]);
            const res = await h.evQuery(ctx, { limit: max + 500 });
            expect(res.ids.length).to.be.at.most(res.limit);
            expect(res.limit).to.be.below(max + 500);
        });
    });

    describe('expanding recurrences', () => {
        scenario('CEQ-038', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, WEEKLY);
            const res = await h.evQuery(ctx, { expandRecurrences: true, filter: JANUARY, calculateTotal: true, sort: sortByStart });
            expect(new Set(res.ids).size).to.equal(4);
            expect(res.ids).to.not.include(id);
            expect(res.total).to.equal(4);
            expect((await h.startsOf(ctx, res.ids)).map(object => object.start)).to.deep.equal([
                '2026-01-05T09:00:00',
                '2026-01-12T09:00:00',
                '2026-01-19T09:00:00',
                '2026-01-26T09:00:00'
            ]);
        });

        scenario('CEQ-039', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, WEEKLY);
            for (const filter of [undefined, { after: JANUARY.after }, { before: JANUARY.before }, { operator: 'AND', conditions: [JANUARY] }]) {
                const args = { expandRecurrences: true };
                if (filter) {
                    args.filter = filter;
                }
                await h.expectError(h.evQuery(ctx, args), 'invalidArguments');
            }
        });

        scenario('CEQ-040', async () => {
            const ctx = await h.setupUser();
            const session = await ctx.client.session();
            const duration = session.accounts[ctx.client.accountId].accountCapabilities[jmap.URN.calendars].maxExpandedQueryDuration;
            const days = Number(/^P(\d+)D$/.exec(duration)[1]);
            await h.createEvent(ctx, WEEKLY);
            const start = Date.parse('2026-01-01T00:00:00Z');
            const local = ms => new Date(ms).toISOString().slice(0, 19);
            const exact = { after: local(start), before: local(start + days * 86400000) };
            const longer = { after: exact.after, before: local(start + days * 86400000 + 1000) };
            await h.evQuery(ctx, { expandRecurrences: true, filter: exact });
            await h.expectError(h.evQuery(ctx, { expandRecurrences: true, filter: longer }), 'expandDurationTooLarge');
            await h.evQuery(ctx, { filter: longer });
        });

        scenario('CEQ-041', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, utc('Busy', '2026-01-01T09:00:00', 'PT30S', { recurrenceRule: { frequency: 'minutely', count: 20000 } }));
            const hour = await h.evQuery(ctx, {
                expandRecurrences: true,
                limit: 1,
                calculateTotal: true,
                filter: { after: '2026-01-01T08:59:00', before: '2026-01-01T09:59:45' }
            });
            expect(hour.total).to.equal(60);
            expect(hour.ids).to.have.length(1);
            await h.expectError(h.evQuery(ctx, { expandRecurrences: true, limit: 1, filter: JANUARY }), 'cannotCalculateOccurrences');
        });

        scenario('CEQ-042', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(
                ctx,
                utc('Never', '2026-01-15T10:00:00', 'PT0S', { recurrenceRule: { frequency: 'secondly', byMonth: ['2'], byMonthDay: [30] } })
            );
            const started = Date.now();
            const outcome = await h.evQuery(ctx, { expandRecurrences: true, filter: { after: '2026-02-01T00:00:00', before: '2026-03-01T00:00:00' } }).then(
                res => res.ids,
                err => err.type
            );
            expect(Date.now() - started).to.be.below(10000);
            expect(Array.isArray(outcome) ? outcome : [outcome]).to.satisfy(value =>
                Array.isArray(outcome) ? value.length === 0 : value[0] === 'cannotCalculateOccurrences'
            );
        });

        scenario('CEQ-043', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(
                ctx,
                Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': { excluded: true }, '2026-01-21T15:00:00': {} } })
            );
            const instances = await expandedStarts(ctx, JANUARY);
            expect(instances.map(object => object.start)).to.deep.equal([
                '2026-01-05T09:00:00',
                '2026-01-19T09:00:00',
                '2026-01-21T15:00:00',
                '2026-01-26T09:00:00'
            ]);
            expect(instances[2].recurrenceId).to.equal('2026-01-21T15:00:00');
        });

        scenario('CEQ-044', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': { start: '2026-02-02T15:00:00' } } }));
            expect(await startsIn(ctx, JANUARY)).to.deep.equal(['2026-01-05T09:00:00', '2026-01-19T09:00:00', '2026-01-26T09:00:00']);
            const day = await expandedStarts(ctx, { after: '2026-02-02T00:00:00', before: '2026-02-03T00:00:00' }, { timeZone: 'Europe/Tallinn' });
            expect(day.map(object => [object.start, object.recurrenceId])).to.deep.equal([
                ['2026-02-02T09:00:00', '2026-02-02T09:00:00'],
                ['2026-02-02T15:00:00', '2026-01-12T09:00:00']
            ]);
        });

        scenario('CEQ-045', async () => {
            const ctx = await h.setupUser();
            const r1 = await h.createEvent(ctx, utc('R1', '2026-01-05T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'weekly' } }));
            const r2 = await h.createEvent(ctx, utc('R2', '2026-01-07T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'weekly' } }));
            const single = await h.createEvent(ctx, utc('Single', '2026-01-06T09:00:00', 'PT1H'));
            const res = await h.evGet(ctx, await h.expand(ctx, { after: '2026-01-05T00:00:00', before: '2026-01-15T00:00:00' }), {
                properties: ['start', 'baseEventId']
            });
            expect(res.list.map(object => [object.baseEventId || object.id, object.start.slice(0, 10)])).to.deep.equal([
                [r1.id, '2026-01-05'],
                [single.id, '2026-01-06'],
                [r2.id, '2026-01-07'],
                [r1.id, '2026-01-12'],
                [r2.id, '2026-01-14']
            ]);
        });

        scenario('CEQ-046', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, utc('Daily', '2026-01-05T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'daily', count: 10 } }));
            const all = await h.expand(ctx);
            const res = await h.evQuery(ctx, { expandRecurrences: true, filter: JANUARY, sort: sortByStart, calculateTotal: true, position: 4, limit: 3 });
            expect(res.total).to.equal(10);
            expect((await h.startsOf(ctx, res.ids)).map(object => object.start.slice(0, 10))).to.deep.equal(['2026-01-09', '2026-01-10', '2026-01-11']);
            const anchored = await h.evQuery(ctx, { expandRecurrences: true, filter: JANUARY, sort: sortByStart, anchor: all[4], limit: 3 });
            expect(anchored.position).to.equal(4);
            expect(anchored.ids[0]).to.equal(all[4]);
        });

        scenario('CEQ-047', async () => {
            const ctx = await h.setupUser();
            const b = await h.createCalendar(ctx, { name: 'B' });
            await h.createEvent(ctx, Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': { title: 'Retrospective' } } }));
            await h.createEvent(ctx, Object.assign({}, WEEKLY, { calendarIds: { [b]: true }, title: 'Retrospective too' }));
            const found = await h.expand(ctx, Object.assign({ inCalendar: ctx.calendar, title: 'retrospective' }, JANUARY));
            expect(found).to.have.length(1);
            expect((await h.startsOf(ctx, found))[0].recurrenceId).to.equal('2026-01-12T09:00:00');
        });

        scenario('CEQ-048', async () => {
            const ctx = await h.setupUser();
            const instance = recurrenceId => ({
                uid: 'series-1',
                recurrenceId,
                recurrenceIdTimeZone: 'Etc/UTC',
                start: recurrenceId,
                timeZone: 'Etc/UTC',
                duration: 'PT1H'
            });
            const a = await h.createEvent(ctx, instance('2026-01-12T09:00:00'));
            const b = await h.createEvent(ctx, instance('2026-01-19T09:00:00'));
            expect(await h.expand(ctx)).to.deep.equal([a.id, b.id]);
        });

        const days = async (ctx, rule, filter = JANUARY, extra = {}) => {
            await h.createEvent(ctx, utc('Rule', extra.start || '2026-01-05T09:00:00', 'PT1H', Object.assign({ recurrenceRule: rule }, extra.values || {})));
            return (await startsIn(ctx, filter)).map(start => start.slice(0, 10));
        };

        scenario('CEQ-049', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, utc('Rule', '2026-01-05T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'daily', interval: 2, count: 3 } }));
            expect(await startsIn(ctx, JANUARY)).to.deep.equal(['2026-01-05T09:00:00', '2026-01-07T09:00:00', '2026-01-09T09:00:00']);
        });

        scenario('CEQ-050', async () => {
            const ctx = await h.setupUser();
            expect(await days(ctx, { frequency: 'weekly', byDay: [{ day: 'we' }], count: 3 })).to.deep.equal(['2026-01-05', '2026-01-07', '2026-01-14']);
        });

        scenario('CEQ-051', async () => {
            const ctx = await h.setupUser();
            const first = await h.createEvent(
                ctx,
                utc('A', '2026-01-05T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'daily', until: '2026-01-07T09:00:00' } })
            );
            const second = await h.createEvent(
                ctx,
                utc('B', '2026-01-05T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'daily', until: '2026-01-07T08:59:59' } })
            );
            const res = await h.evGet(ctx, await h.expand(ctx), { properties: ['start', 'baseEventId'] });
            const of = id => res.list.filter(object => object.baseEventId === id).map(object => object.start.slice(0, 10));
            expect(of(first.id)).to.deep.equal(['2026-01-05', '2026-01-06', '2026-01-07']);
            expect(of(second.id)).to.deep.equal(['2026-01-05', '2026-01-06']);
        });

        scenario('CEQ-052', async () => {
            const ctx = await h.setupUser();
            const values = { recurrenceOverrides: { '2026-01-06T09:00:00': { excluded: true } } };
            expect(await days(ctx, { frequency: 'daily', count: 3 }, JANUARY, { values })).to.deep.equal(['2026-01-05', '2026-01-07']);
        });

        scenario('CEQ-053', async () => {
            const ctx = await h.setupUser();
            const byDay = ['mo', 'we', 'fr'].map(day => ({ day }));
            expect(await days(ctx, { frequency: 'weekly', byDay, count: 5 })).to.deep.equal([
                '2026-01-05',
                '2026-01-07',
                '2026-01-09',
                '2026-01-12',
                '2026-01-14'
            ]);
        });

        scenario('CEQ-054', async () => {
            const window = { after: '1997-08-01T00:00:00', before: '1997-09-15T00:00:00' };
            const expected = { mo: ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24'], su: ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31'] };
            for (const [firstDayOfWeek, starts] of Object.entries(expected)) {
                const ctx = await h.setupUser();
                const rule = { frequency: 'weekly', interval: 2, count: 4, byDay: [{ day: 'tu' }, { day: 'su' }], firstDayOfWeek };
                expect(await days(ctx, rule, window, { start: '1997-08-05T09:00:00' }), firstDayOfWeek).to.deep.equal(starts);
            }
        });

        const half = { after: '2026-01-01T00:00:00', before: '2026-07-01T00:00:00' };

        scenario('CEQ-055', async () => {
            const ctx = await h.setupUser();
            expect(await days(ctx, { frequency: 'monthly', count: 3 }, half, { start: '2026-01-31T09:00:00' })).to.deep.equal([
                '2026-01-31',
                '2026-03-31',
                '2026-05-31'
            ]);
        });

        scenario('CEQ-056', async () => {
            const expected = { backward: ['2026-01-31', '2026-02-28', '2026-03-31'], forward: ['2026-01-31', '2026-03-01', '2026-03-31'] };
            for (const [skip, starts] of Object.entries(expected)) {
                const ctx = await h.setupUser();
                expect(await days(ctx, { frequency: 'monthly', count: 3, skip }, half, { start: '2026-01-31T09:00:00' }), skip).to.deep.equal(starts);
            }
        });

        const quarter = { after: '2026-01-01T00:00:00', before: '2026-04-01T00:00:00' };

        scenario('CEQ-057', async () => {
            const ctx = await h.setupUser();
            expect(
                await days(ctx, { frequency: 'monthly', byDay: [{ day: 'tu', nthOfPeriod: 2 }], count: 3 }, quarter, { start: '2026-01-13T09:00:00' })
            ).to.deep.equal(['2026-01-13', '2026-02-10', '2026-03-10']);
        });

        scenario('CEQ-058', async () => {
            const ctx = await h.setupUser();
            expect(
                await days(ctx, { frequency: 'monthly', byDay: [{ day: 'fr', nthOfPeriod: -1 }], count: 3 }, quarter, { start: '2026-01-30T09:00:00' })
            ).to.deep.equal(['2026-01-30', '2026-02-27', '2026-03-27']);
        });

        scenario('CEQ-059', async () => {
            const p = await h.setupUser();
            expect(await days(p, { frequency: 'monthly', byMonthDay: [1, 15], count: 4 }, quarter, { start: '2026-01-01T09:00:00' })).to.deep.equal([
                '2026-01-01',
                '2026-01-15',
                '2026-02-01',
                '2026-02-15'
            ]);
            const n = await h.setupUser();
            expect(await days(n, { frequency: 'monthly', byMonthDay: [-1], count: 3 }, quarter, { start: '2026-01-31T09:00:00' })).to.deep.equal([
                '2026-01-31',
                '2026-02-28',
                '2026-03-31'
            ]);
        });

        scenario('CEQ-060', async () => {
            const ctx = await h.setupUser();
            const rule = { frequency: 'yearly', byMonth: ['3', '9'], count: 3 };
            expect(await days(ctx, rule, { after: '2026-01-01T00:00:00', before: '2026-12-31T00:00:00' }, { start: '2026-03-10T09:00:00' })).to.deep.equal([
                '2026-03-10',
                '2026-09-10'
            ]);
            expect((await startsIn(ctx, { after: '2027-01-01T00:00:00', before: '2027-12-31T00:00:00' })).map(start => start.slice(0, 10))).to.deep.equal([
                '2027-03-10'
            ]);
        });

        scenario('CEQ-061', async () => {
            const expected = { omit: [[], ['2028-02-29']], backward: [['2025-02-28'], ['2028-02-29']], forward: [['2025-03-01'], ['2028-02-29']] };
            for (const [skip, [y2025, y2028]] of Object.entries(expected)) {
                const ctx = await h.setupUser();
                await h.createEvent(ctx, utc('Leap', '2024-02-29T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'yearly', skip } }));
                const of = async filter => (await startsIn(ctx, filter)).map(start => start.slice(0, 10));
                expect(await of({ after: '2025-02-01T00:00:00', before: '2025-03-31T00:00:00' }), skip).to.deep.equal(y2025);
                expect(await of({ after: '2028-02-01T00:00:00', before: '2028-03-31T00:00:00' }), skip).to.deep.equal(y2028);
            }
        });

        scenario('CEQ-062', async () => {
            const ctx = await h.setupUser();
            const byDay = ['mo', 'tu', 'we', 'th', 'fr'].map(day => ({ day }));
            expect(await days(ctx, { frequency: 'monthly', byDay, bySetPosition: [-1], count: 3 }, quarter, { start: '2026-01-30T17:00:00' })).to.deep.equal([
                '2026-01-30',
                '2026-02-27',
                '2026-03-31'
            ]);
        });

        scenario('CEQ-063', async () => {
            const ctx = await h.setupUser();
            const rule = { frequency: 'yearly', interval: 3, byYearDay: [1, 100, 200], count: 5 };
            const year = y => ({ after: `${y}-01-01T00:00:00`, before: `${y + 1}-01-01T00:00:00` });
            expect(await days(ctx, rule, year(2026), { start: '2026-01-01T09:00:00' })).to.deep.equal(['2026-01-01', '2026-04-10', '2026-07-19']);
            const of = async filter => (await startsIn(ctx, filter)).map(start => start.slice(0, 10));
            expect(await of(year(2029))).to.deep.equal(['2029-01-01', '2029-04-10']);
            expect(await of(year(2027))).to.deep.equal([]);
            expect(await of(year(2028))).to.deep.equal([]);
        });

        scenario('CEQ-064', async () => {
            const ctx = await h.setupUser();
            const rule = { frequency: 'yearly', byWeekNo: [20], byDay: [{ day: 'mo' }] };
            expect(await days(ctx, rule, { after: '2026-05-01T00:00:00', before: '2026-06-01T00:00:00' }, { start: '2026-05-11T09:00:00' })).to.deep.equal([
                '2026-05-11'
            ]);
            expect((await startsIn(ctx, { after: '2027-05-01T00:00:00', before: '2027-06-01T00:00:00' })).map(start => start.slice(0, 10))).to.deep.equal([
                '2027-05-17'
            ]);
        });

        scenario('CEQ-065', async () => {
            const window = { after: '2026-01-05T00:00:00', before: '2026-01-08T00:00:00' };
            const hourly = await h.setupUser();
            await h.createEvent(hourly, utc('Hourly', '2026-01-05T09:00:00', 'PT0S', { recurrenceRule: { frequency: 'hourly', interval: 6, count: 4 } }));
            expect(await startsIn(hourly, window)).to.deep.equal(['2026-01-05T09:00:00', '2026-01-05T15:00:00', '2026-01-05T21:00:00', '2026-01-06T03:00:00']);
            const daily = await h.setupUser();
            await h.createEvent(
                daily,
                utc('Daily', '2026-01-05T09:00:00', 'PT0S', { recurrenceRule: { frequency: 'daily', byHour: [9, 17], byMinute: [0, 30], count: 5 } })
            );
            expect(await startsIn(daily, window)).to.deep.equal([
                '2026-01-05T09:00:00',
                '2026-01-05T09:30:00',
                '2026-01-05T17:00:00',
                '2026-01-05T17:30:00',
                '2026-01-06T09:00:00'
            ]);
        });

        scenario('CEQ-066', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, {
                title: 'NY',
                start: '2026-03-07T09:00:00',
                timeZone: 'America/New_York',
                duration: 'PT1H',
                recurrenceRule: { frequency: 'daily', count: 2 }
            });
            const found = await h.expand(ctx, { after: '2026-03-07T00:00:00', before: '2026-03-09T00:00:00' }, { timeZone: 'America/New_York' });
            const res = await h.evGet(ctx, found, { properties: ['start', 'utcStart'] });
            expect(res.list.map(object => [object.start, object.utcStart])).to.deep.equal([
                ['2026-03-07T09:00:00', '2026-03-07T14:00:00Z'],
                ['2026-03-08T09:00:00', '2026-03-08T13:00:00Z']
            ]);
        });

        scenario('CEQ-067', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, {
                title: 'Early',
                start: '2026-03-01T03:30:00',
                timeZone: 'Europe/Tallinn',
                duration: 'PT15M',
                recurrenceRule: { frequency: 'daily' }
            });
            for (const [day, utcStart] of [
                ['2026-03-29', '2026-03-29T01:30:00Z'],
                ['2026-10-25', '2026-10-25T00:30:00Z']
            ]) {
                const found = await h.expand(ctx, { after: `${day}T00:00:00`, before: `${day}T23:59:59` }, { timeZone: 'Europe/Tallinn' });
                expect(found, day).to.have.length(1);
                const [object] = (await h.evGet(ctx, found, { properties: ['utcStart', 'recurrenceId'] })).list;
                expect(object.utcStart, day).to.equal(utcStart);
                expect(object.recurrenceId).to.equal(`${day}T03:30:00`);
            }
        });

        scenario('CEQ-068', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, { title: 'Late', start: '2026-01-05T23:30:00', duration: 'PT1H', recurrenceRule: { frequency: 'daily', count: 3 } });
            for (const timeZone of ['Etc/UTC', 'Asia/Tokyo']) {
                expect(await startsIn(ctx, { after: '2026-01-06T00:00:00', before: '2026-01-07T00:00:00' }, { timeZone }), timeZone).to.deep.equal([
                    '2026-01-05T23:30:00',
                    '2026-01-06T23:30:00'
                ]);
            }
        });

        scenario('CEQ-069', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, {
                title: 'All day',
                start: '2026-01-05T00:00:00',
                duration: 'P1D',
                showWithoutTime: true,
                recurrenceRule: { frequency: 'weekly', count: 3 }
            });
            const found = await h.expand(ctx, JANUARY, { timeZone: 'Pacific/Auckland' });
            const res = await h.evGet(ctx, found, { properties: ['start', 'duration', 'showWithoutTime'] });
            expect(res.list.map(object => [object.start, object.duration, object.showWithoutTime])).to.deep.equal([
                ['2026-01-05T00:00:00', 'P1D', true],
                ['2026-01-12T00:00:00', 'P1D', true],
                ['2026-01-19T00:00:00', 'P1D', true]
            ]);
        });

        scenario('CEQ-070', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, utc('Forever', '2020-01-01T09:00:00', 'PT1H', { recurrenceRule: { frequency: 'daily' } }));
            const found = await h.expand(ctx, { after: '2026-06-01T00:00:00', before: '2026-06-04T00:00:00' });
            expect((await h.startsOf(ctx, found)).map(object => object.start)).to.deep.equal([
                '2026-06-01T09:00:00',
                '2026-06-02T09:00:00',
                '2026-06-03T09:00:00'
            ]);
        });
    });

    describe('queryChanges', () => {
        const inA = ctx => ({ filter: { inCalendar: ctx.calendar }, sort: sortByStart });
        const changesOf = (ctx, args) => h.method(ctx, 'CalendarEvent/queryChanges', args);

        scenario('CEQ-071', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, utc('E', '2026-01-10T10:00:00', 'PT1H'));
            const q1 = await h.evQuery(ctx, inA(ctx));
            expect(q1.canCalculateChanges).to.equal(true);
            const res = await changesOf(ctx, Object.assign({ sinceQueryState: q1.queryState }, inA(ctx)));
            expect(res).to.include({ oldQueryState: q1.queryState, newQueryState: q1.queryState });
            expect(res.removed).to.deep.equal([]);
            expect(res.added).to.deep.equal([]);
        });

        scenario('CEQ-072', async () => {
            const ctx = await h.setupUser();
            const e1 = await h.createEvent(ctx, utc('E1', '2026-01-10T10:00:00', 'PT1H'));
            const e2 = await h.createEvent(ctx, utc('E2', '2026-01-20T10:00:00', 'PT1H'));
            const q1 = await h.evQuery(ctx, inA(ctx));
            expect(q1.ids).to.deep.equal([e1.id, e2.id]);
            const e3 = await h.createEvent(ctx, utc('E3', '2026-01-15T10:00:00', 'PT1H'));
            await h.evSet(ctx, { destroy: [e1.id] });
            const res = await changesOf(ctx, Object.assign({ sinceQueryState: q1.queryState, calculateTotal: true }, inA(ctx)));
            expect(res.removed).to.include(e1.id);
            expect(res.added).to.deep.include({ id: e3.id, index: 0 });
            expect(res.total).to.equal(2);
            expect(res.newQueryState).to.not.equal(q1.queryState);
        });

        scenario('CEQ-073', async () => {
            const ctx = await h.setupUser();
            const e1 = await h.createEvent(ctx, utc('E1', '2026-01-10T10:00:00', 'PT1H'));
            const e2 = await h.createEvent(ctx, utc('E2', '2026-01-11T10:00:00', 'PT1H'));
            const e3 = await h.createEvent(ctx, utc('E3', '2026-01-12T10:00:00', 'PT1H'));
            const q1 = await h.evQuery(ctx, inA(ctx));
            expect(q1.ids).to.deep.equal([e1.id, e2.id, e3.id]);
            await h.update(ctx, e1.id, { start: '2026-01-13T10:00:00' });
            const res = await changesOf(ctx, Object.assign({ sinceQueryState: q1.queryState }, inA(ctx)));
            expect(res.removed).to.include(e1.id);
            expect(res.added).to.deep.include({ id: e1.id, index: 2 });
        });

        scenario('CEQ-074', async () => {
            const ctx = await h.setupUser();
            const b = await h.createCalendar(ctx, { name: 'B' });
            const e1 = await h.createEvent(ctx, utc('E1', '2026-01-10T10:00:00', 'PT1H'));
            const e2 = await h.createEvent(ctx, utc('E2', '2026-01-11T10:00:00', 'PT1H', { calendarIds: { [b]: true } }));
            const q1 = await h.evQuery(ctx, { filter: { inCalendar: ctx.calendar } });
            await h.update(ctx, e1.id, { calendarIds: { [b]: true } });
            await h.update(ctx, e2.id, { calendarIds: { [ctx.calendar]: true } });
            const res = await changesOf(ctx, { sinceQueryState: q1.queryState, filter: { inCalendar: ctx.calendar } });
            expect(res.removed).to.include(e1.id);
            expect(res.added.map(item => item.id)).to.deep.equal([e2.id]);
            expect(res.added[0].index).to.equal(0);
        });

        scenario('CEQ-075', async () => {
            const ctx = await h.setupUser();
            const first = await h.createEvent(ctx, utc('First', '2026-01-01T10:00:00', 'PT1H'));
            const q1 = await h.evQuery(ctx, inA(ctx));
            for (let day = 10; day < 15; day++) {
                await h.createEvent(ctx, utc(`E${day}`, `2026-01-${day}T10:00:00`, 'PT1H'));
            }
            await h.expectError(changesOf(ctx, Object.assign({ sinceQueryState: q1.queryState, maxChanges: 2 }, inA(ctx))), 'tooManyChanges');
            const res = await changesOf(ctx, Object.assign({ sinceQueryState: q1.queryState, upToId: first.id }, inA(ctx)));
            expect(res.removed).to.deep.equal([]);
            expect(res.added).to.deep.equal([]);
        });

        scenario('CEQ-076', async () => {
            const ctx = await h.setupUser();
            await h.expectError(changesOf(ctx, { sinceQueryState: 'bogus' }), 'cannotCalculateChanges');
        });

        scenario('CEQ-077', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, WEEKLY);
            const expanded = await h.evQuery(ctx, { expandRecurrences: true, filter: JANUARY });
            expect(expanded.canCalculateChanges).to.equal(false);
            await h.expectError(changesOf(ctx, { sinceQueryState: expanded.queryState, filter: JANUARY }), 'cannotCalculateChanges');
            expect((await h.evQuery(ctx, { filter: JANUARY })).canCalculateChanges).to.equal(true);
        });
    });

    describe('expansion budget', () => {
        it('a query stops once the recurrence expansions used up their time', async () => {
            const spent = await instance.startInstance({
                calendars: Object.assign({}, config.jmap.calendars, { maxQueryExpansionTime: 0 }),
                alerts: { enabled: false }
            });
            try {
                const ctx = await h.setupUser({}, spent.url);
                const single = await h.createEvent(ctx, utc('Single', '2026-01-10T10:00:00', 'PT1H'));
                // events that need no expansion still answer
                expect(await ids(ctx, { filter: JANUARY })).to.deep.equal([single.id]);
                await h.createEvent(ctx, WEEKLY);
                await h.expectError(h.evQuery(ctx, { filter: JANUARY }), 'cannotCalculateOccurrences');
                await h.expectError(h.evQuery(ctx, { filter: JANUARY, expandRecurrences: true }), 'cannotCalculateOccurrences');
            } finally {
                await instance.stopInstance(spent.app);
            }
        });
    });
});
