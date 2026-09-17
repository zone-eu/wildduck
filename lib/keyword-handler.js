'use strict';

const { ObjectId } = require('mongodb');
const { SYSTEM_FLAGS, DB_MAX_TIME_MAILBOXES, MAX_KEYWORDS } = require('./consts');
const { keywordSchema } = require('./schemas');

const reserved = new Set([...SYSTEM_FLAGS].map(flag => flag.toLowerCase()));

// Paths remain the IMAP keyword stored on messages. Parent records do not
// imply that messages tagged with a child also carry the parent keyword.
function expandPaths(values) {
    const paths = new Set();
    for (const value of values) {
        if (typeof value !== 'string' || !value || reserved.has(value.toLowerCase()) || value.startsWith('\\')) {
            continue;
        }
        if (keywordSchema.validate(value).error) {
            const err = new Error('Keyword paths must be at most 256 characters and five nonempty levels');
            err.code = 'InvalidKeyword';
            err.responseCode = 400;
            throw err;
        }
        paths.add(value);
        const parts = value.split('/');
        if (parts.every(part => part.length)) {
            for (let i = 1; i < parts.length; i++) {
                const parent = parts.slice(0, i).join('/');
                if (!reserved.has(parent.toLowerCase())) {
                    paths.add(parent);
                }
            }
        }
    }
    return [...paths];
}

async function ensureKeywords(database, user, values) {
    const paths = expandPaths(values);
    const created = [];
    if (!paths.length) {
        return { created };
    }
    user = typeof user === 'string' ? new ObjectId(user) : user;
    const collection = database.collection('keywords');
    // Most assignments reuse existing labels. Resolve only the requested paths
    // through the unique user/path index before reading allocation slots.
    const known = await collection
        .find({ user, path: { $in: paths } }, { projection: { path: 1, deleting: 1 }, maxTimeMS: DB_MAX_TIME_MAILBOXES })
        .toArray();
    if (known.some(record => record.deleting)) {
        const err = new Error('Keyword is being deleted');
        err.code = 'KeywordDeleting';
        err.responseCode = 409;
        throw err;
    }
    if (known.length === paths.length) {
        return { created };
    }
    let remaining = paths;
    while (remaining.length) {
        const records = await collection.find({ user }, { projection: { path: 1, slot: 1 }, maxTimeMS: DB_MAX_TIME_MAILBOXES }).toArray();
        const existing = new Set(records.map(record => record.path));
        remaining = remaining.filter(path => !existing.has(path));
        if (!remaining.length) {
            return { created };
        }
        if (records.length + remaining.length > MAX_KEYWORDS) {
            const err = new Error(`A user can have at most ${MAX_KEYWORDS} labels, including parent paths`);
            err.code = 'KeywordLimitExceeded';
            err.responseCode = 400;
            throw err;
        }
        // Unique slots give a hard concurrency-safe bound without requiring
        // MongoDB transactions or a Redis lock. Reserve slots for any records
        // created by earlier revisions that do not yet have a slot.
        const used = new Set(records.filter(record => Number.isInteger(record.slot)).map(record => record.slot));
        let unassigned = records.length - used.size;
        for (let slot = 0; slot < MAX_KEYWORDS && unassigned; slot++) {
            if (!used.has(slot)) {
                used.add(slot);
                unassigned--;
            }
        }
        for (const path of remaining) {
            let slot = 0;
            while (used.has(slot)) {
                slot++;
            }
            try {
                await collection.insertOne({ user, path, slot, created: new Date() });
                used.add(slot);
                created.push(path);
            } catch (err) {
                if (err.code !== 11000) {
                    throw err;
                }
                // Another writer claimed this path or slot. Reload before
                // deciding which paths and capacity are still available.
                break;
            }
        }
    }
}

module.exports = { ensureKeywords, expandPaths };
