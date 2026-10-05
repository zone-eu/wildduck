/* eslint no-console: 0 */
'use strict';

// Generates legacy-v1-trees.json: the MIME trees the v1 parser produced for every indexer test case and,
// for every stream selector, the size it announced and a hash of the bytes IMAP actually served (the
// rebuild output after the LengthLimiter). Existing mail stores hold v1 trees, so this snapshot pins how
// they must keep rendering. It must only ever be regenerated from a commit whose parser still writes v1
// trees; regenerating it from newer code would silently rebase the compatibility guarantee.
//
// Usage: node imap-core/test/fixtures/legacy-v1-trees.generate.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Indexer = require('../../lib/indexer/indexer');
const compileStream = require('../../lib/handler/imap-compile-stream');
const { cases, listSelectors, runSelector, materialize, wireLiteral, sha256, treeReplacer } = require('./indexer-cases');

const indexer = new Indexer();
const target = path.join(__dirname, 'legacy-v1-trees.json');

(async () => {
    let snapshot = {
        commit: execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(),
        note: 'Trees and output of the v1 parser and walker. Do not regenerate from code that writes v2 trees.',
        cases: {}
    };

    let seen = new Map();
    for (let name of Object.keys(cases)) {
        let { source, expected } = cases[name];
        let digest = sha256(source);
        if (seen.has(digest)) {
            console.log(`${name}: identical to ${seen.get(digest)}, skipped`);
            continue;
        }
        seen.set(digest, name);

        let tree = indexer.parseMimeTree(source);
        let sections = {};
        for (let selector of listSelectors(tree)) {
            let result = runSelector(indexer, tree, selector);
            if (!result || result.type !== 'stream') {
                continue;
            }
            let wire = await wireLiteral(compileStream, result);
            // the stream was consumed by wireLiteral, run it again for the raw rebuild size
            let raw = await materialize(runSelector(indexer, tree, selector));
            sections[selector.key] = {
                size: raw.size,
                rebuilt: raw.bytes.length,
                wireLength: wire.bytes.length,
                wireSha256: sha256(wire.bytes),
                matchesExpected: selector.key === '' ? wire.bytes.equals(expected) : undefined
            };
        }

        snapshot.cases[name] = { tree, sections };
        console.log(`${name}: ${Object.keys(sections).length} sections`);
    }

    fs.writeFileSync(target, JSON.stringify(snapshot, treeReplacer, 1) + '\n');
    console.log(`wrote ${target} (${fs.statSync(target).size} bytes) at ${snapshot.commit}`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
