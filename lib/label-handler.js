'use strict';

const { ObjectId } = require('mongodb');
const { SYSTEM_FLAGS, DB_MAX_TIME_MAILBOXES, MAX_LABELS, MAX_LABEL_LENGTH } = require('./consts');

const reserved = new Set([...SYSTEM_FLAGS].map(flag => flag.toLowerCase()));

/**
 * Checks a custom label name. A label is a non-empty string of at most MAX_LABEL_LENGTH UTF-16
 * code units that is neither an internal flag (`$` or `\` prefix) nor a system flag in any case.
 * The API validator `label` (lib/fastify/validation.js) uses the same check.
 *
 * @param {*} value Candidate label name
 * @returns {Boolean} True when the value can be used as a custom label
 */
function isValidLabelName(value) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_LABEL_LENGTH &&
        !value.startsWith('$') &&
        !value.startsWith('\\') &&
        !reserved.has(value.toLowerCase())
    );
}

function normalizeUser(user) {
    return typeof user === 'string' ? new ObjectId(user) : user;
}

function getRequestedNames(values) {
    const names = new Set();
    for (const value of values || []) {
        if (typeof value !== 'string' || !value || reserved.has(value.toLowerCase()) || value.startsWith('\\')) {
            continue;
        }
        if (!isValidLabelName(value)) {
            const err = new Error('Label names must be non-empty strings no longer than 256 characters and must not use a reserved system flag');
            err.code = 'InvalidLabel';
            err.responseCode = 400;
            throw err;
        }
        names.add(value);
    }
    return [...names];
}

function labelStateError(record) {
    if (record && record.deleting) {
        const err = new Error('Label is being deleted');
        err.code = 'LabelDeleting';
        err.responseCode = 409;
        return err;
    }
}

function labelLimitError() {
    const err = new Error(`A user can have at most ${MAX_LABELS} labels`);
    err.code = 'LabelLimitExceeded';
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
                        slot: { $arrayElemAt: [{ $setDifference: [{ $range: [0, MAX_LABELS] }, '$slots'] }, 0] }
                    }
                }
            ],
            { maxTimeMS: DB_MAX_TIME_MAILBOXES }
        )
        .toArray();

    if (!allocation) {
        return 0;
    }
    if (allocation.count >= MAX_LABELS || !Number.isInteger(allocation.slot)) {
        throw labelLimitError();
    }
    return allocation.slot;
}

async function findNameRecords(collection, user, names) {
    if (!names.length) {
        return [];
    }
    return collection
        .find(
            {
                user,
                name: { $in: names }
            },
            {
                projection: { name: 1, metaData: 1, slot: 1, deleting: 1 },
                maxTimeMS: DB_MAX_TIME_MAILBOXES
            }
        )
        .toArray();
}

async function ensureLabels(database, user, values, options = {}) {
    const names = getRequestedNames(values);
    const created = [];
    if (!names.length) {
        return { created, labels: [] };
    }

    user = normalizeUser(user);
    const collection = database.collection('labels');
    let records = await findNameRecords(collection, user, names);

    for (const record of records) {
        const err = labelStateError(record);
        if (err) {
            throw err;
        }
    }

    const existing = new Set(records.map(record => record.name));
    for (const name of names) {
        if (existing.has(name)) {
            continue;
        }

        // user+slot is the concurrency-safe hard limit. A duplicate name or
        // slot means another writer won a race, so resolve the name and retry.
        while (!existing.has(name)) {
            const slot = await getFreeSlot(collection, user);
            try {
                await collection.insertOne({ user, name, slot, created: new Date(), ...(options.metaData === undefined ? {} : { metaData: options.metaData }) });
                created.push(name);
                existing.add(name);
            } catch (err) {
                if (err.code !== 11000) {
                    throw err;
                }

                const [conflict] = await findNameRecords(collection, user, [name]);
                if (conflict) {
                    const stateError = labelStateError(conflict);
                    if (stateError) {
                        throw stateError;
                    }
                    existing.add(name);
                }
            }
        }
    }

    records = await findNameRecords(collection, user, names);

    const byName = new Map(records.map(record => [record.name, record]));
    return {
        created,
        labels: names.map(name => byName.get(name)).filter(record => record)
    };
}

async function getLabelMaps(database, user, options = {}) {
    user = normalizeUser(user);
    const query = { user };
    if (options.ids && options.ids.length) {
        query._id = { $in: options.ids };
    }

    const records = await database
        .collection('labels')
        .find(query, { projection: { name: 1, deleting: 1 }, maxTimeMS: DB_MAX_TIME_MAILBOXES })
        .toArray();

    const active = records.filter(record => !record.deleting);
    return {
        records: active,
        byId: new Map(active.map(record => [record._id.toString(), record.name])),
        byName: new Map(active.map(record => [record.name, record]))
    };
}

function labelNamesForMessage(message, byId) {
    return [...new Set((message.labels || []).map(id => byId.get(id.toString())).filter(name => name))];
}

function getMessageImapFlags(message, byId) {
    const flags = [];
    const seen = new Set();
    for (const flag of [...(message.flags || []), ...(message.labels || []).filter(id => byId.has(id.toString())).map(id => `$wdlabel$${id.toString()}`)]) {
        const key = flag.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            flags.push(flag);
        }
    }
    return flags;
}

function resolveImapLabels(flags, records) {
    const byId = new Map(records.filter(record => !record.deleting).map(record => [record._id.toString(), record]));
    const labels = [];
    const ordinaryFlags = [];
    const seen = new Set();
    for (const flag of flags || []) {
        const match = typeof flag === 'string' && /^\$wdlabel\$([a-f0-9]{24})$/i.exec(flag);
        const record = match && byId.get(match[1].toLowerCase());
        if (record) {
            if (!seen.has(record._id.toString())) {
                seen.add(record._id.toString());
                labels.push(record._id);
            }
        } else {
            ordinaryFlags.push(flag);
        }
    }
    return { labels, flags: ordinaryFlags };
}

async function attachLabelNames(database, user, messages) {
    messages = [].concat(messages || []);
    const ids = [];
    const seen = new Set();
    for (const message of messages) {
        for (const id of message.labels || []) {
            const key = id.toString();
            if (!seen.has(key)) {
                seen.add(key);
                ids.push(id);
            }
        }
    }

    const maps = ids.length ? await getLabelMaps(database, user, { ids }) : { byId: new Map() };
    for (const message of messages) {
        message.labelNames = labelNamesForMessage(message, maps.byId);
    }
    return messages;
}

async function prepareLabelChanges(database, user, changes) {
    const hasChanges = changes && ['labels', 'addLabels', 'removeLabels'].some(key => key in changes);
    if (!hasChanges) {
        return changes;
    }

    const setNames = getRequestedNames(changes.labels || []);
    const addNames = getRequestedNames(changes.addLabels || []);
    const removeNames = getRequestedNames(changes.removeLabels || []);
    await ensureLabels(database, user, [...setNames, ...addNames]);

    const maps = await getLabelMaps(database, user);
    const toIds = names => names.map(name => maps.byName.get(name)).filter(record => record).map(record => record._id);

    return {
        ...changes,
        _labelIds: toIds(setNames),
        _addLabelIds: toIds(addNames),
        _removeLabelIds: toIds(removeNames),
        _labelNamesById: maps.byId
    };
}

module.exports = {
    isValidLabelName,
    ensureLabels,
    getRequestedNames,
    getLabelMaps,
    labelNamesForMessage,
    getMessageImapFlags,
    resolveImapLabels,
    attachLabelNames,
    prepareLabelChanges
};
