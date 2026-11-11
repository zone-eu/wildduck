'use strict';

const { expect } = require('chai');
const { MethodRegistry } = require('../../../lib/jmap/request');
const { URN } = require('../../../lib/jmap/capabilities');
const types = require('../../../lib/jmap/types');

describe('JMAP method registry', () => {
    const module = (capability, accountCapability) => Object.assign({ capability, methods: {} }, accountCapability ? { accountCapability } : {});

    it('takes the account capability object from the module that declares it, wherever it is listed', () => {
        const declared = () => ({ maxDelayedSend: 0 });
        for (const modules of [
            [module(URN.submission), module(URN.submission, declared)],
            [module(URN.submission, declared), module(URN.submission)]
        ]) {
            expect(new MethodRegistry(modules).accountCapabilities({})).to.deep.equal({ [URN.submission]: { maxDelayedSend: 0 } });
        }
        expect(new MethodRegistry([module(URN.mail)]).accountCapabilities({})).to.deep.equal({ [URN.mail]: {} });
    });

    it('refuses two modules declaring the account capability object of one capability', () => {
        expect(() => new MethodRegistry([module(URN.submission, () => ({})), module(URN.submission, () => ({}))])).to.throw(/Two modules declare/);
    });

    it('accepts the modules of the server', () => {
        expect(() => new MethodRegistry(types.modules)).to.not.throw();
    });
});
