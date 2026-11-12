/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Runs against the local test MongoDB (the database of config/test.toml); skipped when it is not reachable.

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { journalAnchors } = require('../../../lib/journal-state');

const RETENTION = 24 * 3600 * 1000;
// the n-th id of the second `seconds` ago
const secondsAgo = (seconds, n = 1) =>
    new ObjectId(
        ObjectId.createFromTime(Math.floor(Date.now() / 1000) - seconds)
            .toHexString()
            .slice(0, 8) + n.toString(16).padStart(16, '0')
    );

describe('journal anchors', function () {
    this.timeout(10000);
    let client;
    let database;
    let user;
    // the _id lower bounds of the delivery searches (journal finds filtering on command)
    let deliverySearches;

    // the database, with the delivery searches on the journal recorded
    const recording = () => ({
        collection(name) {
            const collection = database.collection(name);
            if (name !== 'journal') {
                return collection;
            }
            return {
                find(filter, options) {
                    if (filter.command) {
                        deliverySearches.push(filter._id.$gt);
                    }
                    return collection.find(filter, options);
                }
            };
        }
    });
    const anchors = () => journalAnchors(recording(), user, { retention: RETENTION });
    const entry = (_id, command = 'FETCH') => database.collection('journal').insertOne({ _id, user, command, created: new Date() });

    before(async function () {
        try {
            client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
            database = client.db(`${config.dbs.dbname}-journal-state-unit`);
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

    beforeEach(() => {
        user = new ObjectId();
        deliverySearches = [];
    });

    it('searches deliveries from a second before a recent journal anchor, and finds one committed late below it', async () => {
        await entry(secondsAgo(30), 'EXISTS');
        const anchor = new ObjectId();
        await entry(anchor);
        const first = await anchors();
        expect(first.journal.toString()).to.equal(anchor.toString());

        // another process commits a delivery with a smaller id after the anchor was stored
        const second = ObjectId.createFromTime(Math.floor(anchor.getTimestamp().getTime() / 1000) - 1);
        const late = new ObjectId(second.toHexString().slice(0, 8) + 'ffffffffffffffff');
        await entry(late, 'EXISTS');
        deliverySearches = [];
        const next = await anchors();
        expect(next.journal.toString()).to.equal(anchor.toString());
        expect(next.delivery.toString()).to.equal(late.toString());
        expect(deliverySearches[0].toString() <= late.toString()).to.be.true;
        expect((await database.collection('jmapstate').findOne({ _id: user })).settled).to.not.exist;
    });

    it('starts the delivery search at the anchor once the second of the anchor is over', async () => {
        // a burst of flag changes, the newest a few seconds ago
        const burst = [secondsAgo(6), secondsAgo(5, 1), secondsAgo(5, 2), secondsAgo(5, 3)];
        const delivery = secondsAgo(8);
        await entry(delivery, 'EXISTS');
        for (const id of burst) {
            await entry(id);
        }
        const newest = burst[burst.length - 1];

        // the first read stores the anchor, searching from a second before it; the anchor's second is
        // over, so the read also records that every delivery up to the anchor was seen
        const first = await anchors();
        expect(first.journal.toString()).to.equal(newest.toString());
        expect(first.delivery.toString()).to.equal(delivery.toString());
        deliverySearches = [];
        await anchors();
        expect(deliverySearches.map(String)).to.not.include(newest.toString());
        const state = await database.collection('jmapstate').findOne({ _id: user });
        expect(state.settled.toString()).to.equal(newest.toString());

        // from now on the search starts at the anchor, the burst is not read again
        deliverySearches = [];
        const third = await anchors();
        expect(deliverySearches.map(String)).to.deep.equal([newest.toString()]);
        expect(third.journal.toString()).to.equal(newest.toString());
        expect(third.delivery.toString()).to.equal(delivery.toString());
    });

    it('searches from a second before a new anchor again, and finds a delivery after a settled anchor', async () => {
        const old = secondsAgo(10);
        await entry(old, 'EXISTS');
        await anchors();
        await anchors();
        expect((await database.collection('jmapstate').findOne({ _id: user })).settled.toString()).to.equal(old.toString());

        const changed = new ObjectId();
        await entry(changed);
        deliverySearches = [];
        const next = await anchors();
        expect(deliverySearches.map(String)).to.deep.equal([old.toString()]);
        expect(next.journal.toString()).to.equal(changed.toString());
        expect(next.delivery.toString()).to.equal(old.toString());

        // the new anchor is recent: the next search starts a second before it
        deliverySearches = [];
        await anchors();
        expect(deliverySearches[0].toString() < changed.toString()).to.be.true;
        expect(deliverySearches[0].toString() > old.toString()).to.be.true;

        const delivered = new ObjectId();
        await entry(delivered, 'EXISTS');
        expect((await anchors()).delivery.toString()).to.equal(delivered.toString());
    });
});
