'use strict';

module.exports = async function (task, data, env, callback) {
    // env: { db, redis, loggelf }
    const db = env.db;
    const redis = env.redis;
    const loggelf = env.loggelf || (() => {});

    // Configurable keep entries (defaults to 1000)
    const keep = (data && data.keep) || (env.config && env.config.jmap && env.config.jmap.changelogKeep) || 1000;

    try {
        // scan keys matching pattern
        let cursor = '0';
        do {
            const res = await redis.scan(cursor, 'MATCH', 'jmap:changes:*', 'COUNT', 1000);
            cursor = res[0];
            const keys = res[1];
            for (const key of keys) {
                const len = await redis.llen(key);
                if (len <= keep) {
                    continue;
                }
                const toMove = len - keep;
                // fetch oldest entries
                const entries = await redis.lrange(key, 0, toMove - 1);
                if (!entries || !entries.length) {
                    // trim anyway
                    await redis.ltrim(key, -keep, -1);
                    continue;
                }

                // parse and prepare docs
                const docs = [];
                for (const raw of entries) {
                    try {
                        const e = JSON.parse(raw);
                        const user = key.replace('jmap:changes:', '');
                        docs.push({ user: user, seq: e.seq, type: e.type, id: e.id, ts: e.ts });
                    } catch (E) {
                        // ignore parse errors
                    }
                }

                if (docs.length) {
                    try {
                        await db.database.collection('jmap_changes').insertMany(docs, { ordered: false });
                    } catch (E) {
                        // ignore insert errors
                    }
                }

                // trim the redis list to keep last 'keep' entries
                await redis.ltrim(key, -keep, -1);
            }
        } while (cursor !== '0');

        return callback(null, true);
    } catch (err) {
        loggelf({ short_message: '[TASKFAIL] jmap-compact', _error: err.message });
        return callback(err);
    }
};
