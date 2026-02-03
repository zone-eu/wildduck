/* eslint global-require: 0, no-console: 0 */
'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const Gelf = require('gelf');
const os = require('os');
const util = require('util');

let loggelf;
let component;
let hostname;

module.exports.gelf = {};

let gelfconf = (config && config.log && config.log.gelf) || {};

component = gelfconf.component || 'wildduck';
hostname = gelfconf.hostname || os.hostname();

module.exports.gelf.handler = gelfconf.enabled
    ? new Gelf(gelfconf.options)
    : {
          emit: (channel, message) => log.error('Gelf', util.inspect(message, false, 3))
      };

loggelf = (...args) => {
    let err = args.shift() || {};
    if (err.code === 'ECONNRESET') {
        // just ignore
        return;
    }

    let message = {
        short_message: component.toUpperCase() + ' [Exception] ' + (err.message || ''),
        full_message: err.stack,
        _exception: 'yes',
        _error: err.message
    };

    let limitLength = val => {
        let str = (val || '').toString().trim();
        if (str.length > 256) {
            str = str.substr(0, 256) + '…';
        }
        return str;
    };

    Object.keys(err).forEach(key => {
        let vKey = '_' + key.replace(/^_/, '');
        if (!message[vKey] && typeof err[key] !== 'object') {
            message[vKey] = limitLength(err[key]);
        }
    });

    for (let extra of args) {
        Object.keys(extra || {}).forEach(key => {
            let vKey = '_' + key.replace(/^_/, '');
            if (!message[vKey] && typeof extra[key] !== 'object') {
                message[vKey] = limitLength(extra[key]);
            }
        });
    }

    message.facility = component; // facility is deprecated but set by the driver if not provided
    message.host = hostname;
    message.timestamp = Date.now() / 1000;
    message._component = component;

    Object.keys(message).forEach(key => {
        if (!message[key]) {
            delete message[key];
        }
    });

    try {
        module.exports.gelf.handler.emit('gelf.log', message);
    } catch (err) {
        // might fail on non-JSONizable input
        try {
            log.error(err);
            log.error(util.inspect(message, false, 3));
        } catch (err) {
            //ignore
        }
    }
};

module.exports.notify = (...args) => {
    loggelf(...args);
};

module.exports.notifyConnection = (connection, ...args) => {
    let err = args[0];
    let metaData = args[1] || {};
    if (connection) {
        if (connection.selected) {
            metaData.selected = connection.selected.mailbox;
        }

        if (connection.session.user) {
            metaData.userId = connection.session.user.id.toString();
        }

        if (connection.id) {
            metaData.sess = connection.id;
        }

        metaData.remoteAddress = connection.session.remoteAddress;
        metaData.isUTF8Enabled = !!connection.acceptUTF8Enabled;
    }

    Object.keys(err.meta || {}).forEach(key => {
        metaData[key] = err.meta[key];
    });

    args[1] = metaData;
    loggelf(...args);
};

module.exports.setGelf = gelf => {
    module.exports.gelf.handler = gelf;
};

module.exports.registerRedisErrorLogger = (redis, meta = {}) => {
    if (!redis || typeof redis.on !== 'function') {
        return;
    }

    if (redis.__gelfRedisErrorLogger) {
        return;
    }

    redis.__gelfRedisErrorLogger = true;

    redis.on('error', err => {
        let error = err instanceof Error ? err : new Error((err && err.message) || String(err));
        module.exports.notify(error, { service: 'redis', ...meta });
    });
};
