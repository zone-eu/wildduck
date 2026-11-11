/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global after */
'use strict';

// Catalogue file calendars.yaml, phase 6: CalendarEvent properties, participants and alerts, patches,
// changes, copy, recurrence rules and overrides, synthetic instance ids and the phase 6 limits of
// scheduling (CEV-067 to CEV-161). CEV-160 is phase 7 and not registered.

const { expect } = require('chai');
const { scenario, api, seed, jmap, outbound } = require('../harness');
const sse = require('../harness/sse');
const h = require('./calendar-event-helpers');

const { LUNCH, WEEKLY, JANUARY } = h;
const alert = (offset, extra = {}) => Object.assign({ '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset } }, extra);
const participant = (address, extra = {}) => Object.assign({ '@type': 'Participant', calendarAddress: `mailto:${address}` }, extra);
const mailto = address => `mailto:${address}`;

/** A weekly event R1 and the synthetic ids of its four January instances: {id, x: {'05': id, '12': id, ...}} */
async function weeklyWithInstances(ctx, values = WEEKLY) {
    const { id } = await h.createEvent(ctx, values);
    const ids = await h.expand(ctx);
    const starts = await h.startsOf(ctx, ids);
    const x = {};
    for (const object of starts) {
        x[object.recurrenceId.slice(8, 10)] = object.id;
    }
    return { id, x, ids };
}

describe('CalendarEvent properties, overrides and instances (CEV, part 2)', function () {
    this.timeout(60000);

    after(() => h.stopMulti());

    describe('properties', () => {
        scenario('CEV-067', async () => {
            const ctx = await h.setupUser();
            const values = { keywords: { work: true, urgent: true }, categories: { 'http://example.com/cat/meeting': true }, color: 'rebeccapurple' };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, values));
            expect(await h.fetch1(ctx, id, { properties: Object.keys(values) })).to.deep.equal(Object.assign({ id }, values));
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { keywords: { work: false } }));
            h.expectInvalid(error, 'keywords/work');
        });

        scenario('CEV-068', async () => {
            const ctx = await h.setupUser();
            const plain = await h.fetch1(ctx, (await h.createEvent(ctx, LUNCH)).id);
            expect(plain.freeBusyStatus === undefined || plain.freeBusyStatus === 'busy').to.equal(true);
            expect(plain.status === undefined || plain.status === 'confirmed').to.equal(true);
            expect(plain.priority === undefined || plain.priority === 0).to.equal(true);
            for (const [property, value] of [
                ['freeBusyStatus', 'free'],
                ['status', 'tentative'],
                ['priority', 9]
            ]) {
                const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { [property]: value }));
                expect((await h.fetch1(ctx, id))[property]).to.equal(value);
            }
            for (const [property, value] of [
                ['freeBusyStatus', 'maybe'],
                ['status', 'done'],
                ['priority', 10]
            ]) {
                const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { [property]: value }));
                h.expectInvalid(error);
                expect(error.properties, property).to.deep.equal([property]);
            }
        });

        scenario('CEV-069', async () => {
            const ctx = await h.setupUser();
            const s1 = await h.evState(ctx);
            const ids = [];
            for (const privacy of ['public', 'private', 'secret']) {
                const values = Object.assign({}, LUNCH, {
                    privacy,
                    description: 'Details',
                    participants: { me: participant(ctx.user.address, { roles: { owner: true } }), bob: participant('bob@example.net', { name: 'Bob' }) }
                });
                ids.push((await h.createEvent(ctx, values)).id);
            }
            const res = await h.evGet(ctx, ids);
            expect(res.list.map(object => object.privacy)).to.deep.equal(['public', 'private', 'secret']);
            for (const object of res.list) {
                expect(object).to.include({ title: 'Lunch', description: 'Details' });
                expect(Object.keys(object.participants).sort()).to.deep.equal(['bob', 'me']);
            }
            expect((await h.evQuery(ctx, {})).ids.sort()).to.deep.equal([...ids].sort());
            expect((await h.evChanges(ctx, s1)).created.sort()).to.deep.equal([...ids].sort());
        });

        const instance = (recurrenceId, extra = {}) =>
            Object.assign(
                { uid: 'series-1', recurrenceId, recurrenceIdTimeZone: 'Europe/Tallinn', start: recurrenceId, timeZone: 'Europe/Tallinn', duration: 'PT1H' },
                extra
            );

        scenario('CEV-070', async () => {
            const ctx = await h.setupUser();
            const i1 = await h.createEvent(ctx, instance('2026-01-05T09:00:00', { privacy: 'public' }));
            const i2 = await h.createEvent(ctx, instance('2026-01-12T09:00:00', { privacy: 'public' }));
            const other = await h.createEvent(ctx, LUNCH);
            const first = await h.tryUpdate(ctx, i1.id, { privacy: 'private' });
            h.expectInvalid(first.error);
            expect(first.error.properties).to.deep.equal(['privacy']);
            const res = await h.evSet(ctx, {
                update: { [i1.id]: { privacy: 'private' }, [i2.id]: { privacy: 'private' }, [other.id]: { title: 'Unrelated' } }
            });
            expect(res.notUpdated).to.equal(null);
            expect(Object.keys(res.updated).sort()).to.deep.equal([i1.id, i2.id, other.id].sort());
            const after = await h.evGet(ctx, [i1.id, i2.id, other.id], { properties: ['privacy', 'title'] });
            expect(after.list.map(object => object.privacy)).to.deep.equal(['private', 'private', undefined]);
            expect(after.list[2].title).to.equal('Unrelated');
        });

        scenario('CEV-071', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, instance('2026-01-05T09:00:00', { privacy: 'private' }));
            const { error } = await h.tryCreate(ctx, instance('2026-01-12T09:00:00'));
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal(['privacy']);
            await h.createEvent(ctx, instance('2026-01-12T09:00:00', { privacy: 'private' }));
        });

        scenario('CEV-072', async () => {
            const ctx = await h.setupUser();
            const relatedTo = { 'other-uid': { '@type': 'Relation', relation: { parent: true } } };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { relatedTo }));
            expect((await h.fetch1(ctx, id)).relatedTo).to.deep.equal(relatedTo);
        });

        scenario('CEV-073', async () => {
            const ctx = await h.setupUser();
            const own = await h.createEvent(ctx, Object.assign({}, LUNCH, { prodId: '-//Example//Client 1.0//EN' }));
            expect((await h.fetch1(ctx, own.id)).prodId).to.equal('-//Example//Client 1.0//EN');
            const none = await h.createEvent(ctx, LUNCH);
            const first = (await h.fetch1(ctx, none.id)).prodId;
            expect((await h.fetch1(ctx, none.id)).prodId).to.equal(first);
        });

        scenario('CEV-074', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign({}, LUNCH, { 'example.com:mood': 'sunny', locations: { l1: { '@type': 'Location', name: 'Room', 'example.com:floor': 3 } } })
            );
            let object = await h.fetch1(ctx, id);
            expect(object['example.com:mood']).to.equal('sunny');
            expect(object.locations.l1['example.com:floor']).to.equal(3);
            await h.update(ctx, id, { 'example.com:mood': 'rainy', 'locations/l1/example.com:floor': 4 });
            object = await h.fetch1(ctx, id);
            expect(object['example.com:mood']).to.equal('rainy');
            expect(object.locations.l1['example.com:floor']).to.equal(4);
            await h.update(ctx, id, { 'example.com:mood': null, 'locations/l1/example.com:floor': null });
            object = await h.fetch1(ctx, id);
            expect(object).to.not.have.property('example.com:mood');
            expect(object.locations.l1).to.not.have.property('example.com:floor');
        });

        scenario('CEV-075', async () => {
            const ctx = await h.setupUser();
            for (const [property, value] of [
                ['colour', 'red'],
                ['recurrenceRules', [{ '@type': 'RecurrenceRule', frequency: 'daily' }]]
            ]) {
                const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { [property]: value }));
                h.expectInvalid(error, property);
            }
        });
    });

    describe('participants', () => {
        scenario('CEV-076', async () => {
            const ctx = await h.setupUser();
            const participants = {
                p1: participant(ctx.user.address, {
                    name: 'Alice',
                    kind: 'individual',
                    roles: { owner: true, attendee: true },
                    participationStatus: 'accepted'
                }),
                p2: participant('bob@example.net', { name: 'Bob', email: 'bob@example.net', roles: { attendee: true }, expectReply: true })
            };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { participants }));
            const object = await h.fetch1(ctx, id);
            expect(object.participants.p1).to.deep.equal(participants.p1);
            expect(object.participants.p2).to.deep.include(participants.p2);
            expect(object.participants.p2.participationStatus === undefined || object.participants.p2.participationStatus === 'needs-action').to.equal(true);
            expect(await outbound.entriesFor('bob@example.net')).to.have.length(0);
        });

        scenario('CEV-077', async () => {
            const ctx = await h.setupUser();
            for (const [values, path] of [
                [{ roles: {} }, 'participants/p1/roles'],
                [{ roles: { owner: false } }, 'participants/p1/roles'],
                [{ participationStatus: 'maybe' }, 'participants/p1/participationStatus']
            ]) {
                const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { participants: { p1: participant('bob@example.net', values) } }));
                h.expectInvalidAt(error, path);
            }
        });

        scenario('CEV-078', async () => {
            const ctx = await h.setupUser();
            const created = await h.createEvent(
                ctx,
                Object.assign({}, LUNCH, {
                    participants: {
                        p1: participant(ctx.user.address, { roles: { owner: true } }),
                        p2: participant('bob@example.net', { roles: { attendee: true } })
                    }
                })
            );
            expect(created.organizerCalendarAddress).to.equal(mailto(ctx.user.address));
            expect(created.isOrigin).to.equal(true);
        });

        scenario('CEV-079', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            const updated = await h.update(ctx, id, {
                participants: {
                    p1: participant(ctx.user.address, { roles: { owner: true } }),
                    p2: participant('bob@example.net', { roles: { attendee: true } })
                }
            });
            expect(updated.organizerCalendarAddress).to.equal(mailto(ctx.user.address));
        });

        scenario('CEV-080', async () => {
            const ctx = await h.setupUser();
            const remote = await h.createEvent(
                ctx,
                Object.assign({}, LUNCH, {
                    organizerCalendarAddress: 'mailto:boss@remote.example',
                    participants: { boss: participant('boss@remote.example', { roles: { owner: true } }), me: participant(ctx.user.address) }
                })
            );
            const object = await h.fetch1(ctx, remote.id);
            expect(object.organizerCalendarAddress).to.equal('mailto:boss@remote.example');
            expect(object.isOrigin).to.equal(false);
            const plain = await h.fetch1(ctx, (await h.createEvent(ctx, LUNCH)).id);
            expect(plain).to.not.have.property('organizerCalendarAddress');
            expect(plain.isOrigin).to.equal(true);
        });

        async function withAlias(ctx) {
            const alias = `al.${ctx.user.address}`;
            const res = await api('POST', `/users/${ctx.user.id}/addresses`, { address: alias });
            expect(res.success).to.equal(true);
            return { alias, id: res.id };
        }

        const organisedBy = (ctx, organizer) =>
            Object.assign({}, LUNCH, {
                organizerCalendarAddress: organizer,
                participants: { org: { '@type': 'Participant', calendarAddress: organizer, roles: { owner: true } }, bob: participant('bob@example.net') }
            });

        scenario('CEV-081', async () => {
            const ctx = await h.setupUser();
            const { alias } = await withAlias(ctx);
            const [local, domain] = ctx.user.address.split('@');
            const cases = [
                [mailto(alias), true],
                [`MAILTO:${local.charAt(0).toUpperCase()}${local.slice(1)}@${domain.toUpperCase()}`, true],
                ['mailto:carol@remote.example', false]
            ];
            for (const [organizer, origin] of cases) {
                const { id } = await h.createEvent(ctx, organisedBy(ctx, organizer));
                expect((await h.fetch1(ctx, id, { properties: ['isOrigin'] })).isOrigin, organizer).to.equal(origin);
            }
        });

        scenario('CEV-082', async () => {
            const ctx = await h.setupUser();
            const { alias, id: addressId } = await withAlias(ctx);
            const { id } = await h.createEvent(ctx, organisedBy(ctx, mailto(alias)));
            expect((await h.fetch1(ctx, id)).isOrigin).to.equal(true);
            const s1 = await h.evState(ctx);
            expect((await api('DELETE', `/users/${ctx.user.id}/addresses/${addressId}`)).success).to.equal(true);
            expect((await h.fetch1(ctx, id)).isOrigin).to.equal(false);
            const changes = await h.evChanges(ctx, s1);
            expect(changes.updated).to.deep.equal([]);
            expect(changes.newState).to.equal(s1);
        });

        scenario('CEV-083', async () => {
            const ctx = await h.setupUser();
            const object = await h.fetch1(ctx, (await h.createEvent(ctx, LUNCH)).id);
            expect(object).to.not.have.property('participants');
            expect(object).to.not.have.property('organizerCalendarAddress');
        });

        scenario('CEV-084', async () => {
            const ctx = await h.setupUser();
            const session = await ctx.client.session();
            const n = session.accounts[ctx.client.accountId].accountCapabilities[jmap.URN.calendars].maxParticipantsPerEvent;
            const many = count => Object.fromEntries(Array.from({ length: count }, (value, i) => [`p${i}`, participant(`guest${i}@example.net`)]));
            const owner = participant(ctx.user.address, { roles: { owner: true } });
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { participants: Object.assign(many(n - 1), { me: owner }) }));
            const more = await h.tryUpdate(ctx, id, { 'participants/extra': participant('extra@example.net') });
            h.expectInvalid(more.error);
            expect(more.error.properties).to.deep.equal(['participants']);
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { participants: Object.assign(many(n), { me: owner }) }));
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal(['participants']);
        });

        scenario('CEV-085', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign({}, LUNCH, {
                    participants: {
                        me: participant(ctx.user.address, { roles: { owner: true } }),
                        p2: participant('bob@example.net', { participationStatus: 'accepted', expectReply: false })
                    }
                })
            );
            await h.update(ctx, id, { start: '2026-03-10T15:00:00', title: 'Moved' });
            expect((await h.fetch1(ctx, id)).participants.p2).to.include({ participationStatus: 'accepted', expectReply: false });
        });

        scenario('CEV-086', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, {
                title: 'Reduced',
                start: '2026-01-05T09:00:00',
                timeZone: 'Europe/Tallinn',
                recurrenceRule: { frequency: 'weekly' },
                organizerCalendarAddress: 'mailto:carol@remote.example',
                participants: {
                    carol: participant('carol@remote.example', { roles: { owner: true } }),
                    alice: participant(ctx.user.address, { roles: { attendee: true } }),
                    bob: participant('bob@example.net', { roles: { attendee: true } }),
                    dave: participant('dave@example.net', { roles: { attendee: true } })
                },
                recurrenceOverrides: { '2026-01-12T09:00:00': { 'participants/bob/participationStatus': 'declined' } }
            });
            const reduced = await h.fetch1(ctx, id, { reduceParticipants: true });
            expect(Object.keys(reduced.participants).sort()).to.deep.equal(['alice', 'carol']);
            expect(reduced.recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({});
            const full = await h.fetch1(ctx, id, { reduceParticipants: false });
            expect(Object.keys(full.participants).sort()).to.deep.equal(['alice', 'bob', 'carol', 'dave']);
            expect(full.recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({ 'participants/bob/participationStatus': 'declined' });
        });

        scenario('CEV-087', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, WEEKLY);
            const before = await h.fetch1(ctx, id);
            for (const property of ['mayInviteSelf', 'mayInviteOthers', 'hideAttendees']) {
                expect(before[property] === undefined || before[property] === false).to.equal(true);
            }
            await h.update(ctx, id, { mayInviteSelf: true, mayInviteOthers: true, hideAttendees: true });
            expect(await h.fetch1(ctx, id, { properties: ['mayInviteSelf', 'mayInviteOthers', 'hideAttendees'] })).to.deep.equal({
                id,
                mayInviteSelf: true,
                mayInviteOthers: true,
                hideAttendees: true
            });
            const { error } = await h.tryUpdate(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': { hideAttendees: false } } });
            h.expectInvalidAt(error, 'recurrenceOverrides');
        });

        scenario('CEV-088', async () => {
            const ctx = await h.setupUser();
            const participants = {
                org: participant('org@remote.example', { roles: { owner: true } }),
                me: participant(ctx.user.address, { roles: { attendee: true } }),
                a: participant('a@example.net', { name: 'Zygmunt Attendee' }),
                b: participant('b@example.net', { name: 'Other' }),
                c: participant('c@example.net', { name: 'Third' })
            };
            const { id } = await h.createEvent(
                ctx,
                Object.assign({}, LUNCH, { hideAttendees: true, organizerCalendarAddress: 'mailto:org@remote.example', participants })
            );
            expect(Object.keys((await h.fetch1(ctx, id)).participants).sort()).to.deep.equal(Object.keys(participants).sort());
            expect((await h.evQuery(ctx, { filter: { participant: 'Zygmunt' } })).ids).to.deep.equal([id]);
        });

        scenario('CEV-089', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign({}, LUNCH, {
                    participants: { me: participant(ctx.user.address, { roles: { owner: true } }), p2: participant('bob@example.net') }
                })
            );
            const p2 = (await h.fetch1(ctx, id)).participants.p2;
            expect(p2.scheduleSequence === undefined || p2.scheduleSequence === 0).to.equal(true);
            await h.update(ctx, id, {
                'participants/p2/participationStatus': 'accepted',
                'participants/p2/scheduleSequence': 2,
                'participants/p2/scheduleUpdated': '2026-03-01T10:00:00Z'
            });
            expect((await h.fetch1(ctx, id)).participants.p2).to.include({
                participationStatus: 'accepted',
                scheduleSequence: 2,
                scheduleUpdated: '2026-03-01T10:00:00Z'
            });
            for (const value of [-1, 1.5]) {
                const { error } = await h.tryUpdate(ctx, id, { 'participants/p2/scheduleSequence': value });
                h.expectInvalidAt(error, 'participants/p2/scheduleSequence');
            }
        });
    });

    describe('alerts', () => {
        scenario('CEV-090', async () => {
            const ctx = await h.setupUser();
            const alerts = {
                a1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' } },
                a2: { '@type': 'Alert', action: 'email', trigger: { '@type': 'AbsoluteTrigger', when: '2026-03-10T06:00:00Z' } }
            };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { alerts }));
            expect((await h.fetch1(ctx, id)).alerts).to.deep.equal(alerts);
            const bare = await h.createEvent(ctx, Object.assign({}, LUNCH, { alerts: { a1: { '@type': 'Alert', trigger: { offset: '-PT5M' } } } }));
            const stored = (await h.fetch1(ctx, bare.id)).alerts.a1;
            expect(stored.action === undefined || stored.action === 'display').to.equal(true);
            expect(stored.trigger.relativeTo === undefined || stored.trigger.relativeTo === 'start').to.equal(true);
        });

        scenario('CEV-091', async () => {
            const ctx = await h.setupUser();
            const bad = [
                { '@type': 'Alert' },
                alert('15 minutes'),
                { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'middle' } },
                alert('-PT5M', { action: 'shout' })
            ];
            for (const value of bad) {
                const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { alerts: { a1: value } }));
                h.expectInvalidAt(error, 'alerts/a1');
            }
            const geo = { '@type': 'Alert', trigger: { '@type': 'example.com:GeoTrigger', radius: 100 } };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { alerts: { a1: geo } }));
            expect((await h.fetch1(ctx, id)).alerts.a1).to.deep.equal(geo);
        });

        scenario('CEV-092', async () => {
            const ctx = await h.setupUser();
            const alerts = { a1: alert('-PT10M') };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { useDefaultAlerts: true, alerts }));
            expect(await h.fetch1(ctx, id, { properties: ['useDefaultAlerts', 'alerts'] })).to.deep.equal({ id, useDefaultAlerts: true, alerts });
            await h.update(ctx, id, { useDefaultAlerts: false });
            expect(await h.fetch1(ctx, id, { properties: ['useDefaultAlerts', 'alerts'] })).to.deep.equal({ id, useDefaultAlerts: false, alerts });
        });
    });

    describe('patches', () => {
        scenario('CEV-093', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            const before = await h.fetch1(ctx, id);
            const patch = { title: 'Dinner', start: '2026-03-10T19:00:00', timeZone: 'Europe/Helsinki', duration: 'PT2H' };
            await h.update(ctx, id, patch);
            const after = await h.fetch1(ctx, id);
            expect(after).to.include(patch);
            expect(after.uid).to.equal(before.uid);
            expect(after.created).to.equal(before.created);
            expect(after.calendarIds).to.deep.equal(before.calendarIds);
        });

        scenario('CEV-094', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign({}, LUNCH, {
                    locations: { l1: { '@type': 'Location', name: 'Room 4' } },
                    participants: { p1: participant(ctx.user.address, { roles: { owner: true } }), p2: participant('bob@example.net') }
                })
            );
            await h.update(ctx, id, {
                'locations/l2': { '@type': 'Location', name: 'Cafe' },
                'locations/l1/name': 'Room 5',
                'participants/p2': null,
                'participants/p1/participationStatus': 'tentative'
            });
            const object = await h.fetch1(ctx, id);
            expect(object.locations).to.deep.equal({ l1: { '@type': 'Location', name: 'Room 5' }, l2: { '@type': 'Location', name: 'Cafe' } });
            expect(Object.keys(object.participants)).to.deep.equal(['p1']);
            expect(object.participants.p1.participationStatus).to.equal('tentative');
        });

        scenario('CEV-095', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { categories: { 'http://example.com/cat/a': true }, keywords: { 'a~b': true } }));
            await h.update(ctx, id, { 'categories/http:~1~1example.com~1cat~1b': true, 'keywords/a~0b': null, 'keywords/c~0d': true });
            const object = await h.fetch1(ctx, id);
            expect(object.categories).to.deep.equal({ 'http://example.com/cat/a': true, 'http://example.com/cat/b': true });
            expect(object.keywords).to.deep.equal({ 'c~d': true });
        });

        scenario('CEV-096', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            const before = await h.fetch1(ctx, id);
            for (const patch of [{ 'locations/nope/name': 'X' }, { 'title/0': 'X' }, { locations: {}, 'locations/l1': { '@type': 'Location', name: 'Y' } }]) {
                const { error } = await h.tryUpdate(ctx, id, patch);
                expect(error, JSON.stringify(patch)).to.exist;
                expect(error.type).to.equal('invalidPatch');
            }
            expect(await h.fetch1(ctx, id)).to.deep.equal(before);
        });

        scenario('CEV-097', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            const s1 = await h.evState(ctx);
            const { error, res } = await h.tryUpdate(ctx, id, { title: 'Valid', duration: 'bogus' });
            h.expectInvalid(error);
            expect(error.properties).to.deep.equal(['duration']);
            expect((await h.fetch1(ctx, id)).title).to.equal('Lunch');
            expect(res.newState).to.equal(s1);
        });

        scenario('CEV-098', async () => {
            const ctx = await h.setupUser();
            const { error } = await h.tryCreate(
                ctx,
                Object.assign({}, WEEKLY, {
                    participants: {
                        me: participant(ctx.user.address, { roles: { owner: true } }),
                        p2: participant('bob@example.net', { participationStatus: 'bogus' })
                    },
                    alerts: { a1: alert('x') },
                    recurrenceOverrides: { '2026-01-12T09:00:00': { duration: 'y' } }
                })
            );
            h.expectInvalid(error);
            expect([...error.properties].sort()).to.deep.equal([
                'alerts/a1/trigger/offset',
                'participants/p2/participationStatus',
                'recurrenceOverrides/2026-01-12T09:00:00/duration'
            ]);
        });

        scenario('CEV-099', async () => {
            const ctx = await h.setupUser();
            const big = 'x'.repeat(300 * 1024);
            const { error } = await h.tryCreate(ctx, Object.assign({}, LUNCH, { description: big }));
            expect(error.type).to.equal('tooLarge');
            const { id } = await h.createEvent(ctx, LUNCH);
            const before = await h.fetch1(ctx, id);
            const updated = await h.tryUpdate(ctx, id, { description: big });
            expect(updated.error.type).to.equal('tooLarge');
            expect(await h.fetch1(ctx, id)).to.deep.equal(before);
            expect((await h.evGet(ctx, null)).list).to.have.length(1);
        });

        scenario('CEV-100', async () => {
            const ctx = await h.setupUser();
            const res = await h.evSet(ctx, { update: { Zmissing: { title: 'X' } }, destroy: ['Zgone'] });
            expect(res.notUpdated.Zmissing.type).to.equal('notFound');
            expect(res.notDestroyed.Zgone.type).to.equal('notFound');
        });

        scenario('CEV-101', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            const stale = await h.evState(ctx);
            await h.update(ctx, id, { title: 'Moved on' });
            await h.expectError(h.evSet(ctx, { ifInState: stale, update: { [id]: { title: 'Lost' } } }), 'stateMismatch');
            const session = await ctx.client.session();
            const max = session.capabilities[jmap.URN.core].maxObjectsInSet;
            const create = Object.fromEntries(
                Array.from({ length: max + 1 }, (value, i) => [`c${i}`, Object.assign({ calendarIds: { [ctx.calendar]: true } }, LUNCH)])
            );
            await h.expectError(h.evSet(ctx, { create }), 'requestTooLarge');
            const res = await h.evGet(ctx, null);
            expect(res.list).to.have.length(1);
            expect(res.list[0].title).to.equal('Moved on');
        });
    });

    describe('calendars of an event', () => {
        scenario('CEV-102', async () => {
            const ctx = await h.setupUser();
            const b = await h.createCalendar(ctx, { name: 'B' });
            const { id } = await h.createEvent(ctx, LUNCH);
            const s1 = await h.evState(ctx);
            await h.update(ctx, id, { calendarIds: { [b]: true } });
            const object = await h.fetch1(ctx, id);
            expect(object.id).to.equal(id);
            expect(object.calendarIds).to.deep.equal({ [b]: true });
            const changes = await h.evChanges(ctx, s1);
            expect(changes.updated).to.deep.equal([id]);
            expect(changes.created).to.deep.equal([]);
            expect(changes.destroyed).to.deep.equal([]);
            expect((await h.evQuery(ctx, { filter: { inCalendar: ctx.calendar } })).ids).to.deep.equal([]);
        });

        scenario('CEV-103', async () => {
            const { url } = await h.multiInstance();
            const ctx = await h.setupUser({}, url);
            const b = await h.createCalendar(ctx, { name: 'B' });
            const { id } = await h.createEvent(ctx, LUNCH);
            await h.update(ctx, id, { [`calendarIds/${b}`]: true });
            expect((await h.fetch1(ctx, id)).calendarIds).to.deep.equal({ [ctx.calendar]: true, [b]: true });
            await h.update(ctx, id, { [`calendarIds/${ctx.calendar}`]: null });
            expect((await h.fetch1(ctx, id)).calendarIds).to.deep.equal({ [b]: true });
        });

        scenario('CEV-104', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            for (const patch of [{ [`calendarIds/${ctx.calendar}`]: null }, { calendarIds: {} }, { calendarIds: { Znope: true } }]) {
                const { error } = await h.tryUpdate(ctx, id, patch);
                h.expectInvalid(error);
                expect(error.properties).to.deep.equal(['calendarIds']);
            }
            expect((await h.fetch1(ctx, id)).calendarIds).to.deep.equal({ [ctx.calendar]: true });
        });
    });

    describe('destroy and changes', () => {
        scenario('CEV-105', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            const res = await h.evSet(ctx, { destroy: [id] });
            expect(res.destroyed).to.deep.equal([id]);
            expect(res.newState).to.not.equal(res.oldState);
            expect((await h.evGet(ctx, [id])).notFound).to.deep.equal([id]);
            expect((await h.evSet(ctx, { destroy: [id] })).notDestroyed[id].type).to.equal('notFound');
        });

        scenario('CEV-106', async () => {
            const ctx = await h.setupUser();
            const first = await h.createEvent(ctx, Object.assign({ uid: 'u-1' }, LUNCH));
            await h.evSet(ctx, { destroy: [first.id] });
            const second = await h.createEvent(ctx, Object.assign({ uid: 'u-1' }, LUNCH));
            expect(second.id).to.not.equal(first.id);
        });

        scenario('CEV-107', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, LUNCH);
            const s1 = await h.evState(ctx);
            const res = await h.evChanges(ctx, s1);
            expect(res).to.include({ oldState: s1, newState: s1, hasMoreChanges: false });
            expect(res.created).to.deep.equal([]);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
        });

        scenario('CEV-108', async () => {
            const ctx = await h.setupUser();
            const e1 = await h.createEvent(ctx, LUNCH);
            const e2 = await h.createEvent(ctx, LUNCH);
            const s1 = await h.evState(ctx);
            const e3 = await h.createEvent(ctx, LUNCH);
            await h.update(ctx, e1.id, { title: 'Changed' });
            await h.evSet(ctx, { destroy: [e2.id] });
            const res = await h.evChanges(ctx, s1);
            expect(res.created).to.deep.equal([e3.id]);
            expect(res.updated).to.deep.equal([e1.id]);
            expect(res.destroyed).to.deep.equal([e2.id]);
            expect(res.newState).to.equal(await h.evState(ctx));
        });

        scenario('CEV-109', async () => {
            const ctx = await h.setupUser();
            const s1 = await h.evState(ctx);
            const ids = [];
            for (let i = 0; i < 7; i++) {
                ids.push((await h.createEvent(ctx, LUNCH)).id);
            }
            const seen = [];
            let since = s1;
            for (let round = 0; round < 10; round++) {
                const res = await h.evChanges(ctx, since, { maxChanges: 3 });
                const page = [...res.created, ...res.updated];
                expect(page.length).to.be.at.most(3);
                seen.push(...res.created);
                since = res.newState;
                if (!res.hasMoreChanges) {
                    break;
                }
            }
            expect(seen.sort()).to.deep.equal(ids.sort());
            await h.expectError(h.evChanges(ctx, 'bogus'), 'cannotCalculateChanges');
        });

        scenario('CEV-110', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const s1 = await h.evState(ctx);
            await h.update(ctx, x['12'], { title: 'Instance title' });
            await h.evSet(ctx, { destroy: [x['19']] });
            const res = await h.evChanges(ctx, s1);
            expect(res.updated).to.deep.equal([id]);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
        });

        scenario('CEV-111', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            const s1 = await h.evState(ctx);
            await h.evSet(ctx, { destroy: [id] });
            // the tombstone outlives a 29 day old state: it expires after the 30 day retention
            const tombstone = await (await seed.db()).collection('jmapchanges').findOne({ user: new seed.ObjectId(ctx.user.id), type: 'CalendarEvent' });
            expect(tombstone.expires.getTime()).to.be.above(Date.now() + 30 * 24 * 3600 * 1000);
            expect((await h.evChanges(ctx, s1)).destroyed).to.deep.equal([id]);
        });

        scenario('CEV-112', async () => {
            const ctx = await h.setupUser();
            const es = await sse.open('/jmap/eventsource/?types=CalendarEvent&closeafter=no&ping=0', {
                authorization: jmap.basic(ctx.user.username, ctx.user.password)
            });
            try {
                await es.until(() => es.comments[0], 5000, 'stream not connected');
                const pushed = state =>
                    es.until(() => es.states().find(event => event.json.changed[ctx.client.accountId].CalendarEvent === state), 10000, 'no state pushed');
                const created = await h.evSet(ctx, { create: { k: Object.assign({ calendarIds: { [ctx.calendar]: true } }, LUNCH) } });
                await pushed(created.newState);
                const destroyed = await h.evSet(ctx, { destroy: [created.created.k.id] });
                await pushed(destroyed.newState);
            } finally {
                es.close();
            }
        });
    });

    describe('copy', () => {
        scenario('CEV-113', async () => {
            const ctx = await h.setupUser();
            const other = await h.setupUser();
            const e9 = await h.createEvent(other, LUNCH);
            for (const fromAccountId of [other.client.accountId, 'u000000000000000000000000']) {
                await h.expectError(
                    h.method(ctx, 'CalendarEvent/copy', { fromAccountId, create: { k1: { id: e9.id, calendarIds: { [ctx.calendar]: true } } } }),
                    'fromAccountNotFound'
                );
            }
            expect((await h.evGet(ctx, null)).list).to.have.length(0);
            expect((await h.fetch1(other, e9.id)).title).to.equal('Lunch');
        });

        scenario('CEV-114', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            await h.expectError(h.method(ctx, 'CalendarEvent/copy', { fromAccountId: ctx.client.accountId, create: { k1: { id } } }), 'invalidArguments');
            expect((await h.evGet(ctx, null)).list).to.have.length(1);
        });
    });

    describe('recurrence rules', () => {
        scenario('CEV-115', async () => {
            const ctx = await h.setupUser();
            const rule = { '@type': 'RecurrenceRule', frequency: 'monthly', interval: 2, byDay: [{ '@type': 'NDay', day: 'tu', nthOfPeriod: 2 }], count: 10 };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { recurrenceRule: rule }));
            const stored = (await h.fetch1(ctx, id)).recurrenceRule;
            expect(stored).to.include({ frequency: 'monthly', interval: 2, count: 10 });
            expect(stored.byDay).to.deep.equal(rule.byDay);
            for (const [property, value] of [
                ['rscale', 'gregorian'],
                ['skip', 'omit'],
                ['firstDayOfWeek', 'mo']
            ]) {
                expect(stored[property] === undefined || stored[property] === value, property).to.equal(true);
            }
        });

        const ruleError = async (ctx, rule) => (await h.tryCreate(ctx, Object.assign({}, LUNCH, { recurrenceRule: rule }))).error;

        scenario('CEV-116', async () => {
            const ctx = await h.setupUser();
            for (const rule of [{}, { frequency: 'fortnightly' }, { frequency: 'WEEKLY' }]) {
                h.expectInvalidAt(await ruleError(ctx, rule), 'recurrenceRule/frequency');
            }
            for (const frequency of ['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly']) {
                await h.createEvent(ctx, Object.assign({}, LUNCH, { recurrenceRule: { frequency, count: 2 } }));
            }
        });

        scenario('CEV-117', async () => {
            const ctx = await h.setupUser();
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'daily', interval: 0 }), 'recurrenceRule/interval');
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'daily', interval: -1 }), 'recurrenceRule/interval');
            const both = await ruleError(ctx, { frequency: 'daily', count: 3, until: '2026-02-01T00:00:00' });
            h.expectInvalid(both);
            expect(both.properties.some(path => ['recurrenceRule/count', 'recurrenceRule/until'].includes(path))).to.equal(true);
        });

        scenario('CEV-118', async () => {
            const ctx = await h.setupUser();
            for (const byDay of [[{ day: 'xx' }], [{ day: 'mo', nthOfPeriod: 0 }], [{ day: 'Mo' }]]) {
                h.expectInvalidAt(await ruleError(ctx, { frequency: 'monthly', byDay }), 'recurrenceRule/byDay');
            }
            await h.createEvent(ctx, Object.assign({}, LUNCH, { recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'fr', nthOfPeriod: -1 }] } }));
        });

        scenario('CEV-119', async () => {
            const ctx = await h.setupUser();
            const bad = [
                ['byMonthDay', [0]],
                ['byMonthDay', [32]],
                ['byMonthDay', []],
                ['byMonth', ['13']],
                ['byMonth', [3]],
                ['byYearDay', [367]],
                ['byWeekNo', [54]],
                ['byHour', [24]],
                ['byMinute', [60]],
                ['bySecond', [61]],
                ['bySetPosition', []]
            ];
            for (const [part, value] of bad) {
                h.expectInvalidAt(await ruleError(ctx, { frequency: 'yearly', [part]: value }), `recurrenceRule/${part}`);
            }
            const good = [
                ['byMonthDay', [-31, 31]],
                ['byMonth', ['1', '12']],
                ['byYearDay', [-366]],
                ['byWeekNo', [-53]],
                ['byHour', [0, 23]],
                ['bySecond', [60]],
                ['bySetPosition', [-1]]
            ];
            for (const [part, value] of good) {
                await h.createEvent(ctx, Object.assign({}, LUNCH, { recurrenceRule: { frequency: 'yearly', [part]: value, count: 2 } }));
            }
        });

        scenario('CEV-120', async () => {
            const ctx = await h.setupUser();
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'weekly', firstDayOfWeek: 'sunday' }), 'recurrenceRule/firstDayOfWeek');
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'monthly', skip: 'sideways' }), 'recurrenceRule/skip');
            const rule = { '@type': 'RecurrenceRule', frequency: 'monthly', firstDayOfWeek: 'su', skip: 'backward' };
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { recurrenceRule: rule }));
            expect((await h.fetch1(ctx, id)).recurrenceRule).to.deep.equal(rule);
        });

        scenario('CEV-121', async () => {
            const ctx = await h.setupUser();
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'yearly', rscale: 'hebrew' }), 'recurrenceRule/rscale');
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'yearly', rscale: 'chinese', byMonth: ['3L'] }), 'recurrenceRule/rscale');
            await h.createEvent(ctx, Object.assign({}, LUNCH, { recurrenceRule: { frequency: 'yearly', rscale: 'gregorian' } }));
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'yearly', rscale: 'GREGORIAN' }), 'recurrenceRule/rscale');
        });

        scenario('CEV-122', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, Object.assign({}, LUNCH, { recurrenceRule: { frequency: 'daily', until: '2026-01-07T09:00:00' } }));
            expect((await h.fetch1(ctx, id)).recurrenceRule.until).to.equal('2026-01-07T09:00:00');
            h.expectInvalidAt(await ruleError(ctx, { frequency: 'daily', until: '2026-01-07T09:00:00Z' }), 'recurrenceRule/until');
        });
    });

    describe('recurrence overrides', () => {
        scenario('CEV-123', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, WEEKLY);
            const overrides = {
                '2026-01-12T09:00:00': { title: 'Special', start: '2026-01-12T11:00:00' },
                '2026-01-19T09:00:00': { excluded: true },
                '2026-01-21T15:00:00': {}
            };
            await h.update(ctx, id, { recurrenceOverrides: overrides });
            expect((await h.fetch1(ctx, id)).recurrenceOverrides).to.deep.equal(overrides);
        });

        scenario('CEV-124', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, WEEKLY);
            const before = await h.fetch1(ctx, id);
            for (const overrides of [
                { '2026-01-12': { title: 'X' } },
                { '2026-01-12T09:00:00Z': { title: 'X' } },
                { '2026-01-12T09:00:00': { duration: 'nonsense' } }
            ]) {
                const { error } = await h.tryUpdate(ctx, id, { recurrenceOverrides: overrides });
                h.expectInvalidAt(error, 'recurrenceOverrides');
            }
            expect(await h.fetch1(ctx, id)).to.deep.equal(before);
        });

        scenario('CEV-125', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, WEEKLY);
            const { error } = await h.tryUpdate(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': { excluded: true, title: 'Gone' } } });
            h.expectInvalidAt(error, 'recurrenceOverrides/2026-01-12T09:00:00');
        });

        scenario('CEV-126', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            await h.update(ctx, id, {
                recurrenceOverrides: { '2026-01-12T09:00:00': { uid: 'other', privacy: 'secret', method: 'cancel', recurrenceRule: null, title: 'Kept' } }
            });
            const base = await h.fetch1(ctx, id);
            const instance = await h.fetch1(ctx, x['12']);
            expect(instance.title).to.equal('Kept');
            expect(instance.uid).to.equal(base.uid);
            expect(instance.privacy).to.equal(base.privacy);
            expect(instance).to.not.have.property('method');
        });

        const withPeople = ctx =>
            Object.assign({}, WEEKLY, {
                participants: {
                    me: participant(ctx.user.address, { roles: { owner: true } }),
                    tom: participant('tom@example.net', { participationStatus: 'accepted' }),
                    zoe: participant('zoe@example.net', { participationStatus: 'accepted' })
                }
            });

        scenario('CEV-127', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign(withPeople(ctx), {
                    recurrenceOverrides: { '2026-01-12T09:00:00': { start: '2026-01-12T10:00:00', 'participants/tom/participationStatus': 'declined' } }
                })
            );
            await h.update(ctx, id, { 'recurrenceOverrides/2026-01-12T09:00:00/participants~1zoe~1participationStatus': 'declined' });
            expect((await h.fetch1(ctx, id)).recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({
                start: '2026-01-12T10:00:00',
                'participants/tom/participationStatus': 'declined',
                'participants/zoe/participationStatus': 'declined'
            });
        });

        scenario('CEV-128', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign(withPeople(ctx), {
                    recurrenceOverrides: {
                        '2026-01-12T09:00:00': {
                            start: '2026-01-12T10:00:00',
                            'participants/tom/participationStatus': 'declined',
                            'participants/zoe/participationStatus': 'declined'
                        }
                    }
                })
            );
            await h.update(ctx, id, { 'recurrenceOverrides/2026-01-12T09:00:00/participants~1tom~1participationStatus': null });
            expect((await h.fetch1(ctx, id)).recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({
                start: '2026-01-12T10:00:00',
                'participants/zoe/participationStatus': 'declined'
            });
        });

        scenario('CEV-129', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(
                ctx,
                Object.assign(withPeople(ctx), { recurrenceOverrides: { '2026-01-12T09:00:00': { start: '2026-01-12T10:00:00' } } })
            );
            await h.update(ctx, id, { 'recurrenceOverrides/2026-01-12T09:00:00/participants~1tom': null });
            expect((await h.fetch1(ctx, id)).recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({ start: '2026-01-12T10:00:00' });
            await h.update(ctx, id, { 'recurrenceOverrides/2026-01-12T09:00:00': { start: '2026-01-12T10:00:00', 'participants/tom': null } });
            expect((await h.fetch1(ctx, id)).recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({
                start: '2026-01-12T10:00:00',
                'participants/tom': null
            });
            const ids = await h.expand(ctx);
            const [instance] = (await h.startsOf(ctx, ids, ['recurrenceId', 'participants'])).filter(object => object.recurrenceId === '2026-01-12T09:00:00');
            expect(Object.keys(instance.participants).sort()).to.deep.equal(['me', 'zoe']);
        });

        scenario('CEV-130', async () => {
            const ctx = await h.setupUser();
            const overrides = { '2026-01-12T09:00:00': { title: '12' }, '2026-01-19T09:00:00': { title: '19' }, '2026-01-26T09:00:00': { title: '26' } };
            const { id } = await h.createEvent(ctx, Object.assign({}, WEEKLY, { recurrenceOverrides: overrides }));
            const keys = async args =>
                Object.keys((await h.fetch1(ctx, id, Object.assign({ properties: ['recurrenceOverrides'] }, args))).recurrenceOverrides).sort();
            expect(await keys({ recurrenceOverridesAfter: '2026-01-19T07:00:00Z', recurrenceOverridesBefore: '2026-01-26T07:00:00Z' })).to.deep.equal([
                '2026-01-19T09:00:00'
            ]);
            expect(await keys({ recurrenceOverridesAfter: '2026-01-19T07:00:00Z' })).to.deep.equal(['2026-01-19T09:00:00', '2026-01-26T09:00:00']);
            expect(await keys({ recurrenceOverridesBefore: '2026-01-26T07:00:00Z' })).to.deep.equal(['2026-01-12T09:00:00', '2026-01-19T09:00:00']);
        });
    });

    describe('synthetic instance ids', () => {
        scenario('CEV-131', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const base = await h.fetch1(ctx, id);
            const object = await h.fetch1(ctx, x['12'], { properties: null });
            expect(object).to.include({ id: x['12'], baseEventId: id, start: '2026-01-12T09:00:00', recurrenceId: '2026-01-12T09:00:00' });
            expect(object).to.include({ title: base.title, duration: base.duration, timeZone: base.timeZone, uid: base.uid });
            expect(object.calendarIds).to.deep.equal(base.calendarIds);
            expect(object).to.not.have.property('recurrenceRule');
            expect(object).to.not.have.property('recurrenceOverrides');
        });

        scenario('CEV-132', async () => {
            const ctx = await h.setupUser();
            const { x } = await weeklyWithInstances(ctx);
            expect(await h.fetch1(ctx, x['12'], { properties: ['recurrenceRule', 'recurrenceOverrides', 'start'] })).to.deep.equal({
                id: x['12'],
                recurrenceRule: null,
                recurrenceOverrides: null,
                start: '2026-01-12T09:00:00'
            });
        });

        scenario('CEV-133', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            await h.update(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': { start: '2026-01-12T11:00:00', title: 'Special' } } });
            expect(await h.fetch1(ctx, x['12'], { properties: ['start', 'title', 'recurrenceId', 'baseEventId'] })).to.deep.equal({
                id: x['12'],
                start: '2026-01-12T11:00:00',
                title: 'Special',
                recurrenceId: '2026-01-12T09:00:00',
                baseEventId: id
            });
        });

        scenario('CEV-134', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            await h.update(ctx, id, { recurrenceOverrides: { '2026-01-19T09:00:00': { excluded: true } } });
            const invented = x['12'].replace(/T090000$/, 'T100000');
            expect((await h.evGet(ctx, [x['19'], invented])).notFound).to.deep.equal([x['19'], invented]);
            await h.evSet(ctx, { destroy: [id] });
            expect((await h.evGet(ctx, [x['12']])).notFound).to.deep.equal([x['12']]);
        });

        scenario('CEV-135', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const res = await h.evGet(ctx, [id, x['12']], { properties: ['baseEventId'] });
            expect(res.list[1].baseEventId).to.equal(id);
            expect(res.list[0].baseEventId === undefined || res.list[0].baseEventId === null).to.equal(true);
        });

        scenario('CEV-136', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, WEEKLY);
            const ids = await h.expand(ctx, { after: '2026-03-20T00:00:00', before: '2026-04-05T00:00:00' });
            expect(ids).to.have.length(2);
            const res = await h.evGet(ctx, ids, { properties: ['utcStart', 'utcEnd'] });
            expect(res.list.map(object => [object.utcStart, object.utcEnd])).to.deep.equal([
                ['2026-03-23T07:00:00Z', '2026-03-23T08:00:00Z'],
                ['2026-03-30T06:00:00Z', '2026-03-30T07:00:00Z']
            ]);
        });

        scenario('CEV-137', async () => {
            const ctx = await h.setupUser();
            const { id, ids, x } = await weeklyWithInstances(ctx);
            for (const value of ids) {
                expect(value).to.match(h.ID);
                expect(Buffer.byteLength(value)).to.be.at.most(255);
            }
            await h.update(ctx, id, { title: 'Renamed' });
            expect(await h.expand(ctx)).to.deep.equal(ids);
            // a restarted worker: a fresh instance of the service answers the same ids
            const { url } = await h.multiInstance();
            const client = jmap.forUser(ctx.user);
            const raw = client.raw.bind(client);
            client.raw = (path, init) => raw(path.startsWith('http') ? path : url + path, init);
            const res = await client.method('CalendarEvent/query', { filter: JANUARY, expandRecurrences: true, sort: [{ property: 'start' }] }, h.USING);
            expect(res.ids).to.deep.equal(ids);
            expect((await h.fetch1(ctx, x['12'])).recurrenceId).to.equal('2026-01-12T09:00:00');
        });

        scenario('CEV-138', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, { title: 'Single', start: '2026-01-15T10:00:00', timeZone: 'Etc/UTC', duration: 'PT1H' });
            const ids = await h.expand(ctx);
            expect(ids).to.deep.equal([id]);
            const object = await h.fetch1(ctx, id);
            expect(object).to.not.have.property('baseEventId');
            expect(object).to.not.have.property('recurrenceId');
        });

        scenario('CEV-139', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const res = await h.evSet(ctx, { update: { [x['12']]: { title: 'Moved', start: '2026-01-12T14:00:00' } } });
            expect(Object.keys(res.updated)).to.deep.equal([x['12']]);
            const base = await h.fetch1(ctx, id);
            expect(base.recurrenceOverrides).to.deep.equal({ '2026-01-12T09:00:00': { title: 'Moved', start: '2026-01-12T14:00:00' } });
            expect(base.title).to.equal('Standup');
            expect((await h.evGet(ctx, null)).list.map(object => object.id)).to.deep.equal([id]);
        });

        scenario('CEV-140', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            await h.update(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': { title: 'Moved' } } });
            await h.update(ctx, x['12'], { description: 'Bring slides' });
            expect((await h.fetch1(ctx, id)).recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({ title: 'Moved', description: 'Bring slides' });
        });

        scenario('CEV-141', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            await h.update(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': { title: 'Moved' } } });
            await h.update(ctx, x['12'], { title: 'Standup' });
            expect((await h.fetch1(ctx, x['12'])).title).to.equal('Standup');
            const base = await h.fetch1(ctx, id);
            expect(base.recurrenceOverrides === undefined || !Object.hasOwn(base.recurrenceOverrides, '2026-01-12T09:00:00')).to.equal(true);
        });

        scenario('CEV-142', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const res = await h.evSet(ctx, { destroy: [x['19']] });
            expect(res.destroyed).to.deep.equal([x['19']]);
            expect(await h.expand(ctx)).to.deep.equal([x['05'], x['12'], x['26']]);
            expect((await h.fetch1(ctx, id)).recurrenceOverrides).to.deep.equal({ '2026-01-19T09:00:00': { excluded: true } });
        });

        scenario('CEV-143', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            await h.update(ctx, id, { recurrenceOverrides: { '2026-01-12T09:00:00': { start: '2026-01-12T14:00:00' } } });
            await h.evSet(ctx, { destroy: [x['12']] });
            expect((await h.fetch1(ctx, id)).recurrenceOverrides).to.deep.equal({ '2026-01-12T09:00:00': { excluded: true } });
            const starts = (await h.startsOf(ctx, await h.expand(ctx))).map(object => object.start);
            expect(starts.filter(start => start.startsWith('2026-01-12'))).to.deep.equal([]);
        });

        scenario('CEV-144', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-21T15:00:00': {} } }));
            const ids = await h.expand(ctx);
            const added = (await h.startsOf(ctx, ids)).find(object => object.recurrenceId === '2026-01-21T15:00:00');
            expect(added).to.exist;
            await h.evSet(ctx, { destroy: [added.id] });
            const base = await h.fetch1(ctx, id);
            expect(base.recurrenceOverrides === undefined || !Object.hasOwn(base.recurrenceOverrides, '2026-01-21T15:00:00')).to.equal(true);
            expect(await h.expand(ctx)).to.not.include(added.id);
        });

        scenario('CEV-145', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const res = await h.evSet(ctx, { destroy: [x['05']] });
            expect(res.destroyed).to.deep.equal([x['05']]);
            const base = await h.fetch1(ctx, id);
            expect(base.start).to.equal('2026-01-05T09:00:00');
            expect(base.recurrenceOverrides).to.deep.equal({ '2026-01-05T09:00:00': { excluded: true } });
            expect((await h.expand(ctx))[0]).to.equal(x['12']);
        });

        scenario('CEV-146', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const s1 = await h.evState(ctx);
            const res = await h.evSet(ctx, { update: { [x['12']]: { title: 'A' }, [x['19']]: { title: 'B' } }, destroy: [x['26']] });
            expect(res.notUpdated).to.equal(null);
            expect(res.notDestroyed).to.equal(null);
            expect((await h.fetch1(ctx, id)).recurrenceOverrides).to.deep.equal({
                '2026-01-12T09:00:00': { title: 'A' },
                '2026-01-19T09:00:00': { title: 'B' },
                '2026-01-26T09:00:00': { excluded: true }
            });
            expect((await h.evChanges(ctx, s1)).updated).to.deep.equal([id]);
        });

        scenario('CEV-147', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const res = await h.evSet(ctx, { update: { [x['12']]: { title: 'Fine' }, [x['19']]: { duration: 'bogus' } } });
            expect(Object.keys(res.updated)).to.deep.equal([x['12']]);
            expect(res.notUpdated[x['19']].type).to.equal('invalidProperties');
            expect(Object.keys((await h.fetch1(ctx, id)).recurrenceOverrides)).to.deep.equal(['2026-01-12T09:00:00']);
        });

        scenario('CEV-148', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const other = await h.createEvent(ctx, LUNCH);
            const before = await h.fetch1(ctx, id);
            const first = await h.evSet(ctx, { update: { [id]: { title: 'Base' }, [x['12']]: { title: 'Instance' }, [other.id]: { title: 'Unrelated' } } });
            expect(first.notUpdated[id].type).to.equal('invalidProperties');
            expect(first.notUpdated[x['12']].type).to.equal('invalidProperties');
            expect(first.updated).to.have.property(other.id);
            const second = await h.evSet(ctx, { destroy: [id], update: { [x['12']]: { title: 'Instance' } } });
            expect(second.notUpdated[x['12']].type).to.equal('invalidProperties');
            expect(second.notDestroyed[id].type).to.equal('invalidProperties');
            expect(await h.fetch1(ctx, id)).to.deep.equal(before);
            expect((await h.fetch1(ctx, other.id)).title).to.equal('Unrelated');
        });

        scenario('CEV-149', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const c2 = await h.createCalendar(ctx);
            const before = await h.fetch1(ctx, id);
            const cases = [
                [{ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' } }, 'recurrenceRule'],
                [{ uid: 'x' }, 'uid'],
                [{ privacy: 'private' }, 'privacy'],
                [{ isDraft: true }, 'isDraft'],
                [{ calendarIds: { [c2]: true } }, 'calendarIds'],
                [{ recurrenceOverrides: {} }, 'recurrenceOverrides']
            ];
            for (const [patch, property] of cases) {
                const { error } = await h.tryUpdate(ctx, x['12'], patch);
                h.expectInvalid(error);
                expect(error.properties, property).to.deep.equal([property]);
            }
            expect(await h.fetch1(ctx, id)).to.deep.equal(before);
        });

        scenario('CEV-150', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            const object = await h.fetch1(ctx, x['12']);
            const patch = Object.assign({}, object, { title: 'Only this' });
            delete patch.id;
            await h.update(ctx, x['12'], patch);
            expect((await h.fetch1(ctx, id)).recurrenceOverrides).to.deep.equal({ '2026-01-12T09:00:00': { title: 'Only this' } });
        });

        scenario('CEV-151', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx);
            await h.evSet(ctx, { destroy: [x['19']] });
            const res = await h.evSet(ctx, { update: { [x['19']]: { title: 'Back' } }, destroy: [x['19']] });
            expect(res.notUpdated[x['19']].type).to.equal('notFound');
            expect(res.notDestroyed[x['19']].type).to.equal('notFound');
            expect((await h.fetch1(ctx, id)).recurrenceOverrides).to.deep.equal({ '2026-01-19T09:00:00': { excluded: true } });
        });

        scenario('CEV-152', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, {
                title: 'All day',
                start: '2026-01-05T00:00:00',
                duration: 'P1D',
                showWithoutTime: true,
                recurrenceRule: { frequency: 'weekly' }
            });
            const starts = await h.startsOf(ctx, await h.expand(ctx));
            const x12 = starts.find(object => object.recurrenceId === '2026-01-12T00:00:00').id;
            await h.update(ctx, x12, { start: '2026-01-13T00:00:00' });
            const object = await h.fetch1(ctx, x12);
            expect(object).to.include({ start: '2026-01-13T00:00:00', duration: 'P1D', showWithoutTime: true });
            expect(object.timeZone === undefined || object.timeZone === null).to.equal(true);
        });

        scenario('CEV-153', async () => {
            const ctx = await h.setupUser();
            const { id, x } = await weeklyWithInstances(ctx, Object.assign({}, WEEKLY, { alerts: { a1: alert('-PT15M') } }));
            await h.update(ctx, x['12'], { 'alerts/a1/acknowledged': '2026-01-12T06:50:00Z' });
            const base = await h.fetch1(ctx, id);
            expect(base).to.not.have.property('recurrenceOverrides');
            expect(base.alerts.a1.acknowledged).to.equal('2026-01-12T06:50:00Z');
        });
    });

    describe('this and future', () => {
        scenario('CEV-154', async () => {
            const ctx = await h.setupUser();
            const r1 = await h.createEvent(ctx, WEEKLY);
            const base = await h.fetch1(ctx, r1.id);
            const res = await h.evSet(ctx, {
                update: {
                    [r1.id]: { 'recurrenceRule/until': '2026-01-18T23:59:59', relatedTo: { newUid: { '@type': 'Relation', relation: { next: true } } } }
                },
                create: {
                    next: Object.assign({ calendarIds: { [ctx.calendar]: true } }, WEEKLY, {
                        uid: 'newUid',
                        start: '2026-01-19T10:00:00',
                        relatedTo: { [base.uid]: { '@type': 'Relation', relation: { first: true } } }
                    })
                }
            });
            expect(res.notUpdated).to.equal(null);
            expect(res.notCreated).to.equal(null);
            const starts = (await h.startsOf(ctx, await h.expand(ctx))).map(object => object.start);
            expect(starts).to.deep.equal(['2026-01-05T09:00:00', '2026-01-12T09:00:00', '2026-01-19T10:00:00', '2026-01-26T10:00:00']);
            expect((await h.fetch1(ctx, r1.id)).relatedTo).to.deep.equal({ newUid: { '@type': 'Relation', relation: { next: true } } });
            expect((await h.fetch1(ctx, res.created.next.id)).relatedTo).to.deep.equal({ [base.uid]: { '@type': 'Relation', relation: { first: true } } });
        });

        scenario('CEV-155', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, WEEKLY);
            const before = await h.fetch1(ctx, id);
            await h.update(ctx, id, {
                title: 'Sync',
                recurrenceOverrides: { '2026-01-05T09:00:00': { title: 'Standup' }, '2026-01-12T09:00:00': { title: 'Standup' } }
            });
            const titles = (await h.startsOf(ctx, await h.expand(ctx), ['title'])).map(object => object.title);
            expect(titles).to.deep.equal(['Standup', 'Standup', 'Sync', 'Sync']);
            const after = await h.fetch1(ctx, id);
            expect(after.uid).to.equal(before.uid);
            expect(after.sequence).to.equal((before.sequence || 0) + 1);
        });

        scenario('CEV-156', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, WEEKLY);
            await h.update(ctx, id, { start: '2026-01-19T09:00:00', recurrenceOverrides: { '2026-01-05T09:00:00': {}, '2026-01-12T09:00:00': {} } });
            const starts = (await h.startsOf(ctx, await h.expand(ctx))).map(object => object.start.slice(0, 10));
            expect(starts).to.deep.equal(['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
        });
    });

    describe('scheduling before phase 7', () => {
        scenario('CEV-157', async () => {
            const ctx = await h.setupUser();
            const values = Object.assign({}, LUNCH, {
                participants: {
                    me: participant(ctx.user.address, { roles: { owner: true } }),
                    bob: participant('bob@example.net', { roles: { attendee: true } })
                }
            });
            const { error } = await h.tryCreate(ctx, values, { sendSchedulingMessages: true });
            expect(error.type).to.equal('noSupportedScheduleMethods');
            expect((await h.evGet(ctx, null)).list).to.have.length(0);
            await h.createEvent(ctx, values, { sendSchedulingMessages: false });
            expect(await outbound.entriesFor('bob@example.net')).to.have.length(0);
            // nothing to send: an event without participants succeeds
            await h.createEvent(ctx, LUNCH, { sendSchedulingMessages: true });
        });

        scenario('CEV-158', async () => {
            const ctx = await h.setupUser();
            const s1 = await h.evState(ctx);
            const uid = `invite-${Date.now()}@remote.example`;
            const ics = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'METHOD:REQUEST',
                'PRODID:-//Remote//EN',
                'BEGIN:VEVENT',
                `UID:${uid}`,
                'DTSTAMP:20260101T000000Z',
                'DTSTART:20260310T120000Z',
                'SUMMARY:Invitation',
                'ORGANIZER:mailto:boss@remote.example',
                `ATTENDEE:mailto:${ctx.user.address}`,
                'END:VEVENT',
                'END:VCALENDAR'
            ].join('\r\n');
            const raw = [
                'From: boss@remote.example',
                `To: ${ctx.user.address}`,
                'Subject: Invitation',
                'MIME-Version: 1.0',
                'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
                '',
                ics
            ].join('\r\n');
            await seed.deliver(ctx.user.address, raw, 'boss@remote.example');
            const messages = await ctx.client.call([['Email/query', { accountId: true }, 'q']]);
            expect(messages[0][1].ids).to.have.length(1);
            const changes = await h.evChanges(ctx, s1);
            expect(changes.created).to.deep.equal([]);
            expect(changes.updated).to.deep.equal([]);
            expect((await h.evQuery(ctx, { filter: { uid } })).ids).to.deep.equal([]);
            expect((await h.method(ctx, 'CalendarEventNotification/get', { ids: null })).list).to.deep.equal([]);
        });

        scenario('CEV-159', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            expect(await h.fetch1(ctx, id, { properties: null })).to.not.have.property('iCalendar');
            await h.expectError(h.evGet(ctx, [id], { properties: ['iCalendar'] }), 'invalidArguments');
        });

        scenario('CEV-161', async () => {
            const ctx = await h.setupUser();
            const { id } = await h.createEvent(ctx, LUNCH);
            await h.update(ctx, id, { title: 'Changed' });
            await h.evSet(ctx, { destroy: [id] });
            const got = await h.method(ctx, 'CalendarEventNotification/get', { ids: null });
            expect(got.list).to.deep.equal([]);
            expect(got.state).to.be.a('string');
            expect((await h.method(ctx, 'CalendarEventNotification/query', {})).ids).to.deep.equal([]);
            const changes = await h.method(ctx, 'CalendarEventNotification/changes', { sinceState: got.state });
            expect(changes).to.include({ oldState: got.state, newState: got.state });
            expect(changes.created).to.deep.equal([]);
            expect(changes.updated).to.deep.equal([]);
            expect(changes.destroyed).to.deep.equal([]);
        });
    });
});
