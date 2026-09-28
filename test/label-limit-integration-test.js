'use strict';
/* globals before, after */

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { ensureLabels } = require('../lib/label-handler');
const { MAX_LABELS } = require('../lib/consts');

describe('Label allocation limits in MongoDB', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this
    const user = new ObjectId();
    let client;
    let database;

    before(async () => {
        client = await MongoClient.connect(config.dbs.mongo);
        database = client.db(config.dbs.dbname);
    });

    after(async () => {
        if (database) {
            await database.collection('labels').deleteMany({ user });
        }
        if (client) {
            await client.close();
        }
    });

    it('enforces the last available slot with concurrent writers and unique indexes', async () => {
        const collection = database.collection('labels');
        const indexes = await collection.indexes();
        expect(indexes.find(index => index.name === 'user_slot').unique).to.equal(true);
        expect(indexes.find(index => index.name === 'user_name').unique).to.equal(true);
        await collection.insertMany(Array.from({ length: MAX_LABELS - 1 }, (_, slot) => ({ user, slot, name: `test-${slot}` })));
        const results = await Promise.allSettled([
            ensureLabels(database, user, ['last-a']),
            ensureLabels(database, user, ['last-b']),
            ensureLabels(database, user, ['last-c'])
        ]);
        expect(results.filter(result => result.status === 'fulfilled').length).to.equal(1);
        for (const result of results.filter(result => result.status === 'rejected')) {
            expect(result.reason.code).to.equal('LabelLimitExceeded');
        }
        expect(await collection.countDocuments({ user })).to.equal(MAX_LABELS);
        await ensureLabels(database, user, ['test-0']);
        expect(await collection.countDocuments({ user })).to.equal(MAX_LABELS);
    });
});
