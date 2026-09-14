'use strict';

const http = require('http');
const https = require('https');
const log = require('npmlog');
const certs = require('./lib/certs');
const metrics = require('./lib/metrics');
const { metricsConfig } = require('./lib/metrics-config');

const METRICS_PATH = '/metrics';
const ALLOWED_METHODS = ['GET', 'HEAD'];

/**
 * Sends a plain text response.
 *
 * @param {http.ServerResponse} res HTTP response.
 * @param {Number} statusCode HTTP status code.
 * @param {String} body Response body.
 * @param {Object} [headers] Additional response headers.
 * @returns {void}
 */
function sendText(res, statusCode, body, headers) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    Object.keys(headers || {}).forEach(key => res.setHeader(key, headers[key]));
    res.end(body);
}

/**
 * Handles a request to the standalone Prometheus endpoint.
 *
 * @param {http.IncomingMessage} req HTTP request.
 * @param {http.ServerResponse} res HTTP response.
 * @returns {Promise<void>}
 */
async function handleRequest(req, res) {
    let path = (req.url || '').split('?').shift();

    // scrape configs and path rewriting proxies often add a trailing slash
    if (path.length > 1 && path.at(-1) === '/') {
        path = path.slice(0, -1);
    }

    if (path !== METRICS_PATH) {
        return sendText(res, 404, 'Not Found\n');
    }

    if (!ALLOWED_METHODS.includes(req.method)) {
        return sendText(res, 405, 'Method Not Allowed\n', { Allow: ALLOWED_METHODS.join(', ') });
    }

    if (req.method === 'HEAD') {
        // node discards the body of a HEAD response, so there is nothing to collect it for
        res.statusCode = 200;
        res.setHeader('Content-Type', metrics.contentType);
        return res.end();
    }

    try {
        let output = await metrics.getMetrics();
        res.statusCode = 200;
        res.setHeader('Content-Type', metrics.contentType);
        res.end(output);
    } catch (err) {
        log.error('Metrics', 'Failed to collect metrics: %s', err.message);
        sendText(res, 500, 'error: metrics collection failed\n');
    }
}

/**
 * Creates an HTTP or HTTPS server for Prometheus metrics.
 *
 * @param {Object} options Metrics listener configuration.
 * @returns {http.Server|https.Server} Metrics server.
 */
function createServer(options) {
    let listener = (req, res) => {
        handleRequest(req, res).catch(err => {
            log.error('Metrics', 'Failed to handle request: %s', err.message);
            if (res.headersSent) {
                return res.end();
            }
            sendText(res, 500, 'error: metrics request failed\n');
        });
    };

    if (!options.secure) {
        return http.createServer(listener);
    }

    let serverOptions = {};
    certs.loadTLSOptions(serverOptions, 'metrics');

    let server = https.createServer(serverOptions, listener);

    // pick up renewed certificates on config reload, like the other TLS listeners do
    certs.registerReload(server, 'metrics', serverOptions);

    return server;
}

/**
 * Starts the standalone Prometheus listener.
 *
 * @param {Object} options Metrics listener configuration.
 * @param {Function} done Completion callback.
 * @returns {void}
 */
function start(options, done) {
    options = options || {};

    // must match how lib/metrics.js decides whether metrics are collected at all
    if (options.enabled !== true) {
        return setImmediate(() => done(null, false));
    }

    let started = false;
    let server = createServer(options);

    server.on('error', err => {
        if (!started) {
            started = true;
            return done(err);
        }
        log.error('Metrics', err);
    });

    server.listen(options.port, options.host, () => {
        if (started) {
            return server.close();
        }
        started = true;
        let address = server.address();
        log.info('Metrics', '%s server listening on %s:%s', options.secure ? 'HTTPS' : 'HTTP', options.host || '0.0.0.0', address && address.port);
        done(null, server);
    });
}

module.exports = done => start(metricsConfig, done);
module.exports.start = start;
