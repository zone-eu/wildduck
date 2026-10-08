/* eslint no-invalid-this: 0 */

'use strict';

const chai = require('chai');
const { resolveMetricsConfig } = require('../lib/metrics-config');

const expect = chai.expect;

describe('Metrics configuration', () => {
    it('should read the top-level metrics section', () => {
        const resolved = resolveMetricsConfig({
            metrics: { enabled: true, port: 9999, host: '0.0.0.0', collectCacheTtl: 500 }
        });

        expect(resolved.enabled).to.equal(true);
        expect(resolved.port).to.equal(9999);
        expect(resolved.host).to.equal('0.0.0.0');
        expect(resolved.collectCacheTtl).to.equal(500);
    });

    // regression guard, moving the config key must not silently stop existing scrapes
    it('should fall back to the deprecated api.metrics section', () => {
        const resolved = resolveMetricsConfig({
            metrics: { enabled: false, port: 8081, host: '127.0.0.1', collectCacheTtl: 10000 },
            api: { metrics: { enabled: true, collectCacheTtl: 500 } }
        });

        expect(resolved.enabled).to.equal(true);
        expect(resolved.collectCacheTtl).to.equal(500);
        // the legacy section has no listener settings, these come from the current section
        expect(resolved.port).to.equal(8081);
        expect(resolved.host).to.equal('127.0.0.1');
    });

    it('should fall back when the metrics section is missing entirely', () => {
        const resolved = resolveMetricsConfig({
            api: { metrics: { enabled: true } }
        });

        expect(resolved.enabled).to.equal(true);
        expect(resolved.port).to.equal(8081);
        expect(resolved.host).to.equal('127.0.0.1');
    });

    it('should prefer the top-level section over the deprecated one', () => {
        const resolved = resolveMetricsConfig({
            metrics: { enabled: true, collectCacheTtl: 100 },
            api: { metrics: { enabled: true, collectCacheTtl: 500 } }
        });

        expect(resolved.collectCacheTtl).to.equal(100);
    });

    it('should stay disabled when neither section enables metrics', () => {
        expect(resolveMetricsConfig({ metrics: { enabled: false } }).enabled).to.equal(false);
        expect(resolveMetricsConfig({ metrics: { enabled: false }, api: { metrics: { enabled: false } } }).enabled).to.equal(false);
        expect(resolveMetricsConfig({}).enabled).to.equal(undefined);
    });
});
