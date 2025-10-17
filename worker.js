'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const imap = require('./imap');
const pop3 = require('./pop3');
const lmtp = require('./lmtp');
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

// Initialize database connection
db.connect(err => {
    if (err) {
        log.error('Db', 'Failed to setup database connection');
        errors.notify(err);
        return setTimeout(() => process.exit(1), 3000);
    }

    tasks.start(err => {
        if (err) {
            log.error('App', 'Failed to start task runner. %s', err.message);
            errors.notify(err);
            return setTimeout(() => process.exit(1), 3000);
        }

        webhooks.start(err => {
            if (err) {
                log.error('App', 'Failed to start webhook runner. %s', err.message);
                errors.notify(err);
                return setTimeout(() => process.exit(1), 3000);
            }

            indexer.start(err => {
                if (err) {
                    log.error('App', 'Failed to start indexer process. %s', err.message);
                    errors.notify(err);
                    return setTimeout(() => process.exit(1), 3000);
                }

                // Start IMAP server
                imap(err => {
                    if (err) {
                        log.error('App', 'Failed to start IMAP server. %s', err.message);
                        errors.notify(err);
                        return setTimeout(() => process.exit(1), 3000);
                    }
                    // Start POP3 server
                    pop3(err => {
                        if (err) {
                            log.error('App', 'Failed to start POP3 server');
                            errors.notify(err);
                            return setTimeout(() => process.exit(1), 3000);
                        }
                        // Start LMTP maildrop server
                        lmtp(err => {
                            if (err) {
                                log.error('App', 'Failed to start LMTP server');
                                errors.notify(err);
                                return setTimeout(() => process.exit(1), 3000);
                            }

                            // Start HTTP API server
                            api(err => {
                                if (err) {
                                    log.error('App', 'Failed to start API server');
                                    errors.notify(err);
                                    return setTimeout(() => process.exit(1), 3000);
                                }

                                // Start HTTP ACME server
                                acme(err => {
                                    if (err) {
                                        log.error('App', 'Failed to start ACME server');
                                        errors.notify(err);
                                        return setTimeout(() => process.exit(1), 3000);
                                    }

                                    // downgrade user and group if needed
                                    if (config.group) {
                                        try {
                                            process.setgid(config.group);
                                            log.info('App', 'Changed group to "%s" (%s)', config.group, process.getgid());
                                        } catch (E) {
                                            log.error('App', 'Failed to change group to "%s" (%s)', config.group, E.message);
                                            errors.notify(E);
                                            return setTimeout(() => process.exit(1), 3000);
                                        }
                                    }
                                    if (config.user) {
                                        try {
                                            process.setuid(config.user);
                                            log.info('App', 'Changed user to "%s" (%s)', config.user, process.getuid());
                                        } catch (E) {
                                            log.error('App', 'Failed to change user to "%s" (%s)', config.user, E.message);
                                            errors.notify(E);
                                            return setTimeout(() => process.exit(1), 3000);
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
                        });
                    });
                });
            });
        });
    });
});
