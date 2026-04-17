/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const imapTools = require('../lib/imap-tools');
const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

describe('#packMessageRange', function() {
    it('should return as is', function() {
        expect(imapTools.packMessageRange([1, 3, 5, 9])).to.equal('1,3,5,9');
    });

    it('should return a range', function() {
        expect(imapTools.packMessageRange([1, 2, 3, 4])).to.equal('1:4');
    });

    it('should return mixed ranges', function() {
        expect(imapTools.packMessageRange([1, 3, 4, 6, 8, 9, 10, 11, 13])).to.equal('1,3:4,6,8:11,13');
    });
});

describe('#filterFolders', function() {
    it('should not throw for wildcard queries containing braces', function() {
        expect(function() {
            imapTools.filterFolders([{ path: 'test' }], '%{2}');
        }).to.not.throw();
    });

    it('should treat braces in wildcard queries as literal characters', function() {
        expect(
            imapTools.filterFolders([{ path: 'test' }, { path: 'test{2}' }, { path: 'other{2}' }], '%{2}').map(folder => folder.path)
        ).to.deep.equal(['test{2}', 'other{2}']);
    });
});
