/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Catalogue file calendars.yaml, phase 6: calendar alerts (CALR), lib/calendar/alerts.js.
//
// "Advancing the clock" runs the alert scheduler in this process (alerts.processDue) with a chosen
// time, on the same database and Redis as the test server; its pushes reach the event streams of the
// server through the notifier, Web Push through the jmap_push queue. The scheduler of the server runs
// on the real clock, so the alerts here lie in the future (2027 and later) where it does not reach
// them; each run is limited to the users of the scenario. Jitter is off except in CALR-038.

const { Queue } = require('bullmq');
const { expect } = require('chai');
const { scenario, api, seed, clock, jmap, outbound } = require('../harness');
const sse = require('../harness/sse');
const instance = require('../harness/instance');
const alerts = require('../../../lib/calendar/alerts');
const h = require('./calendar-event-helpers');
const ph = require('./push-subscription-helpers');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const QUIET = 1000;
const T = Date.parse('2027-06-01T09:00:00Z');
const local = ms => new Date(ms).toISOString().slice(0, 19);
const utcDate = ms => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const offsetAlert = (offset, extra = {}) => Object.assign({ '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset } }, extra);
const absoluteAlert = (when, extra = {}) => Object.assign({ '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: utcDate(when) } }, extra);
const atT = (extra = {}) => Object.assign({ title: 'Alerted', start: local(T), timeZone: 'Etc/UTC', duration: 'PT1H' }, extra);

let deps = null;
let queue = null;

/** The scheduler dependencies of this process, built like a JMAP worker builds them */
async function schedulerDeps() {
    if (!deps) {
        const db = await instance.connect();
        deps = require('../../../jmap').createDeps(); // eslint-disable-line global-require
        queue = new Queue('jmap_push', db.queueConf);
        deps.push = { queueAlert: (user, alert) => queue.add('alert', { user: user.toString(), alert }, { removeOnComplete: true, removeOnFail: true }) };
    }
    return deps;
}

/** One scheduler run at `at` for the users of `contexts`; answers the fired triggers */
async function tick(contexts, at, settings = {}) {
    const users = [].concat(contexts).map(ctx => new seed.ObjectId(ctx.user.id));
    return alerts.processDue(await schedulerDeps(), { now: at, user: users, settings: Object.assign({}, alerts.DEFAULTS, { jitter: 0 }, settings) });
}

/** An event stream of the user that collects calendarAlert events */
async function stream(ctx, types = 'CalendarAlert') {
    const es = await sse.open(`/jmap/eventsource/?types=${types}&closeafter=no&ping=0`, { authorization: jmap.basic(ctx.user.username, ctx.user.password) });
    await es.until(() => es.comments[0], 5000, 'stream not connected');
    es.alerts = () => es.named('calendarAlert').map(event => JSON.parse(event.data));
    es.waitAlerts = (count, timeout = 5000) =>
        es.until(() => es.alerts().length >= count && es.alerts(), timeout, `${count} calendarAlert events, got ${es.alerts().length}`);
    return es;
}

/** Waits for `count` alerts and a quiet time after them; answers their alert ids */
async function alertIds(es, count) {
    if (count) {
        await es.waitAlerts(count);
    }
    await clock.delay(QUIET);
    return es.alerts().map(alert => alert.alertId);
}

const inbox = async ctx => {
    const res = await ctx.client.call([['Email/query', { accountId: true, filter: { text: 'Reminder' } }, 'q']]);
    return res[0][1].ids;
};

describe('Calendar alerts (CALR)', function () {
    this.timeout(120000);

    before(() => ph.push.start());

    after(async () => {
        sse.closeAll();
        await h.stopMulti();
        if (queue) {
            await queue.close();
        }
    });

    describe('firing', () => {
        scenario('CALR-001', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const event = await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('-PT10M', { action: 'display' }) } }));
            await tick(ctx, T - 11 * MINUTE);
            expect(es.alerts()).to.deep.equal([]);
            await tick(ctx, T - 10 * MINUTE);
            const [alert] = await es.waitAlerts(1);
            expect(alert).to.deep.equal({
                '@type': 'CalendarAlert',
                accountId: ctx.client.accountId,
                calendarEventId: event.id,
                uid: event.uid,
                recurrenceId: null,
                alertId: 'a1'
            });
            await tick(ctx, T);
            expect(await alertIds(es, 1)).to.deep.equal(['a1']);
        });

        scenario('CALR-002', async () => {
            const ctx = await h.setupUser();
            const alertOnly = await stream(ctx, 'CalendarAlert');
            const star = await stream(ctx, '*');
            const events = await stream(ctx, 'CalendarEvent');
            await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('PT0S') } }));
            await tick(ctx, T);
            await alertOnly.waitAlerts(1);
            await star.waitAlerts(1);
            await clock.delay(QUIET);
            expect(events.alerts()).to.deep.equal([]);
        });

        scenario('CALR-003', async () => {
            const a = await h.setupUser();
            const b = await h.setupUser();
            const esA = await stream(a, '*');
            const esB = await stream(b, '*');
            await h.createEvent(a, atT({ alerts: { a1: offsetAlert('PT0S') } }));
            await tick([a, b], T);
            await esA.waitAlerts(1);
            await clock.delay(QUIET);
            expect(esB.alerts()).to.deep.equal([]);
        });

        scenario('CALR-004', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            await h.createEvent(
                ctx,
                atT({
                    alerts: {
                        's-before': offsetAlert('-PT5M', { trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'start' } }),
                        's-after': offsetAlert('PT5M', { trigger: { '@type': 'OffsetTrigger', offset: 'PT5M', relativeTo: 'start' } }),
                        'e-before': offsetAlert('-PT5M', { trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'end' } }),
                        'e-at': offsetAlert('PT0S', { trigger: { '@type': 'OffsetTrigger', offset: 'PT0S', relativeTo: 'end' } })
                    }
                })
            );
            const steps = [
                [T - 5 * MINUTE, 's-before'],
                [T + 5 * MINUTE, 's-after'],
                [T + 55 * MINUTE, 'e-before'],
                [T + 60 * MINUTE, 'e-at']
            ];
            for (const [i, [at, alertId]] of steps.entries()) {
                await tick(ctx, at - 1000);
                const fired = await tick(ctx, at);
                expect(fired.map(entry => [entry.alertId, entry.at])).to.deep.equal([[alertId, at]]);
                expect((await es.waitAlerts(i + 1))[i].alertId).to.equal(alertId);
            }
            expect(await alertIds(es, 4)).to.deep.equal(steps.map(step => step[1]));
        });

        scenario('CALR-005', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const w = T + 2 * MINUTE;
            await h.createEvent(ctx, atT({ start: local(T + 7 * DAY), alerts: { abs: absoluteAlert(w) } }));
            expect(await tick(ctx, w - 1000)).to.deep.equal([]);
            const fired = await tick(ctx, w);
            expect(fired.map(entry => [entry.alertId, entry.at])).to.deep.equal([['abs', w]]);
            expect(await alertIds(es, 1)).to.deep.equal(['abs']);
        });

        scenario('CALR-006', async () => {
            const ctx = await h.setupUser();
            // 2027-03-28 is the day summer time begins in Europe/Tallinn: 09:00 local is 06:00Z
            await h.createEvent(ctx, { title: 'DST', start: '2027-03-28T09:00:00', timeZone: 'Europe/Tallinn', alerts: { a1: offsetAlert('-PT1H') } });
            const es = await stream(ctx);
            const at = Date.parse('2027-03-28T05:00:00Z');
            expect(await tick(ctx, at - 1000)).to.deep.equal([]);
            expect((await tick(ctx, at)).map(entry => entry.at)).to.deep.equal([at]);
            expect(await alertIds(es, 1)).to.deep.equal(['a1']);
        });

        scenario('CALR-007', async () => {
            const ctx = await h.setupUser();
            const a = await h.createCalendar(ctx, { name: 'Tokyo', timeZone: 'Asia/Tokyo' });
            await h.createEvent(ctx, { calendarIds: { [a]: true }, title: 'Floating', start: '2027-06-01T09:00:00', alerts: { a1: offsetAlert('PT0S') } });
            const at = Date.parse('2027-06-01T00:00:00Z');
            expect(await tick(ctx, at - 1000)).to.deep.equal([]);
            expect((await tick(ctx, at)).map(entry => entry.at)).to.deep.equal([at]);
        });

        scenario('CALR-008', async () => {
            const ctx = await h.setupUser();
            const b = await h.createCalendar(ctx, { name: 'No zone', timeZone: null });
            await h.createEvent(ctx, { calendarIds: { [b]: true }, title: 'Floating', start: '2027-06-01T09:00:00', alerts: { a1: offsetAlert('PT0S') } });
            const at = Date.parse('2027-06-01T09:00:00Z');
            expect(await tick(ctx, at - 1000)).to.deep.equal([]);
            expect((await tick(ctx, at)).map(entry => entry.at)).to.deep.equal([at]);
        });

        scenario('CALR-009', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const event = await h.createEvent(ctx, atT({ recurrenceRule: { frequency: 'daily', count: 3 }, alerts: { a1: offsetAlert('PT0S') } }));
            for (let day = 0; day < 4; day++) {
                await tick(ctx, T + day * DAY);
            }
            await alertIds(es, 3);
            expect(es.alerts().map(alert => [alert.calendarEventId, alert.alertId, alert.recurrenceId])).to.deep.equal([
                [event.id, 'a1', local(T)],
                [event.id, 'a1', local(T + DAY)],
                [event.id, 'a1', local(T + 2 * DAY)]
            ]);
        });

        scenario('CALR-010', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            await h.createEvent(
                ctx,
                atT({
                    recurrenceRule: { frequency: 'daily' },
                    alerts: { a1: offsetAlert('PT0S') },
                    recurrenceOverrides: {
                        [local(T + DAY)]: { start: local(T + DAY + 2 * HOUR) },
                        [local(T + 2 * DAY)]: { excluded: true },
                        [local(T + 3 * DAY)]: { alerts: { b1: offsetAlert('-PT5M') } }
                    }
                })
            );
            const fired = [];
            for (let at = T - HOUR; at <= T + 3 * DAY + 3 * HOUR; at += 5 * MINUTE) {
                fired.push(...(await tick(ctx, at)));
            }
            expect(fired.map(entry => [entry.alertId, entry.at, entry.recurrenceId])).to.deep.equal([
                ['a1', T, local(T)],
                ['a1', T + DAY + 2 * HOUR, local(T + DAY)],
                ['b1', T + 3 * DAY - 5 * MINUTE, local(T + 3 * DAY)]
            ]);
            expect(await alertIds(es, 3)).to.deep.equal(['a1', 'a1', 'b1']);
        });

        scenario('CALR-011', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const event = await h.createEvent(ctx, {
                uid: 'standalone-1',
                recurrenceId: '2027-06-01T09:00:00',
                recurrenceIdTimeZone: 'Etc/UTC',
                start: '2027-06-01T09:00:00',
                timeZone: 'Etc/UTC',
                alerts: { a1: offsetAlert('PT0S') }
            });
            await tick(ctx, T);
            const [alert] = await es.waitAlerts(1);
            expect(alert.calendarEventId).to.equal(event.id);
            expect(alert.recurrenceId).to.equal('2027-06-01T09:00:00');
        });

        scenario('CALR-012', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            await h.createEvent(ctx, atT({ alerts: { x30: offsetAlert('-PT30M'), x10: offsetAlert('-PT10M'), x0: offsetAlert('PT0S') } }));
            const fired = [];
            for (let at = T - 40 * MINUTE; at <= T + MINUTE; at += MINUTE) {
                fired.push(...(await tick(ctx, at)));
            }
            expect(fired.map(entry => [entry.alertId, entry.at])).to.deep.equal([
                ['x30', T - 30 * MINUTE],
                ['x10', T - 10 * MINUTE],
                ['x0', T]
            ]);
            expect(await alertIds(es, 3)).to.deep.equal(['x30', 'x10', 'x0']);
        });

        scenario('CALR-013', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            await h.createEvent(ctx, atT({ isDraft: true, alerts: { d1: offsetAlert('PT0S') } }));
            const second = await h.createEvent(ctx, atT({ start: local(T + HOUR), isDraft: true, alerts: { d2: offsetAlert('PT0S') } }));
            expect(await tick(ctx, T + MINUTE)).to.deep.equal([]);
            await h.update(ctx, second.id, { isDraft: false });
            expect((await tick(ctx, T + HOUR)).map(entry => entry.alertId)).to.deep.equal(['d2']);
            expect(await alertIds(es, 1)).to.deep.equal(['d2']);
        });

        scenario('CALR-014', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const a = await h.createCalendar(ctx, { name: 'A', isSubscribed: false });
            const b = await h.createCalendar(ctx, { name: 'B' });
            await h.createEvent(ctx, atT({ calendarIds: { [a]: true }, alerts: { inA: offsetAlert('PT0S') } }));
            await h.createEvent(ctx, atT({ calendarIds: { [b]: true }, alerts: { inB: offsetAlert('PT0S') } }));
            await tick(ctx, T + MINUTE);
            expect(await alertIds(es, 1)).to.deep.equal(['inB']);
            await h.method(ctx, 'Calendar/set', { update: { [a]: { isSubscribed: true } } });
            await h.createEvent(ctx, atT({ start: local(T + HOUR), calendarIds: { [a]: true }, alerts: { again: offsetAlert('PT0S') } }));
            await tick(ctx, T + HOUR);
            expect(await alertIds(es, 2)).to.deep.equal(['inB', 'again']);
        });

        scenario('CALR-015', async () => {
            const { url } = await h.multiInstance();
            const ctx = await h.setupUser({}, url);
            const es = await stream(ctx);
            const a = await h.createCalendar(ctx, { name: 'A', isSubscribed: false });
            const b = await h.createCalendar(ctx, { name: 'B' });
            await h.createEvent(ctx, atT({ calendarIds: { [a]: true, [b]: true }, alerts: { a1: offsetAlert('PT0S') } }));
            await tick(ctx, T + MINUTE);
            expect(await alertIds(es, 1)).to.deep.equal(['a1']);
        });

        scenario('CALR-016', async () => {
            // run 1: the start moves an hour later
            const moved = await h.setupUser();
            const event = await h.createEvent(moved, atT({ alerts: { a1: offsetAlert('-PT10M') } }));
            await h.update(moved, event.id, { start: local(T + HOUR) });
            expect(await tick(moved, T - 10 * MINUTE)).to.deep.equal([]);
            expect((await tick(moved, T + 50 * MINUTE)).map(entry => entry.at)).to.deep.equal([T + 50 * MINUTE]);
            // run 2: the event is destroyed
            const destroyed = await h.setupUser();
            const gone = await h.createEvent(destroyed, atT({ alerts: { a1: offsetAlert('-PT10M') } }));
            await h.evSet(destroyed, { destroy: [gone.id] });
            expect(await tick(destroyed, T)).to.deep.equal([]);
            // run 3: the alert is removed
            const removed = await h.setupUser();
            const plain = await h.createEvent(removed, atT({ alerts: { a1: offsetAlert('-PT10M') } }));
            await h.update(removed, plain.id, { 'alerts/a1': null });
            expect(await tick(removed, T)).to.deep.equal([]);
        });

        scenario('CALR-017', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const now = Math.floor(Date.now() / 1000) * 1000;
            await h.createEvent(ctx, { title: 'Yesterday', start: local(now - DAY), timeZone: 'Etc/UTC', alerts: { a1: offsetAlert('-PT10M') } });
            await h.createEvent(ctx, { title: 'Soon', start: local(now + HOUR), timeZone: 'Etc/UTC', alerts: { a1: absoluteAlert(now - HOUR) } });
            expect(await tick(ctx, Date.now() + MINUTE)).to.deep.equal([]);
            expect(await alertIds(es, 0)).to.deep.equal([]);
        });

        scenario('CALR-018', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const geo = { '@type': 'Alert', trigger: { '@type': 'example.com:GeoTrigger' } };
            const event = await h.createEvent(ctx, atT({ alerts: { g: geo } }));
            expect(await tick(ctx, T + 2 * HOUR)).to.deep.equal([]);
            expect(await alertIds(es, 0)).to.deep.equal([]);
            expect((await h.fetch1(ctx, event.id)).alerts.g).to.deep.equal(geo);
        });
    });

    describe('default alerts', () => {
        scenario('CALR-019', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const a = await h.createCalendar(ctx, { name: 'A', defaultAlertsWithTime: { dt: offsetAlert('-PT10M') } });
            await h.createEvent(ctx, atT({ calendarIds: { [a]: true }, useDefaultAlerts: true, alerts: { own: offsetAlert('-PT30M') } }));
            const fired = [];
            for (let at = T - 40 * MINUTE; at <= T; at += 5 * MINUTE) {
                fired.push(...(await tick(ctx, at)));
            }
            expect(fired.map(entry => [entry.alertId, entry.at])).to.deep.equal([['dt', T - 10 * MINUTE]]);
            expect(await alertIds(es, 1)).to.deep.equal(['dt']);
        });

        scenario('CALR-020', async () => {
            const ctx = await h.setupUser();
            const a = await h.createCalendar(ctx, {
                name: 'A',
                timeZone: 'Europe/Tallinn',
                defaultAlertsWithTime: { dt: offsetAlert('-PT10M') },
                defaultAlertsWithoutTime: { dd: offsetAlert('PT9H') }
            });
            await h.createEvent(ctx, {
                calendarIds: { [a]: true },
                title: 'All day',
                start: '2027-06-01T00:00:00',
                duration: 'P1D',
                showWithoutTime: true,
                useDefaultAlerts: true
            });
            const fired = [];
            for (let at = Date.parse('2027-05-31T20:00:00Z'); at <= Date.parse('2027-06-01T22:00:00Z'); at += 30 * MINUTE) {
                fired.push(...(await tick(ctx, at)));
            }
            expect(fired.map(entry => [entry.alertId, utcDate(entry.at)])).to.deep.equal([['dd', '2027-06-01T06:00:00Z']]);
        });

        scenario('CALR-021', async () => {
            const ctx = await h.setupUser();
            const b = await h.createCalendar(ctx, { name: 'B', defaultAlertsWithTime: null, defaultAlertsWithoutTime: null });
            await h.createEvent(ctx, atT({ calendarIds: { [b]: true }, useDefaultAlerts: true, alerts: { own: offsetAlert('PT0S') } }));
            expect(await tick(ctx, T + HOUR)).to.deep.equal([]);
        });

        scenario('CALR-022', async () => {
            const { url } = await h.multiInstance();
            const ctx = await h.setupUser({}, url);
            const a = await h.createCalendar(ctx, { name: 'A', defaultAlertsWithTime: { 'a-def': offsetAlert('-PT10M') } });
            const b = await h.createCalendar(ctx, { name: 'B', defaultAlertsWithTime: { 'b-def': offsetAlert('-PT5M') } });
            await h.createEvent(ctx, atT({ calendarIds: { [a]: true, [b]: true }, useDefaultAlerts: true }));
            const fired = [...(await tick(ctx, T - 10 * MINUTE)), ...(await tick(ctx, T))];
            expect(fired.map(entry => entry.alertId).sort()).to.deep.equal(['a-def', 'b-def']);
        });

        scenario('CALR-023', async () => {
            const ctx = await h.setupUser();
            const a = await h.createCalendar(ctx, { name: 'A', defaultAlertsWithTime: { dt: offsetAlert('-PT10M') } });
            const event = await h.createEvent(ctx, atT({ calendarIds: { [a]: true }, useDefaultAlerts: true }));
            const s1 = await h.evState(ctx);
            await h.method(ctx, 'Calendar/set', { update: { [a]: { defaultAlertsWithTime: { dt2: offsetAlert('-PT30M') } } } });
            const fired = [];
            for (let at = T - 40 * MINUTE; at <= T; at += 5 * MINUTE) {
                fired.push(...(await tick(ctx, at)));
            }
            expect(fired.map(entry => [entry.alertId, entry.at])).to.deep.equal([['dt2', T - 30 * MINUTE]]);
            expect((await h.evChanges(ctx, s1)).updated).to.not.include(event.id);
        });
    });

    describe('acknowledge and snooze', () => {
        scenario('CALR-024', async () => {
            const ctx = await h.setupUser();
            const a = await h.createCalendar(ctx, { name: 'A', defaultAlertsWithTime: { dt: offsetAlert('-PT10M') } });
            const r1 = await h.createEvent(
                ctx,
                atT({ calendarIds: { [a]: true }, useDefaultAlerts: true, alerts: {}, recurrenceRule: { frequency: 'weekly' } })
            );
            const week1 = T - 10 * MINUTE;
            expect((await tick(ctx, week1)).map(entry => entry.alertId)).to.deep.equal(['dt']);
            await h.update(ctx, r1.id, { 'alerts/dt': Object.assign(offsetAlert('-PT10M'), { acknowledged: utcDate(week1 + MINUTE) }) });
            const object = await h.fetch1(ctx, r1.id);
            expect(object).to.not.have.property('recurrenceOverrides');
            expect(object.alerts.dt.acknowledged).to.equal(utcDate(week1 + MINUTE));
            expect(await tick(ctx, week1 + 2 * MINUTE)).to.deep.equal([]);
            expect((await tick(ctx, week1 + 7 * DAY)).map(entry => [entry.alertId, entry.recurrenceId])).to.deep.equal([['dt', local(T + 7 * DAY)]]);
        });

        scenario('CALR-025', async () => {
            const ctx = await h.setupUser();
            const event = await h.createEvent(ctx, atT({ sequence: 4, alerts: { a1: offsetAlert('-PT10M') } }));
            await tick(ctx, T - 10 * MINUTE);
            const s1 = await h.evState(ctx);
            const es = await stream(ctx, 'CalendarEvent');
            const res = await h.evSet(ctx, { update: { [event.id]: { 'alerts/a1/acknowledged': '2026-06-01T08:50:30Z' } } });
            const object = await h.fetch1(ctx, event.id);
            expect(object.alerts.a1.acknowledged).to.equal('2026-06-01T08:50:30Z');
            expect(object.sequence).to.equal(4);
            expect((await h.evChanges(ctx, s1)).updated).to.deep.equal([event.id]);
            await es.until(() => es.states().find(state => state.json.changed[ctx.client.accountId].CalendarEvent === res.newState), 10000, 'no StateChange');
        });

        scenario('CALR-026', async () => {
            const ctx = await h.setupUser();
            const event = await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('-PT10M') } }));
            await h.update(ctx, event.id, { 'alerts/a1/acknowledged': utcDate(T - 5 * MINUTE) });
            expect(await tick(ctx, T + HOUR)).to.deep.equal([]);
        });

        scenario('CALR-027', async () => {
            const ctx = await h.setupUser();
            const r1 = await h.createEvent(ctx, atT({ recurrenceRule: { frequency: 'daily' }, alerts: { a1: offsetAlert('PT0S') } }));
            expect((await tick(ctx, T)).map(entry => entry.recurrenceId)).to.deep.equal([local(T)]);
            await h.update(ctx, r1.id, { 'alerts/a1/acknowledged': utcDate(T + MINUTE) });
            expect(await h.fetch1(ctx, r1.id)).to.not.have.property('recurrenceOverrides');
            expect((await tick(ctx, T + DAY)).map(entry => entry.recurrenceId)).to.deep.equal([local(T + DAY)]);
        });

        scenario('CALR-028', async () => {
            const ctx = await h.setupUser();
            const r1 = await h.createEvent(
                ctx,
                Object.assign({}, h.WEEKLY, {
                    alerts: { a1: offsetAlert('-PT15M') },
                    recurrenceOverrides: { '2026-01-12T09:00:00': { 'alerts/a1/trigger/offset': '-PT1H' } }
                })
            );
            const ids = await h.expand(ctx);
            const x12 = (await h.startsOf(ctx, ids)).find(object => object.recurrenceId === '2026-01-12T09:00:00').id;
            await h.update(ctx, x12, { 'alerts/a1/acknowledged': '2026-01-12T06:01:00Z' });
            const object = await h.fetch1(ctx, r1.id);
            expect(object.recurrenceOverrides).to.deep.equal({
                '2026-01-12T09:00:00': { 'alerts/a1/trigger/offset': '-PT1H', 'alerts/a1/acknowledged': '2026-01-12T06:01:00Z' }
            });
            expect(object.alerts.a1).to.not.have.property('acknowledged');
        });

        scenario('CALR-029', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const event = await h.createEvent(ctx, atT({ start: local(T + HOUR), alerts: { a1: offsetAlert('-PT1H') } }));
            expect((await tick(ctx, T)).map(entry => entry.alertId)).to.deep.equal(['a1']);
            const now = T + MINUTE;
            await h.update(ctx, event.id, {
                'alerts/a1/acknowledged': utcDate(now),
                'alerts/snz': absoluteAlert(now + 30 * MINUTE, { action: 'display', relatedTo: { a1: { '@type': 'Relation', relation: { snooze: true } } } })
            });
            expect(await h.fetch1(ctx, event.id)).to.not.have.property('recurrenceOverrides');
            expect(await tick(ctx, now + 29 * MINUTE)).to.deep.equal([]);
            expect((await tick(ctx, now + 30 * MINUTE)).map(entry => entry.alertId)).to.deep.equal(['snz']);
            const pushed = await es.waitAlerts(2);
            expect(pushed[1]).to.include({ alertId: 'snz', calendarEventId: event.id });
            expect(await tick(ctx, T + 2 * HOUR)).to.deep.equal([]);
        });

        scenario('CALR-030', async () => {
            const ctx = await h.setupUser();
            const a = await h.createCalendar(ctx, { name: 'A', defaultAlertsWithTime: { dt: offsetAlert('-PT2H') } });
            const now = T - HOUR;
            await h.createEvent(
                ctx,
                atT({
                    calendarIds: { [a]: true },
                    useDefaultAlerts: true,
                    alerts: {
                        own: offsetAlert('PT0S'),
                        snz: absoluteAlert(now + 5 * MINUTE, { relatedTo: { dt: { '@type': 'Relation', relation: { snooze: true } } } }),
                        dt: offsetAlert('-PT2H', { acknowledged: utcDate(now) })
                    }
                })
            );
            const fired = [];
            for (let at = now; at <= T + 10 * MINUTE; at += MINUTE) {
                fired.push(...(await tick(ctx, at)));
            }
            expect(fired.map(entry => [entry.alertId, entry.at])).to.deep.equal([['snz', now + 5 * MINUTE]]);
        });

        scenario('CALR-031', async () => {
            const ctx = await h.setupUser();
            const now = T - HOUR;
            const event = await h.createEvent(ctx, atT({ alerts: { snz: absoluteAlert(now + 10 * MINUTE) } }));
            await h.update(ctx, event.id, { 'alerts/snz': null });
            expect(await tick(ctx, now + 10 * MINUTE)).to.deep.equal([]);
            expect(await h.fetch1(ctx, event.id)).to.not.have.nested.property('alerts.snz');
        });
    });

    describe('email alerts', () => {
        scenario('CALR-032', async () => {
            const ctx = await h.setupUser();
            const participants = {
                me: { '@type': 'Participant', calendarAddress: `mailto:${ctx.user.address}`, roles: { owner: true } },
                bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.net' },
                carol: { '@type': 'Participant', calendarAddress: 'mailto:carol@example.net' }
            };
            await h.createEvent(ctx, atT({ title: 'Board meeting', participants, alerts: { m1: offsetAlert('-PT10M', { action: 'email' }) } }));
            await tick(ctx, T - 10 * MINUTE);
            const ids = await inbox(ctx);
            expect(ids).to.have.length(1);
            const [[, email]] = await ctx.client.call([['Email/get', { accountId: true, ids, properties: ['subject', 'to', 'preview'] }, 'g']]);
            const message = email.list[0];
            expect(message.subject).to.include('Board meeting');
            expect(message.to.map(address => address.email)).to.deep.equal([ctx.user.address]);
            expect(message.preview).to.include('2027-06-01 09:00:00');
            for (const address of ['bob@example.net', 'carol@example.net', ctx.user.address]) {
                expect(await outbound.entriesFor(address)).to.have.length(0);
            }
        });

        scenario('CALR-033', async () => {
            const ctx = await h.setupUser();
            const event = await h.createEvent(ctx, atT({ alerts: { m1: offsetAlert('-PT1M', { action: 'email' }) } }));
            const s1 = await h.evState(ctx);
            const fired = await tick(ctx, T);
            expect(fired.map(entry => [entry.alertId, entry.delivered])).to.deep.equal([['m1', true]]);
            const object = await h.fetch1(ctx, event.id);
            expect(object.alerts.m1.acknowledged).to.equal(utcDate(T));
            expect(object).to.not.have.property('recurrenceOverrides');
            expect((await h.evChanges(ctx, s1)).updated).to.deep.equal([event.id]);
        });

        scenario('CALR-034', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            await h.createEvent(ctx, atT({ alerts: { d1: offsetAlert('PT0S', { action: 'display' }), m1: offsetAlert('PT0S', { action: 'email' }) } }));
            await tick(ctx, T);
            expect(await alertIds(es, 1)).to.deep.equal(['d1']);
            expect(await inbox(ctx)).to.have.length(1);
        });

        scenario('CALR-035', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            await h.createEvent(ctx, atT({ alerts: { m1: offsetAlert('PT0S', { action: 'email' }), d1: offsetAlert('PT0S') } }));
            await api('PUT', `/users/${ctx.user.id}`, { disabled: true });
            try {
                await tick(ctx, T + MINUTE);
                await clock.delay(QUIET);
                expect(es.alerts()).to.deep.equal([]);
            } finally {
                await api('PUT', `/users/${ctx.user.id}`, { disabled: false });
            }
            expect(await inbox(ctx)).to.deep.equal([]);
        });
    });

    describe('limits and delivery', () => {
        scenario('CALR-036', async () => {
            const ctx = await h.setupUser();
            const es = await stream(ctx);
            const ten = Object.fromEntries(Array.from({ length: 10 }, (value, i) => [`a${i}`, offsetAlert(`PT${i}S`)]));
            await h.createEvent(ctx, atT({ duration: 'PT30S', recurrenceRule: { frequency: 'minutely' }, alerts: ten }));
            const settings = { pushLimit: 5, pushWindow: 2 };
            const first = await tick(ctx, T + HOUR, settings);
            expect(first.length).to.be.above(5);
            expect(first.filter(entry => entry.delivered)).to.have.length(5);
            expect(await alertIds(es, 5)).to.have.length(5);
            // other users are served meanwhile
            const other = await h.setupUser();
            expect((await h.evGet(other, null)).list).to.deep.equal([]);
            await clock.delay(2100);
            const second = await tick(ctx, T + HOUR + MINUTE, settings);
            expect(second.filter(entry => entry.delivered)).to.have.length(5);
            await es.waitAlerts(10);
        });

        scenario('CALR-037', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(
                ctx,
                atT({ duration: 'PT30S', recurrenceRule: { frequency: 'minutely' }, alerts: { m1: offsetAlert('PT0S', { action: 'email' }) } })
            );
            const fired = await tick(ctx, T + DAY, { emailLimit: 3, emailWindow: 86400 });
            expect(fired.length).to.be.above(3);
            expect(fired.filter(entry => entry.delivered)).to.have.length(3);
            expect(await inbox(ctx)).to.have.length(3);
        });

        scenario('CALR-038', async () => {
            const jitter = 30;
            const users = [];
            for (let batch = 0; batch < 10; batch++) {
                users.push(
                    ...(await Promise.all(
                        Array.from({ length: 20 }, async () => {
                            const ctx = await h.setupUser();
                            await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('PT0S') } }));
                            return ctx;
                        })
                    ))
                );
            }
            const es = await stream(users[0]);
            const fired = [];
            for (let at = T - jitter * 1000; at <= T + 1000; at += 1000) {
                fired.push(...(await tick(users, at, { jitter })).map(entry => Object.assign(entry, { tick: at })));
            }
            expect(fired).to.have.length(200);
            expect(new Set(fired.map(entry => entry.user)).size).to.equal(200);
            // every alert goes out at a tick between H - J and H, early rather than late
            for (const entry of fired) {
                expect(entry.at).to.equal(T);
                expect(entry.tick, entry.user).to.be.within(T - jitter * 1000, T);
            }
            // and they are spread over the interval
            expect(new Set(fired.map(entry => entry.tick)).size).to.be.above(10);
            await es.waitAlerts(1);
        });

        scenario('CALR-039', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('PT0S') } }));
            expect(await tick(ctx, T - 5 * MINUTE)).to.deep.equal([]);
            // a restarted worker: new scheduler dependencies, the state is in the database
            sse.closeAll();
            deps = null;
            const es = await stream(ctx);
            expect((await tick(ctx, T)).map(entry => entry.alertId)).to.deep.equal(['a1']);
            expect(await tick(ctx, T + MINUTE)).to.deep.equal([]);
            expect(await alertIds(es, 1)).to.deep.equal(['a1']);
        });

        scenario('CALR-040', async () => {
            const ctx = await h.setupUser();
            const first = await stream(ctx, '*');
            const event = await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('PT0S') } }));
            await first.until(() => first.states().length, 5000, 'no state event');
            const lastEventId = first.states()[first.states().length - 1].id;
            first.close();
            expect((await tick(ctx, T)).map(entry => entry.alertId)).to.deep.equal(['a1']);
            // changes while away: mail and the event
            await seed.deliver(ctx.user.address, 'Subject: away\r\n\r\nHello\r\n');
            await h.update(ctx, event.id, { title: 'Changed while away' });
            const es = await sse.open('/jmap/eventsource/?types=*&closeafter=no&ping=0', {
                authorization: jmap.basic(ctx.user.username, ctx.user.password),
                headers: { 'Last-Event-ID': lastEventId }
            });
            await es.until(() => es.states().length, 5000, 'no replayed state');
            await clock.delay(QUIET);
            expect(es.named('calendarAlert')).to.deep.equal([]);
            expect((await h.fetch1(ctx, event.id)).alerts.a1).to.not.have.property('acknowledged');
        });

        scenario('CALR-041', async () => {
            const ctx = await h.setupUser();
            const box = ph.push.endpoint();
            const res = await ph.create(ctx.client, {
                ok: { deviceClientId: 'd1', url: box.url, types: ['CalendarAlert', 'CalendarEvent'] },
                bad: { deviceClientId: 'd2', url: box.url, types: ['CalendarAlarm'] }
            });
            expect(res.created).to.have.property('ok');
            ph.expectInvalid(res.notCreated.bad, ['types']);
        });

        scenario('CALR-042', async () => {
            const ctx = await h.setupUser();
            const alertBox = ph.push.endpoint(true);
            const emailBox = ph.push.endpoint(true);
            await ph.verified(ctx.client, alertBox, { types: ['CalendarAlert'] });
            await ph.verified(ctx.client, emailBox, { types: ['Email'] });
            const before = emailBox.requests.length;
            const event = await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('PT0S') } }));
            await tick(ctx, T);
            await clock.waitFor(() => alertBox.requests.some(request => alertBox.json(request)['@type'] === 'CalendarAlert'), {
                timeout: 10000,
                message: 'no CalendarAlert push'
            });
            const pushed = alertBox.requests.map(request => alertBox.json(request)).filter(body => body['@type'] === 'CalendarAlert');
            expect(pushed).to.deep.equal([
                { '@type': 'CalendarAlert', accountId: ctx.client.accountId, calendarEventId: event.id, uid: event.uid, recurrenceId: null, alertId: 'a1' }
            ]);
            const request = alertBox.requests.find(entry => alertBox.json(entry)['@type'] === 'CalendarAlert');
            expect(request.headers['content-encoding']).to.equal('aes128gcm');
            await clock.delay(QUIET);
            expect(emailBox.requests.slice(before).map(entry => emailBox.json(entry)['@type'])).to.not.include('CalendarAlert');
        });
    });

    describe('quota, concurrent changes and dense rules', () => {
        const storedEvent = async ctx => (await schedulerDeps()).database.collection('calendarevents').findOne({ user: new seed.ObjectId(ctx.user.id) });

        it('an email alert that does not fit in the storage quota is not delivered', async () => {
            const ctx = await h.setupUser();
            await h.createEvent(ctx, atT({ alerts: { m1: offsetAlert('PT0S', { action: 'email' }) } }));
            await api('PUT', `/users/${ctx.user.id}`, { quota: 1 });
            const fired = await tick(ctx, T);
            expect(fired.map(entry => [entry.alertId, entry.delivered])).to.deep.equal([['m1', false]]);
            expect(await inbox(ctx)).to.deep.equal([]);
        });

        it('a write conditional on a modSeq that moved on changes nothing', async () => {
            const ctx = await h.setupUser();
            const event = await h.createEvent(ctx, atT({ alerts: { m1: offsetAlert('PT0S', { action: 'email' }) } }));
            const doc = await storedEvent(ctx);
            await h.update(ctx, event.id, { title: 'Changed meanwhile' });
            const { EventStore } = require('../../../lib/calendar/events'); // eslint-disable-line global-require
            const store = new EventStore({ database: (await schedulerDeps()).database });
            const stale = Object.assign(JSON.parse(doc.data), { title: 'Stale write' });
            expect(await store.replace(doc.user, doc._id, stale, doc.calendarIds, {}, { modSeq: doc.modSeq })).to.equal(false);
            expect((await h.fetch1(ctx, event.id)).title).to.equal('Changed meanwhile');
            // the acknowledgement reads the event again and keeps the change
            await tick(ctx, T);
            const object = await h.fetch1(ctx, event.id);
            expect(object.title).to.equal('Changed meanwhile');
            expect(object.alerts.m1.acknowledged).to.equal(utcDate(T));
        });

        it('a minutely rule with a reminder a week ahead is scheduled to its next minute', async () => {
            const ctx = await h.setupUser();
            const started = Date.now();
            await h.createEvent(
                ctx,
                atT({
                    start: local(T + 30 * DAY),
                    duration: 'PT1M',
                    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'minutely' },
                    alerts: { w: offsetAlert('-P7D') }
                })
            );
            expect(Date.now() - started).to.be.below(5000);
            expect((await storedEvent(ctx)).alertAt.getTime()).to.equal(T + 23 * DAY);
        });

        it('an event whose triggers are all acknowledged far ahead is claimed and costs a bounded search', async () => {
            const ctx = await h.setupUser();
            // a secondly rule whose only offset alert is acknowledged in 2199, and an absolute alert due at T
            const values = atT({
                duration: 'PT1S',
                recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'secondly' },
                alerts: { a: offsetAlert('PT0S', { acknowledged: '2199-12-31T00:00:00Z' }), soon: absoluteAlert(T) }
            });
            let started = Date.now();
            await h.createEvent(ctx, values);
            expect(Date.now() - started).to.be.below(2000);
            expect((await storedEvent(ctx)).alertAt.getTime()).to.equal(T);
            started = Date.now();
            const fired = await tick(ctx, T);
            expect(Date.now() - started).to.be.below(2000);
            expect(fired.map(entry => entry.alertId)).to.deep.equal(['soon']);
            // claimed: no longer due at T, and not before the acknowledgement of the offset alert
            const stored = await storedEvent(ctx);
            expect(stored.alertAt === null || stored.alertAt.getTime() > T + 3600 * 1000).to.equal(true);
            expect(await tick(ctx, T + MINUTE)).to.deep.equal([]);
        });

        it('a CalendarAlert is not pushed to a subscription whose account lost the jmap scope', async () => {
            const ctx = await h.setupUser();
            const box = ph.push.endpoint(true);
            await ph.verified(ctx.client, box, { types: ['CalendarAlert'] });
            await h.createEvent(ctx, atT({ alerts: { a1: offsetAlert('PT0S') } }));
            await api('PUT', `/users/${ctx.user.id}`, { disabledScopes: ['jmap'] });
            const before = box.requests.length;
            const fired = await tick(ctx, T);
            expect(fired.map(entry => [entry.alertId, entry.delivered])).to.deep.equal([['a1', true]]);
            await clock.delay(3 * QUIET);
            expect(box.requests.slice(before).map(entry => box.json(entry)['@type'])).to.not.include('CalendarAlert');
        });
    });
});
