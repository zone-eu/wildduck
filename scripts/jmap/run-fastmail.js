#!/usr/bin/env node
'use strict';

// Runs fastmail/JMAP-TestSuite against a WildDuck JMAP service and gates the result with
// test/jmap/external/fastmail-expectations.yaml (rules in test/jmap/external/README.md).
//
//   node scripts/jmap/run-fastmail.js --phase 2 [--jmap http://127.0.0.1:8091] [--api http://127.0.0.1:8080]
//       [--token <REST API access token>] [--workdir <dir>] [--report <file>] [--filter 'Mailbox/*'] [--jobs 4]
//
// The suite is cloned at the pinned commit into the work directory (never into this repository: it has
// no licence) and runs with prove in a container built from test/jmap/external/fastmail-adapter/Dockerfile,
// so it behaves the same on macOS (Docker Desktop, the host is host.docker.internal) and on Linux CI
// (host network). The WildDuck adapter creates a throwaway user per account through the REST API and
// deletes it when the test file ends.
// Exit code 0: the gate passed; 1: the gate failed; 2: the run could not be made.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const EXPECTATIONS = path.join(__dirname, '..', '..', 'test', 'jmap', 'external', 'fastmail-expectations.yaml');
const ADAPTER_DIR = path.join(__dirname, '..', '..', 'test', 'jmap', 'external', 'fastmail-adapter');
const REPOSITORY = 'https://github.com/fastmail/JMAP-TestSuite';

// reasons the suite gives when it skips a whole test body (README.md, "Mapping to the expectations file")
const SKIP_REASON = /^(server does not support |test requires )/;

function parseArgs(argv) {
    const args = {
        jmap: 'http://127.0.0.1:8091',
        api: 'http://127.0.0.1:8080',
        workdir: path.join(os.tmpdir(), 'wildduck-fastmail'),
        jobs: '4'
    };
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        args[key] = argv[i + 1];
    }
    if (!/^\d$/.test(args.phase || '')) {
        throw new Error('--phase <0 to 7> is required');
    }
    if (!/^\d+$/.test(args.jobs)) {
        throw new Error('--jobs must be a number');
    }
    args.phase = Number(args.phase);
    args.workdir = path.resolve(args.workdir);
    return args;
}

/** Clones the suite at the pinned commit, once per work directory */
function prepareSuite(workdir, commit) {
    const dir = path.join(workdir, 'JMAP-TestSuite');
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(workdir, { recursive: true });
        execFileSync('git', ['clone', '--quiet', REPOSITORY, dir], { stdio: 'inherit' });
    }
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    if (head !== commit) {
        execFileSync('git', ['-C', dir, 'fetch', '--quiet', 'origin'], { stdio: 'inherit' });
        execFileSync('git', ['-C', dir, 'checkout', '--quiet', commit], { stdio: 'inherit' });
    }
    return dir;
}

/** Builds the Perl image unless one for this suite commit and Dockerfile already exists */
function prepareImage(suite, commit) {
    const dockerfile = path.join(ADAPTER_DIR, 'Dockerfile');
    const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(dockerfile))
        .update(fs.readFileSync(path.join(suite, 'cpanfile')))
        .digest('hex');
    const image = `wildduck-jmap-fastmail:${commit.slice(0, 12)}-${digest.slice(0, 12)}`;
    if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
        // the build context is the suite clone, only its cpanfile is read
        execFileSync('docker', ['build', '--quiet', '-f', dockerfile, '-t', image, suite], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    return image;
}

/** On Docker Desktop the container reaches the host's loopback services as host.docker.internal */
function containerNetwork(urls) {
    if (process.platform === 'linux') {
        return { dockerArgs: ['--network', 'host'], urls };
    }
    const mapped = {};
    for (const [key, url] of Object.entries(urls)) {
        mapped[key] = url.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i, '$1host.docker.internal');
    }
    return { dockerArgs: ['--add-host', 'host.docker.internal:host-gateway'], urls: mapped };
}

/** Test files to run: everything in the expectations file, or the ids matching --filter */
function selectFiles(expectations, filter) {
    const matches = id => !filter || new RegExp('^' + filter.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(id);
    return expectations.tests.map(test => test.id).filter(matches);
}

/**
 * The outcome of one test file from its raw TAP and whether prove counted the file as ok.
 *
 * Test::Routine nests the body of a file two levels deep: "ok 1 - tests" at the top, "ok 1 - test from
 * t/<file>" one level in (4 spaces) and the body's own assertions and named subtests at 8 spaces.
 * The suite skips a whole body in two ways: "1..0 # SKIP test requires ..." at the top (attr pristine
 * or pool_pairs) or "1..0 # SKIP server does not support ..." as the plan of the body (require_capabilities).
 * pass: ok and the body ran; skip: ok, such a skip plan, and no assertion in the body; anything else fails.
 */
function classify(tap, proveOk) {
    if (tap === null) {
        return { status: 'fail', reason: 'no TAP output' };
    }
    const lines = tap.split(/\r?\n/);
    const skipPlan = lines.map(line => line.match(/^(?: {8})?1\.\.0\s*#\s*skip\s*(.*)$/i)).find(Boolean);
    const bodyRan = lines.some(line => /^ {8}(ok|not ok)\b/.test(line));
    if (proveOk && skipPlan && !bodyRan) {
        return SKIP_REASON.test(skipPlan[1]) ? { status: 'skip', reason: skipPlan[1] } : { status: 'fail', reason: `unexpected skip: ${skipPlan[1]}` };
    }
    if (proveOk) {
        return { status: 'pass' };
    }
    const failed = lines.filter(line => /^\s*not ok\b/.test(line) && !/#\s*todo/i.test(line)).map(line => line.trim());
    const died = lines.filter(line => /^\s*#\s*(Looks like|Tests were run but|No tests run)/.test(line)).map(line => line.replace(/^\s*#\s*/, ''));
    return { status: 'fail', reason: (failed.slice(0, 3).concat(died.slice(0, 1)).join('; ') || 'prove reported the file as failed').slice(0, 300) };
}

/** Files prove listed in its summary as failed (non zero exit, failed tests, parse errors) */
function failedFiles(proveOutput) {
    const failed = new Set();
    const summary = proveOutput.split('Test Summary Report')[1] || '';
    for (const match of summary.matchAll(/^t\/(\S+\.t)\s+\(Wstat/gm)) {
        failed.add(match[1]);
    }
    return failed;
}

/**
 * The gate (README.md): every pass entry up to the phase passes, every never entry does not pass, every
 * skip entry is skipped, and the id lists agree.
 */
function gate(expectations, results, phase, files) {
    const selected = new Set(files);
    const problems = [];
    const early = [];
    const counts = { pass: 0, fail: 0, skip: 0 };
    for (const entry of expectations.tests.filter(test => selected.has(test.id))) {
        const result = results.get(entry.id);
        if (!result) {
            problems.push(`${entry.id}: missing from the run`);
            continue;
        }
        counts[result.status]++;
        const why = result.reason ? ` (${result.reason})` : '';
        if (entry.expect === 'pass' && entry.phase <= phase && result.status !== 'pass') {
            problems.push(`${entry.id}: expected to pass from phase ${entry.phase}, ${result.status}${why}`);
        } else if (entry.expect === 'never' && result.status === 'pass') {
            problems.push(`${entry.id}: expected never to pass (${entry.reason}), passed`);
        } else if (entry.expect === 'skip' && result.status !== 'skip') {
            problems.push(`${entry.id}: expected to be skipped (${entry.reason}), ${result.status}${why}`);
        } else if (entry.phase > phase && result.status === 'pass') {
            early.push(entry.id);
        }
    }
    for (const id of results.keys()) {
        if (!selected.has(id)) {
            problems.push(`${id}: in the run but not in the expectations file`);
        }
    }
    return { problems, early, counts };
}

/** Test files the suite has at the pinned commit, relative to t/ */
function suiteFiles(suite) {
    const found = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(path.join(suite, 't', dir), { withFileTypes: true })) {
            const rel = dir ? `${dir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(rel);
            } else if (entry.name.endsWith('.t')) {
                found.push(rel);
            }
        }
    };
    walk('');
    return found.sort();
}

async function rest(args, method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (args.token) {
        headers['X-Access-Token'] = args.token;
    }
    const res = await fetch(args.api + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        throw new Error(`${method} ${url}: ${res.status} ${data.error || ''}`);
    }
    return data;
}

/**
 * Several test files read the session themselves and call its apiUrl, uploadUrl and downloadUrl, so the
 * server's jmap.baseUrl must be the origin the container reaches it under. Checked with a throwaway user.
 */
async function checkSessionUrls(args, containerJmap) {
    const username = `jtcheck${crypto.randomBytes(5).toString('hex')}`;
    const password = crypto.randomBytes(16).toString('hex');
    const { id } = await rest(args, 'POST', '/users', { username, password, address: `${username}@example.com`, tags: ['jmap-testsuite'] });
    try {
        const res = await fetch(`${args.jmap.replace(/\/+$/, '')}/.well-known/jmap`, {
            headers: { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') }
        });
        if (!res.ok) {
            throw new Error(`GET ${args.jmap}/.well-known/jmap: ${res.status}`);
        }
        const { apiUrl } = await res.json();
        const expected = new URL(containerJmap).origin;
        if (new URL(apiUrl).origin !== expected) {
            throw new Error(`the session names ${apiUrl}, the suite reaches the server as ${expected}; set jmap.baseUrl to ${expected}`);
        }
    } finally {
        await rest(args, 'DELETE', `/users/${id}`).catch(err => console.error(`could not delete ${username}: ${err.message}`));
    }
}

function runProve(args, suite, image, files, configDir, tapDir, network) {
    const { dockerArgs, urls } = network;
    const config = { adapter: 'WildDuck', jmap_uri: urls.jmap, api_uri: urls.api, domain: 'example.com' };
    if (args.token) {
        config.api_token = args.token;
    }
    // the file holds a REST API token and is removed after the run
    fs.writeFileSync(path.join(configDir, 'adapter.json'), JSON.stringify(config, null, 2), { mode: 0o600 });

    const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    const dockerRun = [
        'run',
        '--rm',
        ...user,
        ...dockerArgs,
        '-v',
        `${suite}:/suite:ro`,
        '-v',
        `${path.join(ADAPTER_DIR, 'lib')}:/adapter:ro`,
        '-v',
        `${configDir}:/config:ro`,
        '-v',
        `${tapDir}:/tap`,
        '-e',
        'JMAP_SERVER_ADAPTER_FILE=/config/adapter.json',
        // TAP::Harness writes the raw TAP of every file below this directory
        '-e',
        'PERL_TEST_HARNESS_DUMP_TAP=/tap',
        '-e',
        'HOME=/tmp',
        '-w',
        '/suite',
        image,
        'prove',
        '-Ilib',
        '-I/adapter',
        '-j',
        args.jobs,
        ...files.map(file => `t/${file}`)
    ];
    return spawnSync('docker', dockerRun, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const expectations = yaml.load(fs.readFileSync(EXPECTATIONS, 'utf8'));
    const suite = prepareSuite(args.workdir, expectations.commit);
    const image = prepareImage(suite, expectations.commit);
    const report = path.resolve(args.report || path.join(args.workdir, `report-phase${args.phase}.json`));
    const files = selectFiles(expectations, args.filter);
    const present = new Set(suiteFiles(suite));
    const network = containerNetwork({ jmap: args.jmap, api: args.api });
    await checkSessionUrls(args, network.urls.jmap);

    const runDir = fs.mkdtempSync(path.join(args.workdir, 'run-'));
    const configDir = path.join(runDir, 'config');
    const tapDir = path.join(runDir, 'tap');
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.mkdirSync(tapDir);

    let run;
    try {
        run = runProve(
            args,
            suite,
            image,
            files.filter(file => present.has(file)),
            configDir,
            tapDir,
            network
        );
    } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
    }
    const output = (run.stdout || '').toString();
    const errors = (run.stderr || '').toString();
    fs.writeFileSync(path.join(runDir, 'prove.log'), output + errors);

    // prove exits 1 when a file fails; anything else (docker 125 to 127, a signal) is an unusable run
    if (run.error || run.signal || ![0, 1].includes(run.status) || !/^Result: /m.test(output)) {
        console.error((output + errors).slice(-4000));
        console.error(`fastmail: fatal error, prove did not complete (log ${path.join(runDir, 'prove.log')})`);
        process.exit(2);
    }

    const failed = failedFiles(output);
    const results = new Map();
    for (const file of present) {
        if (!args.filter || files.includes(file)) {
            const tapFile = path.join(tapDir, 't', file);
            const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, 'utf8') : null;
            results.set(file, classify(tap, tap !== null && !failed.has(file)));
        }
    }

    fs.writeFileSync(
        report,
        JSON.stringify(
            {
                suite: expectations.suite,
                commit: expectations.commit,
                phase: args.phase,
                results: [...results].map(([id, result]) => Object.assign({ id }, result))
            },
            null,
            2
        )
    );

    const { problems, early, counts } = gate(expectations, results, args.phase, files);
    console.log(`fastmail phase ${args.phase}: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped; report ${report}, TAP in ${tapDir}`);
    if (early.length) {
        console.log(`passing before their phase (${early.length}): ${early.join(', ')}`);
    }
    if (problems.length) {
        console.log(`gate failed (${problems.length}):\n  ${problems.join('\n  ')}`);
        process.exit(1);
    }
    console.log('gate passed');
}

main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(2);
});
