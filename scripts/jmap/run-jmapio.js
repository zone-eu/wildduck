#!/usr/bin/env node
'use strict';

// Runs jmapio/jmap-test-suite against a WildDuck JMAP service and gates the result with
// test/jmap/external/jmapio-expectations.yaml (rules in test/jmap/external/README.md).
//
//   node scripts/jmap/run-jmapio.js --phase 2 [--jmap http://127.0.0.1:8091] [--api http://127.0.0.1:8080]
//       [--token <REST API access token>] [--workdir <dir>] [--report <file>] [--filter 'email/*']
//
// The suite is cloned at the pinned commit into the work directory (never into this repository: it has
// no licence). Two throwaway users are created through the REST API for the run and deleted afterwards.
// Exit code 0: the gate passed; 1: the gate failed; 2: the run could not be made.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const EXPECTATIONS = path.join(__dirname, '..', '..', 'test', 'jmap', 'external', 'jmapio-expectations.yaml');
const REPOSITORY = 'https://github.com/jmapio/jmap-test-suite';

function parseArgs(argv) {
    const args = { jmap: 'http://127.0.0.1:8091', api: 'http://127.0.0.1:8080', workdir: path.join(os.tmpdir(), 'wildduck-jmapio') };
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        args[key] = argv[i + 1];
    }
    if (!/^\d$/.test(args.phase || '')) {
        throw new Error('--phase <0 to 7> is required');
    }
    args.phase = Number(args.phase);
    return args;
}

/** Clones and builds the suite at the pinned commit, once per work directory */
function prepareSuite(workdir, commit) {
    const dir = path.join(workdir, 'jmap-test-suite');
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(workdir, { recursive: true });
        execFileSync('git', ['clone', '--quiet', REPOSITORY, dir], { stdio: 'inherit' });
    }
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    if (head !== commit) {
        execFileSync('git', ['-C', dir, 'fetch', '--quiet', 'origin'], { stdio: 'inherit' });
        execFileSync('git', ['-C', dir, 'checkout', '--quiet', commit], { stdio: 'inherit' });
    }
    if (!fs.existsSync(path.join(dir, 'dist', 'cli.js')) || head !== commit) {
        execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
        execFileSync('npm', ['run', '--silent', 'build'], { cwd: dir, stdio: 'inherit' });
    }
    return dir;
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

async function createUser(args, role) {
    const username = `jmapio${role}${crypto.randomBytes(5).toString('hex')}`;
    const password = crypto.randomBytes(16).toString('hex');
    const { id } = await rest(args, 'POST', '/users', { username, password, address: `${username}@example.com`, name: `jmapio ${role}` });
    return { id, username, password };
}

/**
 * The gate (README.md): every pass (or phased opinion) entry up to the phase passes, every never entry
 * does not pass, the id lists agree, and the run was not fatal.
 */
function gate(expectations, report, phase, filter) {
    const results = new Map((report.results || []).map(result => [result.testId, result]));
    const matches = id => !filter || new RegExp('^' + filter.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(id);
    const problems = [];
    const early = [];
    const counts = { pass: 0, fail: 0, skip: 0 };
    for (const entry of expectations.tests.filter(test => matches(test.id))) {
        const result = results.get(entry.id);
        if (!result) {
            problems.push(`${entry.id}: missing from the report`);
            continue;
        }
        counts[result.status] = (counts[result.status] || 0) + 1;
        const gated = (entry.expect === 'pass' || (entry.expect === 'opinion' && entry.phase !== undefined)) && entry.phase <= phase;
        if (gated && result.status !== 'pass') {
            problems.push(`${entry.id}: expected to pass from phase ${entry.phase}, ${result.status}${result.error ? ` (${String(result.error).slice(0, 160)})` : ''}`);
        } else if (entry.expect === 'never' && result.status === 'pass') {
            problems.push(`${entry.id}: expected never to pass (${entry.reason}), passed`);
        } else if (entry.phase > phase && result.status === 'pass') {
            early.push(entry.id);
        }
    }
    const known = new Set(expectations.tests.map(test => test.id));
    for (const id of results.keys()) {
        if (!known.has(id)) {
            problems.push(`${id}: in the report but not in the expectations file`);
        }
    }
    return { problems, early, counts };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const expectations = yaml.load(fs.readFileSync(EXPECTATIONS, 'utf8'));
    const suite = prepareSuite(args.workdir, expectations.commit);
    const report = args.report || path.join(args.workdir, `report-phase${args.phase}.json`);
    const configPath = path.join(args.workdir, 'config.json');

    const users = [await createUser(args, 'primary'), await createUser(args, 'secondary')];
    let run;
    try {
        const config = {
            sessionUrl: `${args.jmap.replace(/\/+$/, '')}/.well-known/jmap`,
            serverInfo: `WildDuck phase ${args.phase}`,
            users: {
                primary: { username: users[0].username, password: users[0].password },
                secondary: { username: users[1].username, password: users[1].password }
            },
            authMethod: 'basic',
            timeout: 30000,
            verbose: false
        };
        // the file holds credentials of throwaway users and is removed after the run
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
        const cliArgs = ['dist/cli.js', '-c', configPath, '-f', '-o', report];
        if (args.filter) {
            cliArgs.push('--filter', args.filter);
        }
        run = spawnSync(process.execPath, cliArgs, { cwd: suite, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
    } finally {
        fs.rmSync(configPath, { force: true });
        for (const user of users) {
            await rest(args, 'DELETE', `/users/${user.id}`).catch(err => console.error(`could not delete ${user.username}: ${err.message}`));
        }
    }

    if (run.status === 2 || !fs.existsSync(report)) {
        console.error(run.stdout ? run.stdout.toString().slice(-4000) : '');
        console.error('jmapio: fatal error, no usable report');
        process.exit(2);
    }
    const { problems, early, counts } = gate(expectations, JSON.parse(fs.readFileSync(report, 'utf8')), args.phase, args.filter);
    console.log(`jmapio phase ${args.phase}: ${counts.pass} passed, ${counts.fail || 0} failed, ${counts.skip || 0} skipped; report ${report}`);
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
