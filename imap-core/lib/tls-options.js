'use strict';

const crypto = require('crypto');

// Expose to the world
module.exports = getTLSOptions;

const tlsDefaults = {
    honorCipherOrder: true,
    requestOCSP: false,
    sessionIdContext: crypto.createHash('sha1').update(process.argv.join(' ')).digest('hex').slice(0, 32),
    minVersion: 'TLSv1'
};

/**
 * Mixes existing values with the default ones.
 *
 * @param {Object} [opts] TLS options
 * @returns {Object} Object with mixed TLS values
 */
function getTLSOptions(opts) {
    return Object.assign({}, tlsDefaults, opts || {});
}
