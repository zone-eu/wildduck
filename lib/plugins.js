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
let handlers = {};

module.exports.setApiServer = (server) => {
    apiServer = server;
};

module.exports.setHandlers = (handlersObj) => {
    handlers = handlersObj;
};

module.exports.init = context => {
    // Merge handlers into context
    const fullContext = Object.assign({}, context, handlers);
    
    module.exports.handler = new PluginHandler({
        logger: log,
        pluginsPath: config.plugins.pluginsPath,
        plugins: config.plugins.conf,
        context: fullContext,
        log: config.log,
        db
    });
    
    // Set apiServer if provided (to allow plugins to add API endpoints)
    if (apiServer) {
        module.exports.handler.apiServer = {server: apiServer};
    }
};
