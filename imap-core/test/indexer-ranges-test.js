/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Exhaustive range test for the rebuilder. A partial fetch must return exactly the bytes of the full
// output at that origin, for any origin and any length, including ranges that start or end beyond the
// data. Sampled windows can miss a seam, so for small messages every (origin, length) pair is checked:
// for the whole message and every section, for v2 trees and for v1 trees written by the previous
// parser, with attachment bodies in memory and in a storage that delivers them in tiny chunks, and
// through the IMAP literal path.

const chai = require('chai');
const expect = chai.expect;
const Indexer = require('../lib/indexer/indexer');
const LegacyIndexer = require('./fixtures/legacy-v1/indexer');
const compileStream = require('../lib/handler/imap-compile-stream');
const MemoryAttachmentStorage = require('./fixtures/memory-attachment-storage');
const { cases, listSelectors, runSelector, materialize, wireLiteral } = require('./fixtures/indexer-cases');
const { scenarios } = require('./fixtures/attachment-scenarios');
const { generateMessage } = require('./fixtures/mime-fuzz');

chai.config.includeStack = true;

// every length up to this size, a fixed set of lengths beyond it
const EXHAUSTIVE_LIMIT = 160;
const LENGTHS = [1, 2, 3, 4, 5, 7, 16, 57, 76, 77, 78, 79, 80, 152, 153, 154];

function lengthsFor(size, origin) {
    let rest = size - origin;
    if (size <= EXHAUSTIVE_LIMIT) {
        // every length that ends inside the data, and two that run past it
        return Array.from({ length: Math.max(rest, 0) + 2 }, (_, i) => i + 1);
    }
    return [...LENGTHS, rest, rest + 1].filter(n => n >= 1);
}

function describeDiff(actual, expected) {
    let i = 0;
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) {
        i++;
    }
    let show = buf => JSON.stringify(buf.subarray(Math.max(0, i - 20), i + 20).toString('latin1'));
    return `first difference at ${i} (lengths ${actual.length} vs ${expected.length}): got ${show(actual)} want ${show(expected)}`;
}

async function checkAllRanges(label, indexer, tree, selector, viaWire) {
    let full = await materialize(runSelector(indexer, tree, selector));
    expect(full.bytes.length, `${label} full length`).to.equal(full.size);
    let size = full.size;
    for (let origin = 0; origin <= size + 1; origin++) {
        for (let length of lengthsFor(size, origin)) {
            let options = { startFrom: origin, maxLength: length };
            let want = full.bytes.subarray(origin, origin + length);
            let got = await materialize(runSelector(indexer, tree, selector, options));
            if (!got.bytes.equals(want)) {
                expect.fail(`${label} <${origin}.${length}> ${describeDiff(got.bytes, want)}`);
            }
            if (viaWire && (origin % 7 === 0 || length <= 3)) {
                let literal = await wireLiteral(compileStream, runSelector(indexer, tree, selector, options), options);
                if (literal.mismatches.length || !literal.bytes.equals(want)) {
                    expect.fail(`${label} <${origin}.${length}> on the wire: ${JSON.stringify(literal.mismatches)} ${describeDiff(literal.bytes, want)}`);
                }
            }
        }
    }
}

async function checkTree(label, indexer, tree) {
    for (let selector of listSelectors(tree)) {
        let result = runSelector(indexer, tree, selector);
        if (!result || result.type !== 'stream') {
            continue;
        }
        await checkAllRanges(`${label} ${selector.key || 'BODY[]'}`, indexer, tree, selector, !selector.key);
    }
}

function store(indexer, tree) {
    let maildata = indexer.getMaildata(tree);
    return new Promise((resolve, reject) => indexer.storeNodeBodies(maildata, tree, err => (err ? reject(err) : resolve(tree))));
}

// small messages of every layout
const messages = [];
for (let entry of Object.values(cases)) {
    if (entry.source.length <= 1200) {
        messages.push({ name: entry.name, source: entry.source });
    }
}
for (let seed = 7000; messages.length < 70 && seed < 9000; seed++) {
    let { source } = generateMessage(seed);
    if (source.length <= 400) {
        messages.push({ name: 'generated:' + seed, source });
    }
}
const attachmentMessages = scenarios.filter(scenario => scenario.source.length <= 900);

describe('Indexer ranges', function () {
    this.timeout(30 * 60 * 1000);

    describe('v2 trees', function () {
        for (let { name, source } of messages) {
            it(name, async function () {
                let indexer = new Indexer();
                await checkTree(name, indexer, indexer.parseMimeTree(source));
            });
        }
    });

    describe('v1 trees written by the previous parser', function () {
        for (let { name, source } of messages) {
            it(name, async function () {
                let tree = new LegacyIndexer().parseMimeTree(source);
                await checkTree(name, new Indexer(), tree);
            });
        }
    });

    describe('attachments in the storage', function () {
        for (let scenario of attachmentMessages) {
            for (let [kind, options] of [
                ['decoded, 1 byte chunks', { chunkSize: 1 }],
                ['decoded, 57 byte chunks', { chunkSize: 57 }],
                ['legacy metadata', { chunkSize: 5, legacyDecoding: true }],
                ['verbatim', { chunkSize: 3, decodeBase64: false }]
            ]) {
                it(`${scenario.name} (${kind})`, async function () {
                    let indexer = new Indexer({ attachmentStorage: new MemoryAttachmentStorage(options) });
                    let tree = await store(indexer, indexer.parseMimeTree(scenario.source));
                    await checkAllRanges(`${scenario.name} (${kind}) BODY[]`, indexer, tree, { key: '', path: '', type: '' }, true);
                    let full = await materialize(runSelector(indexer, tree, { path: '', type: '' }));
                    expect(full.bytes.equals(scenario.source)).to.be.true;
                });
            }
        }
    });

    describe('range options', function () {
        let indexer = new Indexer();
        let tree = indexer.parseMimeTree(cases['synthetic:nested_blank'].source);
        let fullBytes;

        before(async function () {
            fullBytes = (await materialize(indexer.getContents(tree, false))).bytes;
        });

        let window = async options => (await materialize(indexer.getContents(tree, false, options))).bytes;

        it('treats a missing or zero length as the rest of the data', async function () {
            expect((await window({ startFrom: 10 })).equals(fullBytes.subarray(10))).to.be.true;
            expect((await window({ startFrom: 10, maxLength: 0 })).equals(fullBytes.subarray(10))).to.be.true;
        });

        it('returns nothing for an origin at or beyond the end', async function () {
            expect((await window({ startFrom: fullBytes.length, maxLength: 5 })).length).to.equal(0);
            expect((await window({ startFrom: fullBytes.length + 1000, maxLength: 5 })).length).to.equal(0);
        });

        it('cuts a length that runs past the end', async function () {
            expect((await window({ startFrom: 5, maxLength: 1e9 })).equals(fullBytes.subarray(5))).to.be.true;
        });

        it('treats negative, non-numeric and fractional values safely', async function () {
            expect((await window({ startFrom: -5, maxLength: 3 })).equals(fullBytes.subarray(0, 3))).to.be.true;
            expect((await window({ startFrom: NaN, maxLength: 3 })).equals(fullBytes.subarray(0, 3))).to.be.true;
            expect((await window({ startFrom: '4', maxLength: '3' })).equals(fullBytes.subarray(4, 7))).to.be.true;
            expect((await window({ startFrom: 2, maxLength: -1 })).equals(fullBytes.subarray(2))).to.be.true;
        });

        it('announces the full size and marks the stream as limited', function () {
            for (let options of [{ startFrom: 3, maxLength: 4 }, { startFrom: 3 }, { maxLength: 4 }]) {
                let result = indexer.getContents(tree, false, options);
                expect(result.expectedLength).to.equal(fullBytes.length);
                expect(result.value.isLimited, JSON.stringify(options)).to.be.true;
                // a byte stream, so consumers that read it as bytes get bytes
                expect(result.value.readableObjectMode).to.be.false;
                result.value.destroy();
            }
            expect(indexer.getContents(tree, false).value.isLimited).to.be.false;
        });

        it('serves an origin without a length through the IMAP literal path', async function () {
            for (let startFrom of [1, 5, fullBytes.length - 1]) {
                let options = { startFrom };
                let literal = await wireLiteral(compileStream, indexer.getContents(tree, false, options), { startFrom, maxLength: 0 });
                expect(literal.mismatches).to.deep.equal([]);
                expect(literal.bytes.equals(fullBytes.subarray(startFrom)), `origin ${startFrom}`).to.be.true;
            }
        });
    });
});
