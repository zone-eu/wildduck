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

        // Bulk append for efficient mailbox-level operations (rename/delete with thousands of messages)
        // Uses Redis pipeline to avoid 150,000+ sequential round-trips
        appendChangesBulk: async (user, changes) => {
            if (!changes || changes.length === 0) return 0;
            
            const uid = user.toString();
            const pipeline = redis.pipeline();
            
            // Increment state once for the batch
            const startSeq = await redis.incr('jmap:state:' + uid);
            
            // Add all entries in a single pipeline
            const ts = Date.now();
            for (let i = 0; i < changes.length; i++) {
                const change = changes[i];
                const entry = {
                    seq: Number(startSeq) + i,
                    type: change.type || 'created',
                    id: change.id || null,
                    ts: ts
                };
                pipeline.rpush('jmap:changes:' + uid, JSON.stringify(entry));
            }
            
            // Update state counter to final value
            if (changes.length > 1) {
                pipeline.incrby('jmap:state:' + uid, changes.length - 1);
            }
            
            // Trim list once at the end
            pipeline.ltrim('jmap:changes:' + uid, -MAX_ENTRIES, -1);
            
            // Execute all commands in one round-trip
            await pipeline.exec();
            
            return startSeq + changes.length - 1;
        },

        getChangesSince: async (user, sinceSeq) => {
            const uid = user.toString();
            let state = await redis.get('jmap:state:' + uid);
            state = state ? Number(state) : 0;

            if (!sinceSeq || Number(sinceSeq) < 1) {
                // return recent entries up to MAX_ENTRIES
                // Note: For high-volume accounts with MAX_ENTRIES entries, this loads all in memory
                // Consider using SCAN for very large lists if memory becomes an issue
                const raw = await redis.lrange('jmap:changes:' + uid, 0, -1);
                const entries = raw.map(r => JSON.parse(r)).filter(e => e.seq > 0);
                const created = entries.filter(e => e.type === 'created').map(e => e.id);
                const updated = entries.filter(e => e.type === 'updated').map(e => e.id);
                const destroyed = entries.filter(e => e.type === 'destroyed').map(e => e.id);
                return { created, updated, destroyed, newState: String(state) };
            }

            // Check if sinceSeq is too old (older than oldest entry in changelog)
            // This implements RFC 8620 Section 5.2 requirement
            const raw = await redis.lrange('jmap:changes:' + uid, 0, -1);
            if (raw.length > 0) {
                const oldestEntry = JSON.parse(raw[0]);
                if (Number(sinceSeq) < oldestEntry.seq) {
                    // sinceSeq is older than what we have in changelog
                    return { cannotCalculateChanges: true, newState: String(state) };
                }
            }

            // Note: This fetches all entries and filters in memory
            // Acceptable given MAX_ENTRIES limit, but could be optimized with binary search
            // if the changelog is stored with indexed seq values
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
