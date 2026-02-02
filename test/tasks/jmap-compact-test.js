/* globals before: false, after: false */
'use strict';

const supertest = require('supertest');
const chai = require('chai');
const expect = chai.expect;
const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const JmapChanges = require('../../lib/jmap-changes');
const jmapCompact = require('../../lib/tasks/jmap-compact');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('JMAP changelog compact task', function () {
    this.timeout(20000);

    let redis, testUser;

    before(async () => {
        redis = db.redis;
        await redis.flushdb();
        await db.database.collection('jmap_changes').deleteMany({});

        // Create a real test user instead of using hardcoded ID
        const response = await server
            .post('/users')
            .send({ username: 'jmapcompact', password: 'secretvalue', address: 'jmapcompact@example.com', name: 'JMAP Compact' })
            .expect(200);
        expect(response.body.success).to.be.true;
        testUser = response.body.id;
    });

    after(async () => {
        // Cleanup test user
        if (testUser) {
            try {
                await server.delete(`/users/${testUser}`).expect(200);
            } catch (e) {
                console.warn('Cleanup failed for test user:', e.message);
            }
        }
    });

    it('moves older changelog entries to MongoDB and trims redis list', async () => {
        const jc = new JmapChanges(redis);

        // populate more than keep
        const keep = 10;
        for (let i = 0; i < 25; i++) {
            await jc.appendChange(testUser, { type: i % 3 === 0 ? 'created' : 'updated', id: `msg${i}` });
        }

        // run compact task
        await new Promise((resolve, reject) => {
            jmapCompact({ type: 'jmap-compact' }, { keep }, { db, redis, loggelf: () => {}, config }, err => {
                if (err) return reject(err);
                resolve();
            });
        });

        // redis list should be trimmed to 'keep'
        const len = await redis.llen('jmap:changes:' + testUser);
        expect(len).to.be.at.most(keep);

        // mongo should contain older entries
        const count = await db.database.collection('jmap_changes').countDocuments({ user: testUser });
        expect(count).to.be.at.least(1);
    });
});
