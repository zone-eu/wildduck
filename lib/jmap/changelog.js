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
// Writers outside the JMAP service that change these objects (the REST API changing addresses, for
// example) call next() and destroyed() too.

const crypto = require('crypto');
const { MethodError, invalidArguments } = require('./errors');

const COLLECTION = 'jmapchanges';
const RETENTION = 30 * 24 * 3600 * 1000;
// tombstones live a little longer than states, so a valid state never misses one
const TOMBSTONE_MARGIN = 24 * 3600 * 1000;
const MAX_TIME_MS = 10 * 1000;
const STATE = /^o([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{8})$/;

class ChangeLog {
    /**
     * @param {Object} options
     * @param {Db} options.database
     * @param {String} options.secret key of the state checksum
     * @param {Number} [options.retention] how long a state can be used for /changes, in ms
     */
    constructor(options) {
        this.database = options.database;
        this.secret = options.secret;
        this.retention = options.retention || RETENTION;
    }

    /**
     * Takes the next sequence numbers of a type.
     *
     * @param {ObjectId} user
     * @param {String} type JMAP type name, for example "Identity"
     * @param {Number} [count] how many numbers to take, one per changed object
     * @returns {Promise<Number>} the first of them
     */
    async next(user, type, count = 1) {
        const doc = await this.database
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
     * @param {ObjectId} user
     * @param {String} type
     * @param {Array<{id: *, createdSeq: Number}>} objects
     * @param {Number} seq the first of objects.length sequence numbers taken with next()
     */
    async destroyed(user, type, objects, seq) {
        if (!objects.length) {
            return;
        }
        const expires = new Date(Date.now() + this.retention + TOMBSTONE_MARGIN);
        await this.database.collection(COLLECTION).insertMany(
            objects.map((object, i) => ({ user, type, object: object.id, createdSeq: object.createdSeq || 0, seq: seq + i, expires })),
            { ordered: false }
        );
    }

    /** The current sequence and its time */
    async current(user, type) {
        const doc = await this.database.collection('jmapstate').findOne({ _id: user }, { projection: { [`seq.${type}`]: true, [`seqTime.${type}`]: true } });
        return {
            seq: (doc && doc.seq && doc.seq[type]) || 0,
            time: (doc && doc.seqTime && doc.seqTime[type] && doc.seqTime[type].getTime()) || 0
        };
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
     * @param {Object} options
     * @param {ObjectId} options.user
     * @param {String} options.accountId
     * @param {String} options.type
     * @param {String} options.collection collection of the live objects, with createdSeq and modSeq
     * @param {String} options.sinceState
     * @param {Number} options.maxChanges
     * @param {Function} options.formatId object id to JMAP id
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
        if (since.seq === current.seq) {
            return result;
        }

        const entries = await this.entriesSince(options.collection, user, type, since.seq, maxChanges + 1);
        let last = current.seq;
        if (entries.length > maxChanges) {
            // cut between two sequence numbers, so the intermediate state includes everything up to it
            last = entries[maxChanges - 1].seq;
            while (entries.length && entries[entries.length - 1].seq > last) {
                entries.pop();
            }
            if (!entries.length) {
                // more objects share one sequence number than maxChanges allows
                throw new MethodError('cannotCalculateChanges', { description: 'maxChanges is too small' });
            }
            result.hasMoreChanges = true;
            // the time of the old state keeps the intermediate state from outliving the tombstones after
            // it. From sequence 0 there is no older time; such a state is used right away for the next page
            result.newState = this.formatState(accountId, type, { seq: last, time: since.seq > 0 ? since.time : Date.now() });
        }
        for (const entry of entries) {
            if (entry.destroyed) {
                if (entry.createdSeq <= since.seq) {
                    result.destroyed.push(formatId(entry.id));
                }
            } else {
                result[entry.createdSeq > since.seq ? 'created' : 'updated'].push(formatId(entry.id));
            }
        }
        return result;
    }

    // live objects and tombstones changed after a sequence, merged in sequence order
    async entriesSince(collection, user, type, seq, limit) {
        const [live, tombstones] = await Promise.all([
            this.database
                .collection(collection)
                .find({ user, modSeq: { $gt: seq } }, { projection: { _id: true, modSeq: true, createdSeq: true } })
                .sort({ modSeq: 1 })
                .limit(limit)
                .maxTimeMS(MAX_TIME_MS)
                .toArray(),
            this.database
                .collection(COLLECTION)
                .find({ user, type, seq: { $gt: seq } }, { projection: { object: true, seq: true, createdSeq: true } })
                .sort({ seq: 1 })
                .limit(limit)
                .maxTimeMS(MAX_TIME_MS)
                .toArray()
        ]);
        const entries = [
            ...live.map(doc => ({ id: doc._id, seq: doc.modSeq, createdSeq: doc.createdSeq || 0 })),
            ...tombstones.map(doc => ({ id: doc.object, seq: doc.seq, createdSeq: doc.createdSeq, destroyed: true }))
        ];
        return entries.sort((a, b) => a.seq - b.seq).slice(0, limit);
    }
}

/** The change log of the service, created once per set of dependencies */
function changeLogFor(context) {
    if (!context.deps.changeLog) {
        context.deps.changeLog = new ChangeLog({ database: context.deps.database, secret: context.options.accessSecret });
    }
    return context.deps.changeLog;
}

module.exports = { ChangeLog, changeLogFor, COLLECTION };
