'use strict';

// TTL indexes whose expiry comes from a runtime setting (indexes.yaml: `ttlSetting` next to the
// index definition). Index setup creates them with the setting's value, and changes an existing index
// in place with collMod when the setting was changed since, so no index rebuild is needed.

/**
 * Creates an index from an indexes.yaml entry. For a setting driven TTL index that exists with
 * another expiry, the expiry is updated. Other option conflicts are thrown to the caller.
 *
 * @param {Db} db Database holding the collection
 * @param {Object} entry An entry of indexes.yaml ({collection, index, ttlSetting?})
 * @param {SettingsHandler} settingsHandler
 * @returns {Promise<{created: Boolean, ttlChanged: Boolean}>}
 */
async function ensureIndex(db, entry, settingsHandler) {
    let spec = entry.index;
    if (entry.ttlSetting) {
        const ms = await settingsHandler.get(entry.ttlSetting);
        spec = Object.assign({}, spec, { expireAfterSeconds: Math.max(1, Math.round(ms / 1000)) });
    }

    try {
        // the raw command, because the driver's createIndexes() only returns index names. Through mongos
        // the counts are reported per shard
        const r = await db.command({ createIndexes: entry.collection, indexes: [spec] });
        const results = r.raw ? Object.values(r.raw) : [r];
        return { created: results.some(result => result.numIndexesAfter > result.numIndexesBefore), ttlChanged: false };
    } catch (err) {
        if (err.codeName !== 'IndexOptionsConflict' || !entry.ttlSetting) {
            throw err;
        }
        await db.command({ collMod: entry.collection, index: { name: spec.name, expireAfterSeconds: spec.expireAfterSeconds } });
        return { created: false, ttlChanged: true };
    }
}

module.exports = { ensureIndex };
