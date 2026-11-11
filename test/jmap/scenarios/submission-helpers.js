/* eslint no-unused-expressions: 0 */
'use strict';

// Shared helpers of the EmailSubmission scenario files (catalogue file submission.yaml): an account
// with its identities and mailbox ids, drafts created over JMAP, EmailSubmission calls and views of
// the outbound queue (test/jmap/harness/outbound.js stands in for the MTA).

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { api, seed, jmap, outbound } = require('../harness');
const { account } = require('./email-set-helpers');
const { append, message } = require('./email-get-helpers');

const USING = [jmap.URN.core, jmap.URN.mail, jmap.URN.submission];
const SUBMISSION_ID = /^S[0-9a-f]{24}$/;
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const unique = prefix => `${prefix}${crypto.randomBytes(5).toString('hex')}`;

/** A user with a JMAP client, mailbox ids and the identity of the main address */
async function sender(options) {
    const ctx = await account(options);
    ctx.identities = await identities(ctx);
    ctx.identity = ctx.identities.find(entry => entry.email === ctx.user.address);
    return ctx;
}

/** One method call with the submission capability; answers the response arguments */
const call = (ctx, name, args = {}) => ctx.client.method(name, args, USING);

/** Several method calls; answers the methodResponses */
const calls = (ctx, methodCalls, using = USING) =>
    ctx.client.call(
        methodCalls.map(([name, args, callId]) => [name, Object.assign({ accountId: ctx.client.accountId }, args), callId]),
        using
    );

/** Method calls against another JMAP listener (an in process instance); answers the methodResponses */
async function callsAt(url, ctx, methodCalls) {
    const body = {
        using: USING,
        methodCalls: methodCalls.map(([name, args, callId]) => [name, Object.assign({ accountId: ctx.client.accountId }, args), callId || 'c0'])
    };
    const res = await ctx.client.raw(`${url}/jmap/api/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status, res.body.toString()).to.equal(200);
    return res.json.methodResponses;
}

async function identities(ctx) {
    return (await call(ctx, 'Identity/get')).list;
}

/** Adds an address to the user through the REST API */
const addAddress = (ctx, address, extra = {}) => api('POST', `/users/${ctx.user.id}/addresses`, Object.assign({ address }, extra));

/** The identity of an address, read again after the address was added */
async function identityOf(ctx, email) {
    const found = (await identities(ctx)).find(entry => entry.email.toLowerCase() === email.toLowerCase());
    expect(found, `identity of ${email}`).to.exist;
    return found;
}

const asAddresses = list => [].concat(list || []).map(entry => (typeof entry === 'string' ? { email: entry } : entry));

/**
 * Creates a draft in Drafts with $draft over JMAP.
 *
 * @param {Object} ctx
 * @param {Object} [fields] {from, to, cc, bcc, sender, subject, text, keywords, mailbox, extra}
 * @returns {Promise<{id, threadId, blobId, size}>}
 */
async function createDraft(ctx, fields = {}) {
    const object = Object.assign(
        {
            mailboxIds: { [fields.mailbox || ctx.mb.Drafts]: true },
            keywords: fields.keywords || { $draft: true, $seen: true },
            from: asAddresses(fields.from || ctx.user.address),
            subject: fields.subject || 'Submission scenario',
            textBody: [{ partId: 't', type: 'text/plain' }],
            bodyValues: { t: { value: fields.text || 'Hello from a submission scenario' } }
        },
        fields.to === null ? {} : { to: asAddresses(fields.to || 'rcpt@example.net') },
        fields.cc ? { cc: asAddresses(fields.cc) } : {},
        fields.bcc ? { bcc: asAddresses(fields.bcc) } : {},
        fields.sender ? { sender: asAddresses(fields.sender) } : {},
        fields.extra || {}
    );
    const res = await ctx.client.method('Email/set', { create: { d: object } });
    expect(res.notCreated, JSON.stringify(res.notCreated)).to.equal(null);
    return res.created.d;
}

/** Appends a raw message over IMAP (Drafts by default); answers its Email id */
async function appendRaw(ctx, headers, body = 'Body text', mailbox = 'Drafts') {
    return (await append(ctx.user, Buffer.isBuffer(headers) ? headers : message(headers, body), { mailbox, flags: ['\\Draft'] })).id;
}

/** EmailSubmission/set with the given arguments; answers the response arguments of the first response */
const submissionSet = (ctx, args) => call(ctx, 'EmailSubmission/set', args);

/** EmailSubmission/set create of one submission under s1 */
const submit = (ctx, object, extra = {}) => submissionSet(ctx, Object.assign({ create: { s1: object } }, extra));

/** Submits an Email with the main identity (or extra.identityId) */
const submitEmail = (ctx, emailId, extra = {}) => submit(ctx, Object.assign({ identityId: ctx.identity.id, emailId }, extra));

/** Asserts a create succeeded; answers the created object */
function expectCreated(res, creationId = 's1') {
    expect(res.notCreated || {}, JSON.stringify(res.notCreated)).to.not.have.property(creationId);
    expect(res.created, JSON.stringify(res)).to.have.property(creationId);
    expect(res.created[creationId].id).to.match(SUBMISSION_ID);
    return res.created[creationId];
}

/** Asserts a create failed with the type; answers the SetError */
function expectNotCreated(res, type, creationId = 's1') {
    expect((res.created || {})[creationId], JSON.stringify(res)).to.equal(undefined);
    expect(res.notCreated, JSON.stringify(res)).to.have.property(creationId);
    expect(res.notCreated[creationId].type, JSON.stringify(res.notCreated[creationId])).to.equal(type);
    return res.notCreated[creationId];
}

/** Asserts an invalidProperties SetError naming exactly these properties */
function expectProperties(error, properties) {
    expect(error.type, JSON.stringify(error)).to.equal('invalidProperties');
    expect([...error.properties].sort()).to.deep.equal([...properties].sort());
}

/** Runs a call that must fail with a method error; answers the error arguments */
async function methodError(ctx, name, args, using = USING) {
    const [[responseName, responseArgs]] = await calls(ctx, [[name, args, 'c0']], using);
    expect(responseName, JSON.stringify(responseArgs)).to.equal('error');
    return responseArgs;
}

/** One submission by id */
async function getSubmission(ctx, id, properties) {
    const res = await call(ctx, 'EmailSubmission/get', Object.assign({ ids: [id] }, properties ? { properties } : {}));
    expect(res.notFound, `submission ${id}`).to.deep.equal([]);
    return res.list[0];
}

/** The EmailSubmission state */
const submissionState = async ctx => (await call(ctx, 'EmailSubmission/get', { ids: [] })).state;

/** The stored record of a submission (database view) */
async function recordOf(id) {
    const db = await seed.db();
    return db.collection('jmapsubmissions').findOne({ _id: new seed.ObjectId(id.slice(1)) });
}

/** The queue id of a submission */
const queueIdOf = async id => (await recordOf(id)).queueId;

/** Messages the user has in the outbound queue: queue ids of the stored queue files */
async function queuedMessages(ctx) {
    const db = await outbound.senderDb();
    const files = await db
        .collection(`${config.sender.gfs}.files`)
        .find({ 'metadata.data.userId': ctx.user.id }, { projection: { filename: true } })
        .toArray();
    return files.map(entry => entry.filename.replace(/^message /, ''));
}

/** Queue entries of the user's queued messages */
async function queueEntriesOf(ctx) {
    const entries = [];
    for (const queueId of await queuedMessages(ctx)) {
        entries.push(...(await outbound.entries(queueId)));
    }
    return entries;
}

/** Recipients the account sent to in the current window (REST API limits.recipients.used) */
const recipientsUsed = async ctx => (await api('GET', `/users/${ctx.user.id}`)).limits.recipients.used;

/** Asserts that nothing was queued for the user since `before` (queuedMessages) and the counter is unchanged */
async function expectNothingQueued(ctx, before = [], counter) {
    expect(await queuedMessages(ctx)).to.deep.equal(before);
    if (counter !== undefined) {
        expect(await recipientsUsed(ctx)).to.equal(counter);
    }
}

/** Email/get of one Email */
async function emailOf(ctx, id, properties) {
    const res = await ctx.client.method('Email/get', { ids: [id], properties });
    return res.list[0] || null;
}

/** Delivers a queued message of a submission to its local recipients (the MTA of the test rig) */
async function deliverSubmission(id, options) {
    return outbound.deliver(await queueIdOf(id), options);
}

/** The Email ids in the INBOX of a user, newest first */
async function inbox(ctx) {
    return (await ctx.client.method('Email/query', { filter: { inMailbox: ctx.mb.INBOX }, sort: [{ property: 'receivedAt', isAscending: false }] })).ids;
}

module.exports = {
    USING,
    SUBMISSION_ID,
    UTC_DATE,
    unique,
    sender,
    call,
    calls,
    callsAt,
    identities,
    identityOf,
    addAddress,
    createDraft,
    appendRaw,
    submissionSet,
    submit,
    submitEmail,
    expectCreated,
    expectNotCreated,
    expectProperties,
    methodError,
    getSubmission,
    submissionState,
    recordOf,
    queueIdOf,
    queuedMessages,
    queueEntriesOf,
    recipientsUsed,
    expectNothingQueued,
    emailOf,
    deliverSubmission,
    inbox
};
