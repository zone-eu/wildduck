/* eslint no-unused-expressions: 0 */
/* globals before, after */
'use strict';

// Routing of the main JMAP reads on a sharded cluster laid out like production (messages sharded by
// {mailbox, uid}, the two mailboxes of the test user on different shards). Every query is built by the
// JMAP code itself and explained through mongos: reads of one mailbox go to the shard of that mailbox,
// reads across the account go to every shard and use an index there. Run with npm run test:jmap:sharded.

const { expect } = require('chai');
const { MongoClient, ObjectId, MinKey } = require('mongodb');
const { buildQuery } = require('../../../lib/jmap/email-search');
const { parseSort, databaseSort } = require('../../../lib/jmap/email-sort');
const { visibleQuery } = require('../../../lib/jmap/visibility');

const URL = process.env.JMAP_SHARDED_MONGO || `mongodb://127.0.0.1:${process.env.JMAP_SHARDED_PORT || 27117}`;
const DB_NAME = 'wildduck-sharded';
const NS = `${DB_NAME}.messages`;

// the indexes of indexes.yaml these reads rely on
const INDEXES = [
    { key: { mailbox: 1, idate: -1, _id: -1 }, name: 'by_idate_reverse_uid' },
    { key: { mailbox: 1, idate: -1, _id: -1, thread: 1, uid: 1 }, name: 'by_idate_reverse_thread' },
    { key: { user: 1, idate: -1, _id: -1 }, name: 'user_idate' },
    { key: { user: 1, thread: 1 }, name: 'user_messages_by_thread' },
    { key: { mailbox: 1, unseen: 1 }, name: 'mailbox_unseen_flag' },
    { key: { root: 1 }, name: 'by_root', partialFilterExpression: { root: { $exists: true } } }
];

// shard name -> winning plan of that shard, from the explain of a find or an aggregation through mongos
function shardPlans(explain) {
    const plans = {};
    if (explain.queryPlanner && explain.queryPlanner.winningPlan && explain.queryPlanner.winningPlan.shards) {
        for (const shard of explain.queryPlanner.winningPlan.shards) {
            plans[shard.shardName] = shard.winningPlan;
        }
    }
    for (const [name, shard] of Object.entries(explain.shards || {})) {
        // an aggregation explains every shard part: either a cursor stage or a query planner
        const stages = shard.stages || [];
        const planner = shard.queryPlanner || (stages[0] && stages[0].$cursor && stages[0].$cursor.queryPlanner);
        plans[name] = planner ? planner.winningPlan : shard;
    }
    return plans;
}

const usesIndex = (plan, name) => JSON.stringify(plan).includes(`"indexName":"${name}"`);
const scans = plan => JSON.stringify(plan).includes('COLLSCAN');

describe('JMAP reads on a sharded cluster', function () {
    this.timeout(60000); // eslint-disable-line no-invalid-this

    let client;
    let db;
    let messages;
    const user = new ObjectId();
    const first = new ObjectId();
    const second = new ObjectId();
    let context;

    const shardOf = async mailbox => {
        const explain = await messages.find({ mailbox, uid: 1 }).explain();
        return Object.keys(shardPlans(explain));
    };

    before(async () => {
        client = await MongoClient.connect(URL, { serverSelectionTimeoutMS: 5000 });
        db = client.db(DB_NAME);
        messages = db.collection('messages');
        for (const index of INDEXES) {
            await messages.createIndex(
                index.key,
                Object.assign({ name: index.name }, index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {})
            );
        }

        // the two mailboxes in chunks of their own, on different shards
        const admin = client.db('admin');
        for (const mailbox of [first, second]) {
            await admin.command({ split: NS, middle: { mailbox, uid: new MinKey() } }).catch(() => false);
        }
        const owner = async mailbox => (await shardOf(mailbox))[0];
        const target = (await owner(first)) === 'shard1' ? 'shard2' : 'shard1';
        if ((await owner(second)) !== target) {
            await admin.command({ moveChunk: NS, find: { mailbox: second, uid: 1 }, to: target, _waitForDelete: true });
        }

        await db.collection('mailboxes').insertMany([
            { _id: first, user, path: 'INBOX', uidNext: 21, modifyIndex: 21 },
            { _id: second, user, path: 'Archive', uidNext: 21, modifyIndex: 21 }
        ]);
        const docs = [];
        for (const mailbox of [first, second]) {
            for (let uid = 1; uid <= 20; uid++) {
                const _id = new ObjectId();
                docs.push({
                    _id,
                    root: _id,
                    user,
                    mailbox,
                    uid,
                    thread: user,
                    idate: new Date(Date.now() - uid * 1000),
                    undeleted: true,
                    unseen: uid % 2 === 0
                });
            }
        }
        await messages.insertMany(docs);
        context = { account: { user, id: user.toString() }, deps: { database: db }, cache: {}, options: {} };
    });

    after(async () => {
        if (db) {
            await messages.deleteMany({ user });
            await db.collection('mailboxes').deleteMany({ user });
        }
        if (client) {
            await client.close();
        }
    });

    const queryPlans = async (filter, collapse) => {
        context.cache = {};
        const match = await buildQuery(filter, context);
        const sort = databaseSort(parseSort([{ property: 'receivedAt', isAscending: false }]).comparators);
        const pipeline = [{ $match: match }, { $sort: sort.order }].concat(collapse ? [{ $group: { _id: '$thread', doc: { $first: '$$ROOT' } } }] : [], [
            { $limit: 50 }
        ]);
        return shardPlans(await messages.aggregate(pipeline).explain());
    };

    it('keeps the mailboxes of the user on different shards', async () => {
        expect(await shardOf(first)).to.have.length(1);
        expect(await shardOf(first)).to.not.deep.equal(await shardOf(second));
    });

    it('sends Email/query of one mailbox only to the shard of that mailbox, through a mailbox index', async () => {
        for (const collapse of [false, true]) {
            const plans = await queryPlans({ inMailbox: `F${second}` }, collapse);
            expect(Object.keys(plans), `collapseThreads ${collapse}`).to.deep.equal(await shardOf(second));
            const plan = Object.values(plans)[0];
            expect(usesIndex(plan, 'by_idate_reverse_uid') || usesIndex(plan, 'by_idate_reverse_thread'), JSON.stringify(plan)).to.be.true;
        }
    });

    it('sends Email/query of the whole account to every shard, each through user_idate', async () => {
        const plans = await queryPlans(null, false);
        expect(Object.keys(plans)).to.have.length(2);
        for (const plan of Object.values(plans)) {
            expect(usesIndex(plan, 'user_idate'), JSON.stringify(plan)).to.be.true;
        }
    });

    it('counts a mailbox (Mailbox/get counts) on the shard of that mailbox only', async () => {
        for (const filter of [{}, { unseen: true }]) {
            const plans = shardPlans(await messages.find(Object.assign({ mailbox: first }, filter)).explain());
            expect(Object.keys(plans)).to.deep.equal(await shardOf(first));
            expect(scans(Object.values(plans)[0])).to.be.false;
        }
    });

    it('reads a Thread (Thread/get) on every shard through user_messages_by_thread', async () => {
        context.cache = {};
        const plans = shardPlans(await messages.find(Object.assign(await visibleQuery(context), { thread: { $in: [user] } })).explain());
        expect(Object.keys(plans)).to.have.length(2);
        for (const plan of Object.values(plans)) {
            expect(usesIndex(plan, 'user_messages_by_thread'), JSON.stringify(plan)).to.be.true;
        }
    });

    it('finds Emails by id (Email/get) on every shard through by_root', async () => {
        const roots = (
            await messages
                .find({ user }, { projection: { root: 1 } })
                .limit(5)
                .toArray()
        ).map(doc => doc.root);
        const plans = shardPlans(await messages.find({ user, root: { $in: roots, $exists: true } }).explain());
        expect(Object.keys(plans)).to.have.length(2);
        for (const plan of Object.values(plans)) {
            expect(usesIndex(plan, 'by_root'), JSON.stringify(plan)).to.be.true;
        }
    });
});
