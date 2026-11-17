/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { collectTerms, subjectSnippet, previewSnippet } = require('../../../lib/jmap/types/searchsnippet');

describe('JMAP SearchSnippet highlighting', () => {
    it('splits terms per field and leaves out NOT branches', () => {
        const terms = collectTerms({
            operator: 'AND',
            conditions: [{ text: 'Red "Blue Sky"' }, { subject: 'green' }, { body: 'bike' }, { operator: 'NOT', conditions: [{ text: 'gamma' }] }]
        });
        expect(terms.subject).to.deep.equal(['red', 'blue sky', 'green']);
        expect(terms.body).to.deep.equal(['red', 'blue sky', 'bike']);
        expect(collectTerms(null)).to.deep.equal({ subject: [], body: [] });
    });

    it('marks ignoring case and diacritics, keeping the stored spelling', () => {
        expect(subjectSnippet('Voyage sur la Côte', ['cote'])).to.equal('Voyage sur la <mark>Côte</mark>');
        expect(subjectSnippet('The FOOSBALL final', ['foosball'])).to.equal('The <mark>FOOSBALL</mark> final');
        expect(subjectSnippet('nothing here', ['foosball'])).to.equal(null);
    });

    it('marks a phrase only where it occurs as a whole and only at word starts', () => {
        expect(subjectSnippet('your own country, your  country', ['your country'])).to.equal('your own country, <mark>your  country</mark>');
        expect(subjectSnippet('bored red', ['red'])).to.equal('bored <mark>red</mark>');
    });

    it('escapes the text around the marks', () => {
        expect(subjectSnippet('<mark>x</mark> & y', ['y'])).to.equal('&lt;mark&gt;x&lt;/mark&gt; &amp; <mark>y</mark>');
    });

    it('marks whole grapheme clusters', () => {
        expect(subjectSnippet('café time', ['cafe'])).to.equal('<mark>café</mark> time');
    });

    it('keeps the preview within 255 octets around a late match', () => {
        const preview = previewSnippet('filler & <text> '.repeat(100) + 'target end', ['target']);
        expect(Buffer.byteLength(preview)).to.be.at.most(255);
        expect(preview).to.include('<mark>target</mark> end');
        expect(preview).to.not.match(/&[a-z]*$/);

        const long = previewSnippet('target ' + '\u{1F469}‍\u{1F469}‍\u{1F467} '.repeat(100), ['target']);
        expect(Buffer.byteLength(long)).to.be.at.most(255);
        expect(long.endsWith('\u{1F467}') || long.endsWith(' ')).to.be.true;
        expect(previewSnippet('no match', ['target'])).to.equal(null);
    });
});
