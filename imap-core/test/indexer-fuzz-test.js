/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
'use strict';

// Fuzz suite for the indexer (parsing) and the rebuilder (serialising a tree back into bytes).
//
// Generated messages come with a model of the structure the parser must find, so indexing is checked
// against known structure: part tree, headers, bodies, preamble, epilogue, padding, body sections.
// Every message, generated or mutated, must then satisfy the properties that hold for any input at all:
// a byte exact rebuild of the canonical form, sizes that match the bytes for every selector, exact
// bytes for any window of the message or of a section, no literal length correction on the IMAP path,
// BODYSTRUCTURE and ENVELOPE that compile to responses the IMAP parser reads back, and the same again
// with the attachment bodies moved to a storage that chunks them at random sizes.
//
// Reproduce one case with FUZZ_SEED=<seed> FUZZ_ITERATIONS=1; raise FUZZ_ITERATIONS for a longer run.

const chai = require('chai');
const expect = chai.expect;
const Indexer = require('../lib/indexer/indexer');
const compileStream = require('../lib/handler/imap-compile-stream');
const imapHandler = require('../lib/handler/imap-handler');
const imapTools = require('../lib/imap-tools');
const { walkTree } = require('../lib/indexer/tree-walker');
const MemoryAttachmentStorage = require('./fixtures/memory-attachment-storage');
const { Rng, generateMessage, mutate, canonical } = require('./fixtures/mime-fuzz');
const { listSelectors, runSelector, materialize, wireLiteral } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const SEED = Number(process.env.FUZZ_SEED) || 20261004;
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 200;

const BODY = { path: '', type: '' };

function describeDiff(actual, expected) {
    let i = 0;
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) {
        i++;
    }
    let show = buf => JSON.stringify(buf.subarray(Math.max(0, i - 30), i + 30).toString('latin1'));
    return `first difference at ${i} (lengths ${actual.length} vs ${expected.length}): got ${show(actual)} want ${show(expected)}`;
}

function store(indexer, tree) {
    let maildata = indexer.getMaildata(tree);
    return new Promise((resolve, reject) => {
        indexer.storeNodeBodies(maildata, tree, err => (err ? reject(err) : resolve(tree)));
    });
}

function countBreaks(body) {
    return (body.toString('latin1').match(/\r\n/g) || []).length;
}

/**
 * Checks a parsed node against the generated model it came from
 */
function checkModel(node, model, path) {
    let at = `node ${path || 'root'}`;

    expect(node.header, `${at} header`).to.deep.equal(model.header);

    if (!model.hasBody) {
        expect(node.hasBody, `${at} hasBody`).to.equal(false);
        expect(node.size, `${at} size`).to.equal(0);
        return;
    }
    expect(node.hasBody, `${at} hasBody`).to.be.undefined;

    let contentType = node.parsedHeader['content-type'];
    let expectedType = model.contentType ? model.contentType.value : 'text/plain';
    expect(contentType.value, `${at} content type`).to.equal(expectedType);

    if (model.kind === 'multipart') {
        expect(node.boundary, `${at} boundary`).to.equal(model.boundary);
        expect(node.body.equals(model.preamble), `${at} preamble ${describeDiff(node.body, model.preamble)}`).to.be.true;
        let children = node.childNodes || [];
        expect(children.length, `${at} child count`).to.equal(model.children.length);
        if (model.unterminated) {
            expect(node.unterminated, `${at} unterminated`).to.equal(true);
            expect(node.epilogue, `${at} epilogue`).to.be.undefined;
        } else {
            expect(node.unterminated, `${at} unterminated`).to.be.undefined;
            if (model.epilogue && model.epilogue.length) {
                expect(node.epilogue.equals(model.epilogue), `${at} epilogue ${describeDiff(node.epilogue || Buffer.alloc(0), model.epilogue)}`).to.be.true;
            } else {
                expect(node.epilogue, `${at} epilogue`).to.be.undefined;
            }
            expect(node.closePad, `${at} closePad`).to.equal(model.closePad || undefined);
        }
        model.children.forEach((child, i) => {
            expect(children[i].pad, `${at} child ${i + 1} pad`).to.equal(child.pad || undefined);
            checkModel(children[i], child, path ? `${path}.${i + 1}` : `${i + 1}`);
        });
        return;
    }

    expect(node.body.equals(model.body), `${at} body ${describeDiff(node.body, model.body)}`).to.be.true;
    expect(node.size, `${at} size`).to.equal(model.body.length);
    expect(node.lineCount, `${at} lineCount`).to.equal(countBreaks(model.body));

    if (model.message) {
        expect(node.message, `${at} embedded message`).to.exist;
        checkModel(node.message, model.message, `${path || '1'}.message`);
    } else {
        expect(node.message, `${at} embedded message`).to.be.undefined;
    }
}

/**
 * Byte offsets where the serialised pieces of a tree meet, the seams a partial fetch has to get right
 */
function pieceOffsets(tree) {
    let offsets = [0];
    let pos = 0;
    for (let piece of walkTree(tree)) {
        pos += piece.size;
        offsets.push(pos);
    }
    return offsets;
}

/**
 * Properties that hold for any tree, whatever the input looked like
 */
async function checkRebuild(indexer, tree, expected, rng, label, expectedSections) {
    // BODY[] is the canonical message, announced and served without correction
    let wire = await wireLiteral(compileStream, runSelector(indexer, tree, BODY));
    expect(wire.mismatches, `${label} BODY[] corrections`).to.deep.equal([]);
    expect(wire.announced, `${label} BODY[] size`).to.equal(expected.length);
    expect(wire.bytes.equals(expected), `${label} BODY[] ${describeDiff(wire.bytes, expected)}`).to.be.true;

    // every section announces what it emits
    let sections = new Map();
    for (let selector of listSelectors(tree)) {
        let result = runSelector(indexer, tree, selector);
        if (!result || result.type !== 'stream') {
            continue;
        }
        let { size, bytes } = await materialize(result);
        expect(bytes.length, `${label} section ${selector.key || 'BODY[]'} size`).to.equal(size);
        sections.set(selector, bytes);
    }
    if (expectedSections) {
        // the same message with its attachments in storage serves the same sections
        for (let [selector, bytes] of sections) {
            let want = expectedSections.get(selector.key);
            expect(want, `${label} section ${selector.key || 'BODY[]'} exists`).to.exist;
            expect(bytes.equals(want), `${label} section ${selector.key || 'BODY[]'} ${describeDiff(bytes, want)}`).to.be.true;
        }
    }

    // windows of BODY[]: at every piece seam, at random, and beyond the end
    let windows = [];
    for (let offset of pieceOffsets(tree)) {
        for (let origin of [offset - 1, offset]) {
            if (origin >= 0) {
                windows.push([origin, rng.pick([1, 2, 3, 7, 50])]);
            }
        }
    }
    for (let i = 0; i < 15; i++) {
        windows.push([rng.int(0, expected.length), rng.int(1, Math.max(1, expected.length))]);
    }
    windows.push([expected.length, 10], [expected.length + 100, 10]);
    for (let [origin, length] of windows) {
        let options = { startFrom: origin, maxLength: length };
        let window = await wireLiteral(compileStream, runSelector(indexer, tree, BODY, options), options);
        let want = expected.subarray(origin, origin + length);
        expect(window.mismatches, `${label} BODY[]<${origin}.${length}> corrections`).to.deep.equal([]);
        expect(window.bytes.equals(want), `${label} BODY[]<${origin}.${length}> ${describeDiff(window.bytes, want)}`).to.be.true;
    }

    // windows of sections
    for (let [selector, bytes] of sections) {
        if (!selector.key || !bytes.length) {
            continue;
        }
        for (let i = 0; i < 3; i++) {
            let origin = rng.int(0, bytes.length);
            let length = rng.int(1, bytes.length);
            let options = { startFrom: origin, maxLength: length };
            let window = await wireLiteral(compileStream, runSelector(indexer, tree, selector, options), options);
            let want = bytes.subarray(origin, origin + length);
            expect(window.mismatches, `${label} ${selector.key}<${origin}.${length}> corrections`).to.deep.equal([]);
            expect(window.bytes.equals(want), `${label} ${selector.key}<${origin}.${length}> ${describeDiff(window.bytes, want)}`).to.be.true;
        }
    }

    return new Map([...sections].map(([selector, bytes]) => [selector.key, bytes]));
}

/**
 * BODYSTRUCTURE, BODY and ENVELOPE compile to responses the IMAP parser reads back, with and without
 * UTF8=ACCEPT
 */
function checkMetadata(indexer, tree, label) {
    for (let acceptUTF8Enabled of [false, true]) {
        let values = imapTools.getQueryResponse(
            [{ item: 'bodystructure' }, { item: 'body' }, { item: 'envelope' }],
            { mimeTree: tree, bodystructure: indexer.getBodyStructure(tree), envelope: indexer.getEnvelope(tree) },
            { acceptUTF8Enabled }
        );
        let response = imapHandler.compiler({
            tag: '*',
            command: '1 FETCH',
            attributes: [[{ type: 'ATOM', value: 'BODYSTRUCTURE' }, values[0], { type: 'ATOM', value: 'BODY' }, values[1], { type: 'ATOM', value: 'ENVELOPE' }, values[2]]]
        });
        expect(() => imapHandler.parser(response), `${label} response grammar (utf8=${acceptUTF8Enabled})`).to.not.throw();
        if (!acceptUTF8Enabled) {
            // RFC 6855 3: nothing above 0x7F unless the client enabled it
            expect(/[^\u0000-\u007f]/.test(response), `${label} 8-bit bytes in response without UTF8=ACCEPT`).to.be.false; // eslint-disable-line no-control-regex
        }
    }
}

async function checkMessage(source, expected, model, rng, label) {
    let indexer = new Indexer();
    let tree;
    expect(() => {
        tree = indexer.parseMimeTree(source);
    }, `${label} parse`).to.not.throw();
    expect(tree.v, `${label} tree version`).to.equal(2);

    if (model) {
        checkModel(tree, model, '');
    }

    checkMetadata(indexer, tree, label);
    let sections = await checkRebuild(indexer, tree, expected, rng, label);

    // the same with attachment bodies in a chunking storage
    let chunkSize = rng.pick([1, 3, 57, 100, 1000, 255 * 1024]);
    let storage = new MemoryAttachmentStorage({ chunkSize });
    let stored = new Indexer({ attachmentStorage: storage });
    let storedTree = stored.parseMimeTree(source);
    await store(stored, storedTree);
    await checkRebuild(stored, storedTree, expected, rng, `${label} stored (chunk ${chunkSize})`, sections);
}

describe('Indexer fuzz', function () {
    this.timeout(600000);

    describe('generated structures', function () {
        for (let i = 0; i < ITERATIONS; i++) {
            let seed = SEED + i;
            it(`seed ${seed}`, async function () {
                let { source, expected, model } = generateMessage(seed);
                expect(canonical(source).equals(expected), `seed ${seed}: generator expectation ${describeDiff(canonical(source), expected)}`).to.be.true;
                await checkMessage(source, expected, model, new Rng(seed), `seed ${seed}`);
            });
        }
    });

    describe('mutated messages', function () {
        for (let i = 0; i < ITERATIONS; i++) {
            let seed = SEED + i;
            it(`seed ${seed}`, async function () {
                let rng = new Rng(seed * 7919);
                let source = mutate(rng, generateMessage(seed).source);
                await checkMessage(source, canonical(source), null, rng, `mutated seed ${seed}`);
            });
        }
    });
});
