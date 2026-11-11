'use strict';

// Mocha configuration of the JMAP scenario target (Grunt shell:mocha-jmap, npm run test:jmap).
// Paths are relative to the repository root, where the tests are started.

module.exports = {
    spec: ['test/jmap/scenarios/**/*-test.js'],
    require: ['test/jmap/harness/hooks.js'],
    reporter: 'test/jmap/harness/reporter.js',
    timeout: 30000,
    color: true,
    exit: true
};
