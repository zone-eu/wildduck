/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { parseUTCDate, formatUTCDate } = require('../../../lib/jmap/utcdate');
const { keywordsOf, isKeyword, flagOfKeyword } = require('../../../lib/jmap/email-model');

describe('JMAP UTCDate', () => {
    it('parses UTCDate only', () => {
        expect(parseUTCDate('2014-10-30T14:12:00Z').toISOString()).to.equal('2014-10-30T14:12:00.000Z');
        expect(parseUTCDate('2014-10-30T14:12:00.5Z').toISOString()).to.equal('2014-10-30T14:12:00.500Z');
        expect(parseUTCDate('2016-02-29T00:00:00Z').toISOString()).to.equal('2016-02-29T00:00:00.000Z');
        const invalid = [
            '2014-10-30T14:12:00+02:00',
            '2014-10-30',
            'yesterday',
            1414678320,
            null,
            '2014-02-30T00:00:00Z',
            '2018-02-29T00:00:00Z',
            '2014-13-01T00:00:00Z',
            '2014-10-30T24:00:00Z',
            '2014-10-30T14:60:00Z',
            '2014-10-30t14:12:00z',
            '2014-10-30T14:12:00.Z'
        ];
        for (const value of invalid) {
            expect(parseUTCDate(value), String(value)).to.equal(null);
        }
    });

    it('formats without a zero fraction', () => {
        expect(formatUTCDate(new Date('2030-01-01T00:00:00.000Z'))).to.equal('2030-01-01T00:00:00Z');
        expect(formatUTCDate(new Date('2030-01-02T03:04:05.250Z'))).to.equal('2030-01-02T03:04:05.250Z');
        expect(formatUTCDate(new Date('2030-01-02T03:04:05.250Z'), { seconds: true })).to.equal('2030-01-02T03:04:05Z');
        expect(formatUTCDate(null)).to.equal(null);
    });
});

describe('JMAP keywords', () => {
    it('tells keywords from other strings', () => {
        for (const keyword of ['$seen', 'Custom', 'a/b~', 'k'.repeat(255)]) {
            expect(isKeyword(keyword), keyword).to.be.true;
        }
        for (const value of ['', 'a b', 'a(b', 'a]', 'a%', 'a*', 'a"', 'a\\b', 'k'.repeat(256), 'ä', 5, null]) {
            expect(isKeyword(value), String(value)).to.be.false;
        }
    });

    it('maps keywords to IMAP flags and back', () => {
        expect(['$Seen', '$flagged', '$answered', '$draft', '$forwarded', '$MDNSent', 'Custom'].map(flagOfKeyword)).to.deep.equal([
            '\\Seen',
            '\\Flagged',
            '\\Answered',
            '\\Draft',
            '$Forwarded',
            '$MDNSent',
            'Custom'
        ]);
        expect(keywordsOf({ flags: ['\\Seen', '\\Answered', '$Forwarded', 'Custom', '\\Deleted', '\\Recent'], labels: [] }, new Set())).to.deep.equal({
            $seen: true,
            $answered: true,
            $forwarded: true,
            custom: true
        });
    });
});
