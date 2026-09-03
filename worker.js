'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const imap = require('./imap');
const pop3 = require('./pop3');
const lmtp = require('./lmtp');
const prometheus = require('./prometheus');
const mcp = require('./mcp');
const api = require('./api');
const acme = require('./acme');
const tasks = require('./tasks');
const webhooks = require('./webhooks');
const indexer = require('./indexer');
const plugins = require('./lib/plugins');
const db = require('./lib/db');
const errors = require('./lib/errors');

// preload certificate files
require('./lib/certs');

// Services are started in the listed order. The metrics listener comes first so that a later
// service failing to start is still visible through wildduck_service_up before the process exits.
// A failure to connect to the database happens before any of this and is not observable this way.
const SERVICES = [
    ['Prometheus metrics server', prometheus],
    ['task runner', tasks.start],
    ['webhook runner', webhooks.start],
    ['indexer process', indexer.start],
    ['IMAP server', imap],
    ['POP3 server', pop3],
    ['LMTP server', lmtp],
    ['API server', api],
    ['MCP server', mcp],
    ['ACME server', acme]
];

/**
 * Logs a fatal startup error and exits once the error has had a chance to be reported.
 *
 * @param {String} message Error description.
 * @param {Error} err Error object.
 * @returns {void}
 */
function fail(message, err) {
    log.error('App', '%s. %s', message, err.message);
    errors.notify(err);
    setTimeout(() => process.exit(1), 3000);
}

/**
 * Starts the listed services one after another.
 *
 * @param {Array} services List of [name, start] entries.
 * @param {Function} callback Called once every service has started.
 * @returns {void}
 */
function startServices(services, callback) {
    let pos = 0;

    let startNext = () => {
        if (pos >= services.length) {
            return callback();
        }

        let [name, start] = services[pos++];

        start(err => {
            if (err) {
                return fail(`Failed to start ${name}`, err);
            }
            startNext();
        });
    };

    startNext();
}

// Initialize database connection
db.connect(err => {
    if (err) {
        return fail('Failed to setup database connection', err);
    }

    startServices(SERVICES, () => {
        // downgrade user and group if needed
        if (config.group) {
            try {
                process.setgid(config.group);
                log.info('App', 'Changed group to "%s" (%s)', config.group, process.getgid());
            } catch (E) {
                return fail(`Failed to change group to "${config.group}"`, E);
            }
        }

        if (config.user) {
            try {
                process.setuid(config.user);
                log.info('App', 'Changed user to "%s" (%s)', config.user, process.getuid());
            } catch (E) {
                return fail(`Failed to change user to "${config.user}"`, E);
            }
        }

        plugins.init('receiver');
        plugins.handler.load(() => {
            log.verbose('Plugins', 'Plugins loaded');
            plugins.handler.runHooks('init', [], () => {
                log.info('App', 'All servers started, ready to process some mail');
            });
        });
    });
});
