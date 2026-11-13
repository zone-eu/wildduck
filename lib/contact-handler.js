'use strict';

// Contacts storage (RFC 9610 data model): the address books and cards of a user, the media files cards
// reference, and the address register, which is shown as a read only address book. The JMAP service
// uses it for AddressBook and ContactCard; another front end can use it the same way.
//
// Every change takes the next number of the owned change log (lib/jmap/changelog.js) of its type, so
// it is visible to AddressBook/changes and ContactCard/changes whoever made it. A card is stored as its
// JSON text (map keys of JSContact can contain dots, which MongoDB field paths can not) next to the
// fields that queries and limits need: its address books, uid, kind, members, dates, sort keys and
// search terms, the media files it references and its size.

const { ObjectId, Binary } = require('mongodb');
const consts = require('./consts');
const { changeWriter } = require('./jmap/changelog');

const BOOK_TYPE = 'AddressBook';
const CARD_TYPE = 'ContactCard';
const BOOKS = 'contacts.books';
const CARDS = 'contacts.cards';
const MEDIA = 'contacts.media';
const REGISTER = 'addressregister';
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;

// plan 1.3: one address book per card, 256 KB per card, 10,000 cards per account
const DEFAULT_LIMITS = {
    maxAddressBooks: 100,
    maxAddressBooksPerCard: 1,
    maxCards: 10000,
    maxCardSize: 256 * 1024,
    // a photo, logo or sound file
    maxMediaSize: 4 * 1024 * 1024,
    // most register entries shown as cards, the most recently used first
    maxRegisterCards: 10000
};
const DEFAULT_BOOK_NAME = 'Personal';

/**
 * A duplicate key error: a card with the uid exists, or a default address book was made concurrently.
 */
const isDuplicate = err => err && err.code === 11000;

class ContactHandler {
    /**
     * @param {Object} options
     * @param {Db} options.database
     * @param {Object} [options.limits] over DEFAULT_LIMITS
     * @param {Object} [options.changeLog] {next(user, type, count), destroyed(user, type, objects, seq)}, by default
     *   the change log writer of the database
     */
    constructor(options) {
        this.database = options.database;
        this.limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});
        this.changeLog = options.changeLog || changeWriter(options.database);
    }

    // ------------------------------------------------------------ address books

    /**
     * The address books of a user, the default one created when there is none (once, also under
     * concurrent first requests: a unique index allows one default per user).
     *
     * @returns {Promise<Object[]>} in creation order
     */
    async listBooks(user) {
        const books = await this.findBooks(user);
        if (books.some(book => book.isDefault)) {
            return books;
        }
        await this.createBook(user, { name: DEFAULT_BOOK_NAME, isDefault: true }).catch(err => (isDuplicate(err) ? null : Promise.reject(err)));
        return this.findBooks(user);
    }

    findBooks(user) {
        return this.database
            .collection(BOOKS)
            .find({ user }, { maxTimeMS: MAX_TIME_MS })
            .sort({ _id: 1 })
            .limit(this.limits.maxAddressBooks + 1)
            .toArray();
    }

    /**
     * @param {ObjectId} user
     * @param {Object} values {name, description, sortOrder, isSubscribed, isDefault}
     * @returns {Promise<Object>} the stored document
     */
    async createBook(user, values) {
        const seq = await this.changeLog.next(user, BOOK_TYPE);
        const doc = Object.assign({ _id: new ObjectId(), user, name: values.name, description: null, sortOrder: 0, isSubscribed: true }, values, {
            createdSeq: seq,
            modSeq: seq
        });
        if (!doc.isDefault) {
            delete doc.isDefault;
        }
        await this.database.collection(BOOKS).insertOne(doc);
        return doc;
    }

    /** Changes properties of an address book; answers the new document */
    async updateBook(user, book, values) {
        const modSeq = await this.changeLog.next(user, BOOK_TYPE);
        await this.database.collection(BOOKS).updateOne({ _id: book._id, user }, { $set: Object.assign({ modSeq }, values) });
        return Object.assign(book, values, { modSeq });
    }

    /**
     * Makes `book` the default address book instead of `current`.
     */
    async moveDefault(user, current, book) {
        const seq = await this.changeLog.next(user, BOOK_TYPE, 2);
        const books = this.database.collection(BOOKS);
        // the unique default index allows one default at a time: the old one is released first
        await books.updateOne({ _id: current._id, user }, { $unset: { isDefault: true }, $set: { modSeq: seq } });
        try {
            await books.updateOne({ _id: book._id, user }, { $set: { isDefault: true, modSeq: seq + 1 } });
        } catch (err) {
            await books.updateOne({ _id: current._id, user }, { $set: { isDefault: true, modSeq: seq + 1 } }).catch(() => false);
            throw err;
        }
        delete current.isDefault;
        current.modSeq = seq;
        Object.assign(book, { isDefault: true, modSeq: seq + 1 });
    }

    /** True when at least one card is in the address book */
    async hasCards(user, book) {
        return !!(await this.database.collection(CARDS).findOne({ user, addressBooks: book._id }, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS }));
    }

    /**
     * Destroys an address book. Its cards that are in no other address book are destroyed, the others
     * leave it.
     *
     * @returns {Promise<{destroyed: Object[], updated: Object[]}>} the cards destroyed and changed
     */
    async destroyBook(user, book) {
        const cards = await this.database
            .collection(CARDS)
            .find({ user, addressBooks: book._id }, { projection: { _id: true, addressBooks: true, createdSeq: true, blobs: true }, maxTimeMS: MAX_TIME_MS })
            .limit(this.limits.maxCards + 1)
            .toArray();
        const onlyHere = card => card.addressBooks.every(id => id.equals(book._id));
        const destroyed = cards.filter(onlyHere);
        const updated = cards.filter(card => !onlyHere(card));
        if (updated.length) {
            const seq = await this.changeLog.next(user, CARD_TYPE, updated.length);
            await this.database.collection(CARDS).bulkWrite(
                updated.map((card, i) => ({
                    updateOne: { filter: { _id: card._id, user }, update: { $pull: { addressBooks: book._id }, $set: { modSeq: seq + i } } }
                })),
                { ordered: false }
            );
        }
        await this.destroyCards(user, destroyed);

        const seq = await this.changeLog.next(user, BOOK_TYPE);
        await this.database.collection(BOOKS).deleteOne({ _id: book._id, user });
        await this.changeLog.destroyed(user, BOOK_TYPE, [{ id: book._id, createdSeq: book.createdSeq }], seq);
        return { destroyed, updated };
    }

    // ------------------------------------------------------------ cards

    /** Card documents by id, of the user only */
    findCards(user, ids, projection) {
        return this.database
            .collection(CARDS)
            .find({ user, _id: { $in: ids } }, Object.assign({ maxTimeMS: MAX_TIME_MS }, projection ? { projection } : {}))
            .toArray();
    }

    countCards(user) {
        return this.database.collection(CARDS).countDocuments({ user }, { maxTimeMS: MAX_TIME_MS });
    }

    /**
     * Stores a new card.
     *
     * @param {ObjectId} user
     * @param {Object} fields the card document without _id, user and the sequence numbers
     * @returns {Promise<Object>} the stored document
     * @throws {Error} code DuplicateUid when the account has a card with the uid
     */
    async insertCard(user, fields) {
        const seq = await this.changeLog.next(user, CARD_TYPE);
        const doc = Object.assign({ _id: new ObjectId(), user }, fields, { createdSeq: seq, modSeq: seq });
        try {
            await this.database.collection(CARDS).insertOne(doc);
        } catch (err) {
            if (isDuplicate(err)) {
                const duplicate = new Error('A card with this uid exists');
                duplicate.code = 'DuplicateUid';
                throw duplicate;
            }
            throw err;
        }
        return doc;
    }

    /**
     * Replaces the stored fields of a card, if it was not changed since it was read.
     *
     * @param {ObjectId} user
     * @param {Object} doc the card document as read (its modSeq is compared)
     * @param {Object} fields the new values of the changed fields
     * @returns {Promise<Object|null>} the new document, null when the card changed or is gone meanwhile
     */
    async replaceCard(user, doc, fields) {
        const modSeq = await this.changeLog.next(user, CARD_TYPE);
        const result = await this.database
            .collection(CARDS)
            .updateOne({ _id: doc._id, user, modSeq: doc.modSeq }, { $set: Object.assign({}, fields, { modSeq }) });
        if (!result.matchedCount) {
            return null;
        }
        const removed = (doc.blobs || []).filter(id => !(fields.blobs || doc.blobs).some(other => other.equals(id)));
        await this.releaseMedia(user, removed);
        return Object.assign({}, doc, fields, { modSeq });
    }

    /** Destroys cards (documents with _id, createdSeq and blobs) and the media no other card references */
    async destroyCards(user, docs) {
        if (!docs.length) {
            return;
        }
        const seq = await this.changeLog.next(user, CARD_TYPE, docs.length);
        await this.database.collection(CARDS).deleteMany({ user, _id: { $in: docs.map(doc => doc._id) } });
        await this.changeLog.destroyed(
            user,
            CARD_TYPE,
            docs.map(doc => ({ id: doc._id, createdSeq: doc.createdSeq })),
            seq
        );
        await this.releaseMedia(
            user,
            docs.flatMap(doc => doc.blobs || [])
        );
    }

    // ------------------------------------------------------------ media

    /**
     * Stores a media file (a photo, logo or sound of a card).
     *
     * @returns {Promise<ObjectId>}
     */
    async storeMedia(user, content, contentType) {
        const _id = new ObjectId();
        await this.database.collection(MEDIA).insertOne({ _id, user, contentType, size: content.length, data: new Binary(content), created: new Date() });
        return _id;
    }

    /** A media file of the user: {_id, contentType, size, data (Buffer)} or null */
    async getMedia(user, id, options = {}) {
        const projection = options.statOnly ? { contentType: true, size: true } : { contentType: true, size: true, data: true };
        const doc = await this.database.collection(MEDIA).findOne({ _id: id, user }, { projection, maxTimeMS: MAX_TIME_MS });
        if (doc && doc.data) {
            doc.data = Buffer.from(doc.data.buffer);
        }
        return doc;
    }

    /** Removes the media files no card of the user references any more */
    async releaseMedia(user, ids) {
        if (!ids.length) {
            return;
        }
        // one query for all of them: a destroyed address book can take thousands of cards along
        const used = await this.database
            .collection(CARDS)
            .aggregate([{ $match: { user, blobs: { $in: ids } } }, { $unwind: '$blobs' }, { $match: { blobs: { $in: ids } } }, { $group: { _id: '$blobs' } }], {
                maxTimeMS: MAX_TIME_MS
            })
            .toArray();
        const referenced = new Set(used.map(doc => doc._id.toString()));
        const unused = ids.filter(id => !referenced.has(id.toString()));
        if (unused.length) {
            await this.database.collection(MEDIA).deleteMany({ user, _id: { $in: unused } });
        }
    }

    /** The cards of the user that reference media files: [{_id, blobs}] */
    cardsWithMedia(user, ids) {
        return this.database
            .collection(CARDS)
            .find({ user, blobs: { $in: ids } }, { projection: { _id: true, blobs: true }, maxTimeMS: MAX_TIME_MS })
            .limit(this.limits.maxCards)
            .toArray();
    }

    // ------------------------------------------------------------ address register

    /**
     * Address register entries shown as cards: the enabled ones, the most recently used first.
     *
     * @param {ObjectId} user
     * @param {Object} [options] {ids: only these entries, limit: at most this many (and never more than maxRegisterCards)}
     */
    registerEntries(user, options = {}) {
        const query = { user, disabled: false };
        if (options.ids) {
            query._id = { $in: options.ids };
        }
        return this.database
            .collection(REGISTER)
            .find(query, { projection: { name: true, address: true, changed: true }, maxTimeMS: MAX_TIME_MS })
            .sort({ updated: -1 })
            .limit(Math.min(this.limits.maxRegisterCards, options.limit || Infinity))
            .toArray();
    }

    /**
     * Records changes of register entries made by the mail path or the REST API in the ContactCard change
     * log. A new or re-enabled entry is a created card, a changed name an updated card and a disabled
     * entry a destroyed one.
     *
     * @param {ObjectId} user
     * @param {Array<{id: ObjectId, created: Boolean}>} changes entries that were inserted (created) or changed
     * @returns {Promise<Boolean>} true when the change log moved
     */
    async recordRegisterChanges(user, changes) {
        const ids = [...new Map(changes.map(change => [change.id.toString(), change.id])).values()];
        if (!ids.length) {
            return false;
        }
        const register = this.database.collection(REGISTER);
        const docs = await register
            .find({ user, _id: { $in: ids } }, { projection: { disabled: true, createdSeq: true, shown: true }, maxTimeMS: MAX_TIME_MS })
            .toArray();
        if (!docs.length) {
            return false;
        }
        let seq = await this.changeLog.next(user, CARD_TYPE, docs.length);
        const inserted = new Set(changes.filter(change => change.created).map(change => change.id.toString()));
        const destroyed = [];
        const updates = [];
        const now = new Date();
        for (const doc of docs) {
            if (doc.disabled) {
                if (doc.shown !== false) {
                    destroyed.push({ id: `R${doc._id}`, createdSeq: doc.createdSeq || 0 });
                }
                updates.push({ updateOne: { filter: { _id: doc._id, user }, update: { $set: { shown: false } } } });
                continue;
            }
            const fields = { modSeq: seq, shown: true, changed: now };
            if (inserted.has(doc._id.toString()) || doc.shown === false) {
                fields.createdSeq = seq;
            }
            updates.push({ updateOne: { filter: { _id: doc._id, user }, update: { $set: fields } } });
            seq++;
        }
        // one round trip: the mail path calls this for every message with a new address
        await register.bulkWrite(updates, { ordered: false });
        if (destroyed.length) {
            await this.changeLog.destroyed(user, CARD_TYPE, destroyed, seq);
        }
        return true;
    }

    // ------------------------------------------------------------ account

    /** Removes every address book, card and media file of a user */
    async deleteUserData(user) {
        const result = {};
        for (const collection of [BOOKS, CARDS, MEDIA]) {
            result[collection] = { deleted: (await this.database.collection(collection).deleteMany({ user })).deletedCount };
        }
        return result;
    }
}

module.exports = { ContactHandler, DEFAULT_LIMITS, BOOK_TYPE, CARD_TYPE, BOOKS, CARDS, MEDIA, REGISTER };
