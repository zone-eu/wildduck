/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// The mapping between the autoreply document and the VacationResponse, its validation, and the state
// reconcile. The reconcile part runs against the local test MongoDB and is skipped when it is not reachable.

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { toVacation, toAutoreply, checkVacation, reconcile } = require('../../../lib/jmap/types/vacation');

const DEFAULTS = { id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null };

describe('JMAP VacationResponse', () => {
    describe('mapping', () => {
        it('maps a missing document to the defaults', () => {
            expect(toVacation(null)).to.deep.equal(DEFAULTS);
        });

        it('maps empty strings and false boundaries to null', () => {
            expect(toVacation({ status: true, subject: '', text: 'text', html: '', start: false, end: false })).to.deep.equal(
                Object.assign({}, DEFAULTS, { isEnabled: true, textBody: 'text' })
            );
        });

        it('formats dates as UTCDate without a zero fraction', () => {
            const vacation = toVacation({ start: new Date('2030-01-01T00:00:00.000Z'), end: new Date('2030-01-02T03:04:05.250Z') });
            expect(vacation.fromDate).to.equal('2030-01-01T00:00:00Z');
            expect(vacation.toDate).to.equal('2030-01-02T03:04:05.250Z');
        });

        it('reads a date stored as a string and ignores an invalid one', () => {
            expect(toVacation({ start: '2030-01-01T00:00:00.000Z', end: 'garbage' })).to.include({ fromDate: '2030-01-01T00:00:00Z', toDate: null });
        });

        it('stores the REST form', () => {
            const values = toAutoreply(Object.assign({}, DEFAULTS, { isEnabled: true, fromDate: '2030-01-01T00:00:00Z', subject: 'S' }));
            expect(values).to.deep.equal({ status: true, start: new Date('2030-01-01T00:00:00Z'), end: false, subject: 'S', text: '', html: '' });
            expect(toVacation(values)).to.deep.equal(Object.assign({}, DEFAULTS, { isEnabled: true, fromDate: '2030-01-01T00:00:00Z', subject: 'S' }));
        });
    });

    describe('validation', () => {
        const check = (patch, current = DEFAULTS) => checkVacation(Object.assign({}, current, patch), new Set(Object.keys(patch)), current);
        const invalid = (patch, current) => {
            try {
                check(patch, current);
            } catch (err) {
                expect(err.type).to.equal('invalidProperties');
                return err.extra.properties;
            }
            throw new Error('expected invalidProperties');
        };

        it('accepts valid values', () => {
            check({
                isEnabled: true,
                fromDate: '2030-01-01T00:00:00Z',
                toDate: '2030-01-01T00:00:00.5Z',
                subject: null,
                textBody: 'x',
                htmlBody: null,
                id: 'singleton'
            });
        });

        it('names every invalid property', () => {
            expect(invalid({ isEnabled: null, subject: 1, fromDate: '2030-01-01T00:00:00+02:00', toDate: '2030-13-01T00:00:00Z' })).to.deep.equal([
                'isEnabled',
                'subject',
                'fromDate',
                'toDate'
            ]);
            expect(invalid({ id: 'other' })).to.deep.equal(['id']);
            // a day that does not exist is not a UTCDate
            expect(invalid({ fromDate: '2018-02-30T00:00:00Z' })).to.deep.equal(['fromDate']);
        });

        it('rejects a date window that ends before it starts, judged on the result', () => {
            expect(invalid({ fromDate: '2030-02-01T00:00:00Z', toDate: '2030-01-01T00:00:00Z' })).to.deep.equal(['fromDate', 'toDate']);
            const current = Object.assign({}, DEFAULTS, { fromDate: '2030-01-10T00:00:00Z' });
            expect(invalid({ toDate: '2030-01-05T00:00:00Z' }, current)).to.deep.equal(['toDate']);
            // an untouched inverted window does not fail other updates
            check({ subject: 'x' }, Object.assign({}, current, { toDate: '2030-01-05T00:00:00Z' }));
        });

        it('counts the length limits in characters', () => {
            check({ subject: '☀'.repeat(2048) });
            expect(invalid({ subject: 'x'.repeat(2049) })).to.deep.equal(['subject']);
            check({ textBody: 'x'.repeat(128 * 1024), htmlBody: 'x'.repeat(128 * 1024) });
            expect(invalid({ htmlBody: 'x'.repeat(128 * 1024 + 1) })).to.deep.equal(['htmlBody']);
        });
    });

    describe('state reconcile', function () {
        this.timeout(10000);
        let client;
        let database;

        before(async function () {
            try {
                client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
                database = client.db(`${config.dbs.dbname}-vacation-unit`);
                await database.command({ ping: 1 });
            } catch {
                this.skip();
            }
        });

        after(async () => {
            if (database) {
                await database.dropDatabase();
            }
            if (client) {
                await client.close();
            }
        });

        it('moves the state only when the object changed', async () => {
            const user = new ObjectId();
            const first = await reconcile(database, user, DEFAULTS);
            expect(first).to.include({ seq: 1, changed: true });
            expect(await reconcile(database, user, DEFAULTS)).to.include({ seq: 1, changed: false });
            const enabled = Object.assign({}, DEFAULTS, { isEnabled: true });
            expect(await reconcile(database, user, enabled)).to.include({ seq: 2, changed: true });
            // back to an earlier object is a new state too
            expect(await reconcile(database, user, DEFAULTS)).to.include({ seq: 3, changed: true });
        });

        it('takes one number for concurrent readers of one change', async () => {
            const user = new ObjectId();
            await reconcile(database, user, DEFAULTS);
            const enabled = Object.assign({}, DEFAULTS, { isEnabled: true });
            const results = await Promise.all(Array.from({ length: 5 }, () => reconcile(database, user, enabled)));
            expect(new Set(results.map(result => result.seq))).to.deep.equal(new Set([2]));
        });

        it('keeps the other sequences of the jmap.state document', async () => {
            const user = new ObjectId();
            await database.collection('jmap.state').insertOne({ _id: user, seq: { Identity: 7 } });
            await reconcile(database, user, DEFAULTS);
            const doc = await database.collection('jmap.state').findOne({ _id: user });
            expect(doc.seq).to.deep.equal({ Identity: 7, VacationResponse: 1 });
        });
    });
});
