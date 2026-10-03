/* eslint no-console: 0 */
'use strict';

// Regenerates simple.json and mimetorture.json, the parsed trees that imap-indexer-test compares the
// parser output against. Run it after an intentional change to the tree format and review the diff.
//
// Usage: node imap-core/test/fixtures/tree-fixtures.generate.js

const fs = require('fs');
const path = require('path');
const parseMimeTree = require('../../lib/indexer/parse-mime-tree');
const { treeReplacer } = require('./indexer-cases');

for (let name of ['simple', 'mimetorture']) {
    let source = fs.readFileSync(path.join(__dirname, name + '.eml'));
    let target = path.join(__dirname, name + '.json');
    fs.writeFileSync(target, JSON.stringify(parseMimeTree(source), treeReplacer, 4) + '\n');
    console.log(`wrote ${target}`);
}
