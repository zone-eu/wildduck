'use strict';

// State strings and change history for the mail types (Email, Thread, Mailbox), from the change
// journal (RFC 8620 5.2). A state is a journal anchor (lib/journal-state.js) plus a keyed checksum of
// the account, so a state string of another account, or a made up one, is never accepted.

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { journalAnchors } = require('../journal-state');
const { MethodError, invalidArguments } = require('./errors');
const consts = require('../consts');

const STATE = /^([0-9a-f]{24})([0-9a-f]{8})$/;

function checksum(secret, accountId, anchor) {
    return crypto.createHmac('sha256', secret).update(`${accountId}:${anchor}`).digest('hex').slice(0, 8);
}

const formatState = (context, anchor) => `${anchor}${checksum(context.options.accessSecret, context.account.id, anchor.toString())}`;

/**
 * The current mail state of the account, read once per request.
 *
 * @returns {Promise<{state: String, delivery: String, anchor: ObjectId}>}
 */
async function mailState(context) {
    if (!context.cache.anchors) {
        context.cache.anchors = journalAnchors(context.deps.database, context.account.user);
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

/**
 * Journal entries after a state, oldest first, checked against the journal retention.
 *
 * @param {Object} context
 * @param {ObjectId} since
 * @param {Object} [filter] Additional journal filter
 * @returns {Promise<AsyncIterable<Object>>}
 */
async function entriesSince(context, since, filter = {}) {
    const { anchor, retention } = await mailState(context);
    // a state from before the retention window may have missed entries that expired since
    if (since.getTimestamp().getTime() < Date.now() - retention + 60 * 1000 || since.toString() > anchor.toString()) {
        throw new MethodError('cannotCalculateChanges');
    }
    const window = (context.options.changes && context.options.changes.safetyWindow) || 0;
    const from = window ? ObjectId.createFromTime(Math.floor((since.getTimestamp().getTime() - window) / 1000)) : since;
    return context.deps.database
        .collection('journal')
        .find(Object.assign({ user: context.account.user, _id: { $gt: from, $lte: anchor } }, filter))
        .sort({ _id: 1 })
        .maxTimeMS(consts.DB_MAX_TIME_MESSAGES);
}

/**
 * Checks maxChanges (RFC 8620 5.2: a positive UnsignedInt or null).
 */
function maxChangesOf(args) {
    if (args.maxChanges === undefined || args.maxChanges === null) {
        return Infinity;
    }
    if (!Number.isInteger(args.maxChanges) || args.maxChanges <= 0) {
        throw invalidArguments('maxChanges must be a positive integer');
    }
    return args.maxChanges;
}

/**
 * Collects changes from journal entries in order, stopping before the entry that would take the
 * number of changed ids past maxChanges (the entry before it is the intermediate state).
 *
 * @param {AsyncIterable} entries
 * @param {Function} apply (changes Map, entry) => key of the id the entry touches, or null; updates the map
 * @param {Number} maxChanges
 * @returns {Promise<{changes: Map, last: ObjectId|null, more: Boolean}>}
 */
async function foldEntries(entries, apply, maxChanges) {
    const changes = new Map();
    let last = null;
    for await (const entry of entries) {
        const key = apply.key(entry);
        if (key !== null && !changes.has(key) && changes.size >= maxChanges) {
            await entries.close();
            return { changes, last, more: true };
        }
        apply.fold(changes, entry);
        last = entry._id;
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

module.exports = { mailState, parseState, entriesSince, maxChangesOf, foldEntries, changeLists, formatState, createdAfter };
