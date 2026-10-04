/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals after: false */
'use strict';

// Differential test between the current rebuilder and the previous one, on v1 trees.
//
// Mail stores hold trees written by the previous parser, including the broken trees it wrote for
// broken mail. Their stored size and the user quota were computed by the previous getSize(), and
// clients received what the previous rebuild() produced, cut or padded to that size by the IMAP
// literal path. This suite parses every corpus message with the frozen previous parser
// (fixtures/legacy-v1) and requires, for every section the previous code could serve:
//
//   1. the current code announces the same size;
//   2. where the previous rebuild emitted exactly what it announced, the current bytes are identical;
//   3. otherwise the current bytes are what IMAP clients received (the previous rebuild cut or padded
//      to its size), or the previous rebuild with only its uncounted line breaks removed;
//   4. all of the above holds for the tree as MongoDB returns it (BSON, bodies as Binary), and with the
//      attachment bodies moved to the attachment storage;
//   5. any window of a section is the matching slice of the full section, and equals the previous
//      windowed rebuild where that one was consistent;
//   6. getMaildata() (search text, preview html, attachment list, extracted bodies) gives the same
//      result as the previous one on the same tree, and leaves the tree in the same state.

const chai = require('chai');
const expect = chai.expect;
const { BSON } = require('mongodb');
const Indexer = require('../lib/indexer/indexer');
const LegacyIndexer = require('./fixtures/legacy-v1/indexer');
const MemoryAttachmentStorage = require('./fixtures/memory-attachment-storage');
const { loadCorpus } = require('./fixtures/indexer-corpus');
const { Rng } = require('./fixtures/mime-fuzz');
const { listSelectors, materialize, treeReplacer, treeReviver } = require('./fixtures/indexer-cases');

chai.config.includeStack = true;

const corpus = loadCorpus();
const stats = { messages: 0, sections: 0, consistent: 0, wireEqual: 0, breaksRemoved: 0, renumbered: 0, attachmentMissedBefore: 0 };

const clone = tree => JSON.parse(JSON.stringify(tree, treeReplacer), treeReviver);
// the tree as the database returns it: BSON encoded and decoded, bodies come back as Binary
const fromDatabase = tree => BSON.deserialize(BSON.serialize({ tree })).tree;

function describeDiff(actual, expected) {
    let i = 0;
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) {
        i++;
    }
    let show = buf => JSON.stringify(buf.subarray(Math.max(0, i - 30), i + 30).toString('latin1'));
    return `first difference at ${i} (lengths ${actual.length} vs ${expected.length}): got ${show(actual)} want ${show(expected)}`;
}

/**
 * What an IMAP client received for a stream that announced `size` bytes: cut, or padded with spaces
 */
function wire(bytes, size) {
    return bytes.length >= size ? bytes.subarray(0, size) : Buffer.concat([bytes, Buffer.alloc(size - bytes.length, ' ')]);
}

/**
 * True when `shorter` is `longer` with nothing but complete CRLF pairs removed
 */
function isCrlfDeletion(longer, shorter) {
    let i = 0;
    let j = 0;
    while (i < longer.length) {
        if (j < shorter.length && longer[i] === shorter[j]) {
            i++;
            j++;
        } else if (longer[i] === 0x0d && longer[i + 1] === 0x0a) {
            i += 2;
        } else {
            return false;
        }
    }
    return j === shorter.length;
}

function selectorOf(key) {
    if (key === '') {
        return false;
    }
    if (key === 'text') {
        return { type: 'text' };
    }
    if (key.endsWith('.text')) {
        return { path: key.slice(0, -5), type: 'text' };
    }
    return { path: key, type: '' };
}

/**
 * Every stream section either implementation serves for a tree, as selector keys. The previous
 * implementation numbered parts differently in two documented cases (a top-level message/rfc822
 * message, a multipart without parts), so both numberings are enumerated
 */
function sectionKeys(tree) {
    let keys = new Set(listSelectors(tree).map(selector => selector.key));
    let walk = (node, prefix) => {
        let children = (node.message && node.message.childNodes) || node.childNodes || [];
        children.forEach((child, i) => {
            let key = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
            keys.add(key);
            if (child.message) {
                keys.add(key + '.text');
            }
            walk(child, key);
        });
    };
    walk(tree, '');
    keys.add('1');
    return [...keys];
}

async function render(indexer, tree, key, options) {
    let result = indexer.getContents(tree, selectorOf(key), options);
    if (!result || result.type !== 'stream') {
        return null;
    }
    return materialize(result);
}

/**
 * The node a section key selects, as a path of indexes from the root, so selections made by the two
 * implementations on different copies of the tree can be compared
 */
function nodePath(indexer, tree, key) {
    let selector = selectorOf(key);
    let node = selector && selector.path ? indexer.resolveContentNode(tree, selector.path) : tree;
    if (!node) {
        return null;
    }
    if (selector && selector.type === 'text') {
        node = selector.path ? node.message : node;
        if (!node) {
            return null;
        }
    }
    let find = (current, trail) => {
        if (current === node) {
            return trail;
        }
        for (let [i, child] of (current.childNodes || []).entries()) {
            let found = find(child, trail + '/' + i);
            if (found) {
                return found;
            }
        }
        return current.message ? find(current.message, trail + '/m') : null;
    };
    return find(tree, '') || 'outside';
}

/**
 * The previous implementation numbered parts differently in two documented cases: everything under a
 * top-level message/rfc822 message was shifted by one level (its own BODYSTRUCTURE numbered them the
 * other way), and a non-multipart message inside a message/rfc822 part had no part 1
 */
function numberingChangeExplained(tree, key) {
    if (tree.message) {
        return true;
    }
    let path = key.replace(/\.text$/, '').split('.');
    let node = tree;
    for (let number of path) {
        if (node.message) {
            // a part number below a message/rfc822 part
            return !node.message.childNodes || number === '1';
        }
        node = (node.childNodes || [])[Number(number) - 1];
        if (!node) {
            return false;
        }
    }
    return false;
}

async function compareTree(label, tree, legacy, current, rng, unstored) {
    stats.messages++;
    let legacyTree = clone(tree);
    let currentTree = clone(tree);
    let storedTree = fromDatabase(tree);

    let sections = new Map();
    for (let key of sectionKeys(tree)) {
        let at = `${label} section ${key || 'BODY[]'}`;

        if (nodePath(legacy, tree, key) !== nodePath(current, tree, key)) {
            stats.renumbered++;
            expect(numberingChangeExplained(tree, key), `${at}: the implementations select different parts`).to.be.true;
            continue;
        }

        legacy.misses = 0;
        let old = await render(legacy, legacyTree, key);
        let now = await render(current, currentTree, key);
        let fromDb = await render(current, storedTree, key);

        expect(!!now, `${at}: served by only one implementation`).to.equal(!!old);
        if (!old) {
            continue;
        }
        stats.sections++;

        if (unstored) {
            // attachments in the storage are invisible in the output
            let plain = unstored.get(key);
            expect(now.bytes.equals(plain.bytes), `${at} against the message without stored attachments ${describeDiff(now.bytes, plain.bytes)}`).to.be.true;
        }

        // 1. same announced size
        expect(now.size, `${at} size`).to.equal(old.size);
        // the current code is self-consistent
        expect(now.bytes.length, `${at} emitted length`).to.equal(now.size);
        // 4. the database form renders the same
        expect(fromDb.size, `${at} size from database`).to.equal(now.size);
        expect(fromDb.bytes.equals(now.bytes), `${at} bytes from database ${describeDiff(fromDb.bytes, now.bytes)}`).to.be.true;

        if (legacy.misses) {
            // the previous code looked an attachment up by the wrong id and served line breaks or
            // nothing in its place; the current output was checked against the plain message above
            stats.attachmentMissedBefore++;
        } else if (old.bytes.length === old.size) {
            // 2. consistent previous output is reproduced byte for byte
            stats.consistent++;
            expect(now.bytes.equals(old.bytes), `${at} ${describeDiff(now.bytes, old.bytes)}`).to.be.true;
        } else if (now.bytes.equals(wire(old.bytes, old.size))) {
            // 3a. what IMAP clients received
            stats.wireEqual++;
        } else {
            // 3b. the previous rebuild without its uncounted line breaks
            expect(isCrlfDeletion(old.bytes, now.bytes), `${at}: neither the client view nor a line break correction of the previous output`).to.be.true;
            stats.breaksRemoved++;
        }

        // 5. windows of the section
        for (let i = 0; i < 4 && now.size; i++) {
            let startFrom = rng.int(0, now.size);
            let maxLength = rng.int(1, now.size);
            let windowed = await render(current, currentTree, key, { startFrom, maxLength });
            let want = now.bytes.subarray(startFrom, startFrom + maxLength);
            expect(windowed.bytes.equals(want), `${at} <${startFrom}.${maxLength}> ${describeDiff(windowed.bytes, want)}`).to.be.true;
            if (old.bytes.length === old.size && !legacy.misses) {
                let oldWindow = await render(legacy, legacyTree, key, { startFrom, maxLength });
                expect(windowed.bytes.equals(oldWindow.bytes), `${at} <${startFrom}.${maxLength}> against the previous window`).to.be.true;
            }
        }
        sections.set(key, now);
    }
    return sections;
}

/**
 * getMaildata() output without the parts that are random by design
 */
function normalizeMaildata(maildata) {
    return {
        text: maildata.text,
        html: maildata.html,
        attachments: maildata.attachments.map(attachment =>
            Object.assign({}, attachment, { filename: /^[0-9a-f]{8}\./.test(attachment.filename) ? 'random.' + attachment.filename.split('.').pop() : attachment.filename })
        ),
        nodes: maildata.nodes.map(node => ({
            attachmentId: node.attachmentId,
            contentType: node.contentType,
            transferEncoding: node.transferEncoding,
            lineCount: node.lineCount,
            body: node.body.toString('base64')
        }))
    };
}

describe('Indexer legacy differential', function () {
    this.timeout(30 * 60 * 1000);

    after(function () {
        // eslint-disable-next-line no-console
        console.log('      legacy differential:', JSON.stringify(stats));
    });

    for (let { name, source } of corpus) {
        it(name, async function () {
            let rng = new Rng(source.length + 17);
            let legacy = new LegacyIndexer();
            let current = new Indexer();

            let tree = legacy.parseMimeTree(source);
            expect(tree.v, 'v1 tree').to.be.undefined;

            // 6. the same extraction from the same tree
            let legacyMaildataTree = clone(tree);
            let currentMaildataTree = clone(tree);
            let oldMaildata = normalizeMaildata(legacy.getMaildata(legacyMaildataTree));
            let newMaildata = normalizeMaildata(current.getMaildata(currentMaildataTree));
            expect(newMaildata).to.deep.equal(oldMaildata);
            expect(JSON.stringify(currentMaildataTree, treeReplacer)).to.equal(JSON.stringify(legacyMaildataTree, treeReplacer));

            let plain = await compareTree(name, tree, legacy, current, rng);

            // the same tree with its attachment bodies in the storage, stored as the previous code did
            let storage = new MemoryAttachmentStorage({ decodeBase64: false, chunkSize: rng.pick([1, 57, 1000, 255 * 1024]) });
            let legacyStore = new LegacyIndexer({ attachmentStorage: storage });
            // count lookups that miss, which the previous code turned into empty attachments
            legacyStore.getAttachment = async id => {
                try {
                    return await storage.get(id);
                } catch (err) {
                    legacyStore.misses++;
                    throw err;
                }
            };
            let stored = legacyStore.parseMimeTree(source);
            let maildata = legacyStore.getMaildata(stored);
            await new Promise((resolve, reject) => legacyStore.storeNodeBodies(maildata, stored, err => (err ? reject(err) : resolve())));
            if (maildata.nodes.length) {
                await compareTree(name + ' (stored)', stored, legacyStore, new Indexer({ attachmentStorage: storage }), rng, plain);
            }
        });
    }
});
