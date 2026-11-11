'use strict';

// Change history for the data types JMAP owns (Identity, EmailSubmission, contacts, calendars), which
// the mail journal does not cover (RFC 8620 5.2).
//
// Every change takes the next number of a per user, per type sequence kept in the user's jmapstate
// document. A live object stores the sequence of its creation (createdSeq) and of its last change
// (modSeq), so /changes is a range scan of the type's collection on {user, modSeq}. A destroyed object
// leaves a tombstone in jmapchanges, removed by a TTL index after the retention. The state string is
// the sequence and the time of the last change, with a keyed checksum of the account; a state older
// than the retention, whose tombstones may be gone, answers cannotCalculateChanges.
//
// A number is taken before its object is written, so concurrent writers of a type may commit out of
// order; /changes reads a safety window of numbers below the state again (see ChangeLog#changes).
//
// Writers outside the JMAP service that change these objects (the REST API changing addresses, for
// example) record their changes through changeWriter(), which needs no checksum key.

const crypto = require('crypto');
const { MethodError, invalidArguments } = require('./errors');

const COLLECTION = 'jmapchanges';
const RETENTION = 30 * 24 * 3600 * 1000;
// tombstones live a little longer than states, so a valid state never misses one
const TOMBSTONE_MARGIN = 24 * 3600 * 1000;
const MAX_TIME_MS = 10 * 1000;
// sequence numbers below a state that /changes reads again ([jmap.changes] ownedSafetyWindow)
const DEFAULT_SAFETY_WINDOW = 32;
const STATE = /^o([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{8})$/;

/**
 * Takes the next sequence numbers of a type.
 *
 * @param {Db} database
 * @param {ObjectId} user
 * @param {String} type JMAP type name, for example "Identity"
 * @param {Number} [count] how many numbers to take, one per changed object
 * @returns {Promise<Number>} the first of them
 */
async function nextSeq(database, user, type, count = 1) {
    const doc = await database
        .collection('jmapstate')
        .findOneAndUpdate(
            { _id: user },
            { $inc: { [`seq.${type}`]: count }, $set: { [`seqTime.${type}`]: new Date() } },
            { upsert: true, returnDocument: 'after', projection: { [`seq.${type}`]: true } }
        );
    return doc.seq[type] - count + 1;
}

/**
 * Records destroyed objects. Call after the objects are gone.
 *
 * @param {Db} database
 * @param {ObjectId} user
 * @param {String} type
 * @param {Array<{id: *, createdSeq: Number}>} objects
 * @param {Number} seq the first of objects.length sequence numbers taken with nextSeq()
 * @param {Number} [retention] how long states stay usable, in ms
 */
async function recordDestroyed(database, user, type, objects, seq, retention = RETENTION) {
    if (!objects.length) {
        return;
    }
    const expires = new Date(Date.now() + retention + TOMBSTONE_MARGIN);
    await database.collection(COLLECTION).insertMany(
        objects.map((object, i) => ({ user, type, object: object.id, createdSeq: object.createdSeq || 0, seq: seq + i, expires })),
        { ordered: false }
    );
}

/** The position {seq, time} of a type in a jmapstate document (missing: the start) */
const positionOf = (doc, type) => ({
    seq: (doc && doc.seq && doc.seq[type]) || 0,
    time: (doc && doc.seqTime && doc.seqTime[type] && doc.seqTime[type].getTime()) || 0
});

/** The sequences of every owned type of a user: one read of the jmapstate document */
const readSequences = (database, user) =>
    database.collection('jmapstate').findOne({ _id: user }, { projection: { seq: true, seqTime: true }, maxTimeMS: MAX_TIME_MS });

/**
 * The writing half of a change log, for writers outside the JMAP service: they record changes but never
 * format a state string, so they need no checksum key.
 *
 * @param {Db} database
 * @returns {{next: Function, destroyed: Function}} as ChangeLog#next and ChangeLog#destroyed
 */
const changeWriter = database => ({
    next: (user, type, count) => nextSeq(database, user, type, count),
    destroyed: (user, type, objects, seq) => recordDestroyed(database, user, type, objects, seq)
});

/**
 * The entries of the safety window that a /changes response reports again: those of the `max` most
 * recently changed ids, so the ids seen again never take the whole of maxChanges.
 */
function windowEntries(entries, max) {
    const keep = new Set();
    for (let i = entries.length - 1; i >= 0 && keep.size < max; i--) {
        keep.add(entries[i].id);
    }
    return entries.filter(entry => keep.has(entry.id));
}

class ChangeLog {
    /**
     * @param {Object} options
     * @param {Db} options.database
     * @param {String} options.secret key of the state checksum
     * @param {Number} [options.retention] how long a state can be used for /changes, in ms
     * @param {Number} [options.safetyWindow] sequence numbers below a state that /changes reads again, see changes()
     */
    constructor(options) {
        this.database = options.database;
        this.secret = options.secret;
        this.retention = options.retention || RETENTION;
        this.safetyWindow = Math.max(0, Math.floor(Number(options.safetyWindow) || 0));
    }

    /** Takes the next sequence numbers of a type, see nextSeq() */
    next(user, type, count = 1) {
        return nextSeq(this.database, user, type, count);
    }

    /** Records destroyed objects, see recordDestroyed() */
    destroyed(user, type, objects, seq) {
        return recordDestroyed(this.database, user, type, objects, seq, this.retention);
    }

    /** The current sequence and its time */
    async current(user, type) {
        const doc = await this.database.collection('jmapstate').findOne({ _id: user }, { projection: { [`seq.${type}`]: true, [`seqTime.${type}`]: true } });
        return positionOf(doc, type);
    }

    formatState(accountId, type, position) {
        const body = `${position.seq.toString(36)}.${Math.floor(position.time / 1000).toString(36)}`;
        return `o${body}.${this.checksum(accountId, type, body)}`;
    }

    /** The state string of a type */
    async state(user, accountId, type) {
        return this.formatState(accountId, type, await this.current(user, type));
    }

    checksum(accountId, type, body) {
        return crypto.createHmac('sha256', this.secret).update(`${accountId}:${type}:${body}`).digest('hex').slice(0, 8);
    }

    /**
     * Parses a sinceState. Anything that is not a state of this account and type is cannotCalculateChanges.
     *
     * @returns {{seq: Number, time: Number}}
     */
    parseState(accountId, type, state) {
        if (typeof state !== 'string') {
            throw invalidArguments('sinceState must be a string');
        }
        const match = STATE.exec(state);
        if (!match || this.checksum(accountId, type, `${match[1]}.${match[2]}`) !== match[3]) {
            throw new MethodError('cannotCalculateChanges');
        }
        return { seq: parseInt(match[1], 36), time: parseInt(match[2], 36) * 1000 };
    }

    /**
     * The changes of a type since a state (RFC 8620 5.2).
     *
     * A sequence number is taken before its object is written, so two writers of one type can commit out of
     * order, and a state read between the two commits names a number whose object is not written yet. The
     * safety window covers that: the entries up to `safetyWindow` numbers below the state are read again
     * and their ids reported once more (as updated or destroyed, never as created), which RFC 8620 5.2
     * allows. With a window of 0 such a late write is never reported to a client holding that state.
     *
     * @param {Object} options
     * @param {ObjectId} options.user
     * @param {String} options.accountId
     * @param {String} options.type
     * @param {String} options.collection collection of the live objects, with createdSeq and modSeq
     * @param {Object[]} [options.sources] instead of collection, when the objects of the type live in several
     *   collections: [{collection, formatId, filter}], filter an extra condition on the live objects
     * @param {String} options.sinceState
     * @param {Number} options.maxChanges
     * @param {Function} options.formatId object id to JMAP id (live objects of `collection` and tombstones)
     * @returns {Promise<{oldState, newState, hasMoreChanges, created, updated, destroyed}>}
     */
    async changes(options) {
        const { user, accountId, type, maxChanges, formatId } = options;
        const since = this.parseState(accountId, type, options.sinceState);
        const current = await this.current(user, type);
        // a tombstone matters only for an object created at or before the state, and it outlives the
        // retention counted from the destroy, which came after the state; sequence 0 predates every object
        const expired = since.seq > 0 && since.seq < current.seq && since.time < Date.now() - this.retention;
        if (since.seq > current.seq || expired) {
            throw new MethodError('cannotCalculateChanges');
        }
        const result = {
            oldState: options.sinceState,
            newState: this.formatState(accountId, type, current),
            hasMoreChanges: false,
            created: [],
            updated: [],
            destroyed: []
        };
        const window = Math.min(this.safetyWindow, since.seq);
        if (since.seq === current.seq && !window) {
            return result;
        }

        const sources = options.sources || [{ collection: options.collection, formatId }];
        // a sequence number names one object, so the window holds at most `window` entries. Entries after
        // the current number are left for the next call, whose state includes them
        const entries = await this.entriesSince(sources, user, type, since.seq - window, maxChanges + window + 1, formatId, current.seq);
        const older = windowEntries(
            entries.filter(entry => entry.seq <= since.seq),
            maxChanges - 1
        );
        const newer = entries.filter(entry => entry.seq > since.seq);
        const budget = maxChanges - new Set(older.map(entry => entry.id)).size;
        if (newer.length > budget) {
            // cut between two sequence numbers, so the intermediate state includes everything up to it
            const last = newer[budget - 1].seq;
            while (newer.length && newer[newer.length - 1].seq > last) {
                newer.pop();
            }
            if (!newer.length) {
                // more objects share one sequence number than maxChanges allows
                throw new MethodError('cannotCalculateChanges', { description: 'maxChanges is too small' });
            }
            result.hasMoreChanges = true;
            // the time of the old state keeps the intermediate state from outliving the tombstones after
            // it. From sequence 0 there is no older time; such a state is used right away for the next page
            result.newState = this.formatState(accountId, type, { seq: last, time: since.seq > 0 ? since.time : Date.now() });
        }

        // an id is reported once, as its last entry left it. The client knows it when any of its entries was
        // created at or before the state (a register card is destroyed and created again under one id)
        const ids = new Map();
        for (const entry of [...older, ...newer]) {
            const known = entry.createdSeq <= since.seq || (ids.has(entry.id) && ids.get(entry.id).known);
            ids.set(entry.id, { known, destroyed: !!entry.destroyed });
        }
        for (const [id, { known, destroyed }] of ids) {
            if (!destroyed) {
                result[known ? 'updated' : 'created'].push(id);
            } else if (known) {
                result.destroyed.push(id);
            }
        }
        return result;
    }

    // live objects and tombstones changed after a sequence (and up to `upTo` when given), merged in sequence
    // order, with their JMAP ids
    async entriesSince(sources, user, type, seq, limit, formatId, upTo) {
        const range = upTo === undefined ? { $gt: seq } : { $gt: seq, $lte: upTo };
        const [tombstones, ...live] = await Promise.all([
            this.database
                .collection(COLLECTION)
                .find({ user, type, seq: range }, { projection: { object: true, seq: true, createdSeq: true } })
                .sort({ seq: 1 })
                .limit(limit)
                .maxTimeMS(MAX_TIME_MS)
                .toArray(),
            ...sources.map(source =>
                this.database
                    .collection(source.collection)
                    .find(Object.assign({ user, modSeq: range }, source.filter), { projection: { _id: true, modSeq: true, createdSeq: true } })
                    .sort({ modSeq: 1 })
                    .limit(limit)
                    .maxTimeMS(MAX_TIME_MS)
                    .toArray()
            )
        ]);
        const entries = [
            ...live.flatMap((docs, index) => docs.map(doc => ({ id: sources[index].formatId(doc._id), seq: doc.modSeq, createdSeq: doc.createdSeq || 0 }))),
            ...tombstones.map(doc => ({ id: formatId(doc.object), seq: doc.seq, createdSeq: doc.createdSeq, destroyed: true }))
        ];
        return entries.sort((a, b) => a.seq - b.seq).slice(0, limit);
    }
}

/** The change log of the service, created once per set of dependencies */
function changeLogFor(context) {
    if (!context.deps.changeLog) {
        const changes = context.options.changes || {};
        context.deps.changeLog = new ChangeLog({
            database: context.deps.database,
            secret: context.options.accessSecret,
            safetyWindow: changes.ownedSafetyWindow === undefined ? DEFAULT_SAFETY_WINDOW : changes.ownedSafetyWindow
        });
    }
    return context.deps.changeLog;
}

/**
 * Push states of owned types (lib/jmap/push/states.js). A state computation reads the jmapstate document
 * once for all owned types: readStates() shares that read as context.readSequences.
 *
 * @param {Object} context request context of the account
 * @param {String[]} types
 * @returns {Promise<Object>} type -> state
 */
async function ownedPushStates(context, types) {
    const doc = await (context.readSequences ? context.readSequences() : readSequences(context.deps.database, context.account.user));
    const log = changeLogFor(context);
    return Object.fromEntries(types.map(type => [type, log.formatState(context.account.id, type, positionOf(doc, type))]));
}

module.exports = { ChangeLog, changeLogFor, changeWriter, nextSeq, readSequences, ownedPushStates, COLLECTION };
