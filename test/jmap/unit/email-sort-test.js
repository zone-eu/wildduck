/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { parseSort, baseSubject, addressKey } = require('../../../lib/jmap/email-sort');
const { collationKey } = require('../../../lib/jmap/collation');

describe('JMAP Email/query sorts', () => {
    describe('baseSubject (RFC 5256 2.1)', () => {
        const cases = [
            ['Re: banana', 'banana'],
            ['Fwd: Re: cherry', 'cherry'],
            ['RE: apple', 'apple'],
            ['[list] Apple pie (fwd)', 'Apple pie'],
            ['Re [2]: Fw: x', 'x'],
            ['[fwd: Re: wrapped]', 'wrapped'],
            ['  spaced \t  out  ', 'spaced out'],
            ['[only a blob]', '[only a blob]'],
            ['Re:', ''],
            ['', '']
        ];
        for (const [subject, base] of cases) {
            it(`${JSON.stringify(subject)} -> ${JSON.stringify(base)}`, () => {
                expect(baseSubject(subject)).to.equal(base);
            });
        }
    });

    describe('addressKey', () => {
        it('takes the name of the first address, else its email, of the last header field', () => {
            expect(addressKey([{ key: 'from', value: 'carl <zzz@example.com>, aaron <a@example.com>' }], 'from')).to.equal('carl');
            expect(addressKey([{ key: 'from', value: 'bbb@example.com' }], 'from')).to.equal('bbb@example.com');
            expect(addressKey([{ key: 'to', value: 'list: m@example.com;' }], 'to')).to.equal('m@example.com');
            expect(addressKey([], 'to')).to.equal('');
            expect(
                addressKey(
                    [
                        { key: 'from', value: 'first <f@example.com>' },
                        { key: 'from', value: 'last <l@example.com>' }
                    ],
                    'from'
                )
            ).to.equal('last');
        });
    });

    describe('collations', () => {
        const sorted = (values, collation) => [...values].sort((a, b) => (collationKey(collation)(a) < collationKey(collation)(b) ? -1 : 1));
        it('places accented letters next to their base letters by default', () => {
            expect(sorted(['cherry', 'Äpfel', 'Banana', 'apple'])).to.deep.equal(['apple', 'Äpfel', 'Banana', 'cherry']);
        });
        it('answers null for an unknown collation', () => {
            expect(collationKey('i;octet')).to.equal(null);
        });
    });

    describe('parseSort', () => {
        it('normalises the default order', () => {
            const definitions = [undefined, null, [], [{ property: 'receivedAt', isAscending: false }]].map(sort => parseSort(sort).definition);
            for (const definition of definitions) {
                expect(definition).to.deep.equal(definitions[0]);
            }
        });

        it('sorts strings and thread keywords in memory, keyword sorts are mutable', () => {
            expect(parseSort([{ property: 'subject' }]).inMemory).to.be.true;
            expect(parseSort([{ property: 'someInThreadHaveKeyword', keyword: '$seen' }])).to.include({ inMemory: true, mutable: true });
            expect(parseSort([{ property: 'hasKeyword', keyword: '$seen' }])).to.include({ inMemory: false, mutable: true });
            expect(parseSort([{ property: 'size' }])).to.include({ inMemory: false, mutable: false });
        });

        it('keeps the collation of string sorts only', () => {
            expect(parseSort([{ property: 'subject', collation: 'i;ascii-casemap' }]).definition[0].collation).to.equal('i;ascii-casemap');
            expect(parseSort([{ property: 'size', collation: 'i;nonexistent' }]).definition[0]).to.not.have.property('collation');
        });

        it('rejects bad comparators', () => {
            expect(() => parseSort([{ property: 'subject', collation: 'i;nonexistent' }]))
                .to.throw()
                .with.property('type', 'unsupportedSort');
            expect(() => parseSort([{ property: 'allInThreadHaveKeyword', keyword: '' }]))
                .to.throw()
                .with.property('type', 'invalidArguments');
            expect(() => parseSort([{ property: 'from', extra: 1 }]))
                .to.throw()
                .with.property('type', 'invalidArguments');
        });
    });
});
