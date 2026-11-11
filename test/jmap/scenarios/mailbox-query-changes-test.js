/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue file mailbox.yaml: Mailbox/queryChanges (phase 4, work package 4.3).

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, jmap } = require('../harness');
const redisUrl = require('../../../lib/redis-url');

const NAME = [{ property: 'name' }];
const KEYS = ['accountId', 'oldQueryState', 'newQueryState', 'removed', 'added'];

const withImap = (user, fn) => seed.withImap(user, fn);

/** A new user with the default mailboxes plus `paths` created over IMAP, and a JMAP client */
async function setup(paths = []) {
    const user = await accounts.createUser();
    await withImap(user, async imap => {
        for (const path of paths) {
            await imap.mailboxCreate(path);
        }
    });
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

/** path -> JMAP mailbox id */
async function idsOf(user) {
    const res = await api('GET', `/users/${user.id}/mailboxes`);
    return Object.fromEntries(res.results.map(mailbox => [mailbox.path, `F${mailbox.id}`]));
}

const mquery = (client, args) => client.method('Mailbox/query', args);
const mchanges = (client, args) => client.method('Mailbox/queryChanges', args);

async function errorOf(client, args) {
    const [[name, response]] = await client.call([['Mailbox/queryChanges', Object.assign({ accountId: true }, args), 'c0']]);
    return name === 'error' ? response.type : null;
}

/** Applies a /queryChanges response to a list (RFC 8620 5.6) */
function apply(list, changes) {
    const removed = new Set(changes.removed);
    const result = list.filter(id => !removed.has(id));
    for (const item of [...changes.added].sort((a, b) => a.index - b.index)) {
        result.splice(item.index, 0, item.id);
    }
    return result;
}

describe('Mailbox/queryChanges (mailbox.yaml)', () => {
    scenario('MBX-122', async () => {
        const { client } = await setup();
        const before = await mquery(client, { sort: NAME });
        expect(before.canCalculateChanges).to.be.true;
        const res = await mchanges(client, { sort: NAME, filter: null, sinceQueryState: before.queryState });
        expect(res).to.have.all.keys(KEYS);
        expect(res).to.deep.equal({ accountId: client.accountId, oldQueryState: before.queryState, newQueryState: before.queryState, removed: [], added: [] });
    });

    scenario('MBX-123', async () => {
        const { user, client } = await setup(['A', 'C']);
        const args = { filter: { hasAnyRole: false }, sort: NAME };
        const before = await mquery(client, args);
        await withImap(user, imap => imap.mailboxCreate('B'));
        const res = await mchanges(client, Object.assign({ sinceQueryState: before.queryState }, args));
        const ids = await idsOf(user);
        expect(res.removed).to.deep.equal([]);
        expect(res.added).to.deep.equal([{ id: ids.B, index: 1 }]);
        expect(res.newQueryState).to.equal((await mquery(client, args)).queryState);
    });

    scenario('MBX-124', async () => {
        const { user, client } = await setup(['A', 'B', 'C']);
        const ids = await idsOf(user);
        const before = await mquery(client, { sort: NAME });
        await withImap(user, imap => imap.mailboxDelete('B'));
        const res = await mchanges(client, { sort: NAME, sinceQueryState: before.queryState });
        expect(res.removed).to.deep.equal([ids.B]);
        expect(res.added).to.deep.equal([]);
    });

    scenario('MBX-125', async () => {
        const { user, client } = await setup(['A', 'B', 'C']);
        const ids = await idsOf(user);
        const args = { filter: { hasAnyRole: false }, sort: [{ property: 'name', isAscending: true }] };
        const before = await mquery(client, args);
        expect(before.ids).to.deep.equal([ids.A, ids.B, ids.C]);
        await withImap(user, imap => imap.mailboxRename('A', 'D'));
        const res = await mchanges(client, Object.assign({ sinceQueryState: before.queryState }, args));
        expect(res.removed).to.deep.equal([ids.A]);
        expect(res.added).to.deep.equal([{ id: ids.A, index: 2 }]);
        expect(apply(before.ids, res)).to.deep.equal((await mquery(client, args)).ids);
    });

    scenario('MBX-126', async () => {
        const { user, client } = await setup(['S1', 'S2', 'S3']);
        await withImap(user, imap => imap.mailboxUnsubscribe('S3'));
        const ids = await idsOf(user);
        const args = { filter: { isSubscribed: true } };
        const before = await mquery(client, args);
        expect(before.ids).to.include.members([ids.S1, ids.S2]).and.not.include(ids.S3);
        await withImap(user, async imap => {
            await imap.mailboxUnsubscribe('S1');
            await imap.mailboxSubscribe('S3');
        });
        const res = await mchanges(client, Object.assign({ sinceQueryState: before.queryState }, args));
        const after = (await mquery(client, args)).ids;
        expect(res.removed).to.deep.equal([ids.S1]);
        expect(res.added).to.deep.equal([{ id: ids.S3, index: after.indexOf(ids.S3) }]);
        expect(apply(before.ids, res)).to.deep.equal(after);
    });

    scenario('MBX-127', async () => {
        const { user, client } = await setup();
        const before = await mquery(client, { sort: NAME });
        await seed.deliver(user.address, await fixtures.buildMessage({ subject: 'Count only 127' }));
        const res = await mchanges(client, { sort: NAME, sinceQueryState: before.queryState });
        expect(res.removed).to.deep.equal([]);
        expect(res.added).to.deep.equal([]);
    });

    scenario('MBX-128', async () => {
        const { user, client } = await setup();
        const before = await mquery(client, {});
        const created = ['N1', 'N2', 'N3', 'N4', 'N5'];
        await withImap(user, async imap => {
            for (const path of created) {
                await imap.mailboxCreate(path);
            }
        });
        expect(await errorOf(client, { sinceQueryState: before.queryState, maxChanges: 2 })).to.equal('tooManyChanges');
        const res = await mchanges(client, { sinceQueryState: before.queryState, maxChanges: 5 });
        const ids = await idsOf(user);
        expect(res.added.map(item => item.id)).to.have.members(created.map(path => ids[path]));
        expect(res.removed).to.deep.equal([]);
    });

    scenario('MBX-129', async () => {
        const { user, client } = await setup();
        const before = await mquery(client, {});
        await withImap(user, imap => imap.mailboxCreate('Extra'));
        const res = await mchanges(client, { sinceQueryState: before.queryState, calculateTotal: true });
        expect(res.total).to.equal(6);
    });

    scenario('MBX-130', async () => {
        const { user, client } = await setup(['A', 'B', 'C']);
        const args = { filter: { hasAnyRole: false }, sort: NAME };
        const before = await mquery(client, args);
        await withImap(user, imap => imap.mailboxCreate('D'));
        const ids = await idsOf(user);
        const res = await mchanges(client, Object.assign({ sinceQueryState: before.queryState, upToId: ids.B }, args));
        expect(res.added.length === 0 || (res.added.length === 1 && res.added[0].id === ids.D && res.added[0].index === 3), JSON.stringify(res.added)).to.be
            .true;
        expect(res.removed).to.not.include.members([ids.A, ids.B]);
        const unknown = await mchanges(
            client,
            Object.assign({ sinceQueryState: before.queryState, upToId: `F${crypto.randomBytes(12).toString('hex')}` }, args)
        );
        expect(apply(before.ids, unknown)).to.deep.equal((await mquery(client, args)).ids);
    });

    scenario('MBX-131', async () => {
        const { user, client } = await setup();
        expect(await errorOf(client, { sinceQueryState: crypto.randomBytes(16).toString('hex') })).to.equal('cannotCalculateChanges');
        // a state whose cached result is gone, as it is long before the journal retention ends
        const before = await mquery(client, {});
        const redis = new Redis(typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis);
        try {
            expect(await redis.del(`jmap:qc:${user.id}:${before.queryState}`)).to.equal(1);
        } finally {
            redis.disconnect();
        }
        expect(await errorOf(client, { sinceQueryState: before.queryState })).to.equal('cannotCalculateChanges');
    });
});
