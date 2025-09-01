/* eslint-disable no-unused-expressions */
'use strict';

const { expect } = require('chai');
const { extractQuotedPhrases, parseFilterQueryText, filterQueryTermMatches } = require('../lib/tools');

describe.only('Email Filtering helper functions', () => {
    describe('extractQuotedPhrases', () => {
        it('should extract single quoted phrase', () => {
            const result = extractQuotedPhrases('urgent "project meeting" status');
            expect(result.phrases).to.deep.equal(['project meeting']);
            expect(result.cleanQuery).to.equal('urgent __PHRASE_0__ status');
        });

        it('should extract multiple quoted phrases', () => {
            const result = extractQuotedPhrases('"first phrase" and "second phrase"');
            expect(result.phrases).to.deep.equal(['first phrase', 'second phrase']);
            expect(result.cleanQuery).to.equal('__PHRASE_0__ and __PHRASE_1__');
        });

        it('should handle empty quotes', () => {
            const result = extractQuotedPhrases('urgent "" status');
            expect(result.phrases).to.deep.equal([]);
            expect(result.cleanQuery).to.equal('urgent "" status');
        });

        it('should handle quotes with only whitespace', () => {
            const result = extractQuotedPhrases('urgent "   " status');
            expect(result.phrases).to.deep.equal([]);
            expect(result.cleanQuery).to.equal('urgent "   " status');
        });

        it('should handle no quotes', () => {
            const result = extractQuotedPhrases('urgent meeting status');
            expect(result.phrases).to.deep.equal([]);
            expect(result.cleanQuery).to.equal('urgent meeting status');
        });

        it('should trim whitespace from phrases', () => {
            const result = extractQuotedPhrases('"  project meeting  "');
            expect(result.phrases).to.deep.equal(['project meeting']);
            expect(result.cleanQuery).to.equal('__PHRASE_0__');
        });

        it('should handle unclosed quotes gracefully', () => {
            const result = extractQuotedPhrases('urgent "project meeting status');
            expect(result.phrases).to.deep.equal([]);
            expect(result.cleanQuery).to.equal('urgent "project meeting status');
        });
    });

    describe('parseFilterQueryText', () => {
        it('should handle null/undefined input', () => {
            expect(parseFilterQueryText(null)).to.deep.equal({
                andTerms: [],
                orTerms: []
            });
            expect(parseFilterQueryText(undefined)).to.deep.equal({
                andTerms: [],
                orTerms: []
            });
            expect(parseFilterQueryText('')).to.deep.equal({
                andTerms: [],
                orTerms: []
            });
        });

        it('should handle non-string input', () => {
            expect(parseFilterQueryText(123)).to.deep.equal({
                andTerms: [],
                orTerms: []
            });
            expect(parseFilterQueryText({})).to.deep.equal({
                andTerms: [],
                orTerms: []
            });
        });

        it('should parse AND terms with spaces', () => {
            const result = parseFilterQueryText('urgent meeting status');
            expect(result.andTerms).to.deep.equal(['urgent', 'meeting', 'status']);
            expect(result.orTerms).to.deep.equal([]);
            expect(result.exactPhrases).to.deep.equal([]);
        });

        it('should parse AND terms with commas', () => {
            const result = parseFilterQueryText('urgent, meeting, status');
            expect(result.andTerms).to.deep.equal(['urgent', 'meeting', 'status']);
            expect(result.orTerms).to.deep.equal([]);
        });

        it('should parse AND terms with extra spaces', () => {
            const result = parseFilterQueryText('urgent       meeting    status');
            expect(result.andTerms).to.deep.equal(['urgent', 'meeting', 'status']);
            expect(result.orTerms).to.deep.equal([]);
        });

        it('should parse OR terms', () => {
            const result = parseFilterQueryText('urgent OR deadline OR meeting');
            expect(result.andTerms).to.deep.equal([]);
            expect(result.orTerms).to.deep.equal(['urgent', 'deadline', 'meeting']);
            expect(result.exactPhrases).to.deep.equal([]);
        });

        it('should parse OR terms with phrases', () => {
            const result = parseFilterQueryText('urgent meeting OR project deadline');
            expect(result.andTerms).to.deep.equal([]);
            expect(result.orTerms).to.deep.equal(['urgent meeting', 'project deadline']);
        });

        it('should handle quoted phrases in AND context', () => {
            const result = parseFilterQueryText('urgent "project meeting" status');
            expect(result.andTerms).to.deep.equal(['urgent', '__PHRASE_0__', 'status']);
            expect(result.orTerms).to.deep.equal([]);
            expect(result.exactPhrases).to.deep.equal(['project meeting']);
        });

        it('should handle quoted phrases in OR context', () => {
            const result = parseFilterQueryText('"project meeting" OR deadline OR "final report"');
            expect(result.andTerms).to.deep.equal([]);
            expect(result.orTerms).to.deep.equal(['__PHRASE_0__', 'deadline', '__PHRASE_1__']);
            expect(result.exactPhrases).to.deep.equal(['project meeting', 'final report']);
        });

        it('should handle mixed spaces and commas', () => {
            const result = parseFilterQueryText('urgent, meeting status');
            expect(result.andTerms).to.deep.equal(['urgent', 'meeting', 'status']);
        });

        it('should filter out empty terms', () => {
            const result = parseFilterQueryText('urgent  ,  , meeting   status');
            expect(result.andTerms).to.deep.equal(['urgent', 'meeting', 'status']);
        });

        it('should handle whitespace around OR', () => {
            const result = parseFilterQueryText('urgent OR   deadline   OR meeting');
            expect(result.orTerms).to.deep.equal(['urgent', 'deadline', 'meeting']);
        });
    });

    describe('filterQueryTermMatches', () => {
        const testText = 'this is an urgent project meeting about the final report status';

        it('should match single word terms', () => {
            expect(filterQueryTermMatches(testText, 'urgent')).to.be.true;
            expect(filterQueryTermMatches(testText, 'project')).to.be.true;
            expect(filterQueryTermMatches(testText, 'missing')).to.be.false;
        });

        it('should match multi-word terms (all words present)', () => {
            expect(filterQueryTermMatches(testText, 'urgent project')).to.be.true;
            expect(filterQueryTermMatches(testText, 'final report')).to.be.true;
            expect(filterQueryTermMatches(testText, 'project status')).to.be.true;
        });

        it('should not match multi-word terms when words are missing', () => {
            expect(filterQueryTermMatches(testText, 'urgent missing')).to.be.false;
            expect(filterQueryTermMatches(testText, 'project missing status')).to.be.false;
        });

        it('should handle terms with commas', () => {
            expect(filterQueryTermMatches(testText, 'urgent, project')).to.be.true;
            expect(filterQueryTermMatches(testText, 'urgent, missing')).to.be.false;
        });

        it('should match exact phrases using placeholders', () => {
            const exactPhrases = ['project meeting', 'final report'];

            expect(filterQueryTermMatches(testText, '__PHRASE_0__', exactPhrases)).to.be.true;
            expect(filterQueryTermMatches(testText, '__PHRASE_1__', exactPhrases)).to.be.true;
        });

        it('should not match exact phrases that are not consecutive', () => {
            const exactPhrases = ['urgent report']; // words exist but not consecutive

            expect(filterQueryTermMatches(testText, '__PHRASE_0__', exactPhrases)).to.be.false;
        });

        it('should handle invalid phrase placeholders', () => {
            const exactPhrases = ['project meeting'];

            expect(filterQueryTermMatches(testText, '__PHRASE_1__', exactPhrases)).to.be.false; // index out of bounds
            expect(filterQueryTermMatches(testText, '__PHRASE_0__', [])).to.be.false; // empty phrases array
        });

        it('should handle empty terms', () => {
            expect(filterQueryTermMatches(testText, '')).to.be.true; // empty string includes returns true
        });

        it('should be case insensitive for regular terms', () => {
            expect(filterQueryTermMatches(testText, 'URGENT')).to.be.true;
            expect(filterQueryTermMatches(testText, 'Project Meeting')).to.be.true;
        });

        it('should handle exact phrases with extra whitespace', () => {
            const exactPhrases = ['  project meeting  '];

            expect(filterQueryTermMatches(testText, '__PHRASE_0__', exactPhrases)).to.be.true;
        });

        it('should handle malformed phrase placeholders', () => {
            expect(filterQueryTermMatches(testText, '__PHRASE_abc__')).to.be.false;
            expect(filterQueryTermMatches(testText, '__PHRASE__')).to.be.false;
            expect(filterQueryTermMatches(testText, 'PHRASE_0')).to.be.false;
        });
    });

    describe('Simple integration tests', () => {
        it('should work end-to-end with quoted phrases', () => {
            const query = 'urgent "project meeting" OR "final report"';
            const parsed = parseFilterQueryText(query);
            const testText = 'We have an urgent project meeting scheduled';

            expect(filterQueryTermMatches(testText, parsed.orTerms[0], parsed.exactPhrases)).to.be.true;
            expect(filterQueryTermMatches(testText, parsed.orTerms[1], parsed.exactPhrases)).to.be.false;
        });

        it('should handle complex mixed queries', () => {
            const query = 'status "project deadline" OR urgent, meeting';
            const parsed = parseFilterQueryText(query);

            expect(parsed.andTerms).to.deep.equal([]);
            expect(parsed.orTerms).to.deep.equal(['status __PHRASE_0__', 'urgent, meeting']);
            expect(parsed.exactPhrases).to.deep.equal(['project deadline']);
        });

        it('should preserve AND logic with multiple exact phrases', () => {
            const query = '"first phrase" "second phrase" regular';
            const parsed = parseFilterQueryText(query);

            expect(parsed.andTerms).to.deep.equal(['__PHRASE_0__', '__PHRASE_1__', 'regular']);
            expect(parsed.exactPhrases).to.deep.equal(['first phrase', 'second phrase']);
        });
    });
});
