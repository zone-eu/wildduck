'use strict';

const config = require('@zone-eu/wild-config');
const { Client } = require('@opensearch-project/opensearch');

const { ensureIndex } = require('./ensure-es-index');
const log = require('npmlog');

let cachedClient = null;

const getClient = () => {
    if (cachedClient) {
        return cachedClient;
    }

    let parsedUrl = new URL(config.elasticsearch.url);
    if (config.elasticsearch.user) {
        parsedUrl.username = config.elasticsearch.user;
    }

    if (config.elasticsearch.pass) {
        parsedUrl.password = config.elasticsearch.pass;
    }

    cachedClient = new Client({
        node: parsedUrl.href,
        ssl: {
            rejectUnauthorized: false
        }
    });

    return cachedClient;
};

const init = async () => {
    if (!config.elasticsearch.enabled) {
        return false;
    }

    let client = getClient();
    let indexInfo = await ensureIndex(client, config.elasticsearch.index);
    if (indexInfo && indexInfo.created) {
        log.info('ElasticSearch', 'Index "%s" created', config.elasticsearch.index);
    } else if (indexInfo && indexInfo.updated && indexInfo.changes) {
        log.info('ElasticSearch', 'Index "%s" updated (%s)', config.elasticsearch.index, JSON.stringify(indexInfo.changes));
    }

    return true;
};

module.exports = { init, getClient };
