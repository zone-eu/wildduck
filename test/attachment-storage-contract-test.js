/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Contract test for the real GridFS attachment storage: the scenarios that the in-memory storage double
// in imap-core/test must also hold when the bytes live in MongoDB, so the double can not drift from the
// driver that production uses.

const chai = require('chai');
const expect = chai.expect;
const db = require('../lib/db');
const AttachmentStorage = require('../lib/attachment-storage');
const Indexer = require('../imap-core/lib/indexer/indexer');
const compileStream = require('../imap-core/lib/handler/imap-compile-stream');
const { scenarios, SEAMS } = require('../imap-core/test/fixtures/attachment-scenarios');
const { listSelectors, runSelector, materialize, wireLiteral } = require('../imap-core/test/fixtures/indexer-cases');

chai.config.includeStack = true;

const BODY = { path: '', type: '' };

const SELECTED = new Set([
    ...SEAMS,
    'base64 300 bytes, 76 columns, 1 trailing blank lines',
    'base64 1140 bytes, 72 columns, 2 trailing blank lines',
    'unpadded base64 1000 bytes',
    'base64 single short line',
    'base64 wrapped at an unusual line length',
    'base64 with uneven wrapping',
    'quoted-printable attachment'
]);

function store(indexer, source) {
    let tree = indexer.parseMimeTree(source);
    let maildata = indexer.getMaildata(tree);
    return new Promise((resolve, reject) => {
        indexer.storeNodeBodies(maildata, tree, err => (err ? reject(err) : resolve(tree)));
    });
}

describe('GridFS attachment storage contract', function () {
    this.timeout(120000);

    let storage;
    let indexer;

    before(async function () {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
        storage = new AttachmentStorage({
            gridfs: db.gridfs,
            options: { type: 'gridstore', bucket: 'attachments', decodeBase64: true },
            redis: db.redis
        });
        indexer = new Indexer({ attachmentStorage: storage });
    });

    for (let scenario of scenarios) {
        if (!SELECTED.has(scenario.name)) {
            continue;
        }

        describe(scenario.name, function () {
            let tree;

            before(async function () {
                tree = await store(indexer, scenario.source);
            });

            if (scenario.decoded !== undefined) {
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
                expect(wire.bytes.equals(scenario.source)).to.be.true;
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
                let expected = scenario.source;
                for (let origin = 0; origin < expected.length; origin += 7) {
                    for (let length of [7, 50]) {
                        let options = { startFrom: origin, maxLength: length };
                        let wire = await wireLiteral(compileStream, runSelector(indexer, tree, BODY, options), options);
                        expect(wire.mismatches, `<${origin}.${length}>`).to.deep.equal([]);
                        expect(wire.bytes.equals(expected.subarray(origin, origin + length)), `<${origin}.${length}>`).to.be.true;
                    }
                }
            });
        });
    }
});
