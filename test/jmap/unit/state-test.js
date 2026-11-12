/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// State strings of the mail types (lib/jmap/state.js). The mailState() tests run against the local test
// MongoDB (the database of config/test.toml) and are skipped when it is not reachable.

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const consts = require('../../../lib/consts');

// a copy of the module of its own: the journal retention is cached in the module, other suites may have filled it
const STATE_MODULE = require.resolve('../../../lib/jmap/state');
delete require.cache[STATE_MODULE];
const { mailState, parseState, formatState, createdAfter } = require(STATE_MODULE);
delete require.cache[STATE_MODULE];

const typeOf = fn => {
    try {
        fn();
    } catch (err) {
        return err.type;
    }
    return null;
};

describe('JMAP mail state strings', () => {
    const context = { options: { accessSecret: 'unit' }, account: { id: 'A1' } };

    it('parses its own state strings and refuses others', () => {
        const anchor = new ObjectId();
        const state = formatState(context, anchor);
        expect(parseState(context, state).equals(anchor)).to.be.true;
        expect(typeOf(() => parseState(context, 5))).to.equal('invalidArguments');
        expect(typeOf(() => parseState(context, 'nonsense'))).to.equal('cannotCalculateChanges');
        expect(typeOf(() => parseState(context, `${anchor}00000000`))).to.equal('cannotCalculateChanges');
        expect(typeOf(() => parseState({ options: { accessSecret: 'unit' }, account: { id: 'A2' } }, state))).to.equal('cannotCalculateChanges');
    });

    it('compares creation times in whole seconds', () => {
        const since = ObjectId.createFromTime(1700000000);
        expect(createdAfter(ObjectId.createFromTime(1700000000).toString(), since)).to.be.false;
        expect(createdAfter(new ObjectId(`${ObjectId.createFromTime(1700000000).toString().slice(0, 8)}ffffffffffffffff`).toString(), since)).to.be.false;
        expect(createdAfter(ObjectId.createFromTime(1700000001).toString(), since)).to.be.true;
    });
});

describe('JMAP mail state', function () {
    this.timeout(10000);
    let client;
    let database;

    before(async function () {
        try {
            client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
            database = client.db(`${config.dbs.dbname}-state-unit`);
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

    // a settings handler answering the journal retention, counting its reads
    const settings = value => ({
        value,
        reads: 0,
        async get(key) {
            expect(key).to.equal('const:journal:time');
            this.reads++;
            return this.value;
        }
    });

    const contextOf = (settingsHandler, changes) => {
        const user = new ObjectId();
        return {
            account: { user, id: user.toString() },
            options: Object.assign({ accessSecret: 'unit' }, changes === undefined ? {} : { changes }),
            deps: { database, settingsHandler },
            cache: {}
        };
    };

    it('reads the journal retention from the settings, and again once the cache time is over', async () => {
        const handler = settings(5 * 3600 * 1000);
        let context = contextOf(handler, { retentionCacheTime: 0 });
        const first = await mailState(context);
        expect(first.retention).to.equal(5 * 3600 * 1000);
        // one read per request
        expect(await mailState(context)).to.deep.equal(first);
        expect(handler.reads).to.equal(1);

        handler.value = 7 * 3600 * 1000;
        context = contextOf(handler, { retentionCacheTime: 0 });
        expect((await mailState(context)).retention).to.equal(7 * 3600 * 1000);
        expect(handler.reads).to.equal(2);
    });

    it('falls back to the default retention when none is set', async () => {
        const handler = settings(null);
        expect((await mailState(contextOf(handler, { retentionCacheTime: 0 }))).retention).to.equal(consts.JOURNAL_TIME);
    });

    it('answers the newest journal entry as the state of the account', async () => {
        const context = contextOf(settings(5 * 3600 * 1000), { retentionCacheTime: 0 });
        const entry = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 10);
        await database.collection('journal').insertOne({ _id: entry, user: context.account.user, command: 'FETCH' });
        const { state, anchor } = await mailState(context);
        expect(anchor.equals(entry)).to.be.true;
        expect(state).to.equal(formatState(context, entry));
        expect(parseState(context, state).equals(entry)).to.be.true;
    });

    it('keeps the journal retention for the cache time', async () => {
        const handler = settings(9 * 3600 * 1000);
        // the earlier tests left the cache expired; this read keeps the value for 60 seconds
        await mailState(contextOf(handler, { retentionCacheTime: 60 }));
        handler.value = 11 * 3600 * 1000;
        expect((await mailState(contextOf(handler, { retentionCacheTime: 60 }))).retention).to.equal(9 * 3600 * 1000);
        expect((await mailState(contextOf(handler))).retention).to.equal(9 * 3600 * 1000);
        expect(handler.reads).to.equal(1);
    });
});
