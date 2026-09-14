/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const { normalizeDomain } = require('../lib/tools');

const expect = chai.expect;
chai.config.includeStack = true;

describe('#normalizeDomain', function () {
    it('should decode a Punycode label that is not at the beginning of a domain', function () {
        expect(normalizeDomain('  Mail.XN--BCHER-KVA.Example  ')).to.equal('mail.bücher.example');
    });
});
