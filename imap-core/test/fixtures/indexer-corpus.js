'use strict';

// Every message source the indexer suites can throw at the parser and the rebuilder:
//   - the repository fixtures and the synthetic layouts in indexer-cases.js
//   - the attachment scenarios
//   - generated messages and the same messages broken by the mutator (mime-fuzz.js), seeded
//   - an optional external corpus: MIME_CORPUS_DIR=dir1:dir2 adds every .eml file below those
//     directories, for runs against real mail that can not live in this repository
//
// MIME_CORPUS_FUZZ sets how many generated (and as many mutated) messages are added, 150 by default.
// MIME_CORPUS_LIST=file reads the paths of the .eml files to add from a file, one per line, for runs
// that split a large corpus into shards. MIME_CORPUS_EXTERNAL_ONLY=1 leaves out everything but the
// external messages.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cases } = require('./indexer-cases');
const { scenarios } = require('./attachment-scenarios');
const { Rng, generateMessage, mutate } = require('./mime-fuzz');

const FUZZ_COUNT = process.env.MIME_CORPUS_FUZZ !== undefined && process.env.MIME_CORPUS_FUZZ !== '' ? Number(process.env.MIME_CORPUS_FUZZ) : 150;
const EXTERNAL_ONLY = /^(1|true|yes)$/i.test(process.env.MIME_CORPUS_EXTERNAL_ONLY || '');
const FUZZ_SEED = Number(process.env.FUZZ_SEED) || 20261004;

function findEml(dir, found) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return found;
    }
    for (let entry of entries) {
        let full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
            findEml(full, found);
        } else if (entry.isFile() && /\.eml$/i.test(entry.name)) {
            found.push(full);
        }
    }
    return found;
}

function loadCorpus() {
    let corpus = [];
    let seen = new Set();
    let add = (name, source) => {
        let digest = crypto.createHash('sha256').update(source).digest('hex');
        if (!seen.has(digest)) {
            seen.add(digest);
            corpus.push({ name, source });
        }
    };

    let builtIn = !EXTERNAL_ONLY;
    for (let entry of builtIn ? Object.values(cases) : []) {
        add(entry.name, entry.source);
    }
    for (let scenario of builtIn ? scenarios : []) {
        add('attachment:' + scenario.name, scenario.source);
    }
    for (let i = 0; builtIn && i < FUZZ_COUNT; i++) {
        let seed = FUZZ_SEED + i;
        let { source } = generateMessage(seed);
        add('generated:' + seed, source);
        add('mutated:' + seed, mutate(new Rng(seed * 7919), source));
    }
    // inputs that are not mail at all
    if (builtIn) {
        let rng = new Rng(FUZZ_SEED);
        add('garbage:empty', Buffer.alloc(0));
        add('garbage:crlf', Buffer.from('\r\n'));
        add('garbage:lf', Buffer.from('\n'));
        add('garbage:cr', Buffer.from('\r'));
        add('garbage:dashes', Buffer.from('--\r\n--\r\n----\r\n'));
        for (let i = 0; i < 10; i++) {
            add('garbage:random:' + i, rng.bytes(rng.int(1, 300)));
        }
    }

    for (let dir of (process.env.MIME_CORPUS_DIR || '').split(':').filter(Boolean)) {
        for (let file of findEml(dir, []).sort()) {
            add('external:' + file, fs.readFileSync(file));
        }
    }
    if (process.env.MIME_CORPUS_LIST) {
        for (let file of fs.readFileSync(process.env.MIME_CORPUS_LIST, 'utf8').split('\n').filter(Boolean)) {
            add('external:' + file, fs.readFileSync(file));
        }
    }

    return corpus;
}

module.exports = { loadCorpus };
