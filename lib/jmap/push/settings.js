'use strict';

// The effective [jmap.push] settings (config/jmap.toml documents each one).

const fs = require('fs');
const os = require('os');
const tls = require('tls');
const { domainResolver } = require('./webpush');

const MIN_LIFETIME = 48 * 3600;

const DEFAULTS = Object.freeze({
    enabled: true,
    maxPerUser: 20,
    createRate: 30,
    maxLifetime: 7 * 24 * 3600,
    verificationTimeout: 3600,
    verifyAttempts: 5,
    attempts: 5,
    retryDelay: 10,
    maxRetryDelay: 600,
    failureLimit: 5,
    timeout: 10,
    coalesce: 1,
    ttl: 24 * 3600,
    concurrency: 20,
    vapidRefresh: 60,
    allowHosts: [],
    ca: null,
    vapidSubject: null,
    testDns: null
});

/**
 * The push settings of the [jmap] options. RFC 8620 7.2: the maximum lifetime must be at least 48
 * hours; a shorter one is refused at start up.
 *
 * @param {Object} options the [jmap] configuration
 */
function pushSettings(options) {
    if (options.pushSettings) {
        return options.pushSettings;
    }
    const settings = Object.assign({}, DEFAULTS, options.push || {});
    if (!(settings.maxLifetime >= MIN_LIFETIME)) {
        throw new Error('jmap.push.maxLifetime must be at least 172800 seconds (48 hours, RFC 8620 7.2)');
    }
    for (const key of [
        'maxPerUser',
        'createRate',
        'verificationTimeout',
        'verifyAttempts',
        'attempts',
        'retryDelay',
        'maxRetryDelay',
        'failureLimit',
        'timeout'
    ]) {
        if (!(settings[key] > 0)) {
            throw new Error(`jmap.push.${key} must be positive`);
        }
    }
    settings.allowHosts = new Set([].concat(settings.allowHosts || []).map(host => String(host).toLowerCase()));
    // extra trusted certificates for push services, on top of the default ones
    settings.tlsCa = settings.ca ? [...tls.rootCertificates, ...[].concat(settings.ca).map(file => fs.readFileSync(file, 'utf8'))] : undefined;
    if (settings.testDns && settings.testDns.server) {
        settings.resolve = domainResolver([].concat(settings.testDns.server), [].concat(settings.testDns.domains || []));
    }
    if (!settings.vapidSubject) {
        const base = typeof options.baseUrl === 'string' && /^https:\/\//.test(options.baseUrl) ? new URL(options.baseUrl).origin : null;
        settings.vapidSubject = base || `mailto:postmaster@${os.hostname()}`;
    }
    // cached on the options object, which lives as long as the service
    Object.defineProperty(options, 'pushSettings', { value: settings, enumerable: false });
    return settings;
}

module.exports = { pushSettings, DEFAULTS, MIN_LIFETIME };
