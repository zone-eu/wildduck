'use strict';

// Small per user lists a webmail client keeps: senders whose remote content (images) may load, and
// the most recent searches. Each entry is one document with the user first in its index.

const tools = require('../tools');
const { invalid } = require('./preferences');

const MAX_SENDERS = 1000;
const MAX_SEARCHES = 5;
const MAX_SEARCH_LENGTH = 512;

/** A sender address in the form WildDuck stores addresses (NFC, lowercase, punycode domain). */
function senderAddress(value) {
    const address = typeof value === 'string' ? value.trim() : '';
    // a plain address check: local part, @, domain with a dot; the exact syntax is not the point here
    if (!/^[^\s@<>()]{1,64}@[^\s@<>()]+\.[^\s@<>()]+$/.test(address) || address.length > 254) {
        throw invalid('Must be an email address', 'address');
    }
    return tools.normalizeAddress(address);
}

class WebmailSenders {
    constructor(db) {
        this.collection = db.database.collection('webmail.senders');
    }

    static toEntry(doc) {
        return { id: doc._id.toString(), address: doc.address, created: doc.created };
    }

    async list(user) {
        const docs = await this.collection.find({ user }).sort({ address: 1 }).limit(MAX_SENDERS).toArray();
        return docs.map(WebmailSenders.toEntry);
    }

    /** Adds a sender; adding one that is listed already changes nothing. */
    async add(user, value) {
        const address = senderAddress(value);
        const result = await this.collection.findOneAndUpdate(
            { user, address },
            { $setOnInsert: { user, address, created: new Date() } },
            { upsert: true, returnDocument: 'after', includeResultMetadata: true }
        );
        // the limit is checked only when the add created an entry, and that entry is taken back
        if (result.lastErrorObject?.upserted && (await this.collection.countDocuments({ user })) > MAX_SENDERS) {
            await this.collection.deleteOne({ _id: result.value._id });
            throw invalid(`At most ${MAX_SENDERS} senders can be listed`, 'address', 'TooMany');
        }
        return WebmailSenders.toEntry(result.value);
    }

    async remove(user, value) {
        const result = await this.collection.deleteOne({ user, address: senderAddress(value) });
        return result.deletedCount > 0;
    }
}

class WebmailSearches {
    constructor(db) {
        this.collection = db.database.collection('webmail.searches');
    }

    static toEntry(doc) {
        return { id: doc._id.toString(), query: doc.query, used: doc.used };
    }

    async list(user) {
        const docs = await this.collection.find({ user }).sort({ used: -1 }).limit(MAX_SEARCHES).toArray();
        return docs.map(WebmailSearches.toEntry);
    }

    /** Remembers a search, moving it to the top when it was there already; keeps the newest few. */
    async add(user, value) {
        const query = typeof value === 'string' ? value.trim() : '';
        if (!query || query.length > MAX_SEARCH_LENGTH) {
            throw invalid(`Must be 1 to ${MAX_SEARCH_LENGTH} characters`, 'query');
        }
        const result = await this.collection.findOneAndUpdate(
            { user, query },
            { $set: { used: new Date() }, $setOnInsert: { user, query } },
            { upsert: true, returnDocument: 'after', includeResultMetadata: true }
        );
        // only a new search can push the list over the limit; a repeated one just moves up
        if (result.lastErrorObject?.upserted) {
            const stale = await this.collection
                .find({ user }, { projection: { _id: true } })
                .sort({ used: -1 })
                .skip(MAX_SEARCHES)
                .toArray();
            if (stale.length) {
                await this.collection.deleteMany({ _id: { $in: stale.map(entry => entry._id) } });
            }
        }
        return WebmailSearches.toEntry(result.value);
    }

    async remove(user, id) {
        const result = await this.collection.deleteOne({ user, _id: id });
        return result.deletedCount > 0;
    }
}

module.exports = { WebmailSenders, WebmailSearches };
