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
    describe('arguments', () => {
        const run = (args, handlers = {}) =>
            runSet(Object.assign({ accountId: 'A1' }, args), contextOf(), Object.assign({ state: async () => 's1' }, handlers));
        const typeOf = promise =>
            promise.then(
                () => null,
                err => err.type
            );

        it('refuses create, update and destroy of the wrong shape', async () => {
            expect(await typeOf(run({ create: 'x' }))).to.equal('invalidArguments');
            expect(await typeOf(run({ update: 5 }))).to.equal('invalidArguments');
            expect(await typeOf(run({ destroy: 'M1' }))).to.equal('invalidArguments');
            expect(await typeOf(run({ destroy: ['M1', 5] }))).to.equal('invalidArguments');
            expect(await typeOf(run({ ifInState: 5 }))).to.equal('invalidArguments');
            expect(await typeOf(run({ create: { 'not valid': {} } }))).to.equal('invalidArguments');
            expect(await typeOf(run({ other: true }))).to.equal('invalidArguments');
        });

        it('accepts null and well formed arguments', async () => {
            const response = await run({ create: null, update: null, destroy: null, ifInState: null });
            expect(response).to.include({ accountId: 'A1', oldState: 's1', newState: 's1', created: null, destroyed: null });
            expect(await typeOf(run({ destroy: ['M1'], ifInState: 's1' }, { destroy: async () => true }))).to.equal(null);
            expect(await typeOf(run({ create: { 'c_1-A': {} } }, { create: async () => ({ id: 'X1' }) }))).to.equal(null);
        });

        it('checks the account, unless the type has none', async () => {
            expect(await typeOf(runSet({ accountId: 'A2' }, contextOf(), { state: async () => 's1' }))).to.equal('accountNotFound');
            const response = await runSet({ create: { c1: {} } }, contextOf(), { accountless: true, create: async () => ({ id: 'P1' }) });
            expect(response).to.deep.equal({
                created: { c1: { id: 'P1' } },
                notCreated: null,
                updated: null,
                notUpdated: null,
                destroyed: null,
                notDestroyed: null
            });
        });

        it('allows exactly maxObjectsInSet objects', async () => {
            const destroy = Array.from({ length: 10 }, (item, i) => `M${i}`);
            expect(await typeOf(run({ destroy }, { destroy: async () => true }))).to.equal(null);
            expect(await typeOf(run({ destroy: destroy.concat('M10') }, { destroy: async () => true }))).to.equal('requestTooLarge');
        });

        it('compares ifInState with the current state', async () => {
            expect(await typeOf(run({ ifInState: 's0' }))).to.equal('stateMismatch');
            expect(await typeOf(run({ ifInState: 's1' }))).to.equal(null);
        });
    });

    describe('outcomes', () => {
        it('fails each object on its own, keyed by its id or by the unknown reference', async () => {
            const context = contextOf();
            const fail = async id => {
                if (id === 'M9') {
                    throw new SetError('notFound');
                }
                return id === 'M1' ? { serverSet: 1 } : null;
            };
            const response = await runSet(
                {
                    accountId: 'A1',
                    create: { c1: {}, c2: 'not an object' },
                    update: { M1: {}, M2: {}, M9: {}, '#nope': {} },
                    destroy: ['M3', 'M9', '#nope', '#c1']
                },
                context,
                { state: async () => 's1', create: async () => ({ id: 'N1' }), update: fail, destroy: fail }
            );
            expect(response.created).to.deep.equal({ c1: { id: 'N1' } });
            expect(response.notCreated.c2.type).to.equal('invalidProperties');
            expect(response.updated).to.deep.equal({ M1: { serverSet: 1 }, M2: null });
            expect(Object.keys(response.notUpdated).sort()).to.deep.equal(['#nope', 'M9']);
            expect(response.notUpdated['#nope'].type).to.equal('notFound');
            expect(response.destroyed).to.deep.equal(['M3', 'N1']);
            expect(Object.keys(response.notDestroyed).sort()).to.deep.equal(['#nope', 'M9']);
            expect(response.notDestroyed['#nope'].type).to.equal('notFound');
        });

        it('forbids what the type does not implement', async () => {
            const response = await runSet({ accountId: 'A1', create: { c1: {} }, update: { M1: {} }, destroy: ['M2'] }, contextOf(), {
                state: async () => 's1'
            });
            expect(response.notCreated.c1.type).to.equal('forbidden');
            expect(response.notUpdated.M1.type).to.equal('forbidden');
            expect(response.notDestroyed.M2.type).to.equal('forbidden');
            expect(response.newState).to.equal('s1');
        });

        it('passes errors other than SetErrors on', async () => {
            const err = await runSet({ accountId: 'A1', destroy: ['M1'] }, contextOf(), {
                state: async () => 's1',
                destroy: async () => {
                    throw new Error('database down');
                }
            }).catch(error => error);
            expect(err.message).to.equal('database down');
        });

        it('reads the new state and notifies event streams after any change', async () => {
            for (const args of [{ create: { c1: {} } }, { update: { M1: {} } }, { destroy: ['M1'] }]) {
                const context = contextOf();
                const fired = [];
                context.account.user = 'U1';
                context.deps.notifier = { fire: user => fired.push(user) };
                let reads = 0;
                const response = await runSet(Object.assign({ accountId: 'A1' }, args), context, {
                    state: async () => `s${++reads}`,
                    create: async () => ({ id: 'N1' }),
                    update: async () => null,
                    destroy: async () => true
                });
                expect(response, JSON.stringify(args)).to.include({ oldState: 's1', newState: 's2' });
                expect(fired).to.deep.equal(['U1']);
            }
        });
    });

    it('keeps an id list entry that is not a string as it is', () => {
        expect([...referencedIds(contextOf(), [7])()]).to.deep.equal([7]);
    });
});
