'use strict';

const { expect } = require('chai');
const responseBudget = require('../../../lib/jmap/response-budget');
const { uniqueIds } = require('../../../lib/jmap/types/common');
const { MethodRegistry, processRequest } = require('../../../lib/jmap/request');
const { URN } = require('../../../lib/jmap/capabilities');

const contextOf = (limits = {}) => ({ limits: Object.assign({ maxCallsInRequest: 32 }, limits), advertised: new Set([URN.core]), cache: {} });

describe('JMAP response budget (NV-15)', () => {
    it('draws until the budget is used and refuses what does not fit, without drawing it', () => {
        const context = contextOf({ maxResponseBytes: 1000 });
        responseBudget.draw(context, 600);
        expect(responseBudget.remaining(context)).to.equal(400);
        expect(() => responseBudget.draw(context, 401))
            .to.throw()
            .with.property('type', 'requestTooLarge');
        expect(responseBudget.remaining(context)).to.equal(400);
        responseBudget.spend(context, 1000);
        expect(responseBudget.remaining(context)).to.equal(0);
    });

    it('defaults to 64 MB', () => {
        expect(responseBudget.remaining(contextOf())).to.equal(64 * 1024 * 1024);
    });

    it('answers the call that crosses the budget with requestTooLarge, other calls run', async () => {
        const registry = new MethodRegistry([
            {
                capability: URN.core,
                methods: {
                    'Big/get': async args => ({ list: new Array(args.count).fill({}), notFound: [] }),
                    'Core/echo': async args => args
                }
            }
        ]);
        const body = {
            using: [URN.core],
            methodCalls: [
                ['Big/get', { count: 3 }, 'a'],
                ['Big/get', { count: 2 }, 'b'],
                ['Core/echo', {}, 'c'],
                ['Big/get', { count: 1 }, 'd']
            ]
        };
        const response = await processRequest(body, registry, contextOf({ maxResponseBytes: 4 * responseBudget.OBJECT_BYTES }));
        expect(response.methodResponses.map(([name, args, callId]) => `${callId}:${name === 'error' ? args.type : name}`)).to.deep.equal([
            'a:Big/get',
            'b:requestTooLarge',
            'c:Core/echo',
            'd:Big/get'
        ]);
    });

    it('lists every id once', () => {
        expect(uniqueIds(['a', 'b', 'a', 'c', 'b'])).to.deep.equal(['a', 'b', 'c']);
        expect(uniqueIds(null)).to.equal(null);
        expect(uniqueIds(undefined)).to.equal(undefined);
    });
});
