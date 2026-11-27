/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Catalogue file email-import-copy.yaml, Email/copy (ECPY). Every WildDuck user has one account, so
// every Email/copy call fails, with the RFC 8620 5.4 error order.

const { expect } = require('chai');
const { scenario, accounts, seed, fixtures, jmap } = require('../harness');

const USING = [jmap.URN.core, jmap.URN.mail];

async function session(user) {
    const client = jmap.forUser(user);
    await client.session();
    return client;
}

/** Runs one call with explicit arguments (no accountId filled in) and answers [name, args] */
async function invoke(client, name, args, using = USING) {
    const [[responseName, responseArgs, ...rest]] = await client.call([[name, args, 'c0']], using);
    expect(rest).to.deep.equal(['c0']);
    return [responseName, responseArgs];
}

async function expectError(client, args, type, using) {
    const [name, response] = await invoke(client, 'Email/copy', args, using);
    expect(name).to.equal('error');
    expect(response.type).to.equal(type);
}

describe('Email/copy', function () {
    this.timeout(60000);
    let user;
    let other;
    let client;
    let emailId;
    let archiveId;

    before(async () => {
        user = await accounts.createUser();
        other = await accounts.createUser();
        client = await session(user);
        const raw = await fixtures.buildMessage({ subject: 'Copy source' });
        await seed.withImap(user, async imap => {
            await imap.append('INBOX', raw);
            await imap.mailboxCreate('Archive').catch(() => false);
        });
        const [[, query]] = await client.call([['Email/query', { accountId: client.accountId }, 'q']]);
        emailId = query.ids[0];
        const [[, mailboxes]] = await client.call([['Mailbox/get', { accountId: client.accountId, ids: null }, 'm']]);
        archiveId = mailboxes.list.find(mailbox => mailbox.name === 'Archive').id;
    });

    const otherAccountId = () => `u${other.id}`;
    const create = () => ({ c: { id: emailId, mailboxIds: { [archiveId]: true } } });

    async function snapshot() {
        const [[, get]] = await client.call([['Email/get', { accountId: client.accountId, ids: [emailId], properties: ['mailboxIds'] }, 'g']]);
        const [[, query]] = await client.call([['Email/query', { accountId: client.accountId, calculateTotal: true }, 'q']]);
        return { state: get.state, total: query.total, found: get.list.length };
    }

    scenario('ECPY-001', async () => {
        const before = await snapshot();
        const res = await client.request({
            using: USING,
            methodCalls: [['Email/copy', { fromAccountId: client.accountId, accountId: client.accountId, create: create() }, 'c0']]
        });
        expect(res.status).to.equal(200);
        expect(res.json.methodResponses).to.have.length(1);
        expect(res.json.methodResponses[0][0]).to.equal('error');
        expect(res.json.methodResponses[0][1].type).to.equal('invalidArguments');
        expect(await snapshot()).to.deep.equal(before);
    });

    scenario('ECPY-002', async () => {
        const before = await snapshot();
        const answers = [];
        for (const fromAccountId of ['unknown', otherAccountId()]) {
            const [name, response] = await invoke(client, 'Email/copy', { fromAccountId, accountId: client.accountId, create: create() });
            answers.push([name, response]);
        }
        for (const [name, response] of answers) {
            expect(name).to.equal('error');
            expect(response).to.deep.equal({ type: 'fromAccountNotFound' });
        }
        expect(answers[0]).to.deep.equal(answers[1]);
        expect(await snapshot()).to.deep.equal(before);
    });

    scenario('ECPY-003', async () => {
        const db = await seed.db();
        const count = () => db.collection('messages').countDocuments({ user: new seed.ObjectId(other.id) });
        const otherBefore = await count();
        for (const accountId of ['unknown', otherAccountId()]) {
            await expectError(client, { fromAccountId: client.accountId, accountId, create: create() }, 'accountNotFound');
        }
        expect(await count()).to.equal(otherBefore);
    });

    scenario('ECPY-004', async () => {
        const accountId = client.accountId;
        await expectError(client, { accountId, create: create() }, 'invalidArguments');
        await expectError(client, { fromAccountId: 5, accountId, create: create() }, 'invalidArguments');
        await expectError(client, { fromAccountId: otherAccountId(), accountId }, 'invalidArguments');
        await expectError(client, { fromAccountId: otherAccountId(), accountId, create: [create().c] }, 'invalidArguments');
    });

    scenario('ECPY-005', async () => {
        const res = await client.request({
            using: USING,
            methodCalls: [
                ['Email/copy', { fromAccountId: client.accountId, accountId: client.accountId, onSuccessDestroyOriginal: true, create: create() }, 'c0']
            ]
        });
        expect(res.status).to.equal(200);
        expect(res.json.methodResponses).to.deep.equal([['error', res.json.methodResponses[0][1], 'c0']]);
        expect(res.json.methodResponses[0][1].type).to.equal('invalidArguments');
        expect((await snapshot()).found).to.equal(1);
    });

    scenario('ECPY-006', async () => {
        const args = { fromAccountId: 'uffffffffffffffffffffffff', accountId: 'ueeeeeeeeeeeeeeeeeeeeeeee', create: create() };
        const [coreName, coreResponse] = await invoke(client, 'Email/copy', args, [jmap.URN.core]);
        expect(coreName).to.equal('error');
        expect(coreResponse.type).to.equal('unknownMethod');
        const [name, response] = await invoke(client, 'Email/copy', args);
        expect(name).to.equal('error');
        expect(response.type).to.equal('accountNotFound');
    });
});
