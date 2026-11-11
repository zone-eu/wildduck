/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Runs against the local test MongoDB (the database of config/test.toml); skipped when it is not reachable.

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { ChangeLog } = require('../../../lib/jmap/changelog');

const formatId = id => `I${id}`;

describe('JMAP owned change log', function () {
    this.timeout(10000);
    let client;
    let database;
    let log;
    let user;
    const objects = () => database.collection('jmapunitobjects');

    before(async function () {
        try {
            client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
            database = client.db(`${config.dbs.dbname}-changelog-unit`);
            await database.command({ ping: 1 });
        } catch {
            this.skip();
        }
        log = new ChangeLog({ database, secret: 'unit' });
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
    });

    async function create() {
        const seq = await log.next(user, 'Identity');
        const _id = new ObjectId();
        await objects().insertOne({ _id, user, createdSeq: seq, modSeq: seq });
        return _id;
    }
    async function update(id) {
        await objects().updateOne({ _id: id }, { $set: { modSeq: await log.next(user, 'Identity') } });
    }
    async function destroy(ids) {
        const docs = await objects()
            .find({ _id: { $in: ids } })
            .toArray();
        const seq = await log.next(user, 'Identity', docs.length);
        await objects().deleteMany({ _id: { $in: ids } });
        await log.destroyed(
            user,
            'Identity',
            docs.map(doc => ({ id: doc._id, createdSeq: doc.createdSeq })),
            seq
        );
    }
    const state = () => log.state(user, `u${user}`, 'Identity');
    const changes = (sinceState, maxChanges = 100) =>
        log.changes({ user, accountId: `u${user}`, type: 'Identity', collection: 'jmapunitobjects', sinceState, maxChanges, formatId });

    it('reports created, updated and destroyed objects', async () => {
        const a = await create();
        const b = await create();
        const s0 = await state();
        const c = await create();
        await update(a);
        await destroy([b]);
        const result = await changes(s0);
        expect(result).to.deep.include({ oldState: s0, newState: await state(), hasMoreChanges: false });
        expect(result.created).to.deep.equal([formatId(c)]);
        expect(result.updated).to.deep.equal([formatId(a)]);
        expect(result.destroyed).to.deep.equal([formatId(b)]);
    });

    it('leaves out an object created and destroyed after the state', async () => {
        const s0 = await state();
        const a = await create();
        await destroy([a]);
        const result = await changes(s0);
        expect(result.created).to.be.empty;
        expect(result.destroyed).to.be.empty;
        expect(result.newState).to.not.equal(s0);
    });

    it('keeps the state when nothing changed', async () => {
        await create();
        const s0 = await state();
        expect(await state()).to.equal(s0);
        expect(await changes(s0)).to.deep.include({ newState: s0, created: [], updated: [], destroyed: [] });
    });

    it('pages with maxChanges through intermediate states', async () => {
        const s0 = await state();
        const ids = [];
        for (let i = 0; i < 5; i++) {
            ids.push(await create());
        }
        await destroy(ids.slice(0, 2));
        const seen = { created: [], destroyed: [] };
        let since = s0;
        for (let round = 0; round < 10; round++) {
            const result = await changes(since, 2);
            expect(result.created.length + result.updated.length + result.destroyed.length).to.be.at.most(2);
            seen.created.push(...result.created);
            seen.destroyed.push(...result.destroyed);
            since = result.newState;
            if (!result.hasMoreChanges) {
                break;
            }
        }
        expect(since).to.equal(await state());
        expect(seen.created.sort()).to.deep.equal(ids.slice(2).map(formatId).sort());
        // the destroyed objects existed at the intermediate states, so they may come back as destroyed
        expect(seen.destroyed.every(id => ids.slice(0, 2).map(formatId).includes(id))).to.be.true;
    });

    it('refuses foreign, malformed, future and expired states', async () => {
        await create();
        await create();
        const other = await log.state(new ObjectId(), 'uother', 'Identity');
        for (const bad of [other, 'nonsense', 'o1.1.00000000']) {
            await changes(bad).then(
                () => Promise.reject(new Error(`accepted ${bad}`)),
                err => expect(err.type).to.equal('cannotCalculateChanges')
            );
        }
        const future = log.formatState(`u${user}`, 'Identity', { seq: 99, time: Date.now() });
        await changes(future).then(
            () => Promise.reject(new Error('accepted a future state')),
            err => expect(err.type).to.equal('cannotCalculateChanges')
        );
        const expired = log.formatState(`u${user}`, 'Identity', { seq: 1, time: Date.now() - 31 * 24 * 3600 * 1000 });
        await changes(expired).then(
            () => Promise.reject(new Error('accepted an expired state')),
            err => expect(err.type).to.equal('cannotCalculateChanges')
        );
        await changes(5).then(
            () => Promise.reject(new Error('accepted a number')),
            err => expect(err.type).to.equal('invalidArguments')
        );
    });
});
