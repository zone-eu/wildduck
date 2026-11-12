/* eslint no-unused-expressions: 0 */
'use strict';

// lib/calendar/recurrence.js: edge cases found by the mutation run of the JMAP core modules
// (docs/jmap/mutation.md), kept apart from recurrence-test.js.

const { expect } = require('chai');
const { utcToLocal, formatDuration, addDuration, expandEvent, RecurrenceLimitError } = require('../../../lib/calendar/recurrence');

const event = (start, rule, extra) => Object.assign({ '@type': 'Event', start, recurrenceRule: Object.assign({ '@type': 'RecurrenceRule' }, rule) }, extra);
const starts = (ev, options) => expandEvent(ev, options || {}).instances.map(instance => instance.start);

describe('JMAP recurrence edge cases', () => {
    it('names the limit error, with a message of its own when given', () => {
        const plain = new RecurrenceLimitError();
        expect(plain.message).to.equal('Too many occurrences to calculate');
        expect(plain.code).to.equal('cannotCalculateOccurrences');
        expect(new RecurrenceLimitError('too many').message).to.equal('too many');
    });

    it('formats local times from year 0 to 9999 only', () => {
        expect(utcToLocal(Date.parse('0000-06-01T12:00:00Z'))).to.equal('0000-06-01T12:00:00');
        expect(utcToLocal(Date.parse('9999-06-01T12:00:00Z'))).to.equal('9999-06-01T12:00:00');
        expect(() => utcToLocal(Date.parse('+010000-06-01T12:00:00Z'))).to.throw(RangeError);
        expect(() => utcToLocal(Date.parse('-000001-06-01T12:00:00Z'))).to.throw(RangeError);
    });

    it('reads years before the common era in a time zone', () => {
        // the zone formatter answers 1 BC for year 0
        expect(utcToLocal(Date.parse('0000-06-01T12:00:00Z'), 'Europe/Berlin').slice(0, 13)).to.equal('0000-06-01T12');
    });

    it('formats only finite non negative numbers of seconds', () => {
        for (const value of ['5', Infinity, NaN, -1]) {
            expect(() => formatDuration(value), String(value)).to.throw(TypeError);
        }
        expect(formatDuration(5)).to.equal('PT5S');
    });

    it('adds a duration given as days and seconds', () => {
        expect(addDuration('2024-01-01T00:00:00', { days: 1 })).to.equal(Date.parse('2024-01-02T00:00:00Z'));
        expect(addDuration('2024-01-01T00:00:00', { days: 1, seconds: 60 })).to.equal(Date.parse('2024-01-02T00:01:00Z'));
        expect(addDuration('2024-01-01T00:00:00', {})).to.equal(Date.parse('2024-01-01T00:00:00Z'));
    });

    it('treats an empty by-list like a missing one', () => {
        const ev = event('2024-01-01T10:00:00', { frequency: 'daily', count: 3, bySecond: [], byHour: [] });
        expect(starts(ev)).to.deep.equal(['2024-01-01T10:00:00', '2024-01-02T10:00:00', '2024-01-03T10:00:00']);
    });

    it('uses the default limits for limits that are not positive integers', () => {
        const ev = event('2024-01-01T10:00:00', { frequency: 'daily', count: 3 });
        for (const maxInstances of [0, -1, 1.5]) {
            expect(starts(ev, { maxInstances }), String(maxInstances)).to.have.length(3);
        }
    });

    it('uses an interval of one for an interval that is not a positive integer', () => {
        for (const interval of [0, -1, 1.5]) {
            const ev = event('2024-01-01T10:00:00', { frequency: 'daily', count: 3, interval });
            expect(starts(ev), String(interval)).to.deep.equal(['2024-01-01T10:00:00', '2024-01-02T10:00:00', '2024-01-03T10:00:00']);
        }
    });

    it('applies skip to a monthly byMonthDay with an explicit interval of one', () => {
        const ev = event('2025-01-31T09:00:00', { frequency: 'monthly', interval: 1, byMonthDay: [31], skip: 'backward', count: 3 });
        expect(starts(ev)).to.deep.equal(['2025-01-31T09:00:00', '2025-02-28T09:00:00', '2025-03-31T09:00:00']);
    });

    it('allows exactly the number of chunks the iteration limit gives', () => {
        // a yearly rule needs one library call per chunk of 10 days with these limits; 16 chunks are allowed
        const ev = event('2024-01-01T00:00:00', { frequency: 'yearly' });
        const options = to => ({ from: Date.parse('2024-02-01T00:00:00Z'), to, maxIterations: 20, maxInstances: 10 });
        const fits = Date.parse('2024-02-01T00:00:00Z') + 150 * 24 * 3600 * 1000 - 2 * 3600 * 1000;
        expect(starts(ev, options(fits))).to.deep.equal([]);
        expect(() => expandEvent(ev, options(fits + 10 * 24 * 3600 * 1000))).to.throw(RecurrenceLimitError);
    });

    it('takes null recurrence overrides as none', () => {
        const ev = { '@type': 'Event', start: '2024-01-01T10:00:00', duration: 'PT1H', recurrenceOverrides: null };
        expect(expandEvent(ev)).to.deep.include({ complete: true });
        expect(starts(ev)).to.deep.equal(['2024-01-01T10:00:00']);
    });

    it('expands overrides without a rule as the start and the added instances', () => {
        const ev = {
            '@type': 'Event',
            start: '2024-01-01T10:00:00',
            duration: 'PT1H',
            recurrenceOverrides: { '2024-01-05T10:00:00': {}, '2024-01-07T10:00:00': null }
        };
        const { instances, complete } = expandEvent(ev);
        expect(complete).to.be.true;
        expect(instances.map(instance => instance.start)).to.deep.equal(['2024-01-01T10:00:00', '2024-01-05T10:00:00', '2024-01-07T10:00:00']);
        // an override that is not a patch object adds the instance with an empty patch
        expect(instances[2].patch).to.deep.equal({});
    });

    it('orders instances at the same time by recurrence id', () => {
        const ev = event(
            '2024-01-01T10:00:00',
            { frequency: 'daily', count: 3 },
            { duration: 'PT1H', recurrenceOverrides: { '2024-01-01T10:00:00': { start: '2024-01-02T10:00:00' } } }
        );
        const { instances, complete } = expandEvent(ev);
        expect(complete).to.be.true;
        expect(instances.map(instance => [instance.recurrenceId, instance.start])).to.deep.equal([
            ['2024-01-01T10:00:00', '2024-01-02T10:00:00'],
            ['2024-01-02T10:00:00', '2024-01-02T10:00:00'],
            ['2024-01-03T10:00:00', '2024-01-03T10:00:00']
        ]);
    });

    it('orders an override moved onto a generated instance after it when its recurrence id is later', () => {
        const ev = event(
            '2024-01-01T10:00:00',
            { frequency: 'daily', count: 3 },
            { duration: 'PT1H', recurrenceOverrides: { '2024-01-03T10:00:00': { start: '2024-01-02T10:00:00' } } }
        );
        expect(expandEvent(ev).instances.map(instance => instance.recurrenceId)).to.deep.equal([
            '2024-01-01T10:00:00',
            '2024-01-02T10:00:00',
            '2024-01-03T10:00:00'
        ]);
    });

    it('counts overrides towards maxInstances', () => {
        const ev = event('2024-01-01T10:00:00', { frequency: 'daily', count: 1 }, { recurrenceOverrides: { '2024-01-05T10:00:00': {} } });
        expect(starts(ev, { maxInstances: 2 })).to.have.length(2);
        expect(() => expandEvent(ev, { maxInstances: 1 })).to.throw(RecurrenceLimitError);
    });
});
