/* eslint no-unused-expressions: 0 */
'use strict';

// Pure parts of the CalendarEvent implementation: the object model (lib/jmap/calendar-event-model.js),
// the stored search text (lib/calendar/events.js), string filter matching (calendar-event-query.js)
// and alert triggers (lib/calendar/alerts.js).

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const model = require('../../../lib/jmap/calendar-event-model');
const { searchOf, blobsOf, linkEntries } = require('../../../lib/calendar/events');
const { parseText, textMatches } = require('../../../lib/jmap/types/calendar-event-query');
const alerts = require('../../../lib/calendar/alerts');
const { DEFAULT_LIMITS } = require('../../../lib/calendar-handler');

const WEEKLY = {
    '@type': 'Event',
    version: '2.0',
    uid: 'u',
    title: 'Standup',
    start: '2026-01-05T09:00:00',
    timeZone: 'Europe/Tallinn',
    duration: 'PT1H',
    recurrenceRule: { frequency: 'weekly' }
};
const alert = (offset, extra = {}) => Object.assign({ '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset } }, extra);

describe('CalendarEvent model', () => {
    describe('ids', () => {
        it('encodes and parses instance ids', () => {
            const base = new ObjectId();
            const id = model.instanceId(base, '2026-01-12T09:00:00');
            expect(id).to.equal(`V${base}_20260112T090000`);
            expect(id).to.match(/^[A-Za-z][A-Za-z0-9_-]*$/);
            const parsed = model.parseEventId(id);
            expect(parsed.id.equals(base)).to.be.true;
            expect(parsed.recurrenceId).to.equal('2026-01-12T09:00:00');
            expect(model.parseEventId(`V${base}`).recurrenceId).to.equal(null);
        });

        it('rejects ids that name no event or an impossible date', () => {
            const base = new ObjectId();
            for (const value of ['Zmissing', `K${base}`, `V${base}_20260230T090000`, `V${base}_2026011209`, null, 5]) {
                expect(model.parseEventId(value), String(value)).to.equal(null);
            }
        });
    });

    describe('override patches', () => {
        it('applies pointers leniently, skipping missing parents', () => {
            const result = model.applyOverride(
                { title: 'A', participants: { tom: { name: 'Tom' } } },
                { title: 'B', 'participants/tom/name': 'T', 'participants/zoe/name': 'Z', 'locations/x': null }
            );
            expect(result).to.deep.equal({ title: 'B', participants: { tom: { name: 'T' } } });
        });

        it('removes keys with null and keeps the input unchanged', () => {
            const input = { participants: { tom: { name: 'Tom' }, zoe: { name: 'Zoe' } } };
            expect(model.applyOverride(input, { 'participants/tom': null })).to.deep.equal({ participants: { zoe: { name: 'Zoe' } } });
            expect(input.participants).to.have.property('tom');
        });

        it('diffs to minimal pointers with escaped tokens', () => {
            const base = { title: 'A', participants: { 'a/b': { status: 'x' }, zoe: { status: 'y' } }, keywords: { k: true } };
            const target = { title: 'A', participants: { 'a/b': { status: 'z' } }, keywords: { k: true }, color: 'red' };
            expect(model.diffPatch(base, target)).to.deep.equal({ 'participants/a~1b/status': 'z', 'participants/zoe': null, color: 'red' });
            expect(model.diffPatch(base, base)).to.deep.equal({});
        });

        it('diff and apply round trip', () => {
            const base = { title: 'A', alerts: { a1: alert('-PT5M') }, locations: { l: { name: 'X' } } };
            const target = { title: 'B', alerts: { a1: alert('-PT1H', { acknowledged: '2026-01-01T00:00:00Z' }) }, locations: {} };
            expect(model.applyOverride(base, model.diffPatch(base, target))).to.deep.equal(target);
        });

        it('drops the pointers RFC 8984 tells the server to ignore', () => {
            expect(model.stripIgnored({ uid: 'x', privacy: 'secret', recurrenceRule: null, title: 'Kept', 'relatedTo/a': {} })).to.deep.equal({
                title: 'Kept'
            });
            expect(model.stripIgnored({ excluded: true })).to.deep.equal({ excluded: true });
        });
    });

    describe('instances', () => {
        it('builds an instance with its override and recurrence id', () => {
            const event = Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': { title: 'Special', start: '2026-01-12T11:00:00' } } });
            const instance = model.instanceOf(event, '2026-01-12T09:00:00');
            expect(instance).to.include({
                title: 'Special',
                start: '2026-01-12T11:00:00',
                recurrenceId: '2026-01-12T09:00:00',
                recurrenceIdTimeZone: 'Europe/Tallinn'
            });
            expect(instance).to.not.have.property('recurrenceRule');
            expect(instance).to.not.have.property('recurrenceOverrides');
        });

        it('classifies recurrence ids', () => {
            const event = Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-19T09:00:00': { excluded: true }, '2026-01-21T15:00:00': {} } });
            expect(model.occurrenceOf(event, '2026-01-12T09:00:00')).to.equal('rule');
            expect(model.occurrenceOf(event, '2026-01-19T09:00:00')).to.equal('excluded');
            expect(model.occurrenceOf(event, '2026-01-21T15:00:00')).to.equal('added');
            expect(model.occurrenceOf(event, '2026-01-13T09:00:00')).to.equal(null);
            expect(model.occurrenceOf({ start: '2026-01-05T09:00:00' }, '2026-01-05T09:00:00')).to.equal(null);
        });

        it('computes UTC times, floating events in the given zone', () => {
            expect(model.utcTimes({ start: '2026-03-10T12:00:00', timeZone: 'Europe/Tallinn', duration: 'PT1H' })).to.deep.equal({
                utcStart: '2026-03-10T10:00:00Z',
                utcEnd: '2026-03-10T11:00:00Z'
            });
            expect(model.utcTimes({ start: '2026-07-01T09:00:00', duration: 'PT30M' }, 'Asia/Tokyo')).to.deep.equal({
                utcStart: '2026-07-01T00:00:00Z',
                utcEnd: '2026-07-01T00:30:00Z'
            });
        });
    });

    describe('origin and participants', () => {
        const addresses = new Set(['alice@example.com', 'al@example.com']);

        it('derives isOrigin from the organizer address', () => {
            expect(model.isOriginOf({}, addresses)).to.be.true;
            expect(model.isOriginOf({ organizerCalendarAddress: 'MAILTO:Alice@EXAMPLE.com' }, addresses)).to.be.true;
            expect(model.isOriginOf({ organizerCalendarAddress: 'mailto:al%40example.com' }, addresses)).to.be.true;
            expect(model.isOriginOf({ organizerCalendarAddress: 'mailto:carol@remote.example' }, addresses)).to.be.false;
            expect(model.isOriginOf({ organizerCalendarAddress: 'https://example.com/alice' }, addresses)).to.be.false;
        });

        it('reduces participants to owners and the user, also in overrides', () => {
            const object = {
                participants: {
                    carol: { calendarAddress: 'mailto:carol@remote.example', roles: { owner: true } },
                    alice: { calendarAddress: 'mailto:alice@example.com' },
                    bob: { calendarAddress: 'mailto:bob@example.net' }
                },
                recurrenceOverrides: { '2026-01-12T09:00:00': { 'participants/bob/participationStatus': 'declined', title: 'X' } }
            };
            model.reduceParticipants(object, addresses);
            expect(Object.keys(object.participants)).to.deep.equal(['carol', 'alice']);
            expect(object.recurrenceOverrides['2026-01-12T09:00:00']).to.deep.equal({ title: 'X' });
        });
    });

    describe('validation for storing', () => {
        const limits = Object.assign({}, DEFAULT_LIMITS);

        it('accepts a valid event', () => {
            expect(model.problemsOf(WEEKLY, limits)).to.deep.equal([]);
        });

        it('names unknown, non vendor properties and keeps vendor ones', () => {
            expect(model.problemsOf(Object.assign({ colour: 'red' }, WEEKLY), limits)).to.deep.equal(['colour']);
            expect(model.problemsOf(Object.assign({ 'example.com:mood': 'sunny' }, WEEKLY), limits)).to.deep.equal([]);
        });

        it('names nested problems by path and drops the shallower duplicates', () => {
            const problems = model.problemsOf(
                Object.assign({}, WEEKLY, { alerts: { a1: alert('x') }, recurrenceOverrides: { '2026-01-12T09:00:00': { duration: 'y' } } }),
                limits
            );
            expect(problems.sort()).to.deep.equal(['alerts/a1/trigger/offset', 'recurrenceOverrides/2026-01-12T09:00:00/duration']);
        });

        it('rejects override pointers the draft forbids, other calendar systems and dates out of range', () => {
            expect(model.problemsOf(Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': { isDraft: true } } }), limits)).to.deep.equal([
                'recurrenceOverrides/2026-01-12T09:00:00'
            ]);
            expect(model.problemsOf(Object.assign({}, WEEKLY, { recurrenceRule: { frequency: 'yearly', rscale: 'hebrew' } }), limits)).to.deep.equal([
                'recurrenceRule/rscale'
            ]);
            expect(model.problemsOf(Object.assign({}, WEEKLY, { start: '1899-12-31T00:00:00' }), limits)).to.deep.equal(['start']);
        });

        it('limits participants', () => {
            const participants = Object.fromEntries(
                Array.from({ length: 3 }, (value, i) => [`p${i}`, { '@type': 'Participant', calendarAddress: `mailto:p${i}@example.com` }])
            );
            const event = Object.assign({}, WEEKLY, { organizerCalendarAddress: 'mailto:p0@example.com', participants });
            expect(model.problemsOf(event, Object.assign({}, limits, { maxParticipantsPerEvent: 2 }))).to.deep.equal(['participants']);
            expect(model.problemsOf(event, Object.assign({}, limits, { maxParticipantsPerEvent: 3 }))).to.deep.equal([]);
        });

        it('tells shared changes from per user ones', () => {
            expect(model.sharedChange(WEEKLY, Object.assign({}, WEEKLY, { title: 'New' }))).to.be.true;
            for (const extra of [
                { keywords: { x: true } },
                { color: 'red' },
                { alerts: {} },
                { useDefaultAlerts: true },
                { updated: '2026-01-01T00:00:00Z' }
            ]) {
                expect(model.sharedChange(WEEKLY, Object.assign({}, WEEKLY, extra)), JSON.stringify(extra)).to.be.false;
            }
            const overridden = Object.assign({}, WEEKLY, {
                recurrenceOverrides: { '2026-01-12T09:00:00': { 'alerts/a1/acknowledged': '2026-01-12T06:00:00Z' } }
            });
            expect(model.sharedChange(Object.assign({}, WEEKLY, { recurrenceOverrides: { '2026-01-12T09:00:00': {} } }), overridden)).to.be.false;
        });
    });
});

describe('CalendarEvent search text', () => {
    it('collects lower case text of the base event and the overrides', () => {
        const search = searchOf({
            title: 'Standup',
            description: 'Daily',
            locations: { l: { name: 'Room' } },
            participants: { o: { name: 'Owner', email: 'o@example.com', roles: { owner: true } }, a: { name: 'Attendee' } },
            recurrenceOverrides: { '2026-01-12T09:00:00': { title: 'Retro', 'locations/l9': { name: 'Roof' }, 'participants/a/name': 'Renamed' } }
        });
        expect(search.title).to.equal('standup\nretro');
        expect(search.description).to.equal('daily');
        expect(search.location).to.equal('room\nroof');
        expect(search.participant).to.include('owner').and.include('o@example.com').and.include('attendee').and.include('renamed');
        expect(search.owner).to.include('owner').and.not.include('attendee');
    });

    it('finds the uploads links name', () => {
        const file = new ObjectId();
        const blobs = blobsOf({
            links: { a: { blobId: `Bu${file}` }, b: { href: 'https://example.com' } },
            locations: { l: { links: { c: { blobId: 'Bm123' } } } }
        });
        expect(blobs.map(id => id.toString())).to.deep.equal([file.toString()]);
    });

    it('finds the uploads the links of overrides name, in every patch form (R-2)', () => {
        const files = Array.from({ length: 6 }, () => new ObjectId());
        const link = file => ({ blobId: `Bu${file}` });
        const event = {
            recurrenceOverrides: {
                '2026-01-12T09:00:00': { links: { a: link(files[0]) } },
                '2026-01-19T09:00:00': { 'links/b': link(files[1]), 'participants/p/links/c': link(files[2]) },
                '2026-01-26T09:00:00': { 'locations/l~1x': { links: { d: link(files[3]) } }, 'links/e/blobId': `Bu${files[4]}` },
                '2026-02-02T09:00:00': { participants: { p: { links: { f: link(files[5]) } } }, 'links/g/href': 'https://example.com' }
            }
        };
        expect(blobsOf(event).map(id => id.toString())).to.have.members(files.map(id => id.toString()));
        const entries = linkEntries(event);
        const leaf = entries.find(entry => entry.leaf);
        expect(leaf.leaf).to.equal('recurrenceOverrides/2026-01-26T09:00:00/links~1e~1blobId');
        leaf.link.blobId = 'Bu000000000000000000000000';
        expect(event.recurrenceOverrides['2026-01-26T09:00:00']['links/e/blobId']).to.equal('Bu000000000000000000000000');
        expect(entries.find(entry => entry.link === event.recurrenceOverrides['2026-01-19T09:00:00']['links/b']).path).to.equal(
            'recurrenceOverrides/2026-01-19T09:00:00/links~1b'
        );
    });

    it('matches tokens, plural endings and quoted phrases', () => {
        expect(textMatches('big red bus', parseText('"big red"'))).to.be.true;
        expect(textMatches('red big buses', parseText('"big red"'))).to.be.false;
        expect(textMatches('red big buses', parseText('red big'))).to.be.true;
        expect(textMatches('red big buses', parseText('bus'))).to.be.true;
        expect(textMatches('business', parseText('bus'))).to.be.false;
        expect(textMatches('Carol King <carol@example.net>', parseText('carol@example.net'))).to.be.true;
    });
});

describe('Calendar alert triggers', () => {
    const T = Date.parse('2027-06-01T09:00:00Z');
    const at = { start: '2027-06-01T09:00:00', timeZone: 'Etc/UTC', duration: 'PT1H' };

    it('computes offset triggers relative to start and end', () => {
        const event = Object.assign({}, at, {
            alerts: {
                s: alert('-PT5M'),
                e: { '@type': 'Alert', trigger: { offset: 'PT0S', relativeTo: 'end' } },
                geo: { trigger: { '@type': 'example.com:Geo' } }
            }
        });
        const triggers = alerts.triggersBetween(event, [], T - 3600000, T + 7200000);
        expect(triggers.map(trigger => [trigger.alertId, trigger.at])).to.deep.equal([
            ['s', T - 300000],
            ['e', T + 3600000]
        ]);
    });

    it('skips acknowledged alerts and drafts', () => {
        const event = Object.assign({}, at, { alerts: { a: alert('PT0S', { acknowledged: '2027-06-01T09:00:00Z' }) } });
        expect(alerts.triggersBetween(event, [], T - 1000, T + 1000)).to.deep.equal([]);
        expect(alerts.triggersBetween(Object.assign({}, at, { isDraft: true, alerts: { a: alert('PT0S') } }), [], T - 1000, T + 1000)).to.deep.equal([]);
    });

    it('uses the default alerts of subscribed calendars plus snoozes', () => {
        const calendars = [
            { isSubscribed: true, defaultAlertsWithTime: { d1: alert('-PT10M') } },
            { isSubscribed: false, defaultAlertsWithTime: { d2: alert('-PT20M') } }
        ];
        const snooze = {
            '@type': 'Alert',
            trigger: { '@type': 'AbsoluteTrigger', when: '2027-06-01T08:55:00Z' },
            relatedTo: { d1: { relation: { snooze: true } } }
        };
        const event = Object.assign({}, at, { useDefaultAlerts: true, alerts: { own: alert('PT0S'), snz: snooze } });
        const ids = alerts.triggersBetween(event, calendars, T - 3600000, T + 3600000).map(trigger => trigger.alertId);
        expect(ids).to.deep.equal(['d1', 'snz']);
    });

    it('fires once per occurrence and reads floating events in the calendar zone', () => {
        const event = { start: '2027-06-01T09:00:00', duration: 'PT1H', recurrenceRule: { frequency: 'daily', count: 3 }, alerts: { a: alert('PT0S') } };
        const triggers = alerts.triggersBetween(event, [{ timeZone: 'Asia/Tokyo' }], T - 86400000, T + 5 * 86400000);
        expect(triggers.map(trigger => [trigger.recurrenceId, new Date(trigger.at).toISOString()])).to.deep.equal([
            ['2027-06-01T09:00:00', '2027-06-01T00:00:00.000Z'],
            ['2027-06-02T09:00:00', '2027-06-02T00:00:00.000Z'],
            ['2027-06-03T09:00:00', '2027-06-03T00:00:00.000Z']
        ]);
    });

    it('finds the next trigger of a dense rule far ahead', () => {
        const event = {
            start: '2027-06-01T09:00:00',
            timeZone: 'Etc/UTC',
            duration: 'PT30S',
            recurrenceRule: { frequency: 'minutely' },
            alerts: { a: alert('PT0S') }
        };
        expect(alerts.nextTrigger(event, [], Date.parse('2026-11-12T00:00:00Z'))).to.equal(T);
        expect(alerts.nextTrigger(event, [], T)).to.equal(T + 60000);
        expect(alerts.nextTrigger(Object.assign({}, event, { alerts: {} }), [], T)).to.equal(null);
    });

    it('finds the next trigger of a dense rule with far apart offsets without a wide expansion', () => {
        const event = {
            start: '2027-01-01T00:00:00',
            timeZone: 'Europe/Tallinn',
            duration: 'PT1M',
            recurrenceRule: { frequency: 'minutely' },
            alerts: { week: alert('-P7D'), start: alert('PT0S'), late: { '@type': 'Alert', trigger: { offset: 'P30D', relativeTo: 'end' } } }
        };
        const started = Date.now();
        expect(alerts.nextTrigger(event, [], T)).to.equal(T + 60000);
        expect(alerts.nextTrigger(Object.assign({}, event, { alerts: { week: alert('-P7D') } }), [], T)).to.equal(T + 60000);
        // the triggers of every offset in a short window, each from a narrow expansion
        const triggers = alerts.triggersBetween(event, [], T, T + 60000);
        expect(triggers.map(trigger => trigger.alertId).sort()).to.deep.equal(['late', 'start', 'week']);
        expect(Date.now() - started).to.be.below(2000);
    });

    it('settles for a time to look again when a dense rule has no occurrence near', () => {
        // February 30 never comes: a minutely rule is searched a bounded stretch ahead
        const event = Object.assign({}, at, { recurrenceRule: { frequency: 'minutely', byMonth: ['2'], byMonthDay: [30] }, alerts: { a: alert('-PT5M') } });
        const next = alerts.nextTrigger(event, [], T);
        expect(next).to.be.above(T + 3600000);
        expect(alerts.triggersBetween(event, [], T, next)).to.deep.equal([]);
    });

    it('bounds the search when no trigger comes for a long time', () => {
        const acked = (offset, extra) => Object.assign(alert(offset), { acknowledged: '2199-12-31T00:00:00Z' }, extra);
        const base = { start: '2026-11-12T00:00:00', duration: 'PT1S', recurrenceRule: { frequency: 'secondly' } };
        const now = Date.parse('2026-11-12T00:00:00Z');
        // all acknowledged: the search starts at the acknowledgement
        const event = Object.assign({}, base, { alerts: { a: acked('PT0S') } });
        expect(alerts.nextTrigger(event, [], now)).to.equal(Date.parse('2199-12-31T00:00:01Z'));
        // an override hides that, and many far apart offsets: a bounded search, then no next look
        const cases = [
            Object.assign({}, event, { recurrenceOverrides: { '2026-11-12T00:00:05': { title: 'x', 'alerts/a/acknowledged': '2199-12-31T00:00:00Z' } } }),
            Object.assign({}, event, {
                recurrenceOverrides: { '2026-11-12T00:00:05': { title: 'x' } },
                useDefaultAlerts: false,
                alerts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a${i}`, acked(`-P${i * 37}D`)]))
            })
        ];
        for (const entry of cases) {
            const started = Date.now();
            const next = alerts.nextTrigger(entry, [], now);
            expect(Date.now() - started).to.be.below(500);
            expect(next === null || next >= now + 3600000).to.equal(true);
        }
    });

    it('answers no trigger for a counted rule that ended', () => {
        const event = Object.assign({}, at, {
            start: '2026-01-01T00:00:00',
            recurrenceRule: { frequency: 'minutely', count: 5000 },
            alerts: { a: alert('-PT5M') }
        });
        expect(alerts.nextTrigger(event, [], T)).to.equal(null);
        expect(alerts.nextTrigger(event, [], Date.parse('2026-01-01T00:00:00Z'))).to.equal(Date.parse('2026-01-01T00:01:00Z'));
    });

    it('spreads users over the jitter window', () => {
        const settings = alerts.settingsOf({ jitter: 30 });
        const offsets = new Set(Array.from({ length: 50 }, () => alerts.jitterOf(new ObjectId(), settings)));
        for (const offset of offsets) {
            expect(offset).to.be.at.least(0).and.below(30000);
        }
        expect(offsets.size).to.be.above(10);
        expect(alerts.jitterOf(new ObjectId(), alerts.settingsOf({ jitter: 0 }))).to.equal(0);
    });
});
