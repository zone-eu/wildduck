/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

const acl = require('../lib/acl');

describe('ACL rights helpers', function () {
    describe('#validateRightsUpdate', function () {
        it('should accept valid rights strings', function () {
            expect(acl.validateRightsUpdate('lrswipkxtea')).to.be.true;
            expect(acl.validateRightsUpdate('+lr')).to.be.true;
            expect(acl.validateRightsUpdate('-te')).to.be.true;
            expect(acl.validateRightsUpdate('cd')).to.be.true;
            expect(acl.validateRightsUpdate('')).to.be.true;
            expect(acl.validateRightsUpdate('LRS')).to.be.true;
        });

        it('should reject invalid rights strings', function () {
            expect(acl.validateRightsUpdate('lrq')).to.be.false;
            expect(acl.validateRightsUpdate('l r')).to.be.false;
            expect(acl.validateRightsUpdate('lr9')).to.be.false;
            expect(acl.validateRightsUpdate('+-lr')).to.be.false;
        });
    });

    describe('#normalizeRights', function () {
        it('should keep canonical order and remove duplicates', function () {
            expect(acl.normalizeRights('aetxkpiwsrl')).to.equal('lrswipkxtea');
            expect(acl.normalizeRights('llrr')).to.equal('lr');
            expect(acl.normalizeRights('')).to.equal('');
        });

        it('should map obsolete RFC 2086 rights', function () {
            expect(acl.normalizeRights('c')).to.equal('kx');
            expect(acl.normalizeRights('d')).to.equal('te');
            expect(acl.normalizeRights('lrcd')).to.equal('lrkxte');
        });

        it('should lowercase and drop unknown rights', function () {
            expect(acl.normalizeRights('LRS')).to.equal('lrs');
            expect(acl.normalizeRights('lr9q')).to.equal('lr');
        });
    });

    describe('#applyRights', function () {
        it('should replace rights without a modifier', function () {
            expect(acl.applyRights('lrs', 'wi')).to.equal('wi');
            expect(acl.applyRights('', 'lrs')).to.equal('lrs');
            expect(acl.applyRights('lrs', '')).to.equal('');
        });

        it('should add rights with the + modifier', function () {
            expect(acl.applyRights('lr', '+sw')).to.equal('lrsw');
            expect(acl.applyRights('lr', '+r')).to.equal('lr');
            expect(acl.applyRights('', '+lr')).to.equal('lr');
        });

        it('should remove rights with the - modifier', function () {
            expect(acl.applyRights('lrsw', '-r')).to.equal('lsw');
            expect(acl.applyRights('lrsw', '-xa')).to.equal('lrsw');
            expect(acl.applyRights('lr', '-lr')).to.equal('');
        });

        it('should normalize obsolete rights in updates', function () {
            expect(acl.applyRights('', 'cd')).to.equal('kxte');
            expect(acl.applyRights('lkte', '-d')).to.equal('lk');
        });
    });

    describe('#formatResponseRights', function () {
        it('should append the virtual rights when member rights are present', function () {
            expect(acl.formatResponseRights('lrswipkxtea')).to.equal('lrswipkxteacd');
            expect(acl.formatResponseRights('k')).to.equal('kc');
            expect(acl.formatResponseRights('x')).to.equal('xc');
            expect(acl.formatResponseRights('te')).to.equal('ted');
            expect(acl.formatResponseRights('lrskx')).to.equal('lrskxc');
        });

        it('should not append virtual rights without member rights', function () {
            expect(acl.formatResponseRights('lrs')).to.equal('lrs');
            expect(acl.formatResponseRights('')).to.equal('');
        });
    });
});
