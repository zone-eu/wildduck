/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Property test for the two directions of the indexer: a parsed message must rebuild to the bytes that
// were delivered, every selector must announce exactly the bytes it emits, and the IMAP literal path must
// never have to pad or truncate (RFC 3501 4.3, 7.4.2 "BODY[] is NEVER truncated").

const chai = require('chai');
const expect = chai.expect;
const Indexer = require('../lib/indexer/indexer');
const compileStream = require('../lib/handler/imap-compile-stream');
const { cases, listSelectors, runSelector, materialize, wireLiteral } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const indexer = new Indexer();

function describeDiff(actual, expected) {
    let i = 0;
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) {
        i++;
    }
    let show = buf => JSON.stringify(buf.subarray(Math.max(0, i - 24), i + 24).toString('binary'));
    return `first difference at ${i} (lengths ${actual.length} vs ${expected.length}): got ${show(actual)} want ${show(expected)}`;
}

const BODY = { path: '', type: '' };

describe('Indexer fidelity', function () {
    this.timeout(120000);

    for (let name of Object.keys(cases)) {
        let { source, expected } = cases[name];

        describe(name, function () {
            let tree;

            before(function () {
                tree = indexer.parseMimeTree(source);
            });

            it('rebuilds BODY[] to the delivered bytes', async function () {
                let { size, bytes } = await materialize(runSelector(indexer, tree, BODY));
                expect(bytes.equals(expected), describeDiff(bytes, expected)).to.be.true;
                expect(size).to.equal(expected.length);
            });

            it('announces exactly the bytes it emits for every section', async function () {
                for (let selector of listSelectors(tree)) {
                    let result = runSelector(indexer, tree, selector);
                    if (!result || result.type !== 'stream') {
                        continue;
                    }
                    let { size, bytes } = await materialize(result);
                    expect(bytes.length, `section ${selector.key || 'BODY[]'}`).to.equal(size);
                }
            });

            it('serves BODY[] through the literal path without length corrections', async function () {
                let wire = await wireLiteral(compileStream, runSelector(indexer, tree, BODY));
                expect(wire.mismatches).to.deep.equal([]);
                expect(wire.announced).to.equal(expected.length);
                expect(wire.bytes.equals(expected), describeDiff(wire.bytes, expected)).to.be.true;
            });

            it('serves every partial window of BODY[]', async function () {
                // every origin for small messages, a prime step for large ones so the seams move through
                // every column of wrapped content
                let step = expected.length > 4096 ? 97 : 1;
                let lengths = expected.length > 4096 ? [7, 4096] : [1, 7, 50];
                for (let origin = 0; origin < expected.length; origin += step) {
                    for (let length of lengths) {
                        let options = { startFrom: origin, maxLength: length };
                        let wire = await wireLiteral(compileStream, runSelector(indexer, tree, BODY, options), options);
                        let want = expected.subarray(origin, origin + length);
                        expect(wire.mismatches, `<${origin}.${length}>`).to.deep.equal([]);
                        expect(wire.bytes.equals(want), `<${origin}.${length}> ${describeDiff(wire.bytes, want)}`).to.be.true;
                    }
                }
            });
        });
    }
});
