/* eslint-disable global-require */
/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const expect = chai.expect;

const fs = require('fs');
const Indexer = require('../lib/indexer/indexer');
const { normalize, ensureFinalCrlf, treeReviver } = require('./fixtures/indexer-cases');
const indexer = new Indexer();

chai.config.includeStack = true;

// parsed trees captured with the current parser (regenerate with fixtures/tree-fixtures.generate.js)
const fixtures = {
    simple: {
        eml: fs.readFileSync(__dirname + '/fixtures/simple.eml'),
        tree: JSON.parse(fs.readFileSync(__dirname + '/fixtures/simple.json', 'utf8'), treeReviver)
    },
    mimetorture: {
        eml: fs.readFileSync(__dirname + '/fixtures/mimetorture.eml'),
        tree: JSON.parse(fs.readFileSync(__dirname + '/fixtures/mimetorture.json', 'utf8'), treeReviver)
    }
};

describe('#parseMimeTree', function () {
    it('should parse a simple mime message into the expected tree', function () {
        let parsed = indexer.parseMimeTree(fixtures.simple.eml);
        expect(parsed).to.deep.equal(fixtures.simple.tree);
    });

    it('should parse the MIME torture message into the expected tree', function () {
        let parsed = indexer.parseMimeTree(fixtures.mimetorture.eml);
        expect(parsed).to.deep.equal(fixtures.mimetorture.tree);
    });

    it('should rebuild the MIME torture message byte for byte', function (done) {
        let parsed = indexer.parseMimeTree(fixtures.mimetorture.eml);

        indexer.bodyQuery(parsed, '', (err, data) => {
            expect(err).to.not.exist;
            // the fixture has LF line endings, which the parser normalises
            expect(data.equals(ensureFinalCrlf(normalize(fixtures.mimetorture.eml)))).to.be.true;
            done();
        });
    });

    it('should not mutate subject header order when generating envelope', function () {
        let parsed = indexer.parseMimeTree(
            ['From: sender@example.com', 'Subject: Original subject', 'Subject: Override subject', '', 'Hello world', ''].join('\r\n')
        );

        expect(parsed.parsedHeader.subject).to.deep.equal(['Original subject', 'Override subject']);
        expect(indexer.getEnvelope(parsed)[1].toString()).to.equal('Override subject');
        expect(parsed.parsedHeader.subject).to.deep.equal(['Original subject', 'Override subject']);
        expect(indexer.getEnvelope(parsed)[1].toString()).to.equal('Override subject');
    });
});
