'use strict';

// Checks that every catalogue scenario of a finished work package has a test that passed.
// Finished work packages are listed in test/jmap/progress.json; results are the files that
// harness/reporter.js writes to test/jmap/.results/ when JMAP_RESULTS is set.
//
// Usage: node test/jmap/tools/check-coverage.js

const fs = require('fs');
const path = require('path');
const { loadCatalogue, RESULTS_DIR, ID } = require('./catalogue');

const PROGRESS = path.join(__dirname, '..', 'progress.json');
const RANGE = new RegExp(`^(${ID})\\.\\.(${ID})$`);

// Expands "WDP-001..WDP-005" into the five ids
function expand(entry) {
    const range = RANGE.exec(entry);
    if (!range) {
        return [entry];
    }
    const [prefix, first] = range[1].split('-');
    const last = Number(range[2].split('-')[1]);
    const ids = [];
    for (let n = Number(first); n <= last; n++) {
        ids.push(`${prefix}-${String(n).padStart(3, '0')}`);
    }
    return ids;
}

// A select picks scenarios by prefix, phase and method; every given key must match
const matches = (select, scenario) =>
    (select.prefix === undefined || scenario.id.startsWith(`${select.prefix}-`)) &&
    (select.phase === undefined || scenario.phase === select.phase) &&
    (select.method === undefined || scenario.method === select.method);

function requiredIds(progress, scenarios, errors) {
    const byId = new Map(scenarios.map(scenario => [scenario.id, scenario]));
    const required = new Map();
    for (const pkg of progress.packages) {
        const ids = (pkg.ids || []).flatMap(expand);
        ids.filter(id => !byId.has(id)).forEach(id => errors.push(`progress.json ${pkg.package}: ${id} is not in the catalogue`));
        (pkg.select || []).forEach(select => scenarios.filter(scenario => matches(select, scenario)).forEach(scenario => ids.push(scenario.id)));
        ids.filter(id => byId.has(id) && byId.get(id).applies !== 'no').forEach(id => required.set(id, pkg.package));
    }
    return required;
}

// id -> 'passed' | 'failed' | 'pending'; a failure in any run wins
function resultStates() {
    const states = new Map();
    const files = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR).filter(name => name.endsWith('.json')) : [];
    for (const name of files) {
        for (const result of JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, name), 'utf-8'))) {
            if (states.get(result.id) !== 'failed') {
                states.set(result.id, result.state);
            }
        }
    }
    return { states, runs: files.length };
}

const row = cells => cells.map((cell, i) => (i ? String(cell).padStart(11) : String(cell).padEnd(22))).join('');

function main() {
    const { scenarios, errors } = loadCatalogue();
    const required = requiredIds(JSON.parse(fs.readFileSync(PROGRESS, 'utf-8')), scenarios, errors);
    const { states, runs } = resultStates();
    if (!runs) {
        errors.push(`no results in ${RESULTS_DIR}: run the scenario tests with JMAP_RESULTS=1 first`);
    }

    const areas = new Map();
    for (const scenario of scenarios.filter(entry => entry.applies !== 'no')) {
        const counts = areas.get(scenario.area) || { applicable: 0, required: 0, tested: 0, passed: 0 };
        const state = states.get(scenario.id);
        counts.applicable++;
        counts.required += required.has(scenario.id) ? 1 : 0;
        counts.tested += state ? 1 : 0;
        counts.passed += state === 'passed' ? 1 : 0;
        areas.set(scenario.area, counts);
        if (required.has(scenario.id) && state !== 'passed') {
            errors.push(`${scenario.id} (work package ${required.get(scenario.id)}): ${state || 'no test'}`);
        }
    }

    console.log(row(['area', 'applicable', 'required', 'tested', 'passed']));
    for (const [area, counts] of areas) {
        console.log(row([area, counts.applicable, counts.required, counts.tested, counts.passed]));
    }

    if (errors.length) {
        errors.forEach(error => console.error(`ERROR ${error}`));
        console.error(`${errors.length} problem(s) found`);
        process.exit(1);
    }
    console.log(`all ${required.size} required scenarios passed`);
}

main();
