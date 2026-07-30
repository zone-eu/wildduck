'use strict';

const config = require('@zone-eu/wild-config');
const fastify = require('fastify');
const qs = require('qs');
const log = require('npmlog');
const db = require('./lib/db');
const Gelf = require('gelf');
const os = require('os');
const { normalizeLoggelfMessage } = require('./lib/loggelf-message');
const { RestifyCompatAdapter } = require('./lib/fastify/adapter');

const acmeRoutes = require('./lib/api/acme');

let loggelf;

function maskUrl(url) {
    return (url || '').replace(/(accessToken=)[^&]+/, '$1xxxxxx');
}

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
        normalizeLoggelfMessage(message);

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

    const app = fastify({
        maxParamLength: 196,
        exposeHeadRoutes: false,
        querystringParser: str => qs.parse(str, { allowDots: true }),
        // new code logs through Fastify's built-in pino JSON logger; the
        // request logging is done by our own hook below
        logger: { level: 'warn' },
        disableRequestLogging: true
    });

    app.decorateReply('wdResponseBody', null);
    app.decorateReply('wdContentType', null);

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('server', 'WildDuck ACME Agent');
        if (reply.wdContentType) {
            reply.header('content-type', reply.wdContentType);
        }
        return payload;
    });

    // ---- HTTP access log (previously restify-logger) ----

    app.addHook('onResponse', async (request, reply) => {
        const params = request.wdMergedParams || request.query || {};
        const userIp = ((params && params.ip) || '').toString().substr(0, 40) || '-';
        const userSess = (params && params.sess) || '-';
        const line = `${request.raw.socket.remoteAddress} - [${userIp}/${userSess}] ${request.method} ${maskUrl(request.url)} ${reply.statusCode} ${Math.round(
            reply.elapsedTime
        )}ms`;
        log.http('ACME', line);
    });

    app.setErrorHandler((err, request, reply) => {
        if (err.restifyStyle || (err.responseCode && !reply.sent)) {
            const body = {
                code: err.code || 'InternalError',
                message: err.message
            };
            reply.status(err.responseCode || 500);
            reply.wdResponseBody = body;
            reply.wdContentType = 'application/json';
            return reply.send(body);
        }

        log.error('ACME', 'Unhandled error: %s', err.stack || err.message);
        const body = {
            code: 'InternalError',
            message: err.message
        };
        reply.status(500);
        reply.wdResponseBody = body;
        return reply.send(body);
    });

    const server = new RestifyCompatAdapter(app);
    server.loggelf = message => loggelf(message);

    // registers the challenge route and the catch-all NotFound redirect
    acmeRoutes(db, server);

    app.listen({ port: config.acme.agent.port, host: config.acme.agent.host || '0.0.0.0' }, err => {
        if (err) {
            if (!started) {
                started = true;
                return done(err);
            }
            log.error('ACME', err);
            return;
        }

        if (started) {
            return app.close();
        }
        started = true;
        log.info('ACME', 'Server listening on %s:%s', config.acme.agent.host || '0.0.0.0', config.acme.agent.port);
        done(null, server);
    });
};
