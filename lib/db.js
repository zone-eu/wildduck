'use strict';

const config = require('@zone-eu/wild-config');
const mongodb = require('mongodb');
const Redis = require('ioredis');
const redisUrl = require('./redis-url');
const log = require('npmlog');
const errors = require('./errors');
const packageData = require('../package.json');

const MongoClient = mongodb.MongoClient;

module.exports.database = false;
module.exports.gridfs = false;
module.exports.users = false;
module.exports.senderDb = false;

// Resolves a database handle for a connection string, or for a database name on the main connection
const getDBConnection = async (main, config) => {
    if (main) {
        if (!config) {
            return false;
        }
        if (!/[:/]/.test(config)) {
            return main.db(config);
        }
    }

    let db = await MongoClient.connect(config);
    if (main && db.s && db.s.options && db.s.options.dbName) {
        db = db.db(db.s.options.dbName);
    }
    return db;
};

/**
 * Connects to Redis and MongoDB and fills in the exported database handles
 *
 * @returns {Promise<void>}
 */
const connect = async () => {
    const REDIS_CONF = Object.assign(
        {
            // some defaults
            maxRetriesPerRequest: null,
            showFriendlyErrorStack: true,
            retryStrategy(times) {
                const delay = !times ? 1000 : Math.min(2 ** times * 500, 15 * 1000);
                log.info('Redis', 'Connection retry times=%s delay=%s', times, delay);
                return delay;
            },
            connectionName: `${packageData.name}@${packageData.version}[${process.pid}]`
        },
        typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis || {}
    );

    module.exports.redisConfig = REDIS_CONF;
    module.exports.queueConf = {
        connection: Object.assign({ connectionName: `${REDIS_CONF.connectionName}[notify]` }, REDIS_CONF),
        prefix: `wd:bull`
    };
    module.exports.redis = new Redis(REDIS_CONF);
    errors.registerRedisErrorLogger(module.exports.redis, {
        role: 'primary',
        connectionName: REDIS_CONF.connectionName,
        mode: Array.isArray(REDIS_CONF.sentinels) ? 'sentinel' : 'direct',
        sentinelCount: Array.isArray(REDIS_CONF.sentinels) ? REDIS_CONF.sentinels.length : undefined
    });

    const db = await getDBConnection(false, config.dbs.mongo);

    if (db.s && db.s.options && db.s.options.dbName) {
        module.exports.database = db.db(db.s.options.dbName);
    } else {
        module.exports.database = db;
    }

    module.exports.gridfs = (await getDBConnection(db, config.dbs.gridfs)) || module.exports.database;
    module.exports.users = (await getDBConnection(db, config.dbs.users)) || module.exports.database;
    module.exports.senderDb = (await getDBConnection(db, config.dbs.sender)) || module.exports.database;
};

/**
 * Connects to the databases. Returns a promise when called without a callback
 *
 * @param {Function} [callback] Called once the connections are ready
 * @returns {Promise<void>|undefined}
 */
module.exports.connect = callback => {
    const connecting = connect();
    if (typeof callback !== 'function') {
        return connecting;
    }
    connecting.then(() => callback(), callback);
};
