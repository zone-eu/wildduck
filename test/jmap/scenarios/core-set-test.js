/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
'use strict';

// Catalogue file core.yaml, phase 2: request level behaviour of /set calls (creation ids, createdIds,
// sequential calls, method errors), exercised through Mailbox/set.

const { expect } = require('chai');
const { scenario, accounts, seed, fixtures, jmap } = require('../harness');

const { URN } = jmap;
const USING = [URN.core, URN.mail];

async function setup(paths = []) {
    const user = await accounts.createUser();
    if (paths.length) {
        await seed.withImap(user, async imap => {
            for (const path of paths) {
                await imap.mailboxCreate(path);
            }
        });
    }
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

/** POSTs a Request object (or a raw JSON string) and answers the parsed Response object */
async function request(client, body) {
    const res = await client.request(body);
    expect(res.status, res.body.toString()).to.equal(200);
    return res.json;
}

const mailboxNames = async client => (await client.method('Mailbox/get', { ids: null })).list.map(mailbox => mailbox.name);
const stateOf = async client => (await client.method('Mailbox/get', { ids: [] })).state;

/** Appends `count` messages to the INBOX over IMAP and answers their Email ids */
async function inboxEmails(user, client, count) {
    await seed.withImap(user, async imap => {
        for (let i = 0; i < count; i++) {
            await imap.append('INBOX', await fixtures.buildMessage());
        }
    });
    const inbox = (await client.method('Mailbox/query', { filter: { role: 'inbox' } })).ids[0];
    const ids = (await client.method('Email/query', { filter: { inMailbox: inbox } })).ids;
    expect(ids).to.have.length(count);
    return { inbox, ids };
}

describe('JMAP core /set behaviour (core.yaml)', function () {
    this.timeout(60000);

    scenario('CORE-013', async () => {
        const { client } = await setup();
        const session = await client.session();
        expect(session.capabilities[URN.vacationresponse]).to.deep.equal({});
        expect(session.accounts[client.accountId].accountCapabilities[URN.vacationresponse]).to.deep.equal({});
        expect(session.primaryAccounts[URN.vacationresponse]).to.equal(client.accountId);
    });

    scenario('CORE-057', async () => {
        const { client } = await setup();
        const res = await request(client, {
            using: USING,
            methodCalls: [
                ['Mailbox/set', { accountId: client.accountId, create: { seq: { name: 'Seq' } } }, '0'],
                ['Mailbox/get', { accountId: client.accountId, ids: null }, '1'],
                ['Mailbox/set', { accountId: client.accountId, destroy: ['#seq'] }, '2'],
                ['Mailbox/get', { accountId: client.accountId, ids: null }, '3']
            ]
        });
        const [[, created], [, first], [, destroyed], [, second]] = res.methodResponses;
        expect(created.created.seq).to.exist;
        expect(first.list.map(mailbox => mailbox.name)).to.include('Seq');
        expect(destroyed.destroyed).to.deep.equal([created.created.seq.id]);
        expect(second.list.map(mailbox => mailbox.name)).to.not.include('Seq');
        // each call sees the state the previous one left
        expect(created.newState).to.not.equal(created.oldState);
        expect(first.state).to.equal(created.newState);
        expect(destroyed.oldState).to.equal(first.state);
        expect(destroyed.newState).to.not.equal(destroyed.oldState);
        expect(second.state).to.equal(destroyed.newState);
    });

    scenario('CORE-065', async () => {
        const { client } = await setup();
        const res = await request(client, {
            using: USING,
            methodCalls: [['Mailbox/set', { accountId: client.accountId, create: { k1: { name: 'K1' } } }, '0']]
        });
        expect(res.methodResponses[0][1].created.k1).to.exist;
        expect(res).to.not.have.property('createdIds');
    });

    scenario('CORE-066', async () => {
        const { client } = await setup();
        const res = await request(client, {
            using: USING,
            methodCalls: [['Mailbox/set', { accountId: client.accountId, create: { k2: { name: 'K2' } } }, '0']],
            createdIds: {}
        });
        expect(res.createdIds).to.deep.equal({ k2: res.methodResponses[0][1].created.k2.id });
    });

    scenario('CORE-068', async () => {
        const { user, client } = await setup(['Existing']);
        const existing = (await client.method('Mailbox/get', { ids: null })).list.find(mailbox => mailbox.name === 'Existing').id;
        expect(user).to.exist;
        const res = await request(client, {
            using: USING,
            methodCalls: [['Mailbox/set', { accountId: client.accountId, create: { fresh: { name: 'Fresh' } } }, '0']],
            createdIds: { old: existing }
        });
        expect(res.createdIds).to.deep.equal({ old: existing, fresh: res.methodResponses[0][1].created.fresh.id });
    });

    scenario('CORE-070', async () => {
        const { user, client } = await setup();
        const { ids } = await inboxEmails(user, client, 2);
        const res = await request(client, {
            using: USING,
            methodCalls: [
                ['Mailbox/set', { accountId: client.accountId, create: { newbox: { name: 'New Box' } } }, '0'],
                ['Email/set', { accountId: client.accountId, update: Object.fromEntries(ids.map(id => [id, { mailboxIds: { '#newbox': true } }])) }, '1']
            ]
        });
        const [[, mailboxes], [name, emails]] = res.methodResponses;
        const newbox = mailboxes.created.newbox.id;
        expect(name, JSON.stringify(emails)).to.equal('Email/set');
        expect(Object.keys(emails.updated || {}).sort()).to.deep.equal([...ids].sort());
        expect(emails.notUpdated).to.equal(null);
        const { list } = await client.method('Email/get', { ids, properties: ['mailboxIds'] });
        for (const email of list) {
            expect(email.mailboxIds).to.deep.equal({ [newbox]: true });
        }
    });

    scenario('CORE-071', async () => {
        const { user, client } = await setup();
        const { inbox, ids } = await inboxEmails(user, client, 1);
        const res = await request(client, {
            using: USING,
            methodCalls: [
                ['Email/set', { accountId: client.accountId, update: { [ids[0]]: { mailboxIds: { '#laterbox': true } } } }, '0'],
                ['Mailbox/set', { accountId: client.accountId, create: { laterbox: { name: 'Later Box' } } }, '1']
            ]
        });
        const [[name, emails], [, mailboxes]] = res.methodResponses;
        expect(name, JSON.stringify(emails)).to.equal('Email/set');
        expect(emails.notUpdated[ids[0]].type).to.equal('invalidProperties');
        expect(emails.notUpdated[ids[0]].properties.some(property => property.split('/')[0] === 'mailboxIds')).to.be.true;
        expect(mailboxes.created.laterbox).to.exist;
        const { list } = await client.method('Email/get', { ids, properties: ['mailboxIds'] });
        expect(list[0].mailboxIds).to.deep.equal({ [inbox]: true });
    });

    scenario('CORE-072', async () => {
        const { client } = await setup();
        const res = await request(client, {
            using: USING,
            methodCalls: [
                ['Mailbox/set', { accountId: client.accountId, create: { dup: { name: 'A' } } }, '0'],
                ['Mailbox/set', { accountId: client.accountId, create: { dup: { name: 'B' } } }, '1'],
                ['Mailbox/get', { accountId: client.accountId, ids: ['#dup'] }, '2']
            ],
            createdIds: {}
        });
        const b = res.methodResponses[1][1].created.dup.id;
        const get = res.methodResponses[2][1];
        expect(get.list.map(mailbox => mailbox.id)).to.deep.equal([b]);
        expect(get.list[0].name).to.equal('B');
        expect(res.createdIds).to.deep.equal({ dup: b });
    });

    scenario('CORE-089', async () => {
        const { client } = await setup();
        const max = (await client.session()).capabilities[URN.core].maxObjectsInSet;
        const state = await stateOf(client);
        const names = await mailboxNames(client);
        const unknown = count => Array.from({ length: count }, (value, index) => `F${String(index).padStart(24, '0')}`);
        const create = { a: { name: 'Limit A' }, b: { name: 'Limit B' } };

        const [[name, error]] = await client.call([['Mailbox/set', { accountId: true, create, destroy: unknown(max - 1) }, '0']]);
        expect(name).to.equal('error');
        expect(error.type).to.equal('requestTooLarge');
        expect(await mailboxNames(client)).to.deep.equal(names);
        expect(await stateOf(client)).to.equal(state);

        const res = await client.method('Mailbox/set', { create, destroy: unknown(max - 2) });
        expect(Object.keys(res.created).sort()).to.deep.equal(['a', 'b']);
        expect(Object.keys(res.notDestroyed)).to.have.length(max - 2);
    });

    scenario('CORE-097', async () => {
        const { client } = await setup();
        // a raw body: an object literal with a __proto__ key would set the prototype instead
        const body = `{"using":${JSON.stringify(USING)},"createdIds":{},"methodCalls":[
            ["Mailbox/set",{"accountId":"${client.accountId}","create":{"__proto__":{"name":"Proto"}}},"0"],
            ["Mailbox/get",{"accountId":"${client.accountId}","ids":["#__proto__"]},"1"],
            ["Mailbox/get",{"accountId":"${client.accountId}","ids":["#constructor"]},"2"]]}`;
        const res = await client.request(body);
        expect(res.status).to.equal(200);
        const parsed = JSON.parse(res.body.toString());
        const [[, set], [, byProto], [, byConstructor]] = parsed.methodResponses;
        const created = set.created && Object.hasOwn(set.created, '__proto__');
        const notCreated = set.notCreated && Object.hasOwn(set.notCreated, '__proto__');
        expect(created || notCreated, JSON.stringify(set)).to.be.true;
        if (created) {
            expect(byProto.list.map(mailbox => mailbox.name)).to.deep.equal(['Proto']);
            expect(Object.hasOwn(parsed.createdIds, '__proto__')).to.be.true;
        }
        expect(byConstructor.list).to.deep.equal([]);
        expect(byConstructor.notFound).to.deep.equal(['#constructor']);
        // later requests are unaffected
        expect(await mailboxNames(client)).to.include('INBOX');
    });

    scenario('CORE-111', async () => {
        const { client } = await setup();
        const state = await stateOf(client);
        const names = await mailboxNames(client);
        const [[name, error]] = await client.call([['Mailbox/set', { accountId: true, ifInState: 42, create: { a: { name: 'Never' } } }, '0']]);
        expect(name).to.equal('error');
        expect(error.type).to.equal('invalidArguments');
        expect(await mailboxNames(client)).to.deep.equal(names);
        expect(await stateOf(client)).to.equal(state);
    });

    scenario('CORE-112', async () => {
        const { client } = await setup();
        const names = await mailboxNames(client);
        const [[name, error]] = await client.call([['Mailbox/set', { accountId: true, ifInState: 'not-the-state', create: { a: { name: 'Never' } } }, '0']]);
        expect(name).to.equal('error');
        expect(error.type).to.equal('stateMismatch');
        expect(await mailboxNames(client)).to.deep.equal(names);
    });
});
