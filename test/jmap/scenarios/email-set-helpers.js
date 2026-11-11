'use strict';

// Shared helpers of the Email/set scenario files (catalogue file email-set.yaml): an account with
// the JMAP ids of its mailboxes, Email/set shortcuts, IMAP and REST API views of a message.

const { expect } = require('chai');
const { api, accounts, seed, jmap } = require('../harness');
const { append, imapFor, mailboxId, getOne, download, message } = require('./email-get-helpers');

const EMAIL_ID = /^M[0-9a-f]{24}$/;
const THREAD_ID = /^T[0-9a-f]{24}$/;

/**
 * A user with an Archive mailbox, a JMAP client and the mailbox ids.
 *
 * @returns {Promise<{user, client, mb: Object}>} mb maps INBOX, Archive, Drafts, Sent, Trash, Junk to JMAP ids
 */
async function account(options) {
    const user = await accounts.createUser(options);
    await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
    const client = jmap.forUser(user);
    await client.session();
    const { list } = await client.method('Mailbox/get', { properties: ['name', 'role'] });
    const mb = {};
    for (const entry of list) {
        mb[entry.name] = entry.id;
        if (entry.role) {
            mb[entry.role] = entry.id;
        }
    }
    mb.INBOX = mb.inbox;
    mb.Drafts = mb.drafts;
    mb.Sent = mb.sent;
    mb.Trash = mb.trash;
    mb.Junk = mb.junk;
    return { user, client, mb };
}

/** Email/set answering the response arguments (throws on a method error) */
const set = (client, args) => client.method('Email/set', args);

/** Email/set with one update */
const update = (client, id, patch, extra = {}) => set(client, Object.assign({ update: { [id]: patch } }, extra));

/** Email/set with one create; answers the response */
const create = (client, object, extra = {}) => set(client, Object.assign({ create: { c1: object } }, extra));

/** Runs one call and answers the error response arguments */
async function methodError(client, name, args, using) {
    const [[responseName, responseArgs]] = await client.call([[name, Object.assign({ accountId: client.accountId }, args), 'c0']], using);
    expect(responseName, JSON.stringify(responseArgs)).to.equal('error');
    return responseArgs;
}

/** Asserts an update succeeded for the id */
function expectUpdated(res, id) {
    expect(res.notUpdated, JSON.stringify(res.notUpdated)).to.equal(null);
    expect(res.updated).to.have.property(id);
}

/** Asserts an update failed for the id with the type, answers the SetError */
function expectNotUpdated(res, id, type) {
    expect(res.updated, JSON.stringify(res)).to.equal(null);
    expect(res.notUpdated, JSON.stringify(res)).to.have.property(id);
    expect(res.notUpdated[id].type, JSON.stringify(res.notUpdated[id])).to.equal(type);
    return res.notUpdated[id];
}

/** Asserts a create succeeded, answers created.c1 */
function expectCreated(res, creationId = 'c1') {
    expect(res.notCreated, JSON.stringify(res.notCreated)).to.equal(null);
    const created = res.created[creationId];
    expect(created.id).to.match(EMAIL_ID);
    return created;
}

/** Asserts a create failed with the type, answers the SetError */
function expectNotCreated(res, type, creationId = 'c1') {
    expect(res.created, JSON.stringify(res)).to.equal(null);
    expect(res.notCreated, JSON.stringify(res)).to.have.property(creationId);
    expect(res.notCreated[creationId].type, JSON.stringify(res.notCreated[creationId])).to.equal(type);
    return res.notCreated[creationId];
}

/** Asserts an invalidProperties SetError that names exactly these properties (in any order) */
function expectProperties(error, properties) {
    expect(error.type, JSON.stringify(error)).to.equal('invalidProperties');
    expect([...error.properties].sort()).to.deep.equal([...properties].sort());
}

/** Appends a message over IMAP; answers {id, uid, mailbox} */
const seedEmail = (ctx, options = {}) =>
    append(ctx.user, options.content || message([`Subject: ${options.subject || 'Email set scenario'}`, 'From: a@example.com', 'To: b@example.com']), {
        mailbox: options.mailbox,
        flags: options.flags
    });

/** Keywords of an Email */
const keywordsOf = async (ctx, id) => (await getOne(ctx.client, id, { properties: ['keywords'] })).keywords;

/** The Email object with the given properties */
const emailOf = (ctx, id, properties) => getOne(ctx.client, id, { properties });

/** The current mail state */
const state = async client => (await client.method('Email/get', { ids: [] })).state;

/** IMAP FLAGS of a message by UID (a fresh read) */
async function imapFlags(ctx, path, uid) {
    const client = await imapFor(ctx.user);
    await client.mailboxOpen(path);
    const fetched = await client.fetchOne(String(uid), { flags: true, uid: true }, { uid: true });
    return fetched ? [...fetched.flags] : null;
}

/** The message document of an Email id (database view) */
async function docOf(ctx, id) {
    const db = await seed.db();
    const docs = await db
        .collection('messages')
        .find({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(id.slice(1)) })
        .sort({ _id: -1 })
        .toArray();
    return docs[0] || null;
}

/** The mailbox path of a mailbox id */
async function pathOf(ctx, mailbox) {
    const db = await seed.db();
    return (await db.collection('mailboxes').findOne({ _id: new seed.ObjectId(String(mailbox).replace(/^F/, '')) })).path;
}

/** The REST API view of a message by Email id */
async function restMessage(ctx, id) {
    const doc = await docOf(ctx, id);
    return api('GET', `/users/${ctx.user.id}/mailboxes/${doc.mailbox}/messages/${doc.uid}`);
}

/** The REST API listing of a mailbox by path */
async function restListing(ctx, path) {
    const mailbox = await mailboxId(ctx.user, path);
    return (await api('GET', `/users/${ctx.user.id}/mailboxes/${mailbox}/messages?limit=250`)).results;
}

/** The REST API mailbox info by path */
async function restMailbox(ctx, path) {
    const mailbox = await mailboxId(ctx.user, path);
    return api('GET', `/users/${ctx.user.id}/mailboxes/${mailbox}`);
}

/** storageUsed of the user through the REST API */
const storageUsed = async ctx => (await api('GET', `/users/${ctx.user.id}`)).limits.quota.used;

/** Mailbox/get counts of mailbox ids */
async function counts(ctx, ids) {
    const { list } = await ctx.client.method('Mailbox/get', {
        ids,
        properties: ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']
    });
    return Object.fromEntries(list.map(entry => [entry.id, entry]));
}

/** A label created through the REST API, answers its id */
async function createLabel(ctx, name) {
    return (await api('POST', `/users/${ctx.user.id}/labels`, { name })).id;
}

/** A minimal draft for creates */
const draft = (ctx, extra = {}) => Object.assign({ mailboxIds: { [ctx.mb.Drafts]: true } }, extra);

/** The raw message of an Email as a binary string */
const rawOf = async (ctx, blobId) => (await download(ctx.client, blobId)).toString('binary');

/** Uploads bytes, answers the upload response */
async function upload(ctx, content, type = 'application/octet-stream') {
    const res = await ctx.client.raw(`/jmap/upload/${ctx.client.accountId}/`, { method: 'POST', headers: { 'Content-Type': type }, body: content });
    expect(res.status, res.body.toString()).to.equal(201);
    return res.json;
}

/** The header section of a raw message, unfolded field lines */
function headerFields(raw) {
    const end = raw.indexOf('\r\n\r\n');
    return raw
        .slice(0, end < 0 ? raw.length : end)
        .split(/\r\n(?![ \t])/)
        .filter(Boolean);
}

/** The field lines of a raw message header with the given name */
const fieldsNamed = (raw, name) => headerFields(raw).filter(line => line.toLowerCase().startsWith(name.toLowerCase() + ':'));

module.exports = {
    EMAIL_ID,
    THREAD_ID,
    account,
    set,
    update,
    create,
    methodError,
    expectUpdated,
    expectNotUpdated,
    expectCreated,
    expectNotCreated,
    expectProperties,
    seedEmail,
    keywordsOf,
    emailOf,
    state,
    imapFlags,
    docOf,
    pathOf,
    restMessage,
    restListing,
    restMailbox,
    storageUsed,
    counts,
    createLabel,
    draft,
    rawOf,
    upload,
    headerFields,
    fieldsNamed
};
