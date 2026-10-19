'use strict';

const fs = require('fs');
const ttlCounterScript = fs.readFileSync(__dirname + '/lua/ttlcounter.lua', 'utf-8');
const cachedCounterScript = fs.readFileSync(__dirname + '/lua/cachedcounter.lua', 'utf-8');
const limitedCounterScript = fs.readFileSync(__dirname + '/lua/limitedcounter.lua', 'utf-8');
const processLockScript = fs.readFileSync(__dirname + '/lua/process-lock.lua', 'utf-8');

const clientVersion = Date.now();

module.exports = redis => {
    redis.defineCommand('ttlcounter', {
        numberOfKeys: 1,
        lua: ttlCounterScript
    });

    redis.defineCommand('cachedcounter', {
        numberOfKeys: 1,
        lua: cachedCounterScript
    });

    redis.defineCommand('limitedcounter', {
        numberOfKeys: 1,
        lua: limitedCounterScript
    });

    redis.defineCommand('processlock', {
        numberOfKeys: 1,
        lua: processLockScript
    });

    let asyncTTLCounter = async (key, count, max, windowSize) => {
        if (!max || isNaN(max)) {
            return {
                success: true,
                value: 0,
                ttl: 0
            };
        }
        let res = await redis.ttlcounter(key, count, max, windowSize || 86400);
        return {
            success: !!((res && res[0]) || 0),
            value: (res && res[1]) || 0,
            ttl: (res && res[2]) || 0
        };
    };

    return {
        asyncTTLCounter,

        ttlcounter(key, count, max, windowSize, callback) {
            return asyncTTLCounter(key, count, max, windowSize)
                .then(res => callback(null, res))
                .catch(callback);
        },

        cachedcounter(key, count, ttl, callback) {
            redis.cachedcounter(key, count, ttl, (err, res) => {
                if (err) {
                    return callback(err);
                }
                callback(null, res);
            });
        },

        limitedcounter(key, entry, count, limit, callback) {
            redis.limitedcounter(key, entry, count, limit, clientVersion, (err, res) => {
                if (err) {
                    return callback(err);
                }
                return callback(null, {
                    success: !!((res && res[0]) || 0),
                    value: (res && res[1]) || 0
                });
            });
        },

        async processlock(key, identifier, ttl) {
            return await redis.processlock(key, identifier, ttl);
        }
    };
};
