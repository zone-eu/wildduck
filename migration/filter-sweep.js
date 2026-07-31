'use strict';

// Extracts the deterministic invalid-input sweep slice from a recording.
// The sweep runs before the test suite and its unknown-key case marks the
// request with __migrationProbe, so the slice stays comparable across
// captures even after the test suite itself has changed.
//
// Routes whose validation schema was deliberately changed after the golden
// baseline was recorded are dropped from both sides; their behavior is
// covered by the regular test suite instead.
//
// Usage: node migration/filter-sweep.js <input.jsonl> <output.jsonl> [--all]
//   --all keeps every sweep case up to the end of the sweep instead of only
//   the __migrationProbe marked ones
// Temporary tooling, delete after migration.

const fs = require('fs');

// intentional post-baseline schema fixes (see migration/SEMANTICS.md)
const CHANGED_ROUTES = [/^\/users\/[^/]+\/archived\/messages\/[^/]+\/restore/];

const [input, output, mode] = process.argv.slice(2);
if (!input || !output) {
    console.error('Usage: node migration/filter-sweep.js <input.jsonl> <output.jsonl> [--all]');
    process.exit(1);
}

const all = mode === '--all';

const records = fs
    .readFileSync(input, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
        try {
            return { line, rec: JSON.parse(line) };
        } catch {
            return null;
        }
    })
    .filter(Boolean);

// the sweep is the leading block of the recording, the suite follows the
// last probe marked request
let sweepEnd = 0;
records.forEach((entry, i) => {
    if ((entry.rec.url || '').includes('__migrationProbe')) {
        sweepEnd = i;
    }
});

const lines = records
    .slice(0, all ? sweepEnd + 1 : records.length)
    .filter(entry => all || (entry.rec.url || '').includes('__migrationProbe'))
    .filter(entry => !CHANGED_ROUTES.some(re => re.test((entry.rec.url || '').split('?')[0])))
    .map(entry => entry.line);

fs.writeFileSync(output, lines.join('\n') + '\n');
console.log(`${input}: ${lines.length} sweep records -> ${output}`);
