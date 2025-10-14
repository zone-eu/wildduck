'use strict';

const config = require('wild-config');
const log = require('npmlog');
const PluginHandler = require('wild-plugins');
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

module.exports.init = opts => {
    let context;

    if (typeof opts === 'string') {
        context = opts;
    }
    context = opts.context;

    module.exports.handler = new PluginHandler({
        logger: log,
        pluginsPath: opts.config?.plugins?.pluginsPath || config.plugins.pluginsPath,
        plugins: opts.config?.plugins?.conf || config.plugins.conf,
        context,
        log: opts.config?.log || config.log,
        db
    });
};
