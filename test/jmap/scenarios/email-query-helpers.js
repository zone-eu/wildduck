/* eslint no-unused-expressions: 0 */
'use strict';

// Shared helpers of the Email/query scenario files (catalogue file email-query.yaml).

const { expect } = require('chai');
const { api, accounts, seed, fixtures, jmap } = require('../harness');

/**
 * A test user with extra mailboxes (created in the given order, so a parent comes before its child),
 * its mailboxes by path and special use, and a JMAP client.
 */
async function setup(paths = [], options) {
    const user = await accounts.createUser(options);
    for (const path of paths) {
        await api('POST', `/users/${user.id}/mailboxes`, { path });
    }
    const boxes = await accounts.mailboxes(user);
    const client = jmap.forUser(user);
    await client.session();
    return { user, boxes, client, mailbox: name => `F${boxes[name].id}` };
}

/**
 * A raw RFC 822 message with CRLF line endings. Header values are written as given, so encoded words
 * and raw UTF-8 can be tested. `headers` adds lines, `date` false leaves the Date header out.
 */
function rawMessage(options = {}) {
    const lines = [];
    const add = (name, value) => value !== undefined && value !== null && value !== false && lines.push(`${name}: ${value}`);
    add('From', options.from === undefined ? 'Sender <sender@example.net>' : options.from);
    add('To', options.to === undefined ? 'Recipient <recipient@example.com>' : options.to);
    add('Cc', options.cc);
    add('Bcc', options.bcc);
    add('Subject', options.subject === undefined ? 'Scenario message' : options.subject);
    add('Date', options.date === undefined ? 'Mon, 01 Jan 2024 10:00:00 +0000' : options.date);
    add('Message-ID', options.messageId);
    for (const line of options.headers || []) {
        lines.push(line);
    }
    lines.push('MIME-Version: 1.0');
    if (options.contentType !== false) {
        lines.push(`Content-Type: ${options.contentType || 'text/plain; charset=utf-8'}`);
        lines.push('Content-Transfer-Encoding: 8bit');
    }
    return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + (options.body === undefined ? 'Hello' : options.body).replace(/\r?\n/g, '\r\n') + '\r\n');
}

/** A raw message of exactly `size` bytes, padded in the body */
function sizedMessage(size, options = {}) {
    const base = rawMessage(Object.assign({}, options, { body: '' }));
    if (base.length > size) {
        throw new Error(`message is already ${base.length} bytes`);
    }
    return rawMessage(Object.assign({}, options, { body: 'x'.repeat(size - base.length) }));
}

/** Adds header lines at the top of a raw message (for example a Bcc that MailComposer would drop) */
const withHeaders = (raw, lines) => Buffer.concat([Buffer.from(lines.map(line => line + '\r\n').join('')), raw]);

/**
 * Appends messages over IMAP in the given order and answers their Email ids, uids and mailbox paths.
 *
 * @param {Object} ctx From setup()
 * @param {Object[]} items {box: path or special use (INBOX by default), raw: Buffer or message: buildMessage options, flags, date}
 * @returns {Promise<{id: String, uid: Number, path: String}[]>}
 */
async function append(ctx, items) {
    const raws = await Promise.all(items.map(item => item.raw || fixtures.buildMessage(item.message || {})));
    const placed = await seed.withImap(ctx.user, async client => {
        const result = [];
        for (const [index, item] of items.entries()) {
            const mailbox = ctx.boxes[item.box || 'INBOX'];
            const res = await client.append(mailbox.path, raws[index], item.flags || [], item.date);
            result.push({ mailbox: mailbox.id, path: mailbox.path, uid: res.uid });
        }
        return result;
    });
    return resolveIds(ctx.user, placed);
}

/** Email ids of stored messages, from {mailbox, uid} pairs */
async function resolveIds(user, placed) {
    const db = await seed.db();
    const docs = await db
        .collection('messages')
        .find(
            { user: new seed.ObjectId(user.id), $or: placed.map(entry => ({ mailbox: new seed.ObjectId(entry.mailbox), uid: entry.uid })) },
            { projection: { root: true, mailbox: true, uid: true } }
        )
        .toArray();
    return placed.map(entry => {
        const doc = docs.find(item => item.mailbox.toString() === entry.mailbox && item.uid === entry.uid);
        expect(doc, `message ${entry.uid} in ${entry.path}`).to.exist;
        return Object.assign({ id: `M${(doc.root || doc._id).toString()}` }, entry);
    });
}

/** Runs an IMAP command on one mailbox of the user and logs out */
const imapIn = (ctx, path, fn) =>
    seed.withImap(ctx.user, async client => {
        await client.mailboxOpen(ctx.boxes[path] ? ctx.boxes[path].path : path);
        return fn(client);
    });

/** Email/query; throws for an error response */
const query = (ctx, args = {}) => ctx.client.method('Email/query', args);

/** The ids of an Email/query with the filter and extra arguments */
const idsOf = async (ctx, filter, args = {}) => (await query(ctx, Object.assign({ filter }, args))).ids;

/** The error type of a method call, or null when it succeeds */
async function errorOf(ctx, args, name = 'Email/query') {
    const [[responseName, response]] = await ctx.client.call([[name, Object.assign({ accountId: true }, args), 'c0']]);
    return responseName === 'error' ? response.type : null;
}

/** Email/get of some properties, keyed by id */
async function emails(ctx, ids, properties) {
    const res = await ctx.client.method('Email/get', { ids, properties: ['id'].concat(properties) });
    return Object.fromEntries(res.list.map(email => [email.id, email]));
}

const ids = entries => entries.map(entry => entry.id);

/** 2024-01-<day> 10:00:00 UTC, plus extra hours */
const day = (n, hours = 0) => new Date(Date.UTC(2024, 0, n, 10 + hours, 0, 0));

/** JMAP UTCDate of a Date */
const utc = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

module.exports = { setup, rawMessage, sizedMessage, withHeaders, append, resolveIds, imapIn, query, idsOf, errorOf, emails, ids, day, utc };
