'use strict';

// Email/set (RFC 8621 4.6). Every write goes through MessageHandler, like IMAP and the REST API, so
// flag changes, moves, deletions and new messages are journaled, quota accounted, encrypted and
// audited the same way:
//
//   update   a patch is applied as a whole to {mailboxIds, keywords} and judged on the result. Keyword
//            and label ($wdlabel$<id> keywords) changes go to update() as flag and label deltas, a
//            mailbox change to move() under the mailbox write lock, carrying the deltas along
//   destroy  del() with archiving, as the REST API deletes a message
//   create   the MIME builder (email-builder.js), then add() like the REST API upload
//
// checkMailboxIds, checkKeywords, loadEmails and storeEmail are shared with Email/import and Email/copy.

const os = require('os');
const { isDeepStrictEqual } = require('util');
const { ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const consts = require('../../consts');
const { URN } = require('../capabilities');
const { parseId, formatId, blobId } = require('../ids');
const { SetError, invalidProperties } = require('../set-errors');
const { runSet, resolveId } = require('../set');
const { applyPatch } = require('../patch');
const { openBlob } = require('../blob');
const { planEmail, buildEmail } = require('../email-builder');
const { resolveProperties, projectionFor, bodyArguments, toEmail, keywordsOf, PROPERTIES } = require('../email-model');
const { parseHeaderProperty, formAllowed } = require('../email-headers');
const { attachmentSizes } = require('../email-body');
const { mailState } = require('../state');
const { visibility, VISIBILITY_FIELDS } = require('../visibility');
const { resolveRoots, rootOf } = require('../../message-roots');
const { getLabelMaps } = require('../../label-handler');
const { rootsReady } = require('./email');
const mailbox = require('./mailbox');

// RFC 8621 4.1.1: a keyword is 1 to 255 printable ASCII characters, without the IMAP atom specials
const KEYWORD = /^[\x21-\x7e]{1,255}$/;
const KEYWORD_SPECIALS = /[(){\]%*"\\]/;
// \Deleted is set by destroying an Email, \Recent only by the server; neither can be a keyword
const HIDDEN_KEYWORDS = new Set(['$deleted', '$recent']);
const LABEL_KEYWORD = /^\$wdlabel\$([0-9a-f]{24})$/;
// keywords stored as IMAP system flags, and registered keywords in the spelling IMAP clients use
const IMAP_FLAGS = {
    $seen: '\\Seen',
    $flagged: '\\Flagged',
    $answered: '\\Answered',
    $draft: '\\Draft',
    $forwarded: '$Forwarded',
    $junk: '$Junk',
    $notjunk: '$NotJunk',
    $phishing: '$Phishing',
    $mdnsent: '$MDNSent'
};
// keywords of one Email (flags and labels together); IMAP lists at most 100 flags per mailbox
const MAX_KEYWORDS = 100;
// fields of a message an update reads
const UPDATE_PROJECTION = { _id: true, root: true, mailbox: true, uid: true, flags: true, labels: true, modseq: true, thread: true };
const WRITABLE = ['mailboxIds', 'keywords'];
// an update that finds the message moved or changed under it starts over this many times
const MAX_ATTEMPTS = 3;
const LOCK_TTL = 2 * 60 * 1000;
const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const given = value => value !== undefined && value !== null;

/** Active labels of the account, read once per request */
function labelMaps(context) {
    if (!context.cache.labelMaps) {
        context.cache.labelMaps = getLabelMaps(context.deps.database, context.account.user);
    }
    return context.cache.labelMaps;
}

/** After a write: the next state and mailbox reads of the request see it */
function written(context) {
    context.cache.anchors = null;
    context.cache.mailboxes = null;
}

// ---------------------------------------------------------------- keywords and mailboxes

/**
 * Lowercase keywords of a keywords object, or null when it is not valid (RFC 8621 4.1.1). Keywords that
 * differ only in case are one keyword. A $wdlabel$ keyword must name an active label.
 *
 * @param {*} value
 * @param {Map} labelsById active labels, id -> name
 * @returns {Set<String>|null}
 */
function keywordSet(value, labelsById) {
    if (!isObject(value)) {
        return null;
    }
    const keywords = new Set();
    for (const [keyword, flag] of Object.entries(value)) {
        if (flag !== true || !KEYWORD.test(keyword) || KEYWORD_SPECIALS.test(keyword)) {
            return null;
        }
        const lower = keyword.toLowerCase();
        if (HIDDEN_KEYWORDS.has(lower)) {
            return null;
        }
        if (lower.startsWith('$wdlabel$')) {
            const match = LABEL_KEYWORD.exec(lower);
            if (!match || !labelsById.has(match[1])) {
                return null;
            }
        }
        keywords.add(lower);
    }
    return keywords;
}

/** IMAP flags and label ids of a keyword set */
function flagsOf(keywords) {
    const flags = [];
    const labels = [];
    for (const keyword of keywords) {
        const match = LABEL_KEYWORD.exec(keyword);
        if (match) {
            labels.push(new ObjectId(match[1]));
        } else {
            flags.push(IMAP_FLAGS[keyword] || keyword);
        }
    }
    return { flags, labels };
}

const maxKeywords = context => context.options.maxKeywordsPerEmail || MAX_KEYWORDS;

/**
 * Validates the keywords of a new Email.
 *
 * @returns {Promise<{keywords: Set<String>, flags: String[], labels: ObjectId[]}>}
 * @throws {SetError} invalidProperties, tooManyKeywords
 */
async function checkKeywords(context, value) {
    if (!given(value)) {
        return { keywords: new Set(), flags: [], labels: [] };
    }
    const keywords = keywordSet(value, (await labelMaps(context)).byId);
    if (!keywords) {
        throw invalidProperties('keywords', 'keywords must map valid keywords to true');
    }
    if (keywords.size > maxKeywords(context)) {
        throw new SetError('tooManyKeywords', `an Email has at most ${maxKeywords(context)} keywords`);
    }
    return Object.assign({ keywords }, flagsOf(keywords));
}

/**
 * The mailbox of a mailboxIds value: exactly one visible mailbox of the account (maxMailboxesPerEmail
 * is 1). Creation ids of the request ("#mb") resolve to the mailboxes created under them.
 *
 * @returns {Promise<Object>} the mailbox document (loadMailboxes() form)
 * @throws {SetError} invalidProperties, tooManyMailboxes
 */
async function checkMailboxIds(context, value) {
    if (!isObject(value) || !Object.values(value).every(flag => flag === true)) {
        throw invalidProperties('mailboxIds', 'mailboxIds must map mailbox ids to true');
    }
    const ids = Object.keys(value).map(id => parseId('mailbox', resolveId(context, id)));
    let mailboxes = await mailbox.loadMailboxes(context);
    if (ids.some(id => id && !mailboxes.byId.has(id.toString())) && !context.cache.mailboxesReloaded) {
        // created earlier in this request, after the request cache was filled; read again once per request
        context.cache.mailboxesReloaded = true;
        context.cache.mailboxes = null;
        mailboxes = await mailbox.loadMailboxes(context);
    }
    const found = ids.map(id => id && mailboxes.byId.get(id.toString()));
    if (!found.length || found.some(doc => !doc)) {
        throw invalidProperties('mailboxIds', 'unknown mailbox');
    }
    if (found.length > 1) {
        throw new SetError('tooManyMailboxes', 'an Email is in exactly one mailbox');
    }
    return found[0];
}

/** A UTCDate (RFC 8620 1.4) as a Date, or null */
function parseUTCDate(value) {
    const match = typeof value === 'string' && UTC_DATE.exec(value);
    if (!match) {
        return null;
    }
    const date = new Date(value);
    const [year, month, day] = match.slice(1, 4).map(Number);
    return isNaN(date) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ? null : date;
}

// ---------------------------------------------------------------- lookups

/**
 * The visible message documents of Email roots.
 *
 * @param {Object} context
 * @param {ObjectId[]} roots
 * @param {Object} [projection] fields to read, the whole document when omitted
 * @returns {Promise<Map<String, Object>>} root hex -> document
 */
async function loadEmails(context, roots, projection) {
    if (!roots.length) {
        return new Map();
    }
    const [found, visible] = await Promise.all([
        resolveRoots(context.deps.database.collection('messages'), context.account.user, roots, {
            projection: projection && Object.assign({}, projection, VISIBILITY_FIELDS),
            legacy: !(await rootsReady(context))
        }),
        visibility(context)
    ]);
    for (const [root, doc] of found) {
        if (!visible(doc)) {
            found.delete(root);
        }
    }
    return found;
}

async function loadEmail(context, id, projection) {
    const root = parseId('email', id);
    return root ? (await loadEmails(context, [root], projection)).get(root.toString()) || null : null;
}

// ---------------------------------------------------------------- update

/** A header:* property name the Email object defines */
function isHeaderProperty(property) {
    const parsed = property.startsWith('header:') && parseHeaderProperty(property);
    return !!parsed && formAllowed(parsed.field, parsed.form);
}

/** Values of read only properties of a message, as Email/get answers them with default body arguments */
async function currentValues(context, doc, properties) {
    const resolved = resolveProperties(properties);
    const full = await context.deps.database
        .collection('messages')
        .findOne({ _id: doc._id, mailbox: doc.mailbox, uid: doc.uid }, { projection: projectionFor(resolved), maxTimeMS: consts.DB_MAX_TIME_MESSAGES });
    if (!full) {
        return null;
    }
    const { messageHandler } = context.deps;
    const sizes = resolved.needsTree ? await attachmentSizes(messageHandler, [full.mimeTree]) : undefined;
    const labels = new Set((await labelMaps(context)).byId.keys());
    return toEmail(full, resolved, bodyArguments({}), { labelIds: labels, messageHandler, sizes });
}

/**
 * Flag and label deltas that turn the stored flags of a message into a keyword set. Flags JMAP does
 * not show (\Deleted, \Recent) are never touched; a keyword already stored in another letter case is
 * kept in that spelling.
 */
function keywordChanges(doc, keywords, labelsById) {
    const stored = new Map();
    for (const flag of doc.flags || []) {
        const lower = flag.toLowerCase();
        if (lower !== '\\deleted' && lower !== '\\recent') {
            stored.set(lower, (stored.get(lower) || []).concat(flag));
        }
    }
    const wanted = flagsOf(keywords);
    const wantedFlags = new Set(wanted.flags.map(flag => flag.toLowerCase()));
    const currentLabels = (doc.labels || []).filter(id => labelsById.has(id.toString()));
    const currentIds = new Set(currentLabels.map(id => id.toString()));
    const wantedIds = new Set(wanted.labels.map(id => id.toString()));
    return {
        addFlags: wanted.flags.filter(flag => !stored.has(flag.toLowerCase())),
        removeFlags: [...stored].filter(([lower]) => !wantedFlags.has(lower)).flatMap(([, spellings]) => spellings),
        addLabels: wanted.labels.filter(id => !currentIds.has(id.toString())).map(id => labelsById.get(id.toString())),
        removeLabels: currentLabels.filter(id => !wantedIds.has(id.toString())).map(id => labelsById.get(id.toString()))
    };
}

/** The MessageHandler update object of keyword deltas: only the keys with something to do */
const changesOf = deltas => Object.fromEntries(Object.entries(deltas).filter(([, list]) => list.length));

async function withMailboxLock(context, mailboxId, fn) {
    const lock = context.deps.lock;
    if (!lock) {
        return fn();
    }
    // the write lock IMAP MOVE and the REST API take, so UIDs of a mailbox are handed out in order
    const acquired = await lock.waitAcquireLock(`mbwr:${mailboxId}`, LOCK_TTL, 60 * 1000);
    if (!acquired || !acquired.success) {
        throw new Error('Failed to get folder write lock');
    }
    try {
        return await fn();
    } finally {
        await lock.releaseLock(acquired).catch(() => false);
    }
}

/**
 * Writes an update. Answers false when the message was not where the update looked for it (moved,
 * deleted, or changed since `unchangedSince`), so the caller reads it again.
 */
async function writeUpdate(context, doc, target, changes, unchangedSince) {
    const { messageHandler } = context.deps;
    const user = context.account.user;
    try {
        if (target) {
            const moved = await withMailboxLock(context, doc.mailbox, () =>
                messageHandler.moveAsync({
                    user,
                    source: { user, mailbox: doc.mailbox },
                    destination: { user, mailbox: target },
                    updates: changes,
                    messageQuery: doc.uid
                })
            );
            return !!(moved && moved.info && moved.info.destinationUid && moved.info.destinationUid.length);
        }
        const updates = typeof unchangedSince === 'number' ? Object.assign({ unchangedSince }, changes) : changes;
        return (await messageHandler.updateAsync(user, doc.mailbox, doc.uid, updates)) > 0;
    } catch (err) {
        if (err.code === 'NoSuchMailbox') {
            return false;
        }
        throw err;
    }
}

/**
 * Judges a patched {mailboxIds, keywords} and the other touched properties (which may only repeat
 * their current values).
 *
 * @returns {Promise<{target: Object|null, keywords: Set<String>|null}>}
 * @throws {SetError}
 */
async function judgePatch(context, doc, patched) {
    const invalid = [];
    let limitError = null;
    const result = { target: null, keywords: null };
    const others = [];
    for (const property of patched.properties) {
        if (WRITABLE.includes(property)) {
            continue;
        }
        if (PROPERTIES.includes(property) || isHeaderProperty(property)) {
            others.push(property);
        } else {
            invalid.push(property);
        }
    }
    if (others.length) {
        const current = await currentValues(context, doc, others);
        if (!current) {
            throw new SetError('notFound', 'the Email was removed');
        }
        invalid.push(...others.filter(property => !isDeepStrictEqual(patched.object[property], current[property])));
    }
    if (patched.properties.has('mailboxIds')) {
        try {
            result.target = await checkMailboxIds(context, patched.object.mailboxIds);
        } catch (err) {
            if (err.type !== 'tooManyMailboxes') {
                invalid.push('mailboxIds');
            }
            limitError = limitError || (err.type === 'tooManyMailboxes' ? err : null);
        }
    }
    if (patched.properties.has('keywords')) {
        result.keywords = keywordSet(patched.object.keywords, (await labelMaps(context)).byId);
        if (!result.keywords) {
            invalid.push('keywords');
        } else if (result.keywords.size > maxKeywords(context) && result.keywords.size > Object.keys(patched.base.keywords).length) {
            limitError = limitError || new SetError('tooManyKeywords', `an Email has at most ${maxKeywords(context)} keywords`);
        }
    }
    if (invalid.length) {
        throw invalidProperties(invalid, 'these properties can not be set to these values');
    }
    if (limitError) {
        throw limitError;
    }
    return result;
}

/** Keywords are case insensitive, so are keyword paths: "keywords/$Seen" patches "$seen" */
function normalizePatch(patch) {
    const result = {};
    for (const [key, value] of Object.entries(patch)) {
        const path = key.startsWith('keywords/') ? `keywords/${key.slice(9).toLowerCase()}` : key;
        if (Object.hasOwn(result, path)) {
            throw new SetError('invalidPatch', `${key} names the same keyword as another path`);
        }
        Object.defineProperty(result, path, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
}

async function updateEmail(context, id, patch, preloaded) {
    patch = normalizePatch(patch);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const doc = (attempt === 0 && preloaded) || (await loadEmail(context, id, UPDATE_PROJECTION));
        if (!doc) {
            throw new SetError('notFound', 'no such Email');
        }
        const { byId: labelsById } = await labelMaps(context);
        const base = {
            mailboxIds: { [formatId('mailbox', doc.mailbox)]: true },
            keywords: keywordsOf(doc, new Set(labelsById.keys()))
        };
        const patched = Object.assign(applyPatch(base, patch), { base });
        const { target, keywords } = await judgePatch(context, doc, patched);

        const move = target && !target._id.equals(doc.mailbox) ? target._id : null;
        const changes = keywords ? changesOf(keywordChanges(doc, keywords, labelsById)) : {};
        if (!move && !Object.keys(changes).length) {
            // nothing to write, the state stays
            return null;
        }
        // a whole keywords object replaces the flags as they were read: a concurrent change starts it over
        const unchangedSince = Object.hasOwn(patch, 'keywords') && typeof doc.modseq === 'number' ? doc.modseq : null;
        if (await writeUpdate(context, doc, move, changes, unchangedSince)) {
            written(context);
            return null;
        }
    }
    throw new SetError('notFound', 'the Email kept changing, try again');
}

// ---------------------------------------------------------------- destroy

async function destroyEmail(context, id) {
    const doc = await loadEmail(context, id);
    if (!doc) {
        throw new SetError('notFound', 'no such Email');
    }
    const deleted = await context.deps.messageHandler.delAsync({
        user: context.account.user,
        messageData: doc,
        // as the REST API deletes a message: a draft is not kept in the archive
        archive: !(doc.flags || []).includes('\\Draft')
    });
    if (!deleted) {
        // removed by someone else in the meantime
        throw new SetError('notFound', 'no such Email');
    }
    written(context);
}

// ---------------------------------------------------------------- create

/** The attachment size limit of the account capability (RFC 8621 1.3.1) */
const maxSizeAttachments = context => mailbox.accountCapability(context).maxSizeAttachmentsPerEmail;

/** Reads a stream into a Buffer; null (and the stream destroyed) once it passes `limit` octets */
async function readLimited(stream, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > limit) {
            stream.destroy();
            return null;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
}

/** How often each blob id is used in a body plan */
function blobUses(part, uses = new Map()) {
    if (part.blobId) {
        uses.set(part.blobId, (uses.get(part.blobId) || 0) + 1);
    }
    (part.subParts || []).forEach(child => blobUses(child, uses));
    return uses;
}

/**
 * Loads the blobs a body plan uses. Every use of a blob counts against maxSizeAttachmentsPerEmail.
 *
 * @returns {Promise<Map<String, {content: Buffer, type: String|null}>>}
 * @throws {SetError} blobNotFound with the missing ids, tooLarge
 */
async function loadBlobs(context, plan) {
    const limit = maxSizeAttachments(context);
    const uses = blobUses(plan.body);
    const blobs = new Map();
    const notFound = [];
    let total = 0;
    for (const id of plan.blobIds) {
        const blob = await openBlob(context, id);
        if (!blob || notFound.length) {
            if (blob) {
                blob.stream.destroy();
            } else {
                notFound.push(id);
            }
            continue;
        }
        const count = uses.get(id) || 1;
        const content = total <= limit ? await readLimited(blob.stream, Math.floor((limit - total) / count)) : null;
        if (!content) {
            blob.stream.destroy();
            throw new SetError('tooLarge', `the attachments are larger than ${limit} octets`, { maxSize: limit });
        }
        total += content.length * count;
        blobs.set(id, { content, type: blob.type });
    }
    if (notFound.length) {
        throw new SetError('blobNotFound', 'unknown blob ids', { notFound });
    }
    return blobs;
}

/**
 * Stores a message as a new Email the way the REST API upload does (MessageHandler.add): quota,
 * encryption at rest, journal, audit and push all apply.
 *
 * @param {Object} context
 * @param {Object} options
 * @param {Buffer} options.raw the RFC 5322 message
 * @param {Object} options.mailbox target mailbox (checkMailboxIds() result)
 * @param {Object} options.keywords checkKeywords() result
 * @param {Date} [options.receivedAt] defaults to now
 * @returns {Promise<{id: String, blobId: String, threadId: String, size: Number}>}
 * @throws {SetError} tooLarge, overQuota, rateLimit
 */
async function storeEmail(context, options) {
    const { deps } = context;
    const user = context.account.user;
    const raw = options.raw;
    if (raw.length > consts.MAX_ALLOWED_MESSAGE_SIZE) {
        throw new SetError('tooLarge', `the message is larger than ${consts.MAX_ALLOWED_MESSAGE_SIZE} octets`, { maxSize: consts.MAX_ALLOWED_MESSAGE_SIZE });
    }

    const userData = await deps.users
        .collection('users')
        .findOne({ _id: user }, { projection: { quota: true, storageUsed: true }, maxTimeMS: consts.DB_MAX_TIME_USERS });
    const quota = (userData && userData.quota) || (await deps.settingsHandler.get('const:max:storage'));
    if (quota && ((userData && userData.storageUsed) || 0) + raw.length > quota) {
        throw new SetError('overQuota', 'the message does not fit in the storage quota');
    }

    // the daily upload limit of IMAP APPEND applies to every protocol that adds messages
    const userCache = deps.userHandler && deps.userHandler.userCache;
    const uploadLimit = userCache ? await userCache.getAsync(user, 'imapMaxUpload', { setting: 'const:max:imap:upload' }) : 0;
    const counter = await deps.messageHandler.counters.asyncTTLCounter(`iup:${user}`, 0, uploadLimit, false);
    if (!counter.success) {
        throw new SetError('rateLimit', 'the daily upload limit is used up');
    }

    const keywords = options.keywords || { flags: [], labels: [] };
    const result = await deps.messageHandler.addAsync({
        user,
        mailbox: options.mailbox._id,
        meta: { source: 'JMAP', from: '', origin: context.ip || '', transtype: 'UPLOAD', time: new Date() },
        date: options.receivedAt || new Date(),
        flags: keywords.flags,
        labels: keywords.labels,
        raw
    });
    written(context);
    await deps.messageHandler.counters.asyncTTLCounter(`iup:${user}`, raw.length, uploadLimit, false).catch(() => false);

    const data = result.data;
    const root = new ObjectId(data.id);
    // the thread is not in the add() result; the message is found by its root wherever it is now
    const stored = await loadEmails(context, [root], { thread: true });
    const doc = stored.get(root.toString());
    if (!doc) {
        throw new SetError('notFound', 'the new Email was removed at once');
    }
    return { id: formatId('email', root), blobId: blobId.message(root), threadId: formatId('thread', doc.thread), size: data.size };
}

async function createEmail(context, object) {
    const plan = planEmail(object);
    if (!given(object.mailboxIds)) {
        throw invalidProperties('mailboxIds', 'mailboxIds is required');
    }
    const target = await checkMailboxIds(context, object.mailboxIds);
    const keywords = await checkKeywords(context, object.keywords);
    let receivedAt = new Date();
    if (given(object.receivedAt)) {
        receivedAt = parseUTCDate(object.receivedAt);
        if (!receivedAt) {
            throw invalidProperties('receivedAt', 'receivedAt must be a UTCDate');
        }
    }
    const blobs = await loadBlobs(context, plan);
    const raw = await buildEmail(plan, { blobs, hostname: config.emailDomain || os.hostname() });
    return storeEmail(context, { raw, mailbox: target, keywords, receivedAt });
}

// ---------------------------------------------------------------- Email/set

function setHandlers(context, args) {
    // the messages of the updates and destroys, read in one query before anything is written
    let preloaded = new Map();
    const looked = new Set();
    const notFound = () => new SetError('notFound', 'no such Email');
    // ids of the call's destroy list, resolved once the creates are done
    const destroying = () => new Set((args.destroy || []).map(id => resolveId(context, id)));
    return {
        state: async () => (await mailState(context)).state,
        prepare: async () => {
            const ids = [...Object.keys(args.update || {}), ...(args.destroy || [])].filter(id => parseId('email', id));
            const found = await loadEmails(
                context,
                ids.map(id => parseId('email', id)),
                UPDATE_PROJECTION
            );
            ids.forEach(id => looked.add(id));
            preloaded = new Map([...found].map(([, doc]) => [formatId('email', rootOf(doc)), doc]));
        },
        create: object => createEmail(context, object),
        update: (id, patch) => {
            if (destroying().has(id)) {
                throw new SetError('willDestroy', 'the Email is destroyed in the same call');
            }
            if (looked.has(id) && !preloaded.has(id)) {
                throw notFound();
            }
            return updateEmail(context, id, patch, preloaded.get(id));
        },
        destroy: id => {
            // an id that was not there when the call started is not looked up again, unless it was created in it
            if ((looked.has(id) && !preloaded.has(id)) || !parseId('email', id)) {
                throw notFound();
            }
            return destroyEmail(context, id);
        }
    };
}

async function set(args, context) {
    if (Array.isArray(args.destroy)) {
        // an id listed twice is destroyed once
        args = Object.assign({}, args, { destroy: [...new Set(args.destroy)] });
    }
    return runSet(args, context, setHandlers(context, args));
}

module.exports = {
    capability: URN.mail,
    methods: { 'Email/set': set },
    checkMailboxIds,
    checkKeywords,
    parseUTCDate,
    loadEmails,
    loadBlobs,
    storeEmail,
    MAX_KEYWORDS,
    // pure helpers, exported for the unit tests
    keywordSet,
    keywordChanges,
    normalizePatch
};
