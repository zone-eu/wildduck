/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
'use strict';

// Properties of the current parser and rebuilder over the whole corpus (fixtures, synthetic layouts,
// generated and mutated messages, garbage, and MIME_CORPUS_DIR when set):
//
//   - every section announces exactly what it emits and BODY[] is the canonical form of the input;
//   - parsing is stable: the rebuilt message parses into the same tree (a metamorphic check that needs
//     no model of the input, so it holds for real and for broken mail alike);
//   - the tree as MongoDB returns it (BSON, bodies as Binary) renders the same;
//   - moving the attachment bodies to the storage does not change any section;
//   - BODYSTRUCTURE, BODY and ENVELOPE compile to responses the IMAP parser reads back.

const chai = require('chai');
const expect = chai.expect;
const { BSON } = require('mongodb');
const Indexer = require('../lib/indexer/indexer');
const imapHandler = require('../lib/handler/imap-handler');
const imapTools = require('../lib/imap-tools');
const MemoryAttachmentStorage = require('./fixtures/memory-attachment-storage');
const { loadCorpus } = require('./fixtures/indexer-corpus');
const { canonical } = require('./fixtures/mime-fuzz');
const { listSelectors, runSelector, materialize, treeReplacer } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const corpus = loadCorpus();

function describeDiff(actual, expected) {
    let i = 0;
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) {
        i++;
    }
    let show = buf => JSON.stringify(buf.subarray(Math.max(0, i - 30), i + 30).toString('latin1'));
    return `first difference at ${i} (lengths ${actual.length} vs ${expected.length}): got ${show(actual)} want ${show(expected)}`;
}

const serialize = tree => JSON.stringify(tree, treeReplacer);

async function sections(indexer, tree) {
    let result = new Map();
    for (let selector of listSelectors(tree)) {
        let stream = runSelector(indexer, tree, selector);
        if (stream && stream.type === 'stream') {
            result.set(selector.key, await materialize(stream));
        }
    }
    return result;
}

describe('Indexer corpus', function () {
    this.timeout(30 * 60 * 1000);

    for (let { name, source } of corpus) {
        it(name, async function () {
            let indexer = new Indexer();
            let tree = indexer.parseMimeTree(source);
            let expected = canonical(source);

            let plain = await sections(indexer, tree);
            for (let [key, { size, bytes }] of plain) {
                expect(bytes.length, `section ${key || 'BODY[]'} size`).to.equal(size);
            }
            let body = plain.get('').bytes;
            expect(body.equals(expected), `BODY[] ${describeDiff(body, expected)}`).to.be.true;

            // parsing is stable: the rebuilt message is its own canonical form and parses the same
            let again = indexer.parseMimeTree(body);
            expect(serialize(again), 'reparsed tree').to.equal(serialize(tree));

            // the tree as the database returns it
            let fromDb = BSON.deserialize(BSON.serialize({ tree })).tree;
            let dbSections = await sections(indexer, fromDb);
            expect([...dbSections.keys()]).to.deep.equal([...plain.keys()]);
            for (let [key, { size, bytes }] of dbSections) {
                expect(size, `section ${key || 'BODY[]'} size from database`).to.equal(plain.get(key).size);
                expect(bytes.equals(plain.get(key).bytes), `section ${key || 'BODY[]'} from database`).to.be.true;
            }

            // attachment bodies in the storage, decoded where possible, delivered in odd chunks
            let stored = new Indexer({ attachmentStorage: new MemoryAttachmentStorage({ chunkSize: 61 }) });
            let storedTree = stored.parseMimeTree(source);
            let maildata = stored.getMaildata(storedTree);
            await new Promise((resolve, reject) => stored.storeNodeBodies(maildata, storedTree, err => (err ? reject(err) : resolve())));
            let storedDb = BSON.deserialize(BSON.serialize({ tree: storedTree })).tree;
            for (let [key, { bytes }] of await sections(stored, storedDb)) {
                expect(bytes.equals(plain.get(key).bytes), `section ${key || 'BODY[]'} with stored attachments ${describeDiff(bytes, plain.get(key).bytes)}`).to.be.true;
            }

            // metadata responses are well formed
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
                expect(() => imapHandler.parser(response), 'response grammar').to.not.throw();
            }
        });
    }
});
