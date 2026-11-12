/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Runs against the local test MongoDB (the database of config/test.toml); skipped when it is not reachable.

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { ChangeLog, changeLogFor } = require('../../../lib/jmap/changelog');

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

    describe('writers committing out of order', () => {
        // Two writers take sequence numbers 1 (A) and 2 (B); B commits first, a client reads the state
        // (sequence 2) and only then A commits, with modSeq 1 below the state the client holds.
        async function lateWrite(changeLog) {
            const seqA = await changeLog.next(user, 'Identity');
            const seqB = await changeLog.next(user, 'Identity');
            const b = new ObjectId();
            await objects().insertOne({ _id: b, user, createdSeq: seqB, modSeq: seqB });
            const s1 = await changeLog.state(user, `u${user}`, 'Identity');
            const a = new ObjectId();
            await objects().insertOne({ _id: a, user, createdSeq: seqA, modSeq: seqA });
            return { a, b, s1 };
        }
        const changesOf = (changeLog, sinceState, maxChanges = 100) =>
            changeLog.changes({ user, accountId: `u${user}`, type: 'Identity', collection: 'jmapunitobjects', sinceState, maxChanges, formatId });

        it('without a window the late write is lost for the state read between the commits', async () => {
            const { a, s1 } = await lateWrite(log);
            // the state did not move: nothing is reported, the client never learns of A
            const result = await changesOf(log, s1);
            expect(result.newState).to.equal(s1);
            expect([...result.created, ...result.updated]).to.not.include(formatId(a));
        });

        it('the safety window reports the late write, as updated', async () => {
            const windowed = new ChangeLog({ database, secret: 'unit', safetyWindow: 32 });
            const { a, b, s1 } = await lateWrite(windowed);
            const result = await changesOf(windowed, s1);
            expect(result.newState).to.equal(s1);
            // created before the state, so updated (the client fetches it); B is reported again too
            expect(result.created).to.be.empty;
            expect(result.updated.sort()).to.deep.equal([formatId(a), formatId(b)].sort());
            expect(result.destroyed).to.be.empty;
        });

        it('keeps created, updated and destroyed apart around the window', async () => {
            const windowed = new ChangeLog({ database, secret: 'unit', safetyWindow: 2 });

            const old = await create();
            const gone = await create();
            const touched = await create();
            const s0 = await windowed.state(user, `u${user}`, 'Identity');
            const fresh = await create();
            await update(touched);
            await destroy([gone]);
            const result = await changesOf(windowed, s0);
            expect(result.created).to.deep.equal([formatId(fresh)]);
            // gone and touched were created inside the window, old before it
            expect(result.updated).to.deep.equal([formatId(touched)]);
            expect(result.destroyed).to.deep.equal([formatId(gone)]);
            expect(result.updated).to.not.include(formatId(old));
        });

        it('pages past a window larger than maxChanges', async () => {
            const windowed = new ChangeLog({ database, secret: 'unit', safetyWindow: 32 });
            for (let i = 0; i < 5; i++) {
                await create();
            }
            const s0 = await windowed.state(user, `u${user}`, 'Identity');
            const later = [];
            for (let i = 0; i < 3; i++) {
                later.push(formatId(await create()));
            }
            const seen = [];
            let since = s0;
            for (let round = 0; round < 10; round++) {
                const result = await changesOf(windowed, since, 2);
                expect(result.created.length + result.updated.length + result.destroyed.length).to.be.at.most(2);
                seen.push(...result.created);
                since = result.newState;
                if (!result.hasMoreChanges) {
                    break;
                }
            }
            expect(since).to.equal(await windowed.state(user, `u${user}`, 'Identity'));
            expect(seen.sort()).to.deep.equal(later.sort());
        });
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

    it('keeps an old state usable while nothing changed since', async () => {
        await create();
        const { seq } = await log.current(user, 'Identity');
        const old = Date.now() - 31 * 24 * 3600 * 1000;
        await database.collection('jmapstate').updateOne({ _id: user }, { $set: { 'seqTime.Identity': new Date(old) } });
        const quiet = log.formatState(`u${user}`, 'Identity', { seq, time: old });
        expect(await changes(quiet)).to.deep.include({ newState: quiet, hasMoreChanges: false, created: [] });
    });

    it('has no more changes when they fill maxChanges exactly', async () => {
        const s0 = await state();
        const ids = [await create(), await create()];
        const result = await changes(s0, 2);
        expect(result.hasMoreChanges).to.be.false;
        expect(result.newState).to.equal(await state());
        expect(result.created.sort()).to.deep.equal(ids.map(formatId).sort());
    });

    it('reports the window ids again up to maxChanges less one', async () => {
        const windowed = new ChangeLog({ database, secret: 'unit', safetyWindow: 32 });
        const early = [];
        for (let i = 0; i < 5; i++) {
            early.push(await create());
        }
        const s0 = await windowed.state(user, `u${user}`, 'Identity');
        const fresh = await create();
        const result = await windowed.changes({
            user,
            accountId: `u${user}`,
            type: 'Identity',
            collection: 'jmapunitobjects',
            sinceState: s0,
            maxChanges: 3,
            formatId
        });
        expect(result.hasMoreChanges).to.be.false;
        expect(result.created).to.deep.equal([formatId(fresh)]);
        // the two most recently changed ids of the window
        expect(result.updated.sort()).to.deep.equal(early.slice(3).map(formatId).sort());
    });

    it('reads entries only up to the given sequence', async () => {
        const a = await create();
        const b = await create();
        const { seq } = await log.current(user, 'Identity');
        const sources = [{ collection: 'jmapunitobjects', formatId }];
        expect((await log.entriesSince(sources, user, 'Identity', 0, 10, formatId, seq - 1)).map(entry => entry.id)).to.deep.equal([formatId(a)]);
        expect((await log.entriesSince(sources, user, 'Identity', 0, 10, formatId)).map(entry => entry.id)).to.deep.equal([formatId(a), formatId(b)]);
    });

    it('creates the change log of the service once, with the configured safety window', () => {
        const contextOf = changes => ({ deps: { database }, options: Object.assign({ accessSecret: 'unit' }, changes ? { changes } : {}) });
        const configured = contextOf({ ownedSafetyWindow: 5 });
        const changeLog = changeLogFor(configured);
        expect(changeLog).to.be.instanceOf(ChangeLog);
        expect(changeLog.safetyWindow).to.equal(5);
        expect(changeLogFor(configured)).to.equal(changeLog);
        expect(changeLogFor(contextOf({ ownedSafetyWindow: 0 })).safetyWindow).to.equal(0);
        expect(changeLogFor(contextOf({})).safetyWindow).to.equal(32);
        expect(changeLogFor(contextOf(null)).safetyWindow).to.equal(32);
    });
});
