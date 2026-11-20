'use strict';

// Small per user lists a webmail client keeps: senders whose remote content (images) may load, and
// the most recent searches. Each entry is one document with the user first in its index.

const MAX_SENDERS = 1000;
const MAX_SEARCHES = 5;
const MAX_SEARCH_LENGTH = 512;

function invalid(message, key) {
    const err = new Error(message);
    err.responseCode = 400;
    err.code = 'InputValidationError';
    err.details = { [key]: message };
    return err;
}

function normalizeAddress(value) {
    const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
    // a plain address check: local part, @, domain with a dot; the exact syntax is not the point here
    if (!/^[^\s@<>()]{1,64}@[^\s@<>()]+\.[^\s@<>()]+$/.test(address) || address.length > 254) {
        throw invalid('Must be an email address', 'address');
    }
    return address;
}

class WebmailSenders {
    constructor(db) {
        this.collection = db.database.collection('webmail.senders');
    }

    async list(user) {
        const docs = await this.collection.find({ user }).sort({ address: 1 }).limit(MAX_SENDERS).toArray();
        return docs.map(doc => ({ id: doc._id.toString(), address: doc.address, created: doc.created }));
    }

    async add(user, value) {
        const address = normalizeAddress(value);
        const count = await this.collection.countDocuments({ user });
        if (count >= MAX_SENDERS) {
            const err = new Error(`At most ${MAX_SENDERS} senders can be listed`);
            err.responseCode = 400;
            err.code = 'TooMany';
            throw err;
        }
        const doc = await this.collection.findOneAndUpdate(
            { user, address },
            { $setOnInsert: { user, address, created: new Date() } },
            { upsert: true, returnDocument: 'after' }
        );
        return { id: doc._id.toString(), address: doc.address, created: doc.created };
    }

    async remove(user, value) {
        const address = normalizeAddress(value);
        const result = await this.collection.deleteOne({ user, address });
        return result.deletedCount > 0;
    }
}

class WebmailSearches {
    constructor(db) {
        this.collection = db.database.collection('webmail.searches');
    }

    async list(user) {
        const docs = await this.collection.find({ user }).sort({ used: -1 }).limit(MAX_SEARCHES).toArray();
        return docs.map(doc => ({ id: doc._id.toString(), query: doc.query, used: doc.used }));
    }

    /** Remembers a search, moving it to the top when it was there already; keeps the newest few. */
    async add(user, value) {
        const query = typeof value === 'string' ? value.trim() : '';
        if (!query || query.length > MAX_SEARCH_LENGTH) {
            throw invalid(`Must be 1 to ${MAX_SEARCH_LENGTH} characters`, 'query');
        }
        const doc = await this.collection.findOneAndUpdate(
            { user, query },
            { $set: { used: new Date() }, $setOnInsert: { user, query } },
            { upsert: true, returnDocument: 'after' }
        );
        const stale = await this.collection
            .find({ user }, { projection: { _id: true } })
            .sort({ used: -1 })
            .skip(MAX_SEARCHES)
            .toArray();
        if (stale.length) {
            await this.collection.deleteMany({ _id: { $in: stale.map(entry => entry._id) } });
        }
        return { id: doc._id.toString(), query: doc.query, used: doc.used };
    }

    async remove(user, id) {
        const result = await this.collection.deleteOne({ user, _id: id });
        return result.deletedCount > 0;
    }
}

module.exports = { WebmailSenders, WebmailSearches, MAX_SENDERS, MAX_SEARCHES };
