'use strict';

// State strings and change history for the mail types (Email, Thread, Mailbox), from the change
// journal (RFC 8620 5.2). A state is a journal anchor (lib/journal-state.js) plus a keyed checksum of
// the account, so a state string of another account, or a made up one, is never accepted.

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { journalAnchors } = require('../journal-state');
const { MethodError, invalidArguments } = require('./errors');
const consts = require('../consts');
const { SettingsHandler } = require('../settings-handler');

const STATE = /^([0-9a-f]{24})([0-9a-f]{8})$/;

function checksum(secret, accountId, anchor) {
    return crypto.createHmac('sha256', secret).update(`${accountId}:${anchor}`).digest('hex').slice(0, 8);
}

// The journal retention setting changes rarely, and every state read needs it: it is kept for
// jmap.changes.retentionCacheTime seconds (default 60) instead of read from the settings collection
const retentionCache = { value: null, expires: 0 };

async function journalRetention(context) {
    const changes = context.options.changes || {};
    const ttl = (changes.retentionCacheTime === undefined ? 60 : changes.retentionCacheTime) * 1000;
    if (!retentionCache.value || retentionCache.expires <= Date.now()) {
        const settingsHandler = context.deps.settingsHandler || new SettingsHandler({ db: context.deps.database });
        retentionCache.value = (await settingsHandler.get('const:journal:time')) || consts.JOURNAL_TIME;
        retentionCache.expires = Date.now() + ttl;
    }
    return retentionCache.value;
}

const formatState = (context, anchor) => `${anchor}${checksum(context.options.accessSecret, context.account.id, anchor.toString())}`;

/**
 * The current mail state of the account, read once per request.
 *
 * @returns {Promise<{state: String, delivery: String, anchor: ObjectId}>}
 */
async function mailState(context) {
    if (!context.cache.anchors) {
        context.cache.anchors = journalRetention(context).then(retention => journalAnchors(context.deps.database, context.account.user, { retention }));
    }
    const anchors = await context.cache.anchors;
    return {
        state: formatState(context, anchors.journal),
        delivery: formatState(context, anchors.delivery),
        anchor: anchors.journal,
        retention: anchors.retention
    };
}

/**
 * Parses a sinceState. A string that is not a state of this account is cannotCalculateChanges, like an
 * expired one; a value that is not a string is invalidArguments.
 *
 * @returns {ObjectId} The anchor
 */
function parseState(context, state) {
    if (typeof state !== 'string') {
        throw invalidArguments('sinceState must be a string');
    }
    const match = STATE.exec(state);
    if (!match || checksum(context.options.accessSecret, context.account.id, match[1]) !== match[2]) {
        throw new MethodError('cannotCalculateChanges');
    }
    return new ObjectId(match[1]);
}

// a state this close to the end of the journal retention is refused: entries may expire while it is read
const EXPIRY_MARGIN = 60 * 1000;
// changes per response when the client asks for more or names no limit, and journal entries read per response
const DEFAULT_MAX_CHANGES = 1500;
const DEFAULT_SCAN_LIMIT = 10000;

/**
 * Journal entries after a state, oldest first, checked against the journal retention. The cursor carries
 * the server limits for foldEntries() as `limits` ({changes, scan}).
 *
 * @param {Object} context
 * @param {ObjectId} since
 * @param {Object} [filter] Additional journal filter
 * @returns {Promise<AsyncIterable<Object>>}
 */
async function entriesSince(context, since, filter = {}) {
    const { anchor, retention } = await mailState(context);
    // a state from before the retention window may have missed entries that expired since, unless it is the
    // current state (an anchor older than the retention is replaced, see journal-state.js)
    const expired = !since.equals(anchor) && since.getTimestamp().getTime() < Date.now() - retention + EXPIRY_MARGIN;
    if (expired || since.toString() > anchor.toString()) {
        throw new MethodError('cannotCalculateChanges');
    }
    const options = context.options.changes || {};
    const window = options.safetyWindow || 0;
    const from = window ? ObjectId.createFromTime(Math.floor((since.getTimestamp().getTime() - window) / 1000)) : since;
    const limits = { changes: options.maxChanges || DEFAULT_MAX_CHANGES, scan: options.scanLimit || DEFAULT_SCAN_LIMIT };
    const cursor = context.deps.database
        .collection('journal')
        .find(Object.assign({ user: context.account.user, _id: { $gt: from, $lte: anchor } }, filter))
        .sort({ _id: 1 })
        // one more than the scan limit tells whether the scan stopped early
        .limit(limits.scan + 1)
        .maxTimeMS(consts.DB_MAX_TIME_MESSAGES);
    cursor.limits = limits;
    return cursor;
}

/**
 * Checks maxChanges (RFC 8620 5.2: a positive UnsignedInt or null).
 */
function maxChangesOf(args) {
    if (args.maxChanges === undefined || args.maxChanges === null) {
        return Infinity;
    }
    // a safe integer: 2^53 + 1 parses to 2^53, which would otherwise pass as an integer
    if (!Number.isSafeInteger(args.maxChanges) || args.maxChanges <= 0) {
        throw invalidArguments('maxChanges must be a positive integer');
    }
    return args.maxChanges;
}

/**
 * Collects changes from journal entries in order, stopping before the entry that would take the
 * number of changed ids past maxChanges (the entry before it is the intermediate state). maxChanges is
 * capped by the server limit, and a scan stops after the server's limit of entries read, so a long run of
 * changes to the same few ids still answers quickly with an intermediate state.
 *
 * @param {AsyncIterable} entries From entriesSince()
 * @param {Object} apply {key: entry => key of the id the entry touches, or null; fold: (changes Map, entry) => updates the map}
 * @param {Number} maxChanges
 * @returns {Promise<{changes: Map, last: ObjectId|null, more: Boolean}>}
 */
async function foldEntries(entries, apply, maxChanges) {
    const limits = entries.limits || { changes: Infinity, scan: Infinity };
    const max = Math.min(maxChanges, limits.changes);
    const changes = new Map();
    let last = null;
    let scanned = 0;
    for await (const entry of entries) {
        const key = apply.key(entry);
        if ((key !== null && !changes.has(key) && changes.size >= max) || scanned >= limits.scan) {
            await entries.close();
            return { changes, last, more: true };
        }
        apply.fold(changes, entry);
        last = entry._id;
        scanned++;
    }
    return { changes, last, more: false };
}

/**
 * True if an object with this ObjectId was created after the state. Only whole seconds are compared:
 * ids from different processes in the same second do not sort by time, and reporting a new object as
 * updated is harmless (the client fetches it), while the other way round would duplicate it.
 */
const createdAfter = (id, since) => new ObjectId(id).getTimestamp().getTime() > since.getTimestamp().getTime();

/** Splits a Map of id -> 'created'|'updated'|'destroyed' into the three lists */
function changeLists(changes) {
    const lists = { created: [], updated: [], destroyed: [] };
    for (const [id, kind] of changes) {
        lists[kind].push(id);
    }
    return lists;
}

module.exports = { mailState, parseState, entriesSince, maxChangesOf, foldEntries, changeLists, formatState, createdAfter, EXPIRY_MARGIN };
