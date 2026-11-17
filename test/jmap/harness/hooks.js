'use strict';

// Root hooks for the JMAP test target (mocha --require test/jmap/harness/hooks.js): release
// everything the harness opened and delete the users created during the run.

const accounts = require('./accounts');
const seed = require('./seed');
const outbound = require('./outbound');

exports.mochaHooks = {
    async afterAll() {
        await accounts.cleanup();
        await seed.close();
        await outbound.close();
    }
};
