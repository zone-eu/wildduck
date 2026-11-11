'use strict';

// Loads and validates the JMAP test portfolio: the scenario catalogue (test/jmap/catalogue/*.yaml)
// and the expectation files of the external suites (test/jmap/external/*-expectations.yaml).
// Single source of the schema, the phases and the gate rule. See test/jmap/README.md.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const CATALOGUE_DIR = path.join(ROOT, 'catalogue');
const EXTERNAL_DIR = path.join(ROOT, 'external');

// Index is the phase number
const PHASES = [
    'Backend prerequisites',
    'Core and read only mail',
    'Writes',
    'Submission',
    'Conformance extras',
    'Contacts',
    'Calendars',
    'Calendar scheduling (held)'
];

const LEVELS = ['must', 'should', 'may', 'wd'];
const APPLIES = ['yes', 'adapted', 'no'];
const SEEDS = ['none', 'jmap', 'imap', 'api', 'lmtp', 'smtp', 'db', 'time'];
const SOURCE_PREFIXES = ['james', 'cyrus', 'stalwart', 'jmapio', 'fastmail', 'tmail', 'legacy-proxy', 'jmap-perl', 'rfc', 'wildduck'];
const REQUIRED = ['id', 'title', 'method', 'spec', 'level', 'phase', 'applies', 'seed', 'given', 'when', 'then', 'sources'];
const OPTIONAL = ['notes', 'planned'];
// Field order inside a scenario block, used by edit-catalogue.js when it inserts a field
const FIELD_ORDER = [...REQUIRED, ...OPTIONAL];
const TEXT_FIELDS = ['title', 'method', 'spec', 'given', 'when', 'then', 'notes'];
const ID_PATTERN = /^[A-Z]{2,5}-\d{3}$/;
const BANNED_CHARS = /[–—]/;

const EXPECTS = ['pass', 'never', 'opinion', 'skip'];

const isText = value => typeof value === 'string' && value.trim().length > 0;
const isPhase = value => Number.isInteger(value) && value >= 0 && value < PHASES.length;

function checkEnum(errors, where, name, value, allowed) {
    if (!allowed.includes(value)) {
        errors.push(`${where}: ${name} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
    }
}

function checkSources(errors, where, sources) {
    if (!Array.isArray(sources) || !sources.length) {
        errors.push(`${where}: sources must be a non-empty list`);
        return;
    }
    for (const source of sources) {
        const prefix = isText(source) ? source.split(':')[0] : '';
        if (!SOURCE_PREFIXES.includes(prefix) || source.length <= prefix.length + 1) {
            errors.push(`${where}: source ${JSON.stringify(source)} must look like <${SOURCE_PREFIXES.join('|')}>:<reference>`);
        }
    }
}

function checkScenario(errors, file, scenario, seenIds) {
    const where = `${file} ${(scenario && scenario.id) || '(no id)'}`;
    if (!scenario || typeof scenario !== 'object') {
        errors.push(`${where}: scenario must be a mapping`);
        return;
    }

    for (const key of REQUIRED) {
        if (scenario[key] === undefined || scenario[key] === null) {
            errors.push(`${where}: missing ${key}`);
        }
    }
    for (const key of Object.keys(scenario)) {
        if (!FIELD_ORDER.includes(key)) {
            errors.push(`${where}: unknown key ${key}`);
        }
    }

    if (!ID_PATTERN.test(scenario.id || '')) {
        errors.push(`${where}: id must match ${ID_PATTERN}`);
    } else if (seenIds.has(scenario.id)) {
        errors.push(`${where}: duplicate id, also in ${seenIds.get(scenario.id)}`);
    } else {
        seenIds.set(scenario.id, file);
    }

    for (const key of TEXT_FIELDS) {
        if (scenario[key] !== undefined && !isText(scenario[key])) {
            errors.push(`${where}: ${key} must be non-empty text`);
        }
    }
    if (scenario.planned !== undefined && typeof scenario.planned !== 'boolean') {
        errors.push(`${where}: planned must be a boolean when present`);
    }

    checkEnum(errors, where, 'level', scenario.level, LEVELS);
    checkEnum(errors, where, 'applies', scenario.applies, APPLIES);
    if (!isPhase(scenario.phase)) {
        errors.push(`${where}: phase must be an integer from 0 to ${PHASES.length - 1}`);
    }

    const seeds = [].concat(scenario.seed ?? []);
    if (!seeds.length) {
        errors.push(`${where}: seed must name at least one of ${SEEDS.join(', ')}`);
    }
    seeds.forEach(seed => checkEnum(errors, where, 'seed', seed, SEEDS));

    checkSources(errors, where, scenario.sources);

    if (BANNED_CHARS.test(JSON.stringify(scenario))) {
        errors.push(`${where}: contains an em or en dash`);
    }
}

const listYaml = (dir, suffix) =>
    fs
        .readdirSync(dir)
        .filter(name => name.endsWith(suffix))
        .sort()
        .map(name => path.join(dir, name));

function readYaml(errors, filePath) {
    try {
        return yaml.load(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
        errors.push(`${path.basename(filePath)}: YAML error: ${err.message.split('\n')[0]}`);
        return null;
    }
}

/**
 * Reads every catalogue file, or only the given ones.
 *
 * @param {String[]} [files] Paths of catalogue files; defaults to the whole catalogue directory
 * @returns {{areas: Object[], scenarios: Object[], errors: String[]}}
 */
function loadCatalogue(files) {
    const list = files && files.length ? files : listYaml(CATALOGUE_DIR, '.yaml');
    const errors = [];
    const areas = [];
    const scenarios = [];
    const seenIds = new Map();

    for (const filePath of list) {
        const file = path.basename(filePath);
        const doc = readYaml(errors, filePath);
        if (!doc) {
            continue;
        }
        if (!isText(doc.area) || !isText(doc.title) || !isText(doc.description) || !Array.isArray(doc.scenarios)) {
            errors.push(`${file}: needs area, title, description and a scenarios list`);
            continue;
        }

        doc.scenarios.forEach(scenario => {
            checkScenario(errors, file, scenario, seenIds);
            scenarios.push(Object.assign({ area: doc.area, file }, scenario));
        });
        areas.push({ area: doc.area, title: doc.title, description: doc.description, file, count: doc.scenarios.length });
    }

    return { areas, scenarios, errors };
}

function checkExpectation(errors, where, test, seenIds) {
    if (!isText(test.id)) {
        errors.push(`${where}: entry without id`);
        return;
    }
    if (seenIds.has(test.id)) {
        errors.push(`${where} ${test.id}: duplicate id`);
    }
    seenIds.add(test.id);
    checkEnum(errors, `${where} ${test.id}`, 'expect', test.expect, EXPECTS);
    if (test.expect === 'pass' && !isPhase(test.phase)) {
        errors.push(`${where} ${test.id}: a pass entry needs a phase`);
    }
    if (test.phase !== undefined && !isPhase(test.phase)) {
        errors.push(`${where} ${test.id}: phase must be an integer from 0 to ${PHASES.length - 1}`);
    }
    if (['never', 'opinion', 'skip'].includes(test.expect) && !isText(test.reason)) {
        errors.push(`${where} ${test.id}: ${test.expect} entries need a reason`);
    }
    if (BANNED_CHARS.test(JSON.stringify(test))) {
        errors.push(`${where} ${test.id}: contains an em or en dash`);
    }
}

/**
 * Reads the expectation files of the external suites.
 *
 * @returns {{suites: Object[], errors: String[]}} suites hold {suite, commit, tests[], file}
 */
function loadExpectations() {
    const errors = [];
    const suites = [];
    for (const filePath of listYaml(EXTERNAL_DIR, '-expectations.yaml')) {
        const file = path.basename(filePath);
        const doc = readYaml(errors, filePath);
        if (!doc) {
            continue;
        }
        if (!isText(doc.suite) || !isText(doc.commit) || !Array.isArray(doc.tests)) {
            errors.push(`${file}: needs suite, commit and a tests list`);
            continue;
        }
        const seenIds = new Set();
        doc.tests.forEach(test => checkExpectation(errors, file, test || {}, seenIds));
        suites.push(Object.assign({ file }, doc));
    }
    return { suites, errors };
}

/**
 * The gate rule: an external test must pass at the given phase when it is expected to pass (or the
 * suite is stricter than the RFC but WildDuck complies) from that phase or an earlier one.
 */
const mustPassBy = (test, phase) => ['pass', 'opinion'].includes(test.expect) && isPhase(test.phase) && test.phase <= phase;

module.exports = { loadCatalogue, loadExpectations, mustPassBy, PHASES, FIELD_ORDER, BANNED_CHARS, CATALOGUE_DIR };
