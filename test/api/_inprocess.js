'use strict';

// In-process API for app.inject() based tests: the full application from
// api.js with every hook and route, built against the test databases but not
// listening on any port. Not a test file itself, the mocha glob only picks up
// *-test.js.

const { connect } = require('./_helpers');
const { createViolationLog } = require('../../lib/fastify/response-contract');

/**
 * Builds the API in-process.
 *
 * @returns {Promise<{app: Object, routes: Array, violations: Object}>}
 *     routes lists every documented route ({method, url, name, config, handler}),
 *     violations collects what the response contract check found
 */
const buildApp = async () => {
    await connect();

    // required lazily, api.js pulls in every handler module
    const { createApp } = require('../../api'); // eslint-disable-line global-require

    const violations = createViolationLog();
    const app = createApp({ contractViolations: violations });

    // the route modules register inside a plugin, which only runs on ready(),
    // so a hook added here still sees all of them
    const routes = [];
    app.addHook('onRoute', routeOptions => {
        if (routeOptions.config && routeOptions.config.validationObjs && routeOptions.config.name) {
            routes.push({
                method: routeOptions.method,
                url: routeOptions.url,
                name: routeOptions.config.name,
                config: routeOptions.config,
                handler: routeOptions.handler
            });
        }
    });

    await app.ready();

    return { app, routes, violations };
};

module.exports = { buildApp };
