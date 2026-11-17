'use strict';

const { expect } = require('chai');
const responseBudget = require('../../../lib/jmap/response-budget');
const { MethodRegistry, processRequest } = require('../../../lib/jmap/request');
const { MethodError } = require('../../../lib/jmap/errors');
const { URN, limitsFrom } = require('../../../lib/jmap/capabilities');

const contextOf = (limits = {}) => ({ limits: limitsFrom({ limits }), advertised: new Set([URN.core]), cache: {} });

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

    it('answers every id of a /get once and charges the objects before the call', async () => {
        const seen = [];
        const registry = new MethodRegistry([
            {
                capability: URN.core,
                methods: {
                    'Some/get': async args => {
                        seen.push(args.ids);
                        return { list: args.ids.map(id => ({ id })), notFound: [] };
                    }
                }
            }
        ]);
        const context = contextOf({ maxResponseBytes: 3 * responseBudget.OBJECT_BYTES });
        const body = {
            using: [URN.core],
            methodCalls: [
                ['Some/get', { ids: ['a', 'b', 'a', 'b'] }, 'a'],
                ['Some/get', { ids: ['c', 'd'] }, 'b'],
                ['Some/get', { ids: ['c'] }, 'c']
            ]
        };
        const response = await processRequest(body, registry, context);
        expect(response.methodResponses.map(([name, args, callId]) => `${callId}:${name === 'error' ? args.type : name}`)).to.deep.equal([
            'a:Some/get',
            'b:requestTooLarge',
            'c:Some/get'
        ]);
        expect(response.methodResponses[0][1].list).to.deep.equal([{ id: 'a' }, { id: 'b' }]);
        // the call that did not fit never ran and drew nothing
        expect(seen).to.deep.equal([['a', 'b'], ['c']]);
        expect(responseBudget.remaining(context)).to.equal(0);
    });

    it('gives the objects back when the call fails', async () => {
        const registry = new MethodRegistry([
            {
                capability: URN.core,
                methods: {
                    'Some/get': async () => {
                        throw new MethodError('invalidArguments');
                    }
                }
            }
        ]);
        const context = contextOf({ maxResponseBytes: 1000 });
        await processRequest({ using: [URN.core], methodCalls: [['Some/get', { ids: ['a', 'b'] }, 'a']] }, registry, context);
        expect(responseBudget.remaining(context)).to.equal(1000);
    });

    it('caps a sub budget at what is left and spends what it took', () => {
        const context = contextOf({ maxResponseBytes: 1000 });
        responseBudget.draw(context, 600);
        const budget = responseBudget.capped(context, 10000);
        expect(budget.remaining).to.equal(400);
        budget.remaining -= 150;
        budget.close();
        expect(responseBudget.remaining(context)).to.equal(250);
    });
});
