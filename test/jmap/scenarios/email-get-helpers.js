'use strict';

// Shared helpers of the Email/get scenario files (catalogue file email-get.yaml): a user with a
// JMAP client, IMAP APPEND that answers the Email id, Email/get shortcuts and blob downloads.

const { expect } = require('chai');
const libqp = require('libqp');
const { accounts, seed, jmap } = require('../harness');

const CRLF = '\r\n';

/** Joins lines with CRLF into a raw message Buffer; a string body may follow the header lines. */
const raw = (...lines) => Buffer.from(lines.join(CRLF), 'binary');

/** A plain message with the given header lines (array) and body text */
const message = (headers, body = 'Body text') => raw(...headers, '', body);

const imapSessions = new Map();

/** One IMAP session per user, kept open for the run (closed by the root after hook). */
function imapFor(user) {
    if (!imapSessions.has(user.id)) {
        imapSessions.set(user.id, seed.imap(user));
    }
    return imapSessions.get(user.id);
}

const mailboxIds = new Map();

/** The id of a mailbox of the user by path (database lookup, cached). */
async function mailboxId(user, path) {
    const key = `${user.id}:${path}`;
    if (!mailboxIds.has(key)) {
        const db = await seed.db();
        const doc = await db.collection('mailboxes').findOne({ user: new seed.ObjectId(user.id), path }, { projection: { _id: true } });
        if (!doc) {
            throw new Error(`no mailbox ${path}`);
        }
        mailboxIds.set(key, doc._id);
    }
    return mailboxIds.get(key);
}

/** The Email id of the message with the given UID in a mailbox. */
async function emailIdOf(user, path, uid) {
    const db = await seed.db();
    const doc = await db
        .collection('messages')
        .findOne({ user: new seed.ObjectId(user.id), mailbox: await mailboxId(user, path), uid }, { projection: { _id: true, root: true } });
    if (!doc) {
        throw new Error(`no message ${uid} in ${path}`);
    }
    return 'M' + (doc.root || doc._id).toString();
}

/**
 * Appends a message over IMAP and answers its Email id and UID.
 *
 * @param {Object} user
 * @param {Buffer|String} content Raw message
 * @param {Object} [options] {mailbox: 'INBOX', flags: [], date}
 */
async function append(user, content, options = {}) {
    const client = await imapFor(user);
    const path = options.mailbox || 'INBOX';
    const result = await client.append(path, content, options.flags || [], options.date);
    if (!result || !result.uid) {
        throw new Error('APPEND did not answer a UID');
    }
    return { id: await emailIdOf(user, path, result.uid), uid: result.uid, mailbox: path };
}

/** Appends several messages and answers their Email ids in order. */
async function appendAll(user, contents, options) {
    const ids = [];
    for (const content of contents) {
        ids.push((await append(user, content, options)).id);
    }
    return ids;
}

/** A new user with a JMAP client that has read the session. */
async function newUser(options) {
    const user = await accounts.createUser(options);
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

/** Email/get answering the arguments (throws on a method error). */
const get = (client, ids, args = {}) => client.method('Email/get', Object.assign({ ids: [].concat(ids) }, args));

/** Email/get of one id answering the Email object (fails when it is not found). */
async function getOne(client, id, args = {}) {
    const res = await get(client, id, args);
    expect(res.notFound, `Email ${id} not found`).to.deep.equal([]);
    expect(res.list).to.have.length(1);
    return res.list[0];
}

/** Appends one message and answers its Email object for the given arguments. */
async function appendAndGet(ctx, content, args = {}, options) {
    const { id } = await append(ctx.user, content, options);
    return getOne(ctx.client, id, args);
}

/** Answers the error type of an Email/get call that must fail. */
async function getError(client, args) {
    try {
        await client.method('Email/get', args);
    } catch (err) {
        if (err.type) {
            return err;
        }
        throw err;
    }
    throw new Error('Email/get did not fail');
}

/** Expects an Email/get call to answer invalidArguments. */
async function expectInvalid(client, args, label) {
    const err = await getError(client, args);
    expect(err.type, label || JSON.stringify(args)).to.equal('invalidArguments');
    return err;
}

/** Downloads a blob, answers the bytes (fails on anything but 200). */
async function download(client, blobId, name = 'blob') {
    const res = await client.raw(`/jmap/download/${client.accountId}/${blobId}/${name}`);
    expect(res.status, `download of ${blobId}`).to.equal(200);
    return res.body;
}

/**
 * IMAP FETCH BODY[section] of a message with the transfer encoding removed (WildDuck IMAP has no
 * BINARY extension, so the test decodes it).
 */
async function imapDecodedPart(user, path, uid, section, encoding) {
    const client = await imapFor(user);
    await client.mailboxOpen(path);
    const fetched = await client.fetchOne(String(uid), { bodyParts: [section] }, { uid: true });
    const content = fetched.bodyParts.get(section);
    switch ((encoding || '').toLowerCase()) {
        case 'base64':
            return Buffer.from(content.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
        case 'quoted-printable':
            return libqp.decode(content.toString('latin1'));
        default:
            return content;
    }
}

/** Every leaf part of a bodyStructure in tree order */
function leaves(part, list = []) {
    if (part.subParts) {
        part.subParts.forEach(sub => leaves(sub, list));
    } else {
        list.push(part);
    }
    return list;
}

/** Every part of a bodyStructure in tree order, multiparts included */
function allParts(part, list = []) {
    list.push(part);
    (part.subParts || []).forEach(sub => allParts(sub, list));
    return list;
}

/**
 * Builds a MIME entity from a header list and either a body string or child entities.
 *
 * @param {String[]} headers Header lines of the entity
 * @param {String|Array} body Body text, or a list of child entities (strings) for a multipart
 * @param {String} [boundary]
 */
function entity(headers, body, boundary) {
    if (Array.isArray(body)) {
        const parts = body.map(child => `--${boundary}${CRLF}${child}${CRLF}`).join('');
        return [...headers, '', `${parts}--${boundary}--`, ''].join(CRLF);
    }
    return [...headers, '', body].join(CRLF);
}

let boundaryCounter = 0;

/** A multipart entity of the given subtype with child entities */
function multipart(subtype, children, extraHeaders = []) {
    const boundary = `b${++boundaryCounter}_${Date.now().toString(36)}`;
    return entity([`Content-Type: multipart/${subtype}; boundary="${boundary}"`, ...extraHeaders], children, boundary);
}

/** A leaf entity */
const part = (headers, body) => entity([].concat(headers), body);

/** A whole message: top level headers prepended to an entity (multipart() or part()) */
const top = (headers, body) => Buffer.from([...headers, ''].join(CRLF) + body, 'binary');

const DEFAULT_TOP = ['From: Sender <sender@example.net>', 'To: Recipient <recipient@example.com>', 'Subject: Email get scenario', 'MIME-Version: 1.0'];

/** A whole message with the default top level headers */
const mime = (body, headers = DEFAULT_TOP) => top(headers, body);

// leaf entities and checks shared by the body scenario files
// entities are binary strings of the message octets, so Unicode text is stored as its UTF-8 bytes
const utf8 = value => Buffer.from(value, 'utf8').toString('binary');
const text = (body, headers = ['Content-Type: text/plain; charset=utf-8']) => part(headers, utf8(body));
const html = (body, headers = ['Content-Type: text/html; charset=utf-8']) => part(headers, utf8(body));
const attachment = (type, name, body, extra = []) =>
    part([`Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, ...extra], body);
const base64 = (headers, content) =>
    part([...headers, 'Content-Transfer-Encoding: base64'], Buffer.from(content).toString('base64').replace(/.{76}/g, '$&\r\n'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

// a leaf part: subParts null or absent
const noSubParts = entry => entry.subParts === null || entry.subParts === undefined;
const ids = list => list.map(entry => entry.partId);

module.exports = {
    text,
    html,
    attachment,
    base64,
    PNG,
    noSubParts,
    ids,
    CRLF,
    raw,
    message,
    imapFor,
    mailboxId,
    emailIdOf,
    append,
    appendAll,
    newUser,
    get,
    getOne,
    appendAndGet,
    getError,
    expectInvalid,
    download,
    imapDecodedPart,
    leaves,
    allParts,
    entity,
    multipart,
    part,
    top,
    mime,
    DEFAULT_TOP
};
