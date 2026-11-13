'use strict';

// Validates the JMAP scenario catalogue and the external suite expectation files.
// Usage: node test/jmap/tools/check-catalogue.js [catalogue-file.yaml ...]
// With file arguments only those catalogue files are checked (no expectation files).

const { loadCatalogue, loadExpectations } = require('./catalogue');

const files = process.argv.slice(2);
const { areas, scenarios, errors } = loadCatalogue(files);

for (const area of areas) {
    console.log(`${area.file}: ${area.count} scenarios`);
}
console.log(`total: ${scenarios.length} scenarios in ${areas.length} files`);

if (!files.length) {
    const expectations = loadExpectations();
    expectations.suites.forEach(suite => console.log(`${suite.file}: ${suite.tests.length} tests`));
    errors.push(...expectations.errors);
}

if (errors.length) {
    errors.forEach(error => console.error(`ERROR ${error}`));
    console.error(`${errors.length} problem(s) found`);
    process.exit(1);
}
