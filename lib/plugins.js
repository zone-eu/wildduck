'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const PluginHandler = require('@zone-eu/wild-plugins');
const db = require('./db');

// Placeholder until init() runs, for processes that never load plugins (tests,
// tools using WildDuck as a library): hooks do nothing and messages pass the
// analyzer stage unchanged, as with a plugin handler that has no analyzers
module.exports.handler = {
    runHooks(...args) {
        if (args.length && typeof args[args.length - 1] === 'function') {
            args[args.length - 1]();
        }

        // assume promise
        return new Promise(resolve => setImmediate(resolve));
    },

    runAnalyzerHooks(envelope, source, output) {
        source.once('error', err => output.emit('error', err));
        source.pipe(output);
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
