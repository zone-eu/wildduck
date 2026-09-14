'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');

// Safety net for configurations without a [metrics] section, keep in sync with config/metrics.toml
const DEFAULT_PORT = 8081;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Resolves the effective metrics configuration.
 *
 * Prometheus metrics used to be served by the API process and were configured under
 * [api.metrics]. The listener is now a standalone service configured in the top-level
 * [metrics] section. The legacy section is still honored so that deployments which enabled
 * metrics before the move do not silently stop exposing them after an upgrade.
 *
 * @param {Object} [source] Configuration root to read from. Defaults to the global config.
 * @returns {Object} Effective metrics configuration.
 */
function resolveMetricsConfig(source) {
    source = source || config;

    let metricsConfig = Object.assign({ port: DEFAULT_PORT, host: DEFAULT_HOST }, source.metrics);
    let legacyConfig = source.api?.metrics;

    if (metricsConfig.enabled !== true && legacyConfig?.enabled === true) {
        metricsConfig.enabled = true;

        if (typeof legacyConfig.collectCacheTtl !== 'undefined') {
            metricsConfig.collectCacheTtl = legacyConfig.collectCacheTtl;
        }

        log.warn('Metrics', 'Metrics are enabled in the deprecated [api.metrics] section, move these settings to the top-level [metrics] section');
    }

    return metricsConfig;
}

module.exports = {
    resolveMetricsConfig,
    metricsConfig: resolveMetricsConfig()
};
