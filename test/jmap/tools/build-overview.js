'use strict';

// Renders the JMAP test portfolio as one self-contained HTML page.
// Usage: node test/jmap/tools/build-overview.js [output.html]
// Input: catalogue/*.yaml, external/*-expectations.yaml and overview-template.html next to this file.

const fs = require('fs');
const path = require('path');
const he = require('he');
const { loadCatalogue, loadExpectations, mustPassBy, PHASES } = require('./catalogue');

const TEMPLATE = path.join(__dirname, 'overview-template.html');
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'overview.html');

const LEVEL_BADGE = { must: 'gap', should: 'part', may: 'na', wd: 'ok' };
const APPLIES_BADGE = { yes: 'ok', adapted: 'part', no: 'na' };
const EXPECT_BADGE = { pass: 'ok', never: 'gap', opinion: 'part', skip: 'na' };

const esc = value => he.escape(String(value ?? ''));

const badge = (map, value) => `<span class="badge ${map[value] || 'na'}">${esc(value)}</span>`;

const countBy = (list, keyFn) =>
    list.reduce((counts, item) => {
        const key = keyFn(item);
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});

const table = (head, rows) => `<div class="tbl-wrap"><table><tr>${head.map(cell => `<th>${cell}</th>`).join('')}</tr>${rows.join('')}</table></div>`;

function renderCards(scenarios, areas, suites) {
    const levels = countBy(scenarios, scenario => scenario.level);
    const applies = countBy(scenarios, scenario => scenario.applies);
    const external = suites.reduce((sum, suite) => sum + suite.tests.length, 0);
    const cards = [
        ['Scenarios', scenarios.length, `${areas.length} catalogue files, every scenario traceable to an RFC section and to the suites that test it.`],
        ['RFC MUST', levels.must || 0, `${levels.should || 0} SHOULD, ${levels.may || 0} MAY, ${levels.wd || 0} WildDuck design decisions.`],
        ['Adapted for WildDuck', applies.adapted || 0, `${applies.no || 0} recorded as not applicable; the rest hold as the RFC states.`],
        ['External gate tests', external, suites.map(suite => `${suite.tests.length} in ${suite.suite}`).join(', ') + '.']
    ];
    return `<div class="cards">${cards
        .map(([k, v, d]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`)
        .join('')}</div>`;
}

function renderMatrix(scenarios, areas) {
    const phaseHead = PHASES.map((name, phase) => `<span title="${esc(name)}">P${phase}</span>`);
    const rows = areas.map(area => {
        const counts = countBy(
            scenarios.filter(scenario => scenario.area === area.area),
            scenario => scenario.phase
        );
        const cells = PHASES.map((name, phase) => `<td class="num">${counts[phase] || ''}</td>`).join('');
        return `<tr><td><a href="#area-${esc(area.area)}">${esc(area.title)}</a></td>${cells}<td class="num"><strong>${area.count}</strong></td></tr>`;
    });
    const totals = countBy(scenarios, scenario => scenario.phase);
    rows.push(
        `<tr><td><strong>Total</strong></td>${PHASES.map((name, phase) => `<td class="num"><strong>${totals[phase] || ''}</strong></td>`).join('')}<td class="num"><strong>${
            scenarios.length
        }</strong></td></tr>`
    );
    return table(['Area', ...phaseHead, 'All'], rows);
}

function renderPhases(scenarios, suites) {
    const totals = countBy(scenarios, scenario => scenario.phase);
    const rows = PHASES.map((name, phase) => {
        const gates = suites
            .map(suite => {
                const due = suite.tests.filter(test => mustPassBy(test, phase)).length;
                return `${due} of ${suite.tests.length}`;
            })
            .join('</td><td class="num">');
        return `<tr><td>${phase}</td><td>${esc(name)}</td><td class="num">${totals[phase] || 0}</td><td class="num">${gates}</td></tr>`;
    });
    return table(['#', 'Phase', 'Catalogue scenarios added in this phase', ...suites.map(suite => `${esc(suite.suite)} tests that must pass by then`)], rows);
}

function renderSuite(suite) {
    const expects = countBy(suite.tests, test => test.expect);
    const summary = Object.keys(expects)
        .sort()
        .map(key => `${badge(EXPECT_BADGE, key)} ${expects[key]}`)
        .join(' &nbsp; ');
    const notable = suite.tests.filter(test => test.expect !== 'pass');
    const rows = notable.map(
        test =>
            `<tr><td><code>${esc(test.id)}</code></td><td>${badge(EXPECT_BADGE, test.expect)}</td><td>${esc(test.spec)}</td><td>${esc(test.reason)}</td></tr>`
    );
    const list = rows.length
        ? `<details><summary>${notable.length} tests not expected to simply pass</summary>${table(['Test', 'Expect', 'Spec', 'Reason'], rows)}</details>`
        : '';
    return `<h3>${esc(suite.suite)}</h3><p>Pinned at <code>${esc(suite.commit.slice(0, 12))}</code>. ${suite.tests.length} tests: ${summary}</p>${list}`;
}

function renderScenario(scenario) {
    const sources = scenario.sources.map(source => `<code>${esc(source)}</code>`).join(' ');
    const notes = scenario.notes ? `<p><strong>Notes.</strong> ${esc(scenario.notes)}</p>` : '';
    const planned = scenario.planned === false ? ' <span class="badge na">not planned</span>' : '';
    return `<details class="sc" data-phase="${scenario.phase}" data-level="${scenario.level}" data-applies="${scenario.applies}">
<summary><code>${esc(scenario.id)}</code> ${esc(scenario.title)} <span class="meta">${esc(scenario.method)} · ${esc(scenario.spec)} · P${scenario.phase}</span> ${badge(
        LEVEL_BADGE,
        scenario.level
    )} ${scenario.applies === 'yes' ? '' : badge(APPLIES_BADGE, scenario.applies)}${planned}</summary>
<div class="body"><p><strong>Given.</strong> ${esc(scenario.given)}</p><p><strong>When.</strong> ${esc(scenario.when)}</p><p><strong>Then.</strong> ${esc(
        scenario.then
    )}</p>${notes}<p class="small">Seed: ${esc([].concat(scenario.seed).join(', '))}. Sources: ${sources}</p></div>
</details>`;
}

function renderCatalogue(scenarios, areas) {
    return areas
        .map(area => {
            const items = scenarios.filter(scenario => scenario.area === area.area);
            return `<section class="area" id="area-${esc(area.area)}"><h3>${esc(area.title)} <span class="meta">${area.count} scenarios, <code>catalogue/${esc(
                area.file
            )}</code></span></h3><p>${esc(area.description)}</p>${items.map(renderScenario).join('\n')}</section>`;
        })
        .join('\n');
}

function main() {
    const { areas, scenarios, errors } = loadCatalogue();
    const expectations = loadExpectations();
    errors.push(...expectations.errors);
    if (errors.length) {
        errors.forEach(error => console.error(`ERROR ${error}`));
        process.exit(1);
    }
    // jmapio first: it is the per pull request gate
    const suites = expectations.suites.reverse();
    const parts = {
        cards: renderCards(scenarios, areas, suites),
        matrix: renderMatrix(scenarios, areas),
        phases: renderPhases(scenarios, suites),
        suites: suites.map(renderSuite).join('\n'),
        toc: areas.map(area => `<li><a href="#area-${esc(area.area)}">${esc(area.title)}</a></li>`).join(''),
        catalogue: renderCatalogue(scenarios, areas),
        total: String(scenarios.length)
    };

    const html = fs.readFileSync(TEMPLATE, 'utf-8').replace(/\{\{(\w+)\}\}/g, (match, key) => (key in parts ? parts[key] : match));
    const output = process.argv[2] || DEFAULT_OUTPUT;
    fs.writeFileSync(output, html);
    console.log(`${output}: ${scenarios.length} scenarios, ${suites.length} external suites, ${Math.round(html.length / 1024)} KB`);
}

main();
