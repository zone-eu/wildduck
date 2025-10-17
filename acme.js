'use strict';

const config = require('@zone-eu/wild-config');
const restify = require('restify');
const log = require('npmlog');
const logger = require('restify-logger');
const db = require('./lib/db');
const Gelf = require('gelf');
const os = require('os');

const acmeRoutes = require('./lib/api/acme');

let loggelf;

const serverOptions = {
    name: 'WildDuck ACME Agent',
    strictRouting: true,
    maxParamLength: 196
};

const server = restify.createServer(serverOptions);

// res.pipe does not work if Gzip is enabled
//server.use(restify.plugins.gzipResponse());

server.use(
    restify.plugins.queryParser({
        allowDots: true,
        mapParams: true
    })
);

logger.token('user-ip', req => ((req.params && req.params.ip) || '').toString().substr(0, 40) || '-');
logger.token('user-sess', req => (req.params && req.params.sess) || '-');

logger.token('user', req => (req.user && req.user.toString()) || '-');
logger.token('url', req => {
    if (/\baccessToken=/.test(req.url)) {
        return req.url.replace(/\baccessToken=[^&]+/g, 'accessToken=' + 'x'.repeat(6));
    }
    return req.url;
});

server.use(
    logger(':remote-addr :user [:user-ip/:user-sess] :method :url :status :time-spent :append', {
        stream: {
            write: message => {
                message = (message || '').toString();
                if (message) {
                    log.http('ACME', message.replace('\n', '').trim());
                }
            }
        }
    })
);

module.exports = done => {
    if (!config.acme || !config.acme.agent || !config.acme.agent.enabled) {
        return setImmediate(() => done(null, false));
    }

    let started = false;

    const component = config.log.gelf.component || 'wildduck';
    const hostname = config.log.gelf.hostname || os.hostname();
    const gelf =
        config.log.gelf && config.log.gelf.enabled
            ? new Gelf(config.log.gelf.options)
            : {
                  // placeholder
                  emit: (key, message) => log.info('Gelf', JSON.stringify(message))
              };

    loggelf = message => {
        if (typeof message === 'string') {
            message = {
                short_message: message
            };
        }
        message = message || {};

        if (!message.short_message || message.short_message.indexOf(component.toUpperCase()) !== 0) {
            message.short_message = component.toUpperCase() + ' ' + (message.short_message || '');
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
        gelf.emit('gelf.log', message);
    };

    server.loggelf = message => loggelf(message);

    acmeRoutes(db, server);

    server.on('error', err => {
        if (!started) {
            started = true;
            return done(err);
        }

        log.error('ACME', err);
    });

    server.listen(config.acme.agent.port, config.acme.agent.host, () => {
        if (started) {
            return server.close();
        }
        started = true;
        log.info('ACME', 'Server listening on %s:%s', config.acme.agent.host || '0.0.0.0', config.acme.agent.port);
        done(null, server);
    });
};
