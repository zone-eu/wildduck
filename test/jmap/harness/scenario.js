'use strict';

// Registers a Mocha test for one catalogue scenario. The test title is the scenario id and the
// catalogue title, so results map back to the catalogue (see tools/check-coverage.js).

const { loadCatalogue } = require('../tools/catalogue');

let index = null;
const registered = new Set();

function catalogue() {
    if (!index) {
        const { scenarios, errors } = loadCatalogue();
        if (errors.length) {
            throw new Error(`the JMAP catalogue is invalid, run test/jmap/tools/check-catalogue.js (${errors[0]})`);
        }
        index = new Map(scenarios.map(entry => [entry.id, entry]));
    }
    return index;
}

function lookup(id) {
    const entry = catalogue().get(id);
    if (!entry) {
        throw new Error(`scenario ${id} is not in the catalogue`);
    }
    if (registered.has(id)) {
        throw new Error(`scenario ${id} is registered twice`);
    }
    registered.add(id);
    return entry;
}

/**
 * Registers the test for a scenario. `fn` is called with the catalogue entry, `this` is the
 * Mocha context. A scenario withdrawn in the catalogue (applies: no) is registered as pending.
 *
 * @param {String} id Scenario id, for example 'EGET-012'
 * @param {Function} fn Test body
 */
function scenario(id, fn) {
    const entry = lookup(id);
    const title = `${id} ${entry.title}`;
    const test =
        entry.applies === 'no'
            ? it.skip(title)
            : it(title, function () {
                  return fn.call(this, entry); // eslint-disable-line no-invalid-this
              });
    // read by harness/reporter.js
    test.scenarioId = id;
    return test;
}

module.exports = { scenario };
