/* eslint no-unused-expressions: 0 */
'use strict';

// lib/schemas/jscalendar.js: JSCalendar Event validation (draft-ietf-calext-jscalendarbis-22 with the
// JMAP Calendars additions). The valid events follow the examples of bis section 5, completed with the
// mandatory properties.

const { expect } = require('chai');
const jscalendar = require('../../../lib/schemas/jscalendar');

const { validateEvent, validateAlert, overrideProblems } = jscalendar;

const BASE = Object.freeze({
    '@type': 'Event',
    version: '2.0',
    uid: 'a8df6573-0474-496d-8496-033ad45d7fea',
    updated: '2020-01-02T18:23:04Z'
});
const event = extra => Object.assign({}, BASE, { start: '2020-01-15T13:00:00' }, extra);

function expectValid(value, options = { mandatory: true, stored: true }) {
    const result = validateEvent(value, options);
    expect(result.problems, JSON.stringify(result.problems)).to.deep.equal([]);
    expect(result.valid).to.be.true;
}

function expectInvalid(value, properties, options = {}) {
    const result = validateEvent(value, options);
    expect(result.valid, JSON.stringify(value)).to.be.false;
    expect(result.properties.sort()).to.deep.equal([].concat(properties).sort());
}

describe('JSCalendar validation', () => {
    describe('primitive types', () => {
        it('accepts and refuses UTCDateTime and LocalDateTime values', () => {
            expect(jscalendar.isUTCDateTime('2010-10-10T10:10:10Z')).to.be.true;
            expect(jscalendar.isUTCDateTime('2024-02-29T00:00:00Z')).to.be.true;
            for (const value of [
                '2010-10-10T10:10:10.0Z',
                '2010-10-10T10:10:10.123Z',
                '2010-10-10t10:10:10z',
                '2010-10-10T10:10:10',
                '2023-02-29T00:00:00Z',
                '2010-13-01T00:00:00Z',
                20101010
            ]) {
                expect(jscalendar.isUTCDateTime(value), String(value)).to.be.false;
            }
            expect(jscalendar.isLocalDateTime('2006-01-02T15:04:05')).to.be.true;
            for (const value of ['2006-01-02T15:04:05Z', '2006-01-02 15:04:05', '2006-01-32T00:00:00', '2006-01-02T24:00:00']) {
                expect(jscalendar.isLocalDateTime(value), value).to.be.false;
            }
        });

        it('follows the Duration and SignedDuration grammar', () => {
            for (const value of ['PT1H', 'P1D', 'P1W', 'P1W2D', 'PT1H30M', 'P1DT12H', 'PT0S', 'PT90M']) {
                expect(jscalendar.isDuration(value), value).to.be.true;
            }
            // no years, months or fractions; a time part needs T; "P" alone is empty
            for (const value of ['P', 'PT', 'P1Y', 'P1M', 'P1H', 'PT1.5H', '-PT1H', 'P1DT', 'PT1M1H']) {
                expect(jscalendar.isDuration(value), value).to.be.false;
            }
            for (const value of ['-PT15M', '+P1D', 'PT0S']) {
                expect(jscalendar.isSignedDuration(value), value).to.be.true;
            }
            expect(jscalendar.isSignedDuration('--PT1M')).to.be.false;
        });

        it('accepts IANA time zone names only, in their exact spelling', () => {
            for (const value of ['Europe/Tallinn', 'America/Argentina/Buenos_Aires', 'Etc/UTC', 'UTC', 'Etc/GMT+2', 'US/Pacific', 'EST5EDT']) {
                expect(jscalendar.isTimeZoneId(value), value).to.be.true;
            }
            for (const value of ['Mars/Olympus_Mons', '+02:00', 'EET-2EEST', 'europe/tallinn', 'Europe/TALLINN', '', 'GMT+2', null]) {
                expect(jscalendar.isTimeZoneId(value), String(value)).to.be.false;
            }
        });

        it('checks CSS colors', () => {
            for (const value of ['SteelBlue', 'steelblue', '#01aafF']) {
                expect(jscalendar.isColor(value), value).to.be.true;
            }
            expect(jscalendar.isColor('#0af')).to.be.false;
            expect(jscalendar.isColor('#0af', { short: true })).to.be.true;
            for (const value of ['foo', '#foofoo', '#01aAfFF', '#01aaff80', ['steelblue'], 'transparent']) {
                expect(jscalendar.isColor(value, { short: true }), String(value)).to.be.false;
            }
        });

        it('checks property names: IANA syntax, vendor prefixes, case and reserved names', () => {
            for (const name of ['title', '@type', 'futureProperty', 'example.com:foo', 'example.com:Foo Bar']) {
                expect(jscalendar.validPropertyName(name), name).to.be.true;
            }
            for (const name of ['Title', 'START', 'extra', 'excluded', 'not a name', 'example.com:a/b', 'example.com:a~b', ':noprefix', 'Unknown']) {
                expect(jscalendar.validPropertyName(name), name).to.be.false;
            }
        });
    });

    describe('valid events', () => {
        it('accepts a simple event (bis 5.1)', () => {
            expectValid(event({ title: 'Some event', timeZone: 'America/New_York', duration: 'PT1H' }));
        });

        it('accepts an all-day yearly event (bis 5.4)', () => {
            expectValid(
                event({
                    title: "April Fool's Day",
                    showWithoutTime: true,
                    start: '1900-04-01T00:00:00',
                    duration: 'P1D',
                    recurrenceRule: { frequency: 'yearly' }
                })
            );
        });

        it('accepts an event with an end time zone and a main location (bis 5.6)', () => {
            expectValid(
                event({
                    title: 'Flight XY51 to Tokyo',
                    start: '2020-04-01T09:00:00',
                    timeZone: 'Europe/Berlin',
                    endTimeZone: 'Asia/Tokyo',
                    duration: 'PT10H30M',
                    mainLocationId: '1',
                    locations: { 1: { name: 'Frankfurt Airport (FRA)' }, 2: { name: 'Narita International Airport (NRT)' } }
                })
            );
        });

        it('accepts physical and virtual locations (bis 5.8)', () => {
            expectValid(
                event({
                    locale: 'en',
                    timeZone: 'America/New_York',
                    locations: {
                        venue: { name: 'The Music Bowl', coordinates: 'geo:40.7829,-73.9654' },
                        parking: { name: 'Parking', coordinates: 'geo:40.7637,-73.9748', locationTypes: { parking: true } }
                    },
                    virtualLocations: { vloc1: { name: 'Stream', uri: 'https://stream.example.com/the_band_2020', features: { video: true } } }
                })
            );
        });

        it('accepts a recurring event with overrides and an exclusion (bis 5.9)', () => {
            expectValid(
                event({
                    title: 'Calculus I',
                    start: '2020-01-08T09:00:00',
                    timeZone: 'Europe/London',
                    duration: 'PT1H30M',
                    recurrenceRule: { frequency: 'weekly', until: '2020-06-24T09:00:00' },
                    recurrenceOverrides: {
                        '2020-01-07T14:00:00': { title: 'Introduction to Calculus I (optional)' },
                        '2020-04-01T09:00:00': { excluded: true },
                        '2020-06-24T09:00:00': { title: 'Exam', start: '2020-06-24T10:00:00', duration: 'PT2H', locations: { a: { name: 'Big Auditorium' } } }
                    }
                })
            );
        });

        it('accepts related events of a split series (bis 5.10)', () => {
            expectValid(event({ relatedTo: { '32859916-af7a-4599-82ed-32a4315b4fe7': { relation: { next: true } } } }));
        });

        it('accepts participants with an organizer, and a participant override (bis 5.11)', () => {
            expectValid(
                event({
                    timeZone: 'Africa/Johannesburg',
                    recurrenceRule: { frequency: 'weekly' },
                    organizerCalendarAddress: 'mailto:f245f875@schedule.example.com',
                    participants: {
                        tom: {
                            name: 'Tom Tool',
                            email: 'tom@foobar.example.com',
                            calendarAddress: 'mailto:tom@calendar.example.com',
                            participationStatus: 'accepted'
                        },
                        zoe: {
                            name: 'Zoe',
                            calendarAddress: 'mailto:zoe@foobar.example.com',
                            participationStatus: 'accepted',
                            roles: { owner: true, chair: true }
                        }
                    },
                    recurrenceOverrides: { '2020-03-04T09:00:00': { 'participants/tom/participationStatus': 'declined' } }
                })
            );
        });

        it('preserves unknown and vendor-specific properties and values', () => {
            expectValid(event({ futureProperty: { anything: [1, 2] }, 'example.com:foo': { bar: 'baz' }, status: 'example.com:postponed' }));
        });

        it('accepts the JMAP CalendarEvent properties and attachments by blob id', () => {
            expectValid(
                event({
                    id: 'V0123',
                    calendarIds: { K1: true },
                    isDraft: false,
                    useDefaultAlerts: true,
                    mayInviteSelf: true,
                    hideAttendees: false,
                    links: { a: { blobId: 'Bu0123', rel: 'enclosure', contentType: 'application/pdf', size: 42 } },
                    alerts: {
                        a1: { trigger: { offset: '-PT15M' } },
                        a2: { '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: '2020-01-15T12:00:00Z' }, action: 'email' },
                        a3: { trigger: { '@type': 'example.com:LocationTrigger', radius: 100 } }
                    },
                    participants: { p: { name: 'No address' } }
                })
            );
        });

        it('does not demand the mandatory properties of a stand alone object unless asked', () => {
            expect(validateEvent({ title: 'partial' }).valid).to.be.true;
            expectInvalid({ title: 'partial' }, ['@type', 'uid', 'updated', 'start'], { mandatory: true });
        });
    });

    describe('invalid events', () => {
        const cases = [
            ['a wrong @type', { '@type': 'Task' }, '@type'],
            ['an invalid start', { start: '2020-02-30T00:00:00' }, 'start'],
            ['a UTC start', { start: '2020-01-15T13:00:00Z' }, 'start'],
            ['a negative duration', { duration: '-PT1H' }, 'duration'],
            ['an unknown time zone', { timeZone: 'Mars/Olympus_Mons' }, 'timeZone'],
            ['endTimeZone without timeZone', { endTimeZone: 'Asia/Tokyo' }, 'endTimeZone'],
            ['a three digit color', { color: '#0af' }, 'color'],
            ['priority out of range', { priority: 10 }, 'priority'],
            ['a non-integer sequence', { sequence: 1.5 }, 'sequence'],
            ['an unknown version', { version: '3.0' }, 'version'],
            ['a property differing only in case', { Title: 'x' }, 'Title'],
            ['the reserved extra property', { extra: {} }, 'extra'],
            ['excluded outside an override', { excluded: true }, 'excluded'],
            ['a keyword set to false', { keywords: { a: false } }, 'keywords'],
            ['a status of the wrong case', { status: 'Confirmed' }, 'status'],
            ['mainLocationId naming no location', { mainLocationId: 'nope' }, 'mainLocationId'],
            ['a main location without a name', { mainLocationId: 'l', locations: { l: { coordinates: 'geo:1,2' } } }, 'mainLocationId'],
            ['a location with only @type', { locations: { l: { '@type': 'Location' } } }, 'locations'],
            ['a location with empty links', { locations: { l: { name: 'x', links: {} } } }, 'locations'],
            ['a virtual location without uri', { virtualLocations: { v: { name: 'x' } } }, 'virtualLocations'],
            ['a link with display but no icon rel', { links: { l: { href: 'https://example.com/a.png', display: { badge: true } } } }, 'links'],
            ['a link without href or blobId', { links: { l: { title: 'x' } } }, 'links'],
            ['a map key that is not an Id', { locations: { 'a b': { name: 'x' } } }, 'locations'],
            ['participant email without calendarAddress', { participants: { p: { email: 'a@example.com' } } }, 'participants'],
            ['participant roles without calendarAddress', { participants: { p: { roles: { owner: true } } } }, 'participants'],
            [
                'empty participant roles',
                { organizerCalendarAddress: 'mailto:o@example.com', participants: { p: { calendarAddress: 'mailto:p@example.com', roles: {} } } },
                'participants'
            ],
            ['participant progress on an event', { participants: { p: { name: 'x', progress: 'completed' } } }, 'participants'],
            ['an addressed participant without organizer', { participants: { p: { calendarAddress: 'mailto:p@example.com' } } }, 'organizerCalendarAddress'],
            ['an organizer without addressed participants', { organizerCalendarAddress: 'mailto:o@example.com' }, 'participants'],
            ['sentBy without organizer', { sentBy: 'a@example.com' }, 'sentBy'],
            ['an alert without trigger', { alerts: { a: { action: 'display' } } }, 'alerts'],
            ['an alert offset that is no duration', { alerts: { a: { trigger: { offset: '15 minutes' } } } }, 'alerts'],
            ['an absolute trigger without when', { alerts: { a: { trigger: { '@type': 'AbsoluteTrigger' } } } }, 'alerts'],
            ['a rule without frequency', { recurrenceRule: { interval: 2 } }, 'recurrenceRule'],
            ['a rule with count and until', { recurrenceRule: { frequency: 'daily', count: 2, until: '2020-02-01T00:00:00' } }, 'recurrenceRule'],
            ['a rule with interval 0', { recurrenceRule: { frequency: 'daily', interval: 0 } }, 'recurrenceRule'],
            ['a rule with nthOfPeriod 0', { recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 0 }] } }, 'recurrenceRule'],
            ['a rule with an uppercase day', { recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'MO' }] } }, 'recurrenceRule'],
            ['a rule with an empty byMonthDay', { recurrenceRule: { frequency: 'monthly', byMonthDay: [] } }, 'recurrenceRule'],
            ['a rule with byMonthDay 0', { recurrenceRule: { frequency: 'monthly', byMonthDay: [0] } }, 'recurrenceRule'],
            ['a Gregorian leap month', { recurrenceRule: { frequency: 'yearly', byMonth: ['3L'] } }, 'recurrenceRule'],
            ['an unknown rscale', { recurrenceRule: { frequency: 'yearly', rscale: 'martian' } }, 'recurrenceRule'],
            ['a skip value of the wrong case', { recurrenceRule: { frequency: 'monthly', skip: 'Forward' } }, 'recurrenceRule'],
            ['an hour of 24', { recurrenceRule: { frequency: 'daily', byHour: [24] } }, 'recurrenceRule'],
            ['an occurrence with a rule', { recurrenceId: '2020-01-15T13:00:00', recurrenceRule: { frequency: 'daily' } }, 'recurrenceId'],
            ['recurrenceIdTimeZone without recurrenceId', { recurrenceIdTimeZone: 'Europe/London' }, 'recurrenceIdTimeZone'],
            ['an override key that is not a LocalDateTime', { recurrenceOverrides: { tomorrow: {} } }, 'recurrenceOverrides'],
            ['an exclusion with more members', { recurrenceOverrides: { '2020-01-16T13:00:00': { excluded: true, title: 'x' } } }, 'recurrenceOverrides'],
            ['an override of the uid', { recurrenceOverrides: { '2020-01-16T13:00:00': { uid: 'other' } } }, 'recurrenceOverrides'],
            ['an override of the rule', { recurrenceOverrides: { '2020-01-16T13:00:00': { 'recurrenceRule/interval': 2 } } }, 'recurrenceOverrides'],
            ['an override of isDraft', { recurrenceOverrides: { '2020-01-16T13:00:00': { isDraft: true } } }, 'recurrenceOverrides'],
            [
                'an override of a participant address',
                { recurrenceOverrides: { '2020-01-16T13:00:00': { 'participants/p/calendarAddress': 'mailto:x@example.com' } } },
                'recurrenceOverrides'
            ],
            ['overlapping override pointers', { recurrenceOverrides: { '2020-01-16T13:00:00': { alerts: {}, 'alerts/a': null } } }, 'recurrenceOverrides'],
            ['a non-boolean calendarIds value', { calendarIds: { K1: 1 } }, 'calendarIds'],
            ['an iTIP method on a stored event', { method: 'request' }, 'method']
        ];
        for (const [title, extra, property] of cases) {
            it(`refuses ${title}`, () => expectInvalid(event(extra), [property], { stored: true }));
        }

        it('names every offending top level property once', () => {
            expectInvalid(event({ start: 'x', color: 'nope', participants: { a: { email: 'x@example.com' }, b: { kind: 'individual' } } }), [
                'start',
                'color',
                'participants'
            ]);
        });

        it('refuses values that are not objects', () => {
            for (const value of [null, [], 'event', 1]) {
                expect(validateEvent(value).valid).to.be.false;
            }
        });
    });

    describe('alerts', () => {
        it('validates an Alert and can refuse an AbsoluteTrigger', () => {
            expect(validateAlert({ trigger: { offset: '-PT10M', relativeTo: 'end' } }).valid).to.be.true;
            expect(validateAlert({ '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: 'PT9H' }, acknowledged: '2020-01-01T00:00:00Z' }).valid).to.be
                .true;
            const absolute = { trigger: { '@type': 'AbsoluteTrigger', when: '2030-01-01T00:00:00Z' } };
            expect(validateAlert(absolute).valid).to.be.true;
            expect(validateAlert(absolute, { absolute: false }).valid).to.be.false;
            for (const invalid of [
                {},
                { trigger: {} },
                { trigger: { offset: '-PT10M', relativeTo: 'middle' } },
                { trigger: { offset: '-PT10M' }, action: 'Display' },
                null
            ]) {
                expect(validateAlert(invalid).valid, JSON.stringify(invalid)).to.be.false;
            }
        });
    });

    describe('override patches', () => {
        it('accepts patches and exclusions, refuses forbidden pointers', () => {
            expect(overrideProblems({})).to.deep.equal([]);
            expect(overrideProblems({ excluded: true })).to.deep.equal([]);
            expect(overrideProblems({ title: 'x', 'alerts/a/trigger/offset': '-PT5M' })).to.deep.equal([]);
            expect(overrideProblems({ excluded: false })).to.have.length(1);
            expect(overrideProblems({ privacy: 'private' })).to.have.length(1);
            expect(overrideProblems({ 'participants/x/calendarAddress': 'mailto:a@b.example' })).to.have.length(1);
            expect(overrideProblems({ 'participants/x/name': 'Name' })).to.deep.equal([]);
            expect(overrideProblems({ 'alerts/-': {} })).to.have.length(1);
            expect(overrideProblems([])).to.have.length(1);
        });
    });
});
