/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Attachments live outside the tree, so the bytes a message rebuilds to depend on the attachment
// storage: whether a base64 body was stored decoded, and how its re-encoded form is served. This suite
// stores every scenario through getMaildata() and storeNodeBodies() into an in-memory storage that
// shares the GridFS driver's codec, then requires byte-exact rebuilds, consistent sizes and exact
// partial windows, with the stored bytes delivered in different chunk sizes (the base64 encoder's
// output depends on chunk boundaries) and with the metadata shape of attachments stored before the
// proof-based acceptance rule existed.

const chai = require('chai');
const expect = chai.expect;
const Indexer = require('../lib/indexer/indexer');
const compileStream = require('../lib/handler/imap-compile-stream');
const MemoryAttachmentStorage = require('./fixtures/memory-attachment-storage');
const { scenarios, SEAMS } = require('./fixtures/attachment-scenarios');
const { listSelectors, runSelector, materialize, wireLiteral } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const BODY = { path: '', type: '' };

const CONFIGS = [
    { name: 'proof-based storage, 57 byte chunks', legacyDecoding: false, chunkSize: 57, all: true },
    { name: 'proof-based storage, 100 byte chunks', legacyDecoding: false, chunkSize: 100, all: false },
    { name: 'proof-based storage, GridFS sized chunks', legacyDecoding: false, chunkSize: 255 * 1024, all: false },
    { name: 'legacy metadata, 57 byte chunks', legacyDecoding: true, chunkSize: 57, all: true }
];

function describeDiff(actual, expected) {
    let i = 0;
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) {
        i++;
    }
    let show = buf => JSON.stringify(buf.subarray(Math.max(0, i - 24), i + 24).toString('binary'));
    return `first difference at ${i} (lengths ${actual.length} vs ${expected.length}): got ${show(actual)} want ${show(expected)}`;
}

function store(indexer, source) {
    let tree = indexer.parseMimeTree(source);
    let maildata = indexer.getMaildata(tree);
    return new Promise((resolve, reject) => {
        indexer.storeNodeBodies(maildata, tree, err => (err ? reject(err) : resolve(tree)));
    });
}

describe('Indexer attachments', function () {
    this.timeout(120000);

    for (let config of CONFIGS) {
        describe(config.name, function () {
            for (let scenario of scenarios) {
                if (!config.all && !SEAMS.has(scenario.name)) {
                    continue;
                }

                describe(scenario.name, function () {
                    let storage;
                    let indexer;
                    let tree;

                    before(async function () {
                        storage = new MemoryAttachmentStorage({ chunkSize: config.chunkSize, legacyDecoding: config.legacyDecoding });
                        indexer = new Indexer({ attachmentStorage: storage });
                        tree = await store(indexer, scenario.source);
                    });

                    if (!config.legacyDecoding && scenario.decoded !== undefined) {
                        it('stores the attachment the expected way', async function () {
                            let ids = Object.values(tree.attachmentMap || {});
                            expect(ids.length).to.be.at.least(1);
                            let data = await storage.get(ids[0]);
                            expect(!!data.metadata.decoded).to.equal(scenario.decoded);
                            if (scenario.decoded) {
                                expect(data.metadata.lineLen).to.equal(scenario.lineLen);
                                expect(data.length).to.equal(scenario.decodedLength);
                            }
                        });
                    }

                    it('rebuilds BODY[] to the delivered bytes without length corrections', async function () {
                        let wire = await wireLiteral(compileStream, runSelector(indexer, tree, BODY));
                        expect(wire.mismatches).to.deep.equal([]);
                        expect(wire.announced).to.equal(scenario.source.length);
                        expect(wire.bytes.equals(scenario.source), describeDiff(wire.bytes, scenario.source)).to.be.true;
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

                    it('serves every partial window of BODY[]', async function () {
                        let seam = SEAMS.has(scenario.name);
                        // every offset at the seams, a prime step elsewhere that grows with the message
                        let step = seam ? 1 : Math.max(13, Math.floor(scenario.source.length / 300) + 1 - (Math.floor(scenario.source.length / 300) % 2));
                        // lengths of every residue modulo 4, so windows end at every position of a base64 group
                        let lengths = seam ? [1, 4, 7, 16, 50] : [7, 16, 50];
                        let expected = scenario.source;
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
    }

    describe('missing attachment', function () {
        it('keeps the message size and fills the body with line breaks', async function () {
            let storage = new MemoryAttachmentStorage();
            let indexer = new Indexer({ attachmentStorage: storage });
            let scenario = scenarios.find(s => s.name === 'base64 300 bytes, 76 columns, 1 trailing blank lines');
            let tree = await store(indexer, scenario.source);
            storage.files.clear();

            let wire = await wireLiteral(compileStream, runSelector(indexer, tree, BODY));
            expect(wire.mismatches).to.deep.equal([]);
            expect(wire.bytes.length).to.equal(scenario.source.length);
            // headers and the text part are intact, the attachment body is blank lines
            let bodyStart = scenario.source.indexOf('base64\r\n\r\n') + 'base64\r\n\r\n'.length;
            expect(wire.bytes.subarray(0, bodyStart).equals(scenario.source.subarray(0, bodyStart))).to.be.true;
            expect(/^(\r\n)+$/.test(wire.bytes.subarray(bodyStart, scenario.source.indexOf('\r\n--b--')).toString('binary'))).to.be.true;
        });
    });
});
