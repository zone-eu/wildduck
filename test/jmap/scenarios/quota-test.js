/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Catalogue file quota.yaml, phase 4: Quota (RFC 9425) over the per user storage quota (QUOTA).

const crypto = require('crypto');
const { expect } = require('chai');
const { scenario, api, accounts, seed, clock, jmap } = require('../harness');
const sse = require('../harness/sse');

const USING = [jmap.URN.core, jmap.URN.mail, jmap.URN.quota];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

async function setupUser(options) {
    const user = await accounts.createUser(options);
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

const method = (client, name, args = {}, using = USING) => client.method(name, args, using);
const quotaGet = (client, args = {}, using) => method(client, 'Quota/get', Object.assign({ ids: null }, args), using);

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
    return err.response;
}

const restUser = async user => (await api('GET', `/users/${user.id}`)).limits.quota;
const setQuota = (user, quota) => api('PUT', `/users/${user.id}`, { quota });

function message(subject = `Quota ${crypto.randomBytes(4).toString('hex')}`, body = 'x'.repeat(2000)) {
    return Buffer.from(
        [
            'From: Sender <sender@example.net>',
            'To: Recipient <recipient@example.com>',
            `Subject: ${subject}`,
            `Message-ID: <${crypto.randomBytes(6).toString('hex')}@quota.example>`,
            `Date: ${new Date().toUTCString()}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=us-ascii',
            '',
            body,
            ''
        ].join('\r\n')
    );
}

/** Delivers a message over LMTP and waits until the REST API counts it; answers the new usage */
async function deliver(user, raw = message()) {
    const before = (await restUser(user)).used;
    await seed.deliver(user.address, raw);
    return clock.waitFor(async () => {
        const used = (await restUser(user)).used;
        return used > before ? used : null;
    });
}

async function inboxOf(client) {
    const res = await client.method('Mailbox/get', { ids: null, properties: ['role'] });
    return res.list.find(mailbox => mailbox.role === 'inbox').id;
}

describe('JMAP Quota (quota.yaml, RFC 9425)', function () {
    this.timeout(60000);
    let client;
    let quotaId;

    before(async () => {
        ({ client } = await setupUser());
        quotaId = (await quotaGet(client)).list[0].id;
    });

    scenario('QUOTA-001', async () => {
        const session = await client.session();
        expect(session.capabilities[jmap.URN.quota]).to.deep.equal({});
        expect(session.accounts[client.accountId].accountCapabilities[jmap.URN.quota]).to.deep.equal({});
        await expectError(quotaGet(client, {}, [jmap.URN.core, jmap.URN.mail]), 'unknownMethod');
        const res = await quotaGet(client);
        expect(res.list).to.have.length(1);
        // a client that lists the quota capability and calls only mail methods
        const mail = await client.call([['Mailbox/get', { accountId: client.accountId, ids: null, properties: ['role'] }, 'm']], USING);
        expect(mail[0][0]).to.equal('Mailbox/get');
    });

    scenario('QUOTA-002', async () => {
        const fresh = await setupUser({ quota: 1073741824 });
        const res = await quotaGet(fresh.client);
        expect(res.state).to.be.a('string');
        expect(res.notFound).to.deep.equal([]);
        expect(res.list).to.have.length(1);
        const [quota] = res.list;
        expect(quota.id).to.match(ID);
        expect(quota.resourceType).to.equal('octets');
        expect(quota.scope).to.equal('account');
        expect(quota.hardLimit).to.equal(1073741824);
        expect(quota.used).to.be.a('number').and.at.least(0);
        expect(Number.isInteger(quota.used)).to.be.true;
        expect(quota.name).to.be.a('string').and.not.empty;
        expect(quota.types).to.deep.equal(['Email']);
    });

    scenario('QUOTA-003', async () => {
        const fresh = await setupUser();
        const used = async () => (await quotaGet(fresh.client)).list[0].used;
        expect(await used()).to.equal(0);
        expect((await restUser(fresh.user)).used).to.equal(0);
        const raw = message();
        const after = await deliver(fresh.user, raw);
        expect(after).to.be.at.least(raw.length);
        expect(await used()).to.equal(after);
        expect(await used()).to.equal((await restUser(fresh.user)).used);
        await seed.withImap(fresh.user, async imap => {
            await imap.mailboxOpen('INBOX');
            await imap.messageDelete('1:*');
        });
        await clock.waitFor(async () => (await restUser(fresh.user)).used === 0, { message: 'usage did not return to 0' });
        expect(await used()).to.equal(0);
        expect(await used()).to.equal((await restUser(fresh.user)).used);
    });

    scenario('QUOTA-004', async () => {
        const a = await setupUser({ quota: 5 * 1024 * 1024 });
        const b = await setupUser();
        expect((await quotaGet(a.client)).list[0].hardLimit).to.equal(5 * 1024 * 1024);
        await setQuota(a.user, 7 * 1024 * 1024);
        expect((await quotaGet(a.client)).list[0].hardLimit).to.equal(7 * 1024 * 1024);
        const defaultLimit = (await restUser(b.user)).allowed;
        expect(defaultLimit).to.be.above(0);
        expect((await quotaGet(b.client)).list[0].hardLimit).to.equal(defaultLimit);
    });

    scenario('QUOTA-005', async () => {
        let res = await quotaGet(client, { ids: [quotaId] });
        expect(res.list.map(quota => quota.id)).to.deep.equal([quotaId]);
        expect(res.notFound).to.deep.equal([]);
        res = await quotaGet(client, { ids: [quotaId, 'nonexistent-quota'] });
        expect(res.list.map(quota => quota.id)).to.deep.equal([quotaId]);
        expect(res.notFound).to.deep.equal(['nonexistent-quota']);
        res = await quotaGet(client, { ids: [] });
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.deep.equal([]);
    });

    scenario('QUOTA-006', async () => {
        let res = await quotaGet(client, { ids: [quotaId], properties: ['used'] });
        expect(Object.keys(res.list[0]).sort()).to.deep.equal(['id', 'used']);
        res = await quotaGet(client, { ids: [quotaId], properties: [] });
        expect(res.list[0]).to.deep.equal({ id: quotaId });
        await expectError(quotaGet(client, { properties: ['nosuch'] }), 'invalidArguments');
        await expectError(quotaGet(client, { ids: quotaId }), 'invalidArguments');
    });

    scenario('QUOTA-007', async () => {
        const responses = await client.call(
            [
                ['Quota/get', { accountId: client.accountId, ids: null }, 'g'],
                ['Quota/query', { accountId: client.accountId }, 'q']
            ],
            [jmap.URN.core, jmap.URN.quota]
        );
        expect(responses[0][0]).to.equal('Quota/get');
        expect(responses[0][1].list).to.deep.equal([]);
        expect(responses[1][0]).to.equal('Quota/query');
        expect(responses[1][1].ids).to.deep.equal([]);
    });

    scenario('QUOTA-008', async () => {
        const [byDefault] = (await quotaGet(client)).list;
        for (const property of ['warnLimit', 'softLimit']) {
            expect(byDefault[property] === null || byDefault[property] === undefined, property).to.be.true;
        }
        const [explicit] = (await quotaGet(client, { properties: ['warnLimit', 'softLimit', 'description'] })).list;
        expect(explicit.warnLimit).to.equal(null);
        expect(explicit.softLimit).to.equal(null);
        expect(explicit.description === null || typeof explicit.description === 'string').to.be.true;
    });

    scenario('QUOTA-009', async () => {
        const other = await setupUser();
        const random = `u${crypto.randomBytes(12).toString('hex')}`;
        for (const accountId of [other.client.accountId, random]) {
            const responses = await client.call(
                [
                    ['Quota/get', { accountId, ids: null }, 'g'],
                    ['Quota/query', { accountId }, 'q'],
                    ['Quota/changes', { accountId, sinceState: 'x' }, 'c'],
                    ['Quota/queryChanges', { accountId, sinceQueryState: 'x' }, 'qc']
                ],
                USING
            );
            for (const [name, args] of responses) {
                expect(name, accountId).to.equal('error');
                expect(args).to.deep.equal({ type: 'accountNotFound' });
            }
        }
    });

    scenario('QUOTA-010', async () => {
        const { state } = await quotaGet(client);
        const first = await method(client, 'Quota/changes', { sinceState: state });
        const second = await method(client, 'Quota/changes', { sinceState: state });
        expect(first).to.deep.equal(second);
        expect(first).to.include({ oldState: state, newState: state, hasMoreChanges: false });
        expect(first.created).to.deep.equal([]);
        expect(first.updated).to.deep.equal([]);
        expect(first.destroyed).to.deep.equal([]);
        expect((await quotaGet(client)).state).to.equal(state);
    });

    scenario('QUOTA-011', async () => {
        const fresh = await setupUser();
        const before = await quotaGet(fresh.client);
        const usedBefore = before.list[0].used;
        await deliver(fresh.user);
        const responses = await fresh.client.call(
            [
                ['Quota/changes', { accountId: fresh.client.accountId, sinceState: before.state }, 'c'],
                [
                    'Quota/get',
                    {
                        accountId: fresh.client.accountId,
                        '#ids': { resultOf: 'c', name: 'Quota/changes', path: '/updated' },
                        '#properties': { resultOf: 'c', name: 'Quota/changes', path: '/updatedProperties' }
                    },
                    'g'
                ]
            ],
            USING
        );
        const [, changes] = responses[0];
        expect(changes.newState).to.not.equal(before.state);
        expect(changes.updated).to.deep.equal([before.list[0].id]);
        expect(changes.created).to.deep.equal([]);
        expect(changes.destroyed).to.deep.equal([]);
        expect(changes.updatedProperties).to.deep.equal(['used']);
        const [, got] = responses[1];
        expect(got.list).to.have.length(1);
        expect(Object.keys(got.list[0]).sort()).to.deep.equal(['id', 'used']);
        expect(got.list[0].used).to.be.above(usedBefore);
        expect(got.list[0].used).to.equal((await restUser(fresh.user)).used);
    });

    scenario('QUOTA-012', async () => {
        const fresh = await setupUser({ quota: 3 * 1024 * 1024 });
        const { state, list } = await quotaGet(fresh.client);
        await setQuota(fresh.user, 4 * 1024 * 1024);
        const changes = await method(fresh.client, 'Quota/changes', { sinceState: state });
        expect(changes.updated).to.deep.equal([list[0].id]);
        expect(changes.updatedProperties).to.equal(null);
        expect(changes.newState).to.not.equal(state);
    });

    scenario('QUOTA-013', async () => {
        await expectError(method(client, 'Quota/changes', {}), 'invalidArguments');
        await expectError(method(client, 'Quota/changes', { sinceState: 42 }), 'invalidArguments');
        await expectError(method(client, 'Quota/changes', { sinceState: 'qneverissued' }), 'cannotCalculateChanges');
        // a well formed state of another account
        const other = await setupUser();
        const foreign = (await quotaGet(other.client)).state;
        await expectError(method(client, 'Quota/changes', { sinceState: foreign }), 'cannotCalculateChanges');
    });

    scenario('QUOTA-014', async () => {
        for (const args of [{}, { filter: null }, { filter: {}, calculateTotal: true }]) {
            const res = await method(client, 'Quota/query', args);
            expect(res.ids).to.deep.equal([quotaId]);
            expect(res.position).to.equal(0);
            expect(res.queryState).to.be.a('string');
            expect(res.canCalculateChanges).to.be.a('boolean');
            if (args.calculateTotal) {
                expect(res.total).to.equal(1);
            }
        }
    });

    scenario('QUOTA-015', async () => {
        const [quota] = (await quotaGet(client)).list;
        const query = async filter => (await method(client, 'Quota/query', { filter })).ids;
        const matching = [{ resourceType: 'octets' }, { scope: 'account' }, { type: 'Email' }, { name: quota.name.slice(1, 5) }];
        const other = [{ resourceType: 'count' }, { scope: 'domain' }, { type: 'Calendar' }, { name: 'zzz' }, { scope: 'account', resourceType: 'count' }];
        for (const filter of matching) {
            expect(await query(filter), JSON.stringify(filter)).to.deep.equal([quotaId]);
        }
        for (const filter of other) {
            expect(await query(filter), JSON.stringify(filter)).to.deep.equal([]);
        }
    });

    scenario('QUOTA-016', async () => {
        const unknown = await method(client, 'Quota/query', { filter: { nosuchproperty: 1 } }).catch(err => err);
        expect(['invalidArguments', 'unsupportedFilter']).to.include(unknown.type);
        await expectError(method(client, 'Quota/query', { filter: { scope: 42 } }), 'invalidArguments');
        await expectError(method(client, 'Quota/query', { filter: { resourceType: ['octets'] } }), 'invalidArguments');
    });

    scenario('QUOTA-017', async () => {
        expect((await method(client, 'Quota/query', { sort: [{ property: 'name' }] })).ids).to.deep.equal([quotaId]);
        expect((await method(client, 'Quota/query', { sort: [{ property: 'used', isAscending: false }] })).ids).to.deep.equal([quotaId]);
        await expectError(method(client, 'Quota/query', { sort: [{ property: 'hardLimit' }] }), 'unsupportedSort');
        const shifted = await method(client, 'Quota/query', { position: 1 });
        expect(shifted.ids).to.deep.equal([]);
        expect(shifted.position).to.equal(1);
        expect((await method(client, 'Quota/query', { limit: 0 })).ids).to.deep.equal([]);
    });

    scenario('QUOTA-018', async () => {
        const res = await method(client, 'Quota/query', {});
        expect(res.canCalculateChanges).to.equal(false);
        await expectError(method(client, 'Quota/queryChanges', { sinceQueryState: res.queryState }), 'cannotCalculateChanges');
        await expectError(method(client, 'Quota/queryChanges', { sinceQueryState: res.queryState, filter: { nosuchproperty: 1 } }), 'invalidArguments');
    });

    scenario('QUOTA-019', async () => {
        const fresh = await setupUser();
        const auth = jmap.basic(fresh.user.username, fresh.user.password);
        const streams = [];
        for (const types of ['Quota', '*']) {
            const es = await sse.open(`/jmap/eventsource/?types=${types}&closeafter=no&ping=0`, { authorization: auth });
            expect(es.status).to.equal(200);
            await es.until(() => es.comments[0], 5000, 'stream not connected');
            streams.push(es);
        }
        await deliver(fresh.user);
        try {
            for (const es of streams) {
                const event = await es.until(
                    () => es.states().find(state => state.json.changed[fresh.client.accountId] && state.json.changed[fresh.client.accountId].Quota),
                    10000,
                    'no Quota state pushed'
                );
                const pushed = event.json.changed[fresh.client.accountId].Quota;
                await clock.waitFor(async () => (await quotaGet(fresh.client)).state === pushed || null, { message: 'pushed state is not the current one' });
                expect((await quotaGet(fresh.client)).state).to.equal(pushed);
            }
        } finally {
            streams.forEach(es => es.close());
        }
    });

    scenario('QUOTA-020', async () => {
        const fresh = await setupUser();
        const used = await deliver(fresh.user);
        await setQuota(fresh.user, used + 512);
        const inbox = await inboxOf(fresh.client);
        const draft = {
            mailboxIds: { [inbox]: true },
            keywords: { $draft: true },
            subject: 'Too big',
            bodyValues: { b: { value: 'z'.repeat(10 * 1024) } },
            textBody: [{ partId: 'b', type: 'text/plain' }]
        };
        const before = await fresh.client.call(
            [
                ['Email/get', { accountId: fresh.client.accountId, ids: [] }, 'e'],
                ['Quota/get', { accountId: fresh.client.accountId, ids: null }, 'q']
            ],
            USING
        );
        const res = await method(fresh.client, 'Email/set', { create: { d: draft } });
        expect(res.notCreated.d.type).to.equal('overQuota');
        expect(res.created === null || res.created === undefined).to.be.true;
        const after = await fresh.client.call(
            [
                ['Email/get', { accountId: fresh.client.accountId, ids: [] }, 'e'],
                ['Quota/get', { accountId: fresh.client.accountId, ids: null }, 'q']
            ],
            USING
        );
        expect(after[0][1].state).to.equal(before[0][1].state);
        expect(after[1][1].state).to.equal(before[1][1].state);
        expect(after[1][1].list[0].used).to.equal(used);
        expect(after[1][1].list[0].hardLimit).to.equal(used + 512);

        await setQuota(fresh.user, used + 1024 * 1024);
        const retried = await method(fresh.client, 'Email/set', { create: { d: draft } });
        expect(retried.created.d.id).to.match(/^M[0-9a-f]{24}$/);
        expect((await quotaGet(fresh.client)).list[0].used).to.be.above(used + 10 * 1024);
    });

    scenario('QUOTA-021', async () => {
        const fresh = await setupUser();
        const filler = message('Filler', 'f'.repeat(20000));
        await deliver(fresh.user, filler);
        const used = (await quotaGet(fresh.client)).list[0].used;
        await setQuota(fresh.user, used + 1000);
        const inbox = await inboxOf(fresh.client);
        const big = message('Import me', 'i'.repeat(5000));
        const upload = await fresh.client.raw(`/jmap/upload/${fresh.client.accountId}/`, {
            method: 'POST',
            body: big,
            headers: { 'Content-Type': 'message/rfc822' }
        });
        expect(upload.status).to.equal(201);
        const entry = { blobId: upload.json.blobId, mailboxIds: { [inbox]: true } };
        const failed = await method(fresh.client, 'Email/import', { emails: { i: entry } });
        expect(failed.notCreated.i.type).to.equal('overQuota');
        expect((await quotaGet(fresh.client)).list[0].used).to.equal(used);
        expect((await fresh.client.method('Email/query', {})).ids).to.have.length(1);

        const [fillerId] = (await fresh.client.method('Email/query', {})).ids;
        const destroyed = await fresh.client.method('Email/set', { destroy: [fillerId] });
        expect(destroyed.destroyed).to.deep.equal([fillerId]);
        await clock.waitFor(async () => (await quotaGet(fresh.client)).list[0].used < used, { message: 'space was not freed' });
        const imported = await method(fresh.client, 'Email/import', { emails: { i: entry } });
        expect(imported.created.i.id).to.match(/^M[0-9a-f]{24}$/);
    });

    scenario('QUOTA-022', async () => {
        const fresh = await setupUser();
        const used = await deliver(fresh.user);
        await setQuota(fresh.user, used);
        const res = await fresh.client.raw(`/jmap/upload/${fresh.client.accountId}/`, {
            method: 'POST',
            body: crypto.randomBytes(1024 * 1024),
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        expect(res.status).to.equal(201);
        const quotas = await quotaGet(fresh.client);
        expect(quotas.list).to.have.length(1);
        expect(quotas.list[0].used).to.equal(used);
    });
});
