/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { evaluatePointer, resolveReferences } = require('../../../lib/jmap/references');

const typeOf = fn => {
    try {
        fn();
    } catch (err) {
        return err.type;
    }
    return null;
};

describe('JMAP result references', () => {
    const value = {
        ids: ['a', 'b'],
        list: [
            { id: 'a', threadId: 't1', emailIds: ['x', 'y'] },
            { id: 'b', threadId: 't2', emailIds: ['z'] }
        ],
        'a/b': { '~c': 1 },
        empty: []
    };

    it('evaluates plain JSON Pointers with escapes', () => {
        expect(evaluatePointer(value, '/ids')).to.deep.equal(['a', 'b']);
        expect(evaluatePointer(value, '/ids/1')).to.equal('b');
        expect(evaluatePointer(value, '/a~1b/~0c')).to.equal(1);
        expect(evaluatePointer(value, '')).to.equal(value);
    });

    it('maps "*" over arrays and flattens array results', () => {
        expect(evaluatePointer(value, '/list/*/threadId')).to.deep.equal(['t1', 't2']);
        expect(evaluatePointer(value, '/list/*/emailIds')).to.deep.equal(['x', 'y', 'z']);
        expect(evaluatePointer(value, '/empty/*/id')).to.deep.equal([]);
    });

    it('fails with invalidResultReference for paths that do not resolve', () => {
        for (const path of [
            '/missing',
            '/ids/2',
            '/ids/01',
            '/ids/-1',
            '/list/*/missing',
            'ids',
            '/ids/x',
            '/__proto__',
            '/constructor',
            '/list/0/__proto__/x'
        ]) {
            expect(
                typeOf(() => evaluatePointer(value, path)),
                path
            ).to.equal('invalidResultReference');
        }
    });

    it('resolves "#" arguments from earlier responses', () => {
        const responses = [['Email/query', { ids: ['m1', 'm2'] }, 'c0']];
        const args = resolveReferences({ accountId: 'u1', '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' } }, responses);
        expect(args).to.deep.equal({ accountId: 'u1', ids: ['m1', 'm2'] });
    });

    it('rejects a reference to the wrong method, an unknown call or an error response', () => {
        const responses = [
            ['Email/query', { ids: [] }, 'c0'],
            ['error', { type: 'serverFail' }, 'c1']
        ];
        expect(typeOf(() => resolveReferences({ '#ids': { resultOf: 'c0', name: 'Email/get', path: '/ids' } }, responses))).to.equal('invalidResultReference');
        expect(typeOf(() => resolveReferences({ '#ids': { resultOf: 'c9', name: 'Email/query', path: '/ids' } }, responses))).to.equal(
            'invalidResultReference'
        );
        expect(typeOf(() => resolveReferences({ '#ids': { resultOf: 'c1', name: 'Email/query', path: '/ids' } }, responses))).to.equal(
            'invalidResultReference'
        );
        expect(typeOf(() => resolveReferences({ '#ids': 'c0' }, responses))).to.equal('invalidResultReference');
    });

    it('rejects an argument given both plain and as a reference', () => {
        const responses = [['Email/query', { ids: [] }, 'c0']];
        expect(typeOf(() => resolveReferences({ ids: [], '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' } }, responses))).to.equal(
            'invalidArguments'
        );
    });
});
