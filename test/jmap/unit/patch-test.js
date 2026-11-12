/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const { applyPatch, parsePointer, PatchError } = require('../../../lib/jmap/patch');

const deepFreeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
};

function fails(fn, type) {
    try {
        fn();
    } catch (err) {
        expect(err).to.be.instanceOf(PatchError);
        expect(err.type).to.equal(type);
        return err;
    }
    throw new Error('expected a PatchError');
}

describe('JMAP PatchObject', () => {
    const email = () => deepFreeze({ keywords: { $seen: true, 'a/b': true }, mailboxIds: { F1: true }, replyTo: [{ name: 'x', email: 'x@y' }], name: 'n' });

    it('decodes pointer escapes', () => {
        expect(parsePointer('keywords/a~1b')).to.deep.equal(['keywords', 'a/b']);
        expect(parsePointer('a~0~1b/c')).to.deep.equal(['a~/b', 'c']);
    });

    for (const key of ['', '/keywords', 'keywords/', 'keywords//x', 'keywords/a~2b', 'a~']) {
        it(`refuses the malformed key ${JSON.stringify(key)}`, () => {
            fails(() => applyPatch(email(), { [key]: true }), 'invalidPatch');
        });
    }

    it('adds and removes keys without touching the input', () => {
        const input = email();
        const { object, properties } = applyPatch(input, { 'keywords/$flagged': true, 'keywords/$seen': null, 'keywords/a~1b': null });
        expect(object.keywords).to.deep.equal({ $flagged: true });
        expect(input.keywords).to.deep.equal({ $seen: true, 'a/b': true });
        expect([...properties]).to.deep.equal(['keywords']);
        // untouched properties keep their identity
        expect(object.mailboxIds).to.equal(input.mailboxIds);
    });

    it('applies a move as one patch', () => {
        const { object } = applyPatch(email(), { 'mailboxIds/F1': null, 'mailboxIds/F2': true });
        expect(object.mailboxIds).to.deep.equal({ F2: true });
    });

    it('removing an absent key is a no-op', () => {
        expect(applyPatch(email(), { 'keywords/$absent': null }).object.keywords).to.deep.equal({ $seen: true, 'a/b': true });
    });

    it('replaces top level properties and keeps a null value', () => {
        const { object } = applyPatch(email(), { name: null, keywords: { x: true } });
        expect(object.name).to.equal(null);
        expect(object.keywords).to.deep.equal({ x: true });
    });

    it('an empty patch changes nothing', () => {
        const { object, properties } = applyPatch(email(), {});
        expect(object).to.deep.equal(email());
        expect(properties.size).to.equal(0);
    });

    it('refuses a missing parent', () => {
        fails(() => applyPatch(email(), { 'keywords/$absent/x': true }), 'invalidPatch');
        fails(() => applyPatch(email(), { 'keywords/a/b': true }), 'invalidPatch');
    });

    it('refuses paths into arrays and scalars', () => {
        fails(() => applyPatch(email(), { 'replyTo/0/name': 'y' }), 'invalidPatch');
        fails(() => applyPatch(email(), { 'name/first': 'y' }), 'invalidPatch');
    });

    it('refuses overlapping paths', () => {
        fails(() => applyPatch(email(), { keywords: { a: true }, 'keywords/$seen': true }), 'invalidPatch');
        fails(() => applyPatch(email(), { 'mailboxIds/F1': null, mailboxIds: { F2: true } }), 'invalidPatch');
    });

    it('names unknown properties', () => {
        const err = fails(() => applyPatch(email(), { colour: 'red', 'keywords/x': true }, { properties: ['keywords', 'mailboxIds'] }), 'invalidProperties');
        expect(err.toSetError()).to.deep.include({ type: 'invalidProperties', properties: ['colour'] });
    });

    it('refuses a patch that is not an object', () => {
        fails(() => applyPatch(email(), 'oops'), 'invalidPatch');
        fails(() => applyPatch(email(), ['keywords']), 'invalidPatch');
    });

    it('treats __proto__ as an ordinary key', () => {
        const { object } = applyPatch(email(), { 'keywords/__proto__': true });
        expect(Object.getPrototypeOf(object.keywords)).to.equal(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(object.keywords, '__proto__')).to.be.true;
        expect({}.polluted).to.equal(undefined);
    });

    it('matches a reference model on random keyword patches and never mutates the input', () => {
        const words = ['$seen', '$flagged', 'a/b', 'x~y', 'k1', 'k2', 'k3'];
        const escape = word => word.replace(/~/g, '~0').replace(/\//g, '~1');
        for (let round = 0; round < 500; round++) {
            const start = {};
            words.filter(() => crypto.randomInt(2)).forEach(word => (start[word] = true));
            const patch = {};
            const expected = Object.assign({}, start);
            for (const word of words.filter(() => crypto.randomInt(3) === 0)) {
                const value = crypto.randomInt(2) ? true : null;
                patch[`keywords/${escape(word)}`] = value;
                if (value) {
                    expected[word] = true;
                } else {
                    delete expected[word];
                }
            }
            const input = deepFreeze({ keywords: start });
            expect(applyPatch(input, patch).object.keywords).to.deep.equal(expected);
        }
    });

    it('checks overlapping paths in linear time, also for very long paths', () => {
        const deep = Array.from({ length: 20000 }, (_, i) => 'k' + i).join('/');
        const started = Date.now();
        expect(() => applyPatch({ a: {} }, { a: true, ['a/' + deep]: 1 })).to.throw(PatchError);
        expect(() => applyPatch({ a: {} }, { ['a/' + deep]: 1, a: true })).to.throw(PatchError);
        expect(Date.now() - started).to.be.below(500);
        expect(() => applyPatch({ a: { b: 1, c: 2 } }, { 'a/b': 3, 'a/c': 4 })).to.not.throw();
    });
});

describe('JMAP PatchObject edge cases', () => {
    it('refuses a pointer that is not a string', () => {
        fails(() => parsePointer(5), 'invalidPatch');
        fails(() => parsePointer(null), 'invalidPatch');
    });

    it('tells a missing parent from a parent that is not an object', () => {
        expect(fails(() => applyPatch({}, { 'a/b': 1 }), 'invalidPatch').description).to.equal('a/b: parent does not exist');
        expect(fails(() => applyPatch({ a: null }, { 'a/b': 1 }), 'invalidPatch').description).to.equal('a/b: parent does not exist');
        expect(fails(() => applyPatch({ a: 5 }, { 'a/b': 1 }), 'invalidPatch').description).to.equal('a/b: can not patch inside a value that is not an object');
    });

    it('replaces only existing array members, never with null, when arrays are allowed', () => {
        const card = deepFreeze({ list: ['a', 'b'] });
        expect(applyPatch(card, { 'list/1': 'c' }, { arrays: true }).object.list).to.deep.equal(['a', 'c']);
        expect(card.list).to.deep.equal(['a', 'b']);
        for (const key of ['list/2', 'list/5', 'list/01', 'list/-']) {
            fails(() => applyPatch(card, { [key]: 'c' }, { arrays: true }), 'invalidPatch');
        }
        fails(() => applyPatch(card, { 'list/0': null }, { arrays: true }), 'invalidPatch');
    });
});
