/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const { normalizeDomain, aspExpired } = require('../lib/tools');

const expect = chai.expect;
chai.config.includeStack = true;

describe('#normalizeDomain', function () {
    it('should decode a Punycode label that is not at the beginning of a domain', function () {
        expect(normalizeDomain('  Mail.XN--BCHER-KVA.Example  ')).to.equal('mail.bücher.example');
    });
});

describe('#aspExpired', function () {
    it('treats an ASP as expired from the moment of its expiry, and one without expiry as valid', function () {
        const now = Date.now();
        expect(aspExpired({ expires: new Date(now) }, now)).to.be.true;
        expect(aspExpired({ expires: new Date(now - 1) }, now)).to.be.true;
        expect(aspExpired({ expires: new Date(now + 1) }, now)).to.be.false;
        expect(aspExpired({ expires: new Date(now - 1).toISOString() }, now)).to.be.true;
        expect(aspExpired({}, now)).to.be.false;
        expect(aspExpired(null, now)).to.be.false;
    });
});
