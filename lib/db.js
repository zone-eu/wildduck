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

let getDBConnection = (main, config, callback) => {
    if (main) {
        if (!config) {
            return callback(null, false);
        }
        if (config && !/[:/]/.test(config)) {
            return callback(null, main.db(config));
        }
    }
    MongoClient.connect(
        config,
        {
            useNewUrlParser: true,
            useUnifiedTopology: true
        },
        (err, db) => {
            if (err) {
                return callback(err);
            }
            if (main && db.s && db.s.options && db.s.options.dbName) {
                db = db.db(db.s.options.dbName);
            }
            return callback(null, db);
        }
    );
};

let getRedisConf = defaultConfig => {
    const redisDefaults = {
        // some defaults
        maxRetriesPerRequest: null,
        showFriendlyErrorStack: true,
        retryStrategy(times) {
            const delay = !times ? 1000 : Math.min(2 ** times * 500, 15 * 1000);
            log.info('Redis', 'Connection retry times=%s delay=%s', times, delay);
            return delay;
        },
        connectionName: `${packageData.name}@${packageData.version}[${process.pid}]`
    };

    const redisConfig = typeof defaultConfig === 'string' ? redisUrl(defaultConfig) : defaultConfig || {};

    if (redisConfig && redisConfig.cluster) {
        let clusterConfig = Object.assign({}, redisConfig);
        let nodeDefaults = {};

        for (let key of ['password', 'username', 'tls']) {
            if (typeof clusterConfig[key] !== 'undefined') {
                nodeDefaults[key] = clusterConfig[key];
            }
        }

        let nodes = []
            .concat(clusterConfig.nodes || [])
            .map(node => Object.assign({}, nodeDefaults, node || {}))
            .filter(node => node && node.host);

        delete clusterConfig.cluster;
        delete clusterConfig.nodes;
        delete clusterConfig.password;
        delete clusterConfig.db;
        delete clusterConfig.username;
        delete clusterConfig.tls;

        let redisOptions = Object.assign({}, redisDefaults, nodeDefaults, clusterConfig.redisOptions || {});

        return {
            cluster: true,
            connectionName: redisOptions.connectionName,
            nodes,
            options: Object.assign({}, clusterConfig, { redisOptions })
        };
    }

    return Object.assign({}, redisDefaults, redisConfig);
};

module.exports.connect = callback => {
    const REDIS_CONF = getRedisConf(config.dbs.redis);

    module.exports.redisConfig = REDIS_CONF;
    module.exports.redis = REDIS_CONF.cluster ? new Redis.Cluster(REDIS_CONF.nodes, REDIS_CONF.options) : new Redis(REDIS_CONF);
    module.exports.queueConf = {
        connection: REDIS_CONF.cluster ? module.exports.redis : Object.assign({ connectionName: `${REDIS_CONF.connectionName}[notify]` }, REDIS_CONF),
        prefix: REDIS_CONF.cluster ? `{wd:bull}` : `wd:bull`
    };
    errors.registerRedisErrorLogger(module.exports.redis, {
        role: 'primary',
        connectionName: REDIS_CONF.connectionName,
        mode: REDIS_CONF.cluster ? 'cluster' : Array.isArray(REDIS_CONF.sentinels) ? 'sentinel' : 'direct',
        sentinelCount: Array.isArray(REDIS_CONF.sentinels) ? REDIS_CONF.sentinels.length : undefined,
        clusterNodeCount: REDIS_CONF.cluster && Array.isArray(REDIS_CONF.nodes) ? REDIS_CONF.nodes.length : undefined
    });

    getDBConnection(false, config.dbs.mongo, (err, db) => {
        if (err) {
            return callback(err);
        }

        if (db.s && db.s.options && db.s.options.dbName) {
            module.exports.database = db.db(db.s.options.dbName);
        } else {
            module.exports.database = db;
        }

        getDBConnection(db, config.dbs.gridfs, (err, gdb) => {
            if (err) {
                return callback(err);
            }
            module.exports.gridfs = gdb || module.exports.database;

            getDBConnection(db, config.dbs.users, (err, udb) => {
                if (err) {
                    return callback(err);
                }
                module.exports.users = udb || module.exports.database;

                getDBConnection(db, config.dbs.sender, (err, sdb) => {
                    if (err) {
                        return callback(err);
                    }
                    module.exports.senderDb = sdb || module.exports.database;

                    callback();
                });
            });
        });
    });
};
