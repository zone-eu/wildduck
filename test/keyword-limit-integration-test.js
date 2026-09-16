'use strict';
/* globals before, after */

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { ensureKeywords } = require('../lib/keyword-handler');
const { MAX_KEYWORDS } = require('../lib/consts');

describe('Keyword allocation limits in MongoDB', function () {
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
            await database.collection('keywords').deleteMany({ user });
        }
        if (client) {
            await client.close();
        }
    });

    it('enforces the last available slot with concurrent writers and unique indexes', async () => {
        const collection = database.collection('keywords');
        const indexes = await collection.indexes();
        expect(indexes.find(index => index.name === 'user_slot').unique).to.equal(true);
        expect(indexes.find(index => index.name === 'user_path').unique).to.equal(true);
        await collection.insertMany(Array.from({ length: MAX_KEYWORDS - 1 }, (_, slot) => ({ user, slot, path: `test-${slot}` })));
        const results = await Promise.allSettled([
            ensureKeywords(database, user, ['last-a']),
            ensureKeywords(database, user, ['last-b']),
            ensureKeywords(database, user, ['last-c'])
        ]);
        expect(results.filter(result => result.status === 'fulfilled').length).to.equal(1);
        for (const result of results.filter(result => result.status === 'rejected')) {
            expect(result.reason.code).to.equal('KeywordLimitExceeded');
        }
        expect(await collection.countDocuments({ user })).to.equal(MAX_KEYWORDS);
        await ensureKeywords(database, user, ['test-0']);
        expect(await collection.countDocuments({ user })).to.equal(MAX_KEYWORDS);
    });
});
