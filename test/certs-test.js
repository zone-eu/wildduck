/* eslint no-invalid-this: 0 */

'use strict';

const pathlib = require('path');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const certs = require('../lib/certs');

const expect = chai.expect;

const EXAMPLE_KEY = pathlib.join(__dirname, '..', 'certs', 'example.key');
const EXAMPLE_CERT = pathlib.join(__dirname, '..', 'certs', 'example.cert');

describe('Certificate handling', () => {
    describe('#reload', () => {
        it('should load a certificate for every service that serves TLS', () => {
            // A service missing from the reload list silently serves the global certificate, or
            // the bundled self-signed one, however carefully its own [<service>.tls] block is
            // filled in. The listener starts either way, so nothing reports it.
            const services = ['imap', 'lmtp', 'pop3', 'api', 'metrics', 'mcp'];
            let original = new Map(services.map(service => [service, config[service] && config[service].tls]));
            try {
                for (let service of services) {
                    config[service] = config[service] || {};
                    config[service].tls = { key: EXAMPLE_KEY, cert: EXAMPLE_CERT, ca: [EXAMPLE_CERT] };
                }
                certs.reload();

                for (let service of services) {
                    // a service specific entry carries what its own block declared, where the
                    // default entry has no CA chain at all
                    expect(certs.get(service).ca, service).to.be.an('array').with.length(1);
                }
                expect(certs.get('default').ca).to.equal(false);
            } finally {
                // reload once more with the certificate but no chain, so the entries this left
                // behind hold the same values the default fallback would have given
                for (let service of services) {
                    config[service].tls = { key: EXAMPLE_KEY, cert: EXAMPLE_CERT };
                }
                certs.reload();
                for (let [service, tls] of original) {
                    config[service].tls = tls;
                }
            }
        });
    });

    describe('#applySecureContext', () => {
        const certOptions = { key: 'key', cert: 'cert' };

        it('should use updateSecureContext when the server provides it', () => {
            let updatedWith = false;
            const server = {
                updateSecureContext: options => {
                    updatedWith = options;
                }
            };

            expect(certs.applySecureContext(server, certOptions)).to.equal(true);
            expect(updatedWith).to.deep.equal(certOptions);
        });

        it('should fall back to setSecureContext for node core servers', () => {
            let updatedWith = false;
            const server = {
                setSecureContext: options => {
                    updatedWith = options;
                }
            };

            expect(certs.applySecureContext(server, certOptions)).to.equal(true);
            expect(updatedWith).to.deep.equal(certOptions);
        });

        it('should prefer updateSecureContext when both are available', () => {
            let used = false;
            const server = {
                updateSecureContext: () => {
                    used = 'update';
                },
                setSecureContext: () => {
                    used = 'set';
                }
            };

            certs.applySecureContext(server, certOptions);

            expect(used).to.equal('update');
        });

        it('should report servers that can not be updated', () => {
            expect(certs.applySecureContext({}, certOptions)).to.equal(false);
        });

        it('should keep the original server options when swapping certificates', () => {
            let updatedWith = false;
            const server = {
                setSecureContext: options => {
                    updatedWith = options;
                }
            };

            certs.applySecureContext(server, Object.assign({ minVersion: 'TLSv1.3' }, certOptions));

            // setSecureContext resets anything it is not given, hardening options must survive
            expect(updatedWith.minVersion).to.equal('TLSv1.3');
            expect(updatedWith.cert).to.equal('cert');
        });
    });
});
