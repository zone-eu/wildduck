/* eslint no-console: 0 */
'use strict';

// Mutation testing for the MIME parser, the rebuilder and the attachment codec.
//
// Each mutant is a copy of one source file with one small change (a flipped comparison, an off by one
// constant, a swapped boolean operator, a changed line break, a dropped negation). The mutant is
// written into a private copy of the repository and the indexer suites run against it; a mutant that
// no test catches ("survives") marks behaviour the suites do not pin.
//
// Usage: node imap-core/test/mutation/run.js [--workers 6] [--max 400] [--file imap-core/lib/indexer/tree-walker.js]
//        [--tests full]        the full set also runs the exhaustive range suite
//        [--survivors <json>]  re-run only the mutants listed in a survivors file of an earlier run
// Survivors are written to wildduck-mutation-survivors.json in the system temp directory.
// The repository itself is never modified.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
    let i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : def;
};

const FILES = opt('file', '')
    ? [opt('file')]
    : [
          'imap-core/lib/indexer/parse-mime-tree.js',
          'imap-core/lib/indexer/tree-walker.js',
          'imap-core/lib/indexer/indexer.js',
          'lib/attachments/base64-codec.js',
          'lib/attachments/base64-offset.js',
          'imap-core/lib/length-limiter.js'
      ];
const WORKERS = Number(opt('workers', Math.max(2, os.cpus().length - 2)));
const MAX = Number(opt('max', 0));

const FAST_TESTS = [
    'imap-core/test/attachment-codec-test.js',
    'imap-core/test/parse-mime-tree-test.js',
    'imap-core/test/parse-mime-tree-v2-test.js',
    'imap-core/test/indexer-fidelity-test.js',
    'imap-core/test/indexer-legacy-test.js',
    'imap-core/test/get-contents-test.js',
    'imap-core/test/body-structure-test.js',
    'imap-core/test/imap-indexer-test.js',
    'imap-core/test/indexer-corpus-test.js',
    'imap-core/test/indexer-attachments-test.js',
    'imap-core/test/indexer-fuzz-test.js',
    'imap-core/test/indexer-legacy-differential-test.js',
    'imap-core/test/indexer-maildata-test.js',
    'imap-core/test/imap-compile-stream-test.js'
];
const TESTS = opt('tests', 'fast') === 'full' ? [...FAST_TESTS, 'imap-core/test/indexer-ranges-test.js'] : FAST_TESTS;

// operator replacements, applied to code (comments and string contents of comments are skipped)
const OPERATORS = [
    [/[=]==/g, '!=='],
    [/!==/g, '==='],
    [/ <= /g, ' < '],
    [/ < /g, ' <= '],
    [/ >= /g, ' > '],
    [/ > /g, ' >= '],
    [/ && /g, ' || '],
    [/ \|\| /g, ' && '],
    [/ \+ 1\b/g, ' + 2'],
    [/ - 1\b/g, ' - 2'],
    [/ \+ 2\b/g, ' + 1'],
    [/\btrue\b/g, 'false'],
    [/\bfalse\b/g, 'true'],
    [/\\r\\n/g, '\\n'],
    [/\(!(?!=)/g, '(']
];

function mutantsOf(file) {
    let source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let lines = source.split('\n');
    let mutants = [];
    lines.forEach((line, index) => {
        let code = line.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\*|\/\/)/.test(line) || !code.trim() || /require\(|^\s*'use strict'/.test(code)) {
            return;
        }
        for (let [pattern, replacement] of OPERATORS) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(code))) {
                let mutatedLine = line.slice(0, match.index) + replacement + line.slice(match.index + match[0].length);
                if (mutatedLine !== line) {
                    let copy = lines.slice();
                    copy[index] = mutatedLine;
                    mutants.push({ file, line: index + 1, from: line.trim(), to: mutatedLine.trim(), source: copy.join('\n') });
                }
            }
        }
    });
    return mutants;
}

function makeWorkspace(n) {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), `wildduck-mutant-${n}-`));
    for (let entry of ['imap-core', 'lib', 'config', 'package.json']) {
        fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

function runTests(dir) {
    return new Promise(resolve => {
        execFile(
            path.join(ROOT, 'node_modules/.bin/mocha'),
            ['--exit', '--bail', '--reporter', 'dot', '--timeout', '120000', ...TESTS],
            { cwd: dir, env: Object.assign({}, process.env, { NODE_ENV: 'test', FUZZ_ITERATIONS: '60', MIME_CORPUS_FUZZ: '40', MIME_CORPUS_DIR: '' }), timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
            err => resolve(!err)
        );
    });
}

/**
 * Rebuilds the mutants of an earlier run from their recorded lines, so they can be re-run after the
 * tests or the code changed. A mutant whose line no longer exists is reported and skipped
 */
function mutantsFromSurvivors(file) {
    let mutants = [];
    for (let survivor of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        let lines = fs.readFileSync(path.join(ROOT, survivor.file), 'utf8').split('\n');
        // the same text can appear on several lines, the one nearest the recorded line number is the one
        let index = -1;
        lines.forEach((line, i) => {
            if (line.trim() === survivor.from && (index < 0 || Math.abs(i + 1 - survivor.line) < Math.abs(index + 1 - survivor.line))) {
                index = i;
            }
        });
        if (index < 0) {
            console.log(`GONE ${survivor.file}:${survivor.line} ${survivor.from}`);
            continue;
        }
        let indent = lines[index].match(/^\s*/)[0];
        let copy = lines.slice();
        copy[index] = indent + survivor.to;
        mutants.push({ ...survivor, line: index + 1, source: copy.join('\n') });
    }
    return mutants;
}

(async () => {
    let mutants = opt('survivors', '') ? mutantsFromSurvivors(opt('survivors')) : FILES.flatMap(mutantsOf);
    if (MAX && mutants.length > MAX) {
        // an even sample over all files
        let step = mutants.length / MAX;
        mutants = Array.from({ length: MAX }, (_, i) => mutants[Math.floor(i * step)]);
    }
    console.log(`${mutants.length} mutants, ${WORKERS} workers, tests: ${TESTS.length} files`);

    let workspaces = Array.from({ length: WORKERS }, (_, i) => makeWorkspace(i));
    // the unmutated code must pass first, otherwise every mutant would look killed
    if (!(await runTests(workspaces[0]))) {
        console.error('the suites fail on the unmutated code');
        process.exit(1);
    }

    let next = 0;
    let killed = 0;
    let survivors = [];
    let started = Date.now();
    await Promise.all(
        workspaces.map(async dir => {
            while (next < mutants.length) {
                let mutant = mutants[next++];
                let target = path.join(dir, mutant.file);
                let original = fs.readFileSync(target, 'utf8');
                fs.writeFileSync(target, mutant.source);
                let passed = await runTests(dir);
                fs.writeFileSync(target, original);
                if (passed) {
                    survivors.push(mutant);
                    console.log(`SURVIVED ${mutant.file}:${mutant.line}\n    - ${mutant.from}\n    + ${mutant.to}`);
                } else {
                    killed++;
                }
                let done = killed + survivors.length;
                if (done % 20 === 0) {
                    console.log(`  ${done}/${mutants.length} done, ${survivors.length} survived, ${Math.round((Date.now() - started) / 1000)}s`);
                }
            }
        })
    );

    for (let dir of workspaces) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`\nkilled ${killed}, survived ${survivors.length}, mutation score ${((100 * killed) / mutants.length).toFixed(1)}%`);
    let report = path.join(os.tmpdir(), 'wildduck-mutation-survivors.json');
    fs.writeFileSync(report, JSON.stringify(survivors.map(({ source, ...m }) => m), null, 2)); // eslint-disable-line no-unused-vars
    console.log(`survivors written to ${report}`);
})();
