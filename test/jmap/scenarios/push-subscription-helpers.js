'use strict';

// Shared parts of the PushSubscription and Web Push scenarios (push-subscription-test.js and
// web-push-test.js): users with clients for their different credentials, subscriptions created and
// verified against the local push service (harness/push.js), and mail changes made through IMAP,
// LMTP and the REST API.

const crypto = require('crypto');
const { expect } = require('chai');
const { api, accounts, seed, fixtures, clock, jmap } = require('../harness');
const push = require('../harness/push');

const CORE = [jmap.URN.core];
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
// how long "nothing arrives" is observed
const QUIET = 2500;

/** A user with its account id, mailboxes and a client using the account password */
async function createUser(options) {
    const user = await accounts.createUser(options);
    user.accountId = 'u' + user.id;
    user.client = jmap.forUser(user);
    user.boxes = await accounts.mailboxes(user);
    return user;
}

/** A client for an application password of the user */
async function aspClient(user, scopes = ['*']) {
    const res = await api('POST', `/users/${user.id}/asps`, { description: 'push scenario', scopes, generateMobileconfig: false });
    const client = new jmap.JmapClient(jmap.basic(user.username, res.password));
    client.aspId = res.id;
    return client;
}

/** A client for a user access token */
async function tokenClient(user) {
    const token = await accounts.createToken(user);
    const client = new jmap.JmapClient(`Bearer ${token}`);
    client.token = token;
    client.tokenKey = `tn:token:${crypto.createHash('sha256').update(token).digest('hex')}`;
    return client;
}

/** Runs PushSubscription calls with the core capability only and answers the arguments of the first response */
async function call(client, name, args) {
    const [[responseName, responseArgs]] = await client.call([[name, args, 'p']], CORE);
    if (responseName === 'error') {
        const err = new Error(`${name} answered ${responseArgs.type}`);
        err.type = responseArgs.type;
        throw err;
    }
    return responseArgs;
}

const pushGet = (client, args = {}) => call(client, 'PushSubscription/get', args);
const pushSet = (client, args) => call(client, 'PushSubscription/set', args);

/** Answers the method error of a call (or fails when there is none) */
async function methodError(client, name, args) {
    const [[responseName, responseArgs]] = await client.call([[name, args, 'p']], CORE);
    expect(responseName, JSON.stringify(responseArgs)).to.equal('error');
    return responseArgs;
}

/** Creates subscriptions: {creationId: object} -> the set response */
const create = (client, objects) => pushSet(client, { create: objects });

/** Creates one subscription towards a push endpoint and answers its id */
async function subscribe(client, box, extra = {}) {
    const object = Object.assign({ deviceClientId: crypto.randomBytes(6).toString('hex'), url: box.url }, extra);
    if (box.keys && object.keys === undefined) {
        object.keys = { p256dh: box.keys.p256dh, auth: box.keys.auth };
    }
    const res = await create(client, { s: object });
    expect(res.created, JSON.stringify(res.notCreated)).to.have.property('s');
    return res.created.s.id;
}

/** The PushVerification a box received for a subscription */
async function verificationOf(box, id) {
    let found = null;
    await clock.waitFor(
        () => {
            found = box.requests.map(request => box.json(request)).find(body => body['@type'] === 'PushVerification' && body.pushSubscriptionId === id);
            return found;
        },
        { timeout: 10000, message: `no PushVerification for ${id}` }
    );
    return found;
}

/** Sets the verification code of a subscription; answers the set response */
const setCode = (client, id, code) => pushSet(client, { update: { [id]: { verificationCode: code } } });

/** Creates and verifies a subscription; answers its id */
async function verified(client, box, extra) {
    const id = await subscribe(client, box, extra);
    const verification = await verificationOf(box, id);
    const res = await setCode(client, id, verification.verificationCode);
    expect(res.updated, JSON.stringify(res.notUpdated)).to.have.property(id);
    return id;
}

/** The notCreated (or notUpdated) entry of a set response, checked to be invalidProperties of exactly these properties */
function expectInvalid(entry, properties) {
    expect(entry, 'a SetError').to.be.an('object');
    expect(entry.type).to.equal('invalidProperties');
    expect(entry.properties).to.deep.equal(properties);
}

// ---------------------------------------------------------------- mail changes

async function imapOf(user) {
    if (!user.imap || !user.imap.usable) {
        user.imap = await seed.imap(user);
    }
    return user.imap;
}

async function append(user, mailbox = 'INBOX', flags = []) {
    const client = await imapOf(user);
    return client.append(mailbox, await fixtures.buildMessage(), flags);
}

/** Sets a flag on every message in INBOX over IMAP */
async function flag(user, value = '\\Flagged') {
    const client = await imapOf(user);
    const lock = await client.getMailboxLock('INBOX');
    try {
        await client.noop();
        await client.messageFlagsAdd('1:*', [value]);
    } finally {
        lock.release();
    }
}

async function deliver(user, options = {}) {
    const raw = await fixtures.buildMessage(Object.assign({ to: user.address }, options));
    return seed.deliver(user.address, raw);
}

/** Email, Mailbox and Thread states as the get methods answer them */
async function mailStates(user) {
    const responses = await user.client.call([
        ['Email/get', { accountId: user.accountId, ids: [] }, 'e'],
        ['Mailbox/get', { accountId: user.accountId, ids: [] }, 'm'],
        ['Thread/get', { accountId: user.accountId, ids: [] }, 't']
    ]);
    return { Email: responses[0][1].state, Mailbox: responses[1][1].state, Thread: responses[2][1].state };
}

/** The changed map of a StateChange request for the user's account */
const changedOf = (box, request, user) => box.json(request).changed[user.accountId];

/** Waits until a box has `count` StateChange requests and answers them */
async function stateChanges(box, count, timeout = 10000) {
    await clock.waitFor(() => box.stateChanges().length >= count, { timeout, message: `${count} StateChange requests, got ${box.stateChanges().length}` });
    return box.stateChanges();
}

/** Waits a while and checks that a box received exactly `count` requests in total */
async function expectRequests(box, count, ms = QUIET) {
    await clock.delay(ms);
    expect(box.requests.length, 'requests received').to.equal(count);
}

/** The stored subscription documents of a user */
async function storedOf(user) {
    const db = await seed.db();
    return db
        .collection('jmappush')
        .find({ user: new seed.ObjectId(user.id) })
        .toArray();
}

/** Changes a stored subscription (time travel and the like) */
async function patchStored(id, $set) {
    const db = await seed.db();
    await db.collection('jmappush').updateOne({ _id: new seed.ObjectId(id.slice(1)) }, { $set });
}

module.exports = {
    push,
    CORE,
    UTC_DATE,
    QUIET,
    createUser,
    aspClient,
    tokenClient,
    pushGet,
    pushSet,
    methodError,
    create,
    subscribe,
    verificationOf,
    setCode,
    verified,
    expectInvalid,
    append,
    flag,
    deliver,
    mailStates,
    changedOf,
    stateChanges,
    expectRequests,
    storedOf,
    patchStored,
    imapOf
};
