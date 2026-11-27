'use strict';

const { expect } = require('chai');
const model = require('../../../lib/jmap/calendar-event-model');
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

// the quadratic filter problemsOf used before NV-22, the reference for the output
const quadratic = paths => {
    const unique = [...new Set(paths)];
    return unique.filter(path => !unique.some(other => other.startsWith(`${path}/`)));
};

describe('CalendarEvent invalid property paths (NV-22)', () => {
    it('leaves out ancestors like the quadratic filter', () => {
        for (const paths of [
            [],
            ['start'],
            ['alerts', 'alerts/a1', 'alerts/a1/trigger/offset', 'start', 'start'],
            ['recurrenceOverrides/2026-01-12T09:00:00', 'recurrenceOverrides/2026-01-12T09:00:00/duration', 'recurrenceOverrides'],
            ['alerts/a1/trigger', 'alerts/a10', 'alerts/a1x/trigger', 'alerts/a1'],
            ['a/b', 'a', 'a/b/c', 'ab', 'a~1b', 'a~1b/c']
        ]) {
            expect(model.withoutAncestors(paths), JSON.stringify(paths)).to.deep.equal(quadratic(paths));
        }
    });

    it('names 100,000 unknown properties in linear time', () => {
        const event = Object.assign({}, WEEKLY);
        for (let i = 0; i < 100000; i++) {
            event[`x${i}`] = 1;
        }
        const started = Date.now();
        const problems = model.problemsOf(event, Object.assign({}, DEFAULT_LIMITS));
        expect(Date.now() - started).to.be.below(200);
        expect(problems).to.have.length(100000);
        expect(problems[0]).to.equal('x0');
    });
});
