'use strict';

// Email/import (RFC 8621 4.8): stores message blobs (uploads, stored messages, attached messages) as
// new Emails. Every message is stored through MessageHandler, like IMAP APPEND and the REST API upload,
// so it is journaled, quota accounted, encrypted when the account asks for it, audited and pushed.
// Ids are not content derived: importing the same blob twice gives two Emails, never alreadyExists.

const { ObjectId } = require('mongodb');
const { URN } = require('../capabilities');
const { invalidArguments } = require('../errors');
const { requireAccount } = require('./common');
const { SetError, invalidProperties } = require('../set-errors');
const { runSet, resolveId } = require('../set');
const { formatId, parseId, blobId } = require('../ids');
const { mailState } = require('../state');
const { readBlob } = require('../blob');
const { looksLikeMessage, headerBlock } = require('../parsed-message');
const { headerFields } = require('../email-headers');
const { loadMailboxes } = require('./mailbox');
const { getLabelMaps } = require('../../label-handler');
const parseDate = require('../../../imap-core/lib/parse-date');
const consts = require('../../consts');

const PROPERTIES = ['blobId', 'mailboxIds', 'keywords', 'receivedAt'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// RFC 8620 1.4 UTCDate: an RFC 3339 date-time in UTC with the Z suffix
const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
// RFC 8621 4.1.1 keyword: 1 to 255 of %x21-%x7E, without ( ) { ] % * " \
const KEYWORD = /^[\x21-\x7e]{1,255}$/;
const KEYWORD_SPECIALS = /[(){\]%*"\\]/;
const MAX_KEYWORDS = 128;
const LABEL = /^\$wdlabel\$([0-9a-f]{24})$/;

// keywords with an IMAP system flag, and the usual IMAP spelling of well known keywords
const FLAGS = {
    $seen: '\\Seen',
    $flagged: '\\Flagged',
    $answered: '\\Answered',
    $draft: '\\Draft',
    $forwarded: '$Forwarded',
    $mdnsent: '$MDNSent',
    $junk: '$Junk',
    $notjunk: '$NotJunk',
    $phishing: '$Phishing'
};
// keywords that would stand for an IMAP flag JMAP never exposes
const FORBIDDEN_KEYWORDS = new Set(['$deleted', '$recent']);

function parseReceivedAt(value) {
    const match = typeof value === 'string' && UTC_DATE.exec(value);
    const date = match && new Date(value);
    // a date that overflows (2018-02-30) is not one
    if (!date || isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
        throw invalidProperties('receivedAt', 'receivedAt must be a UTCDate');
    }
    return date;
}

/**
 * Keywords as IMAP flags and label ids. JMAP keywords are case insensitive and come back lowercase.
 *
 * @returns {{flags: String[], labels: ObjectId[]}}
 */
function parseKeywords(keywords) {
    if (keywords === undefined || keywords === null) {
        return { flags: [], labels: [] };
    }
    if (!isObject(keywords) || Object.keys(keywords).length > MAX_KEYWORDS) {
        throw invalidProperties('keywords', 'keywords must be an object of at most ' + MAX_KEYWORDS + ' keywords');
    }
    const flags = new Map();
    const labels = new Map();
    for (const [keyword, value] of Object.entries(keywords)) {
        const lower = keyword.toLowerCase();
        if (value !== true || !KEYWORD.test(keyword) || KEYWORD_SPECIALS.test(keyword) || FORBIDDEN_KEYWORDS.has(lower)) {
            throw invalidProperties('keywords', `invalid keyword ${keyword}`);
        }
        const label = LABEL.exec(lower);
        if (label) {
            labels.set(label[1], new ObjectId(label[1]));
        } else {
            flags.set(lower, FLAGS[lower] || keyword);
        }
    }
    return { flags: [...flags.values()], labels: [...labels.values()] };
}

/** Checks an EmailImport object without looking anything up */
function checkImport(object) {
    const unknown = Object.keys(object).filter(key => !PROPERTIES.includes(key));
    if (unknown.length) {
        throw invalidProperties(unknown, 'unknown properties');
    }
    if (typeof object.blobId !== 'string') {
        throw invalidProperties('blobId', 'blobId is required');
    }
    const mailboxIds = object.mailboxIds;
    const entries = isObject(mailboxIds) ? Object.entries(mailboxIds) : [];
    if (!entries.length || !entries.every(([, value]) => value === true)) {
        throw invalidProperties('mailboxIds', 'mailboxIds must name a mailbox with the value true');
    }
    if (entries.length > 1) {
        // maxMailboxesPerEmail is 1
        throw new SetError('tooManyMailboxes', 'an Email is in exactly one mailbox');
    }
    return {
        mailboxReference: entries[0][0],
        keywords: parseKeywords(object.keywords),
        receivedAt: object.receivedAt === undefined || object.receivedAt === null ? null : parseReceivedAt(object.receivedAt)
    };
}

async function findMailbox(context, reference) {
    const id = parseId('mailbox', resolveId(context, reference));
    let mailboxes = await loadMailboxes(context);
    if (id && reference.startsWith('#') && !mailboxes.byId.has(id.toString())) {
        // created earlier in this request
        delete context.cache.mailboxes;
        mailboxes = await loadMailboxes(context);
    }
    const mailbox = id && mailboxes.byId.get(id.toString());
    if (!mailbox) {
        throw invalidProperties('mailboxIds', 'no such mailbox');
    }
    return mailbox;
}

async function checkLabels(context, labels) {
    if (!labels.length) {
        return;
    }
    const maps = await getLabelMaps(context.deps.database, context.account.user, { ids: labels });
    if (labels.some(label => !maps.byId.has(label.toString()))) {
        throw invalidProperties('keywords', 'unknown label');
    }
}

// the date of the most recent (topmost) Received header of a message, or null
function receivedDate(messageHandler, raw) {
    const header = messageHandler.indexer.parseMimeTree(Buffer.concat([headerBlock(raw), Buffer.from('\r\n\r\n')]));
    const field = headerFields(header).find(entry => entry.name.trim().toLowerCase() === 'received');
    if (!field) {
        return null;
    }
    const value = field.value.replace(/\r?\n[ \t]*/g, ' ');
    const semicolon = value.lastIndexOf(';');
    if (semicolon < 0) {
        return null;
    }
    const date = parseDate(value.slice(semicolon + 1).trim(), null);
    return date && !isNaN(date.getTime()) ? date : null;
}

async function readMessage(context, id) {
    const limit = context.limits.maxSizeMessage || consts.MAX_ALLOWED_MESSAGE_SIZE;
    let buffer;
    try {
        buffer = await readBlob(context, id, limit);
    } catch (err) {
        if (err.code === 'BlobTooLarge') {
            throw new SetError('tooLarge', `the message is larger than ${limit} octets`, { maxSize: limit });
        }
        throw err;
    }
    // RFC 8621 4.8: an unknown blob is invalidProperties, not blobNotFound
    if (!buffer) {
        throw invalidProperties('blobId', 'no such blob');
    }
    if (!looksLikeMessage(buffer)) {
        throw new SetError('invalidEmail', 'the blob is not an RFC 5322 message');
    }
    return buffer;
}

// storage quota and current usage, read once per call and kept up to date while importing
async function quotaOf(context) {
    const userData = await context.deps.users
        .collection('users')
        .findOne({ _id: context.account.user }, { projection: { quota: true, storageUsed: true }, maxTimeMS: consts.DB_MAX_TIME_USERS });
    const quota = (userData && userData.quota) || (await context.deps.settingsHandler.get('const:max:storage')) || 0;
    return { quota, used: (userData && userData.storageUsed) || 0 };
}

function importer(context, usage) {
    const messageHandler = context.deps.messageHandler;
    return async object => {
        const checked = checkImport(object);
        const mailbox = await findMailbox(context, checked.mailboxReference);
        await checkLabels(context, checked.keywords.labels);
        const raw = await readMessage(context, object.blobId);
        if (usage.quota && usage.used + raw.length > usage.quota) {
            throw new SetError('overQuota', 'the account storage quota would be exceeded');
        }
        const date = checked.receivedAt || receivedDate(messageHandler, raw) || new Date();

        const added = await messageHandler.addAsync({
            user: context.account.user,
            mailbox: mailbox._id,
            meta: { source: 'JMAP', from: '', transtype: 'IMPORT', time: new Date() },
            date,
            flags: checked.keywords.flags,
            labels: checked.keywords.labels,
            raw
        });
        // the state and the counts are read again after a change
        delete context.cache.anchors;
        usage.used += added.data.size;
        // a new message: its root is its id
        return { id: formatId('email', added.data.id), blobId: blobId.message(added.data.id), threadId: null, size: added.data.size };
    };
}

// threadId of the created Emails, one query for all of them
async function fillThreads(context, created) {
    const list = Object.values(created || {});
    if (!list.length) {
        return;
    }
    const ids = list.map(email => parseId('email', email.id));
    const docs = await context.deps.database
        .collection('messages')
        .find({ _id: { $in: ids }, user: context.account.user }, { projection: { _id: true, thread: true }, maxTimeMS: consts.DB_MAX_TIME_MESSAGES })
        .toArray();
    const threads = new Map(docs.map(doc => [doc._id.toString(), doc.thread]));
    for (const email of list) {
        const thread = threads.get(email.id.slice(1));
        email.threadId = thread ? formatId('thread', thread) : null;
    }
}

async function emailImport(args, context) {
    requireAccount(args, context);
    for (const key of Object.keys(args)) {
        if (!['accountId', 'ifInState', 'emails'].includes(key)) {
            throw invalidArguments(`unknown argument ${key}`);
        }
    }
    if (!isObject(args.emails)) {
        throw invalidArguments('emails must be an object');
    }
    const usage = {};
    const response = await runSet({ accountId: args.accountId, ifInState: args.ifInState, create: args.emails }, context, {
        state: async () => (await mailState(context)).state,
        prepare: async () => Object.assign(usage, await quotaOf(context)),
        create: importer(context, usage),
        finish: async result => fillThreads(context, result.created)
    });
    return {
        accountId: response.accountId,
        oldState: response.oldState,
        newState: response.newState,
        created: response.created,
        notCreated: response.notCreated
    };
}

module.exports = { capability: URN.mail, methods: { 'Email/import': emailImport }, checkImport, parseKeywords };
