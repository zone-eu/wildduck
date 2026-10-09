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

const getDBConnection = async (main, connection) => {
    if (main) {
        if (!connection) {
            return false;
        }
        if (!/[:/]/.test(connection)) {
            return main.db(connection);
        }
    }

    const client = await MongoClient.connect(connection);
    return main ? client.db() : client;
};

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

    const client = await getDBConnection(false, config.dbs.mongo);
    module.exports.database = client.db();
    module.exports.gridfs = (await getDBConnection(client, config.dbs.gridfs)) || module.exports.database;
    module.exports.users = (await getDBConnection(client, config.dbs.users)) || module.exports.database;
    module.exports.senderDb = (await getDBConnection(client, config.dbs.sender)) || module.exports.database;
};

// Keep the connection callback used by server entry points and library consumers.
module.exports.connect = callback =>
    connect().then(
        () => callback(),
        err => callback(err)
    );
