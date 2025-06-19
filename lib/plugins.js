'use strict';

const config = require('wild-config');
const log = require('npmlog');
const PluginHandler = require('zone-mta/lib/plugin-handler');
const db = require('./db');

module.exports.handler = {
    // dummy handler
    runHooks(...args) {
        if (args.length && typeof args[args.length - 1] === 'function') {
            args[args.length - 1]();
        }

        // assume promise
        return new Promise(resolve => setImmediate(resolve));
    }
};

let apiServer = null;

module.exports.setApiServer = (server) => {
    apiServer = server;
};

module.exports.init = context => {
    module.exports.handler = new PluginHandler({
        logger: log,
        pluginsPath: config.plugins.pluginsPath,
        plugins: config.plugins.conf,
        context,
        log: config.log,
        db
    });
    
    // Set apiServer if provided (to allow plugins to add API endpoints)
    if (apiServer) {
        module.exports.handler.apiServer = {server: apiServer};
    }
};
