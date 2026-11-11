/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { runSet, referencedIds } = require('../../../lib/jmap/set');
const { SetError } = require('../../../lib/jmap/set-errors');

const contextOf = () => ({ account: { id: 'A1' }, limits: { maxObjectsInSet: 10 }, createdIds: {}, deps: {}, cache: {} });

describe('JMAP /set', () => {
    it('resolves the creation references of an id list as their objects are created', () => {
        const context = contextOf();
        const ids = referencedIds(context, ['M1', '#c1', '#c2']);
        expect([...ids()]).to.deep.equal(['M1']);
        context.createdIds.c1 = 'M2';
        expect([...ids()]).to.deep.equal(['M1', 'M2']);
        // the same set, built once
        expect(ids()).to.equal(ids());
    });

    it('hands the checked updates to updateAll together and reports each result', async () => {
        const context = contextOf();
        let batch;
        const response = await runSet({ accountId: 'A1', update: { M1: { a: 1 }, M2: 'not a patch', M3: { b: 2 }, M4: {} } }, context, {
            state: async () => 's1',
            updateAll: async entries => {
                batch = entries;
                return [null, new SetError('notFound'), { serverSet: true }];
            }
        });
        expect(batch).to.deep.equal([
            { id: 'M1', patch: { a: 1 } },
            { id: 'M3', patch: { b: 2 } },
            { id: 'M4', patch: {} }
        ]);
        expect(response.updated).to.deep.equal({ M1: null, M4: { serverSet: true } });
        expect(Object.keys(response.notUpdated).sort()).to.deep.equal(['M2', 'M3']);
        expect(response.notUpdated.M3.type).to.equal('notFound');
        expect(response.notUpdated.M2.type).to.equal('invalidPatch');
    });
});
