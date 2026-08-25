/* eslint no-invalid-this: 0 */

'use strict';

const chai = require('chai');
const certs = require('../lib/certs');

const expect = chai.expect;

describe('Certificate handling', () => {
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
