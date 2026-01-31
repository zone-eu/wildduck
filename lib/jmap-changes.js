'use strict';

// Simple JMAP per-user changelog backed by Redis
// Keys:
// - jmap:state:<user> => integer state (incrementing)
// - jmap:changes:<user> => list of JSON entries {seq, type, id, created}

module.exports = function (redis) {
    if (!redis) {
        throw new Error('Redis instance is required');
    }

    const MAX_ENTRIES = 5000; // keep changelog bounded

    return {
        appendChange: async (user, change) => {
            // user: user id string or ObjectId
            const uid = user.toString();
            const seq = await redis.incr('jmap:state:' + uid);
            const entry = {
                seq: Number(seq),
                type: change.type || 'created',
                id: change.id || null,
                ts: Date.now()
            };
            await redis.rpush('jmap:changes:' + uid, JSON.stringify(entry));
            // trim list
            await redis.ltrim('jmap:changes:' + uid, -MAX_ENTRIES, -1);
            return seq;
        },

        getChangesSince: async (user, sinceSeq) => {
            const uid = user.toString();
            let state = await redis.get('jmap:state:' + uid);
            state = state ? Number(state) : 0;

            if (!sinceSeq || Number(sinceSeq) < 1) {
                // return recent entries up to MAX_ENTRIES
                const raw = await redis.lrange('jmap:changes:' + uid, 0, -1);
                const entries = raw.map(r => JSON.parse(r)).filter(e => e.seq > 0);
                const created = entries.filter(e => e.type === 'created').map(e => e.id);
                const updated = entries.filter(e => e.type === 'updated').map(e => e.id);
                const destroyed = entries.filter(e => e.type === 'destroyed').map(e => e.id);
                return { created, updated, destroyed, newState: String(state) };
            }

            const raw = await redis.lrange('jmap:changes:' + uid, 0, -1);
            const entries = raw
                .map(r => JSON.parse(r))
                .filter(e => Number(e.seq) > Number(sinceSeq));

            const created = entries.filter(e => e.type === 'created').map(e => e.id);
            const updated = entries.filter(e => e.type === 'updated').map(e => e.id);
            const destroyed = entries.filter(e => e.type === 'destroyed').map(e => e.id);

            return { created, updated, destroyed, newState: String(state) };
        }
    };
};