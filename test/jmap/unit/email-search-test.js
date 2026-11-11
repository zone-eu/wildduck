/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { tokenize, textSearch, foldedPattern, validateFilter, MAX_DEPTH, MAX_CONDITIONS } = require('../../../lib/jmap/email-search');

describe('JMAP Email/query search strings', () => {
    it('splits on white space and keeps quoted phrases together', () => {
        expect(tokenize('  red   "green blue"  \'cats and   dogs\' ')).to.deep.equal([
            { text: 'red', phrase: false },
            { text: 'green blue', phrase: true },
            { text: 'cats and dogs', phrase: true }
        ]);
    });

    it('honours backslash escapes inside a phrase and treats an unbalanced quote as a character', () => {
        expect(tokenize('"say \\"hi\\""')).to.deep.equal([{ text: 'say "hi"', phrase: true }]);
        expect(tokenize("don't")).to.deep.equal([{ text: "don't", phrase: false }]);
        expect(tokenize('"open')).to.deep.equal([{ text: '"open', phrase: false }]);
        expect(tokenize('""   ')).to.deep.equal([]);
    });

    it('builds a $text search where every term is required and a leading minus is no negation', () => {
        expect(textSearch(tokenize('something -otherthing'))).to.equal('"something" "otherthing"');
        expect(textSearch(tokenize('"your country" home'))).to.equal('"your country" "home"');
        expect(textSearch(tokenize('"say \\"hi\\""'))).to.equal('"say  hi"');
        expect(textSearch(tokenize(' - '))).to.equal(null);
        expect(textSearch(tokenize(''))).to.equal(null);
    });

    it('matches case and diacritic insensitively and escapes regular expression syntax', () => {
        const matches = (term, value) => new RegExp(foldedPattern(term), 'iu').test(value);
        expect(matches('cote', "Côte d'Azur")).to.be.true;
        expect(matches('CÔTE', 'cote')).to.be.true;
        expect(matches('muller', 'jörg müller')).to.be.true;
        expect(matches('red  green', 'red green')).to.be.true;
        expect(matches('a.c(d', 'a.c(d')).to.be.true;
        expect(matches('a.c', 'abc')).to.be.false;
        expect(matches('孫子', '孫子兵法')).to.be.true;
    });

    it('limits the depth and the number of conditions of a filter', () => {
        let deep = { hasKeyword: '$seen' };
        for (let i = 0; i < MAX_DEPTH; i++) {
            deep = { operator: 'NOT', conditions: [deep] };
        }
        expect(() => validateFilter(deep)).to.not.throw();
        expect(() => validateFilter({ operator: 'AND', conditions: [deep] })).to.throw('the filter is too deep or too large');

        const wide = count => ({ operator: 'OR', conditions: Array.from({ length: count }, () => ({ hasKeyword: '$seen' })) });
        expect(() => validateFilter(wide(MAX_CONDITIONS))).to.not.throw();
        expect(() => validateFilter(wide(MAX_CONDITIONS + 1))).to.throw('the filter is too deep or too large');
    });
});
