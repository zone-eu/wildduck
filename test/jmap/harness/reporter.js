'use strict';

// Mocha reporter: the usual spec output, plus, when JMAP_RESULTS is set, one JSON file per run in
// test/jmap/.results/ with the outcome of every scenario test. tools/check-coverage.js reads them.

const fs = require('fs');
const path = require('path');
const Mocha = require('mocha');
const { RESULTS_DIR } = require('../tools/catalogue');

const { EVENT_TEST_PASS, EVENT_TEST_FAIL, EVENT_TEST_PENDING, EVENT_RUN_END } = Mocha.Runner.constants;

class ScenarioReporter extends Mocha.reporters.Spec {
    constructor(runner, options) {
        super(runner, options);
        if (!process.env.JMAP_RESULTS) {
            return;
        }
        const results = [];
        // scenario() tags its tests with the catalogue id; other tests are not recorded
        const record = state => test => test.scenarioId && results.push({ id: test.scenarioId, state });
        runner.on(EVENT_TEST_PASS, record('passed'));
        runner.on(EVENT_TEST_FAIL, record('failed'));
        runner.on(EVENT_TEST_PENDING, record('pending'));
        runner.once(EVENT_RUN_END, () => {
            fs.mkdirSync(RESULTS_DIR, { recursive: true });
            fs.writeFileSync(path.join(RESULTS_DIR, `${Date.now()}-${process.pid}.json`), JSON.stringify(results));
        });
    }
}

module.exports = ScenarioReporter;
