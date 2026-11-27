/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { keywordSet, keywordChanges, normalizePatch } = require('../../../lib/jmap/types/email-set');

const LABEL = '0123456789abcdef01234567';
const labels = new Map([[LABEL, 'Work']]);

describe('JMAP Email/set helpers', () => {
    describe('keywordSet', () => {
        it('lowercases and collapses keywords', () => {
            expect([...keywordSet({ $Seen: true, Foo: true, foo: true }, labels)]).to.deep.equal(['$seen', 'foo']);
        });

        it('accepts a label keyword of an active label only', () => {
            expect([...keywordSet({ [`$wdlabel$${LABEL.toUpperCase()}`]: true }, labels)]).to.deep.equal([`$wdlabel$${LABEL}`]);
            expect(keywordSet({ $wdlabel$000000000000000000000000: true }, labels)).to.equal(null);
            expect(keywordSet({ $wdlabel$xyz: true }, labels)).to.equal(null);
        });

        it('rejects values other than true, bad characters, hidden flags and lists', () => {
            const invalid = [
                { a: false },
                { a: 1 },
                { 'a b': true },
                { 'a]': true },
                { '': true },
                { ['k'.repeat(256)]: true },
                { $deleted: true },
                ['$seen'],
                null
            ];
            for (const value of invalid) {
                expect(keywordSet(value, labels), JSON.stringify(value)).to.equal(null);
            }
            expect([...keywordSet({ ['k'.repeat(255)]: true, 'a/b~': true }, labels)]).to.have.length(2);
        });
    });

    describe('keywordChanges', () => {
        const doc = { flags: ['\\Seen', 'Important', '\\Deleted', '\\Recent'], labels: [new ObjectId(LABEL), new ObjectId()] };

        it('adds and removes flags and labels, keeping hidden flags and stored spellings', () => {
            const changes = keywordChanges(doc, new Set(['important', '$flagged', '$forwarded']), labels);
            expect(changes).to.deep.equal({ addFlags: ['\\Flagged', '$Forwarded'], removeFlags: ['\\Seen'], addLabels: [], removeLabels: ['Work'] });
        });

        it('changes nothing for the current keywords', () => {
            const changes = keywordChanges(doc, new Set(['$seen', 'important', `$wdlabel$${LABEL}`]), labels);
            expect(changes).to.deep.equal({ addFlags: [], removeFlags: [], addLabels: [], removeLabels: [] });
        });

        it('removes a keyword stored in another letter case', () => {
            expect(keywordChanges(doc, new Set(['$seen']), labels).removeFlags).to.deep.equal(['Important']);
        });
    });

    describe('normalizePatch', () => {
        it('lowercases keyword paths only', () => {
            expect(normalizePatch({ 'keywords/$Seen': true, 'mailboxIds/FAbc': true })).to.deep.equal({ 'keywords/$seen': true, 'mailboxIds/FAbc': true });
        });

        it('refuses two paths for the same keyword', () => {
            expect(() => normalizePatch({ 'keywords/A': true, 'keywords/a': null }))
                .to.throw()
                .with.property('type', 'invalidPatch');
        });

        it('keeps a __proto__ path an own key', () => {
            const patch = normalizePatch(JSON.parse('{"__proto__": 1}'));
            expect(Object.keys(patch)).to.deep.equal(['__proto__']);
            expect(Object.getPrototypeOf(patch)).to.equal(Object.prototype);
        });
    });
});
