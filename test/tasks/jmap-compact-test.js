/* globals before: false, after: false */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const JmapChanges = require('../../lib/jmap-changes');
const jmapCompact = require('../../lib/tasks/jmap-compact');

describe('JMAP changelog compact task', function () {
    this.timeout(20000);

    let redis;

    before(async () => {
        redis = db.redis;
        await redis.flushdb();
        await db.database.collection('jmap_changes').deleteMany({});
    });

    it('moves older changelog entries to MongoDB and trims redis list', async () => {
        const user = '000000000000000000000000';
        const jc = new JmapChanges(redis);

        // populate more than keep
        const keep = 10;
        for (let i = 0; i < 25; i++) {
            await jc.appendChange(user, { type: i % 3 === 0 ? 'created' : 'updated', id: `msg${i}` });
        }

        // run compact task
        await new Promise((resolve, reject) => {
            jmapCompact({ type: 'jmap-compact' }, { keep }, { db, redis, loggelf: () => {}, config }, err => {
                if (err) return reject(err);
                resolve();
            });
        });

        // redis list should be trimmed to 'keep'
        const len = await redis.llen('jmap:changes:' + user);
        expect(len).to.be.at.most(keep);

        // mongo should contain older entries
        const count = await db.database.collection('jmap_changes').countDocuments({ user });
        expect(count).to.be.at.least(1);
    });
});
