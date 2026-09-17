'use strict';

const { ObjectId } = require('mongodb');
const { SYSTEM_FLAGS, DB_MAX_TIME_MAILBOXES, MAX_KEYWORDS } = require('./consts');
const { keywordSchema } = require('./schemas');

const reserved = new Set([...SYSTEM_FLAGS].map(flag => flag.toLowerCase()));

function normalizeUser(user) {
    return typeof user === 'string' ? new ObjectId(user) : user;
}

function getRequestedPaths(values) {
    const paths = new Set();
    for (const value of values || []) {
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
    }
    return [...paths];
}

// Parent records make the label tree independently listable. Assigning a child
// label to a message does not implicitly assign any of its parents.
function expandPaths(values) {
    const paths = new Set();
    for (const value of getRequestedPaths(values)) {
        paths.add(value);
        const parts = value.split('/');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (!reserved.has(parent.toLowerCase())) {
                paths.add(parent);
            }
        }
    }
    return [...paths];
}

function keywordStateError(record) {
    if (record && record.deleting) {
        const err = new Error('Keyword is being deleted');
        err.code = 'KeywordDeleting';
        err.responseCode = 409;
        return err;
    }
}

function keywordLimitError() {
    const err = new Error(`A user can have at most ${MAX_KEYWORDS} labels, including parent paths`);
    err.code = 'KeywordLimitExceeded';
    err.responseCode = 400;
    return err;
}

async function getFreeSlot(collection, user) {
    const [allocation] = await collection
        .aggregate(
            [
                { $match: { user } },
                { $group: { _id: null, count: { $sum: 1 }, slots: { $addToSet: '$slot' } } },
                {
                    $project: {
                        _id: false,
                        count: true,
                        slot: { $arrayElemAt: [{ $setDifference: [{ $range: [0, MAX_KEYWORDS] }, '$slots'] }, 0] }
                    }
                }
            ],
            { maxTimeMS: DB_MAX_TIME_MAILBOXES }
        )
        .toArray();

    if (!allocation) {
        return 0;
    }
    if (allocation.count >= MAX_KEYWORDS || !Number.isInteger(allocation.slot)) {
        throw keywordLimitError();
    }
    return allocation.slot;
}

async function findPathRecords(collection, user, paths) {
    if (!paths.length) {
        return [];
    }
    return collection
        .find(
            {
                user,
                path: { $in: paths }
            },
            {
                projection: { path: 1, slot: 1, deleting: 1 },
                maxTimeMS: DB_MAX_TIME_MAILBOXES
            }
        )
        .toArray();
}

async function ensureKeywords(database, user, values) {
    const requestedPaths = getRequestedPaths(values);
    const paths = expandPaths(requestedPaths);
    const created = [];
    if (!paths.length) {
        return { created, keywords: [] };
    }

    user = normalizeUser(user);
    const collection = database.collection('keywords');
    let records = await findPathRecords(collection, user, paths);

    for (const record of records) {
        const err = keywordStateError(record);
        if (err) {
            throw err;
        }
    }

    let existing = new Set(records.filter(record => paths.includes(record.path)).map(record => record.path));
    for (const path of paths) {
        if (existing.has(path)) {
            continue;
        }

        // user+slot is the concurrency-safe hard limit. A duplicate path or
        // slot means another writer won a race, so resolve the path and retry.
        while (!existing.has(path)) {
            const slot = await getFreeSlot(collection, user);
            try {
                await collection.insertOne({ user, path, slot, created: new Date() });
                created.push(path);
                existing.add(path);
            } catch (err) {
                if (err.code !== 11000) {
                    throw err;
                }

                const [conflict] = await findPathRecords(collection, user, [path]);
                if (conflict) {
                    const stateError = keywordStateError(conflict);
                    if (stateError) {
                        throw stateError;
                    }
                    if (conflict.path === path) {
                        existing.add(path);
                    }
                }
            }
        }
    }

    records = await collection
        .find(
            { user, path: { $in: paths } },
            {
                projection: { path: 1, slot: 1, deleting: 1 },
                maxTimeMS: DB_MAX_TIME_MAILBOXES
            }
        )
        .toArray();

    const byPath = new Map(records.map(record => [record.path, record]));
    return {
        created,
        keywords: requestedPaths.map(path => byPath.get(path)).filter(record => record)
    };
}

async function getKeywordMaps(database, user, options = {}) {
    user = normalizeUser(user);
    const query = { user };
    if (options.ids && options.ids.length) {
        query._id = { $in: options.ids };
    }
    if (options.paths && options.paths.length) {
        query.path = { $in: options.paths };
    }

    const records = await database
        .collection('keywords')
        .find(query, { projection: { path: 1, deleting: 1 }, maxTimeMS: DB_MAX_TIME_MAILBOXES })
        .toArray();

    return {
        records,
        byId: new Map(records.map(record => [record._id.toString(), record.path])),
        byPath: new Map(records.map(record => [record.path, record]))
    };
}

function keywordPathsForMessage(message, byId) {
    return [...new Set((message.keywords || []).map(id => byId.get(id.toString())).filter(path => path))];
}

async function attachKeywordPaths(database, user, messages) {
    messages = [].concat(messages || []);
    const ids = [];
    const seen = new Set();
    for (const message of messages) {
        for (const id of message.keywords || []) {
            const key = id.toString();
            if (!seen.has(key)) {
                seen.add(key);
                ids.push(id);
            }
        }
    }

    const maps = ids.length ? await getKeywordMaps(database, user, { ids }) : { byId: new Map() };
    for (const message of messages) {
        message.keywordPaths = keywordPathsForMessage(message, maps.byId);
    }
    return messages;
}

async function prepareKeywordChanges(database, user, changes) {
    const hasChanges = changes && ['keywords', 'addKeywords', 'removeKeywords'].some(key => key in changes);
    if (!hasChanges) {
        return changes;
    }

    const setPaths = getRequestedPaths(changes.keywords || []);
    const addPaths = getRequestedPaths(changes.addKeywords || []);
    const removePaths = getRequestedPaths(changes.removeKeywords || []);
    await ensureKeywords(database, user, [...setPaths, ...addPaths]);

    const maps = await getKeywordMaps(database, user);
    const toIds = paths => paths.map(path => maps.byPath.get(path)).filter(record => record).map(record => record._id);

    return {
        ...changes,
        _keywordIds: toIds(setPaths),
        _addKeywordIds: toIds(addPaths),
        _removeKeywordIds: toIds(removePaths),
        _keywordPathsById: maps.byId
    };
}

module.exports = {
    ensureKeywords,
    expandPaths,
    getRequestedPaths,
    getKeywordMaps,
    keywordPathsForMessage,
    attachKeywordPaths,
    prepareKeywordChanges
};
