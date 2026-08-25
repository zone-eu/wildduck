'use strict';

const http = require('http');
const https = require('https');
const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const certs = require('./lib/certs');
const metrics = require('./lib/metrics');

/**
 * Handles a request to the standalone Prometheus endpoint.
 *
 * @param {Object} metricSource Metrics registry facade.
 * @param {http.IncomingMessage} req HTTP request.
 * @param {http.ServerResponse} res HTTP response.
 * @returns {Promise<void>}
 */
async function handleRequest(metricSource, req, res) {
    let path = (req.url || '').split('?').shift();

    if (req.method !== 'GET' || path !== '/metrics') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found\n');
        return;
    }

    try {
        let output = await metricSource.getMetrics();
        res.statusCode = 200;
        res.setHeader('Content-Type', metricSource.contentType);
        res.end(output);
    } catch (err) {
        log.error('Metrics', 'Failed to collect metrics: %s', err.message);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('error: metrics collection failed\n');
    }
}

/**
 * Creates an HTTP or HTTPS server for Prometheus metrics.
 *
 * @param {Object} options Metrics listener configuration.
 * @param {Object} [metricSource] Metrics registry facade.
 * @returns {http.Server|https.Server} Metrics server.
 */
function createServer(options, metricSource) {
    options = options || {};
    metricSource = metricSource || metrics;

    let listener = (req, res) => {
        handleRequest(metricSource, req, res).catch(err => {
            log.error('Metrics', 'Failed to handle request: %s', err.message);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            }
            res.end('error: metrics request failed\n');
        });
    };

    if (!options.secure) {
        return http.createServer(listener);
    }

    let serverOptions = {};
    certs.loadTLSOptions(serverOptions, 'metrics');
    return https.createServer(serverOptions, listener);
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

    if (!options.enabled) {
        metrics.setServiceUp('metrics', false);
        return setImmediate(() => done(null, false));
    }

    let started = false;
    let server = createServer(options);

    server.on('error', err => {
        if (!started) {
            started = true;
            metrics.setServiceUp('metrics', false);
            return done(err);
        }
        log.error('Metrics', err);
    });

    server.listen(options.port, options.host, () => {
        if (started) {
            return server.close();
        }
        started = true;
        metrics.setServiceUp('metrics', true);
        let address = server.address();
        log.info('Metrics', '%s server listening on %s:%s', options.secure ? 'HTTPS' : 'HTTP', options.host || '0.0.0.0', address && address.port);
        done(null, server);
    });
}

module.exports = done => start(config.metrics, done);
module.exports.createServer = createServer;
module.exports.start = start;
