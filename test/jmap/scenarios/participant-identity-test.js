/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
'use strict';

// Catalogue file calendars.yaml, phase 6: ParticipantIdentity/get, /changes and /set (PID), derived
// from the user's addresses and fed by REST API address changes.

const crypto = require('crypto');
const { expect } = require('chai');
const { scenario, api, accounts, seed, jmap } = require('../harness');
const instance = require('../harness/instance');

const USING = [jmap.URN.core, jmap.URN.calendars];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

const unique = prefix => `${prefix}${crypto.randomBytes(5).toString('hex')}`;
const mailto = address => `mailto:${address}`;

async function setupUser(options) {
    const user = await accounts.createUser(options);
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

const method = (client, name, args = {}) => client.method(name, args, USING);
const pidGet = (client, args = {}) => method(client, 'ParticipantIdentity/get', Object.assign({ ids: null }, args));
const pidSet = (client, args) => method(client, 'ParticipantIdentity/set', args);
const pidChanges = (client, sinceState) => method(client, 'ParticipantIdentity/changes', { sinceState });
const byAddress = (list, address) => list.find(identity => identity.calendarAddress === mailto(address));

const addAddress = async (user, address, extra = {}) => (await api('POST', `/users/${user.id}/addresses`, Object.assign({ address }, extra))).id;
const alias = () => `${unique('al')}@example.com`;

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
    return err.response;
}

describe('Participant identities (PID)', function () {
    this.timeout(60000);

    scenario('PID-001', async () => {
        const { user, client } = await setupUser();
        const second = alias();
        await addAddress(user, second);
        const res = await pidGet(client);
        expect(res.list).to.have.length(2);
        for (const identity of res.list) {
            expect(identity).to.have.all.keys('id', 'name', 'calendarAddress', 'isDefault');
        }
        expect(res.list.map(identity => identity.calendarAddress).sort()).to.deep.equal([mailto(user.address), mailto(second)].sort());
        expect(res.notFound).to.deep.equal([]);
        expect(res.state).to.be.a('string');
    });

    scenario('PID-002', async () => {
        const { user, client } = await setupUser();
        await addAddress(user, alias());
        await addAddress(user, alias());
        const { list } = await pidGet(client);
        expect(list).to.have.length(3);
        const defaults = list.filter(identity => identity.isDefault);
        expect(defaults).to.have.length(1);
        expect(defaults[0].calendarAddress).to.equal(mailto(user.address));
        expect(list.filter(identity => !identity.isDefault).every(identity => identity.isDefault === false)).to.be.true;
    });

    scenario('PID-003', async () => {
        const { user, client } = await setupUser({ name: 'Alice Example' });
        const named = alias();
        const plain = alias();
        await addAddress(user, named, { name: 'Al' });
        await addAddress(user, plain);
        const { list } = await pidGet(client);
        expect(byAddress(list, user.address).name).to.equal('Alice Example');
        expect(byAddress(list, named).name).to.equal('Al');
        expect(byAddress(list, plain).name).to.equal('Alice Example');

        // a user without any name (the REST API refuses an empty one, so it is removed in the database)
        const nameless = await setupUser();
        await (await seed.db()).collection('users').updateOne({ _id: new seed.ObjectId(nameless.user.id) }, { $unset: { name: true } });
        const [identity] = (await pidGet(nameless.client)).list;
        expect(identity.name).to.equal('');
    });

    scenario('PID-004', async () => {
        const { user, client } = await setupUser();
        await addAddress(user, alias());
        const { list } = await pidGet(client);
        const known = list[1].id;
        const res = await pidGet(client, { ids: [known, 'Zunknown'] });
        expect(res.list.map(identity => identity.id)).to.deep.equal([known]);
        expect(res.notFound).to.deep.equal(['Zunknown']);
    });

    scenario('PID-005', async () => {
        const { user, client } = await setupUser();
        await addAddress(user, alias());
        const { list } = await pidGet(client, { properties: ['calendarAddress'] });
        expect(list).to.have.length(2);
        for (const identity of list) {
            expect(identity).to.have.all.keys('id', 'calendarAddress');
        }
        await expectError(pidGet(client, { properties: ['bogus'] }), 'invalidArguments');
    });

    scenario('PID-006', async () => {
        const { user, client } = await setupUser();
        await addAddress(user, alias());
        const first = (await pidGet(client)).list;
        // a JMAP worker started now knows nothing of the earlier request
        const { app, url } = await instance.startInstance();
        let second;
        try {
            const res = await jmap.forUser(user).raw(`${url}/jmap/api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ using: USING, methodCalls: [['ParticipantIdentity/get', { accountId: client.accountId, ids: null }, 'c0']] })
            });
            second = res.json.methodResponses[0][1].list;
        } finally {
            await instance.stopInstance(app);
        }
        const ids = list => Object.fromEntries(list.map(identity => [identity.calendarAddress, identity.id]));
        expect(ids(second)).to.deep.equal(ids(first));
        for (const identity of first) {
            expect(identity.id).to.match(ID);
        }
    });

    scenario('PID-007', async () => {
        const { user, client } = await setupUser();
        const local = unique('Alice.Smith');
        await addAddress(user, `${local}@EXAMPLE.com`);
        const stored = (await api('GET', `/users/${user.id}/addresses`)).results.map(entry => entry.address);
        const expected = `${local.toLowerCase()}@example.com`;
        expect(stored).to.include(expected);
        const { list } = await pidGet(client);
        expect(list.map(identity => identity.calendarAddress)).to.include(`mailto:${expected}`);
        for (const identity of list) {
            expect(identity.calendarAddress.startsWith('mailto:')).to.be.true;
        }
    });

    scenario('PID-008', async () => {
        const domain = `${unique('wild')}.example.org`;
        const { user, client } = await setupUser();
        await addAddress(user, `*@${domain}`, { allowWildcard: true });
        const { list } = await pidGet(client);
        expect(list.map(identity => identity.calendarAddress)).to.deep.equal([mailto(user.address)]);
        expect(list.some(identity => identity.calendarAddress.includes('*'))).to.be.false;
    });

    scenario('PID-009', async () => {
        const { user, client } = await setupUser();
        await addAddress(user, alias());
        const s1 = (await pidGet(client)).state;
        const res = await pidChanges(client, s1);
        expect(res.oldState).to.equal(s1);
        expect(res.newState).to.equal(s1);
        expect(res.hasMoreChanges).to.equal(false);
        expect(res.created).to.deep.equal([]);
        expect(res.updated).to.deep.equal([]);
        expect(res.destroyed).to.deep.equal([]);
    });

    scenario('PID-010', async () => {
        const { user, client } = await setupUser();
        const s1 = (await pidGet(client)).state;
        const second = alias();
        await addAddress(user, second);
        const res = await pidChanges(client, s1);
        expect(res.newState).to.not.equal(s1);
        expect(res.created).to.have.length(1);
        expect(res.updated).to.deep.equal([]);
        expect(res.destroyed).to.deep.equal([]);
        const [identity] = (await pidGet(client, { ids: res.created })).list;
        expect(identity.calendarAddress).to.equal(mailto(second));
        expect(identity.isDefault).to.equal(false);
    });

    scenario('PID-011', async () => {
        const { user, client } = await setupUser();
        const second = alias();
        const addressId = await addAddress(user, second);
        const before = await pidGet(client);
        const aliasId = byAddress(before.list, second).id;
        await api('DELETE', `/users/${user.id}/addresses/${addressId}`);
        const res = await pidChanges(client, before.state);
        expect(res.destroyed).to.deep.equal([aliasId]);
        expect(res.created).to.deep.equal([]);
        expect(res.updated).to.deep.equal([]);
        expect((await pidGet(client, { ids: [aliasId] })).notFound).to.deep.equal([aliasId]);
    });

    scenario('PID-012', async () => {
        const { user, client } = await setupUser();
        const second = alias();
        const addressId = await addAddress(user, second);
        const before = await pidGet(client);
        const idA = byAddress(before.list, user.address).id;
        const idB = byAddress(before.list, second).id;
        await api('PUT', `/users/${user.id}/addresses/${addressId}`, { main: true });
        const res = await pidChanges(client, before.state);
        expect(res.updated.sort()).to.deep.equal([idA, idB].sort());
        const { list } = await pidGet(client, { ids: [idA, idB] });
        expect(list.find(identity => identity.id === idB).isDefault).to.equal(true);
        expect(list.find(identity => identity.id === idA).isDefault).to.equal(false);
        expect(list.filter(identity => identity.isDefault)).to.have.length(1);
    });

    scenario('PID-013', async () => {
        const { user, client } = await setupUser({ name: 'Alice' });
        await addAddress(user, alias());
        const before = await pidGet(client);
        await api('PUT', `/users/${user.id}`, { name: 'Alice B' });
        const res = await pidChanges(client, before.state);
        expect(res.updated.sort()).to.deep.equal(before.list.map(identity => identity.id).sort());
        const { list } = await pidGet(client);
        expect(list.every(identity => identity.name === 'Alice B')).to.be.true;
    });

    scenario('PID-014', async () => {
        const { client } = await setupUser();
        await pidGet(client);
        await expectError(pidChanges(client, 'bogus-state'), 'cannotCalculateChanges');
    });

    scenario('PID-015', async () => {
        const { user, client } = await setupUser();
        const before = await pidGet(client);
        for (const calendarAddress of [mailto(user.address), 'mailto:someone@elsewhere.example.net']) {
            const res = await pidSet(client, { create: { k1: { name: 'X', calendarAddress } } });
            expect(res.notCreated.k1.type).to.equal('forbidden');
            expect(res.created).to.equal(null);
            expect(res.newState).to.equal(res.oldState);
        }
        expect(await pidGet(client)).to.deep.equal(before);
    });

    scenario('PID-016', async () => {
        const { client } = await setupUser();
        const before = await pidGet(client);
        const id = before.list[0].id;
        for (const patch of [{ name: 'New name' }, { calendarAddress: 'mailto:other@example.net' }]) {
            const res = await pidSet(client, { update: { [id]: patch } });
            expect(res.notUpdated[id].type).to.equal('forbidden');
        }
        expect(await pidGet(client)).to.deep.equal(before);
    });

    scenario('PID-017', async () => {
        const { user, client } = await setupUser();
        const second = alias();
        await addAddress(user, second);
        const before = await pidGet(client);
        const aliasId = byAddress(before.list, second).id;
        const res = await pidSet(client, { destroy: [aliasId, 'Zunknown'] });
        expect(res.notDestroyed[aliasId].type).to.equal('forbidden');
        expect(res.notDestroyed.Zunknown.type).to.equal('notFound');
        expect((await pidGet(client)).list).to.have.length(2);
    });

    scenario('PID-018', async () => {
        const { user, client } = await setupUser();
        const second = alias();
        await addAddress(user, second);
        const before = await pidGet(client);
        const idB = byAddress(before.list, second).id;
        for (const onSuccessSetIsDefault of [idB, 'Zunknown']) {
            const res = await pidSet(client, { onSuccessSetIsDefault });
            expect(res.updated === null || Object.keys(res.updated).length === 0).to.be.true;
            expect(res.newState).to.equal(res.oldState);
        }
        const defaults = (await pidGet(client)).list.filter(identity => identity.isDefault);
        expect(defaults.map(identity => identity.calendarAddress)).to.deep.equal([mailto(user.address)]);
    });

    scenario('PID-019', async () => {
        const { user, client } = await setupUser();
        await pidGet(client);
        await expectError(pidSet(client, { ifInState: 'wrong', create: { k1: { calendarAddress: mailto(user.address) } } }), 'stateMismatch');
    });
});
