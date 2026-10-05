/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const parseDate = require('../lib/parse-date');

chai.config.includeStack = true;

const iso = str => parseDate(str, new Date(0)).toISOString();

describe('parseDate', function () {
    it('parses RFC 5322 dates with numeric zones', function () {
        expect(iso('Thu, 15 May 2014 13:53:30 +0000')).to.equal('2014-05-15T13:53:30.000Z');
        expect(iso('Thu, 15 May 2014 13:53:30 -0700')).to.equal('2014-05-15T20:53:30.000Z');
        expect(iso('15 May 2014 13:53:30 +0300')).to.equal('2014-05-15T10:53:30.000Z');
    });

    it('resolves alphabetic zones', function () {
        expect(iso('Thu, 15 May 2014 13:53:30 EEST')).to.equal('2014-05-15T10:53:30.000Z');
        expect(iso('Thu, 15 May 2014 13:53:30 PDT')).to.equal('2014-05-15T20:53:30.000Z');
        expect(iso('Thu, 15 May 2014 13:53:30 GMT')).to.equal('2014-05-15T13:53:30.000Z');
        expect(iso('Thu, 15 May 2014 13:53:30 UT')).to.equal('2014-05-15T13:53:30.000Z');
    });

    it('ignores a trailing comment', function () {
        expect(iso('Thu, 15 May 2014 13:53:30 -0700 (PDT)')).to.equal('2014-05-15T20:53:30.000Z');
    });

    it('accepts obsolete two digit years and a missing seconds field', function () {
        expect(iso('15 May 14 13:53 +0000')).to.equal('2014-05-15T13:53:00.000Z');
        expect(iso('15 May 99 13:53:30 +0000')).to.equal('1999-05-15T13:53:30.000Z');
    });

    it('falls back to the default date for unparseable input', function () {
        let fallback = new Date('2020-01-02T03:04:05Z');
        expect(parseDate('not a date', fallback)).to.equal(fallback);
        expect(parseDate('', fallback)).to.equal(fallback);
    });

    it('passes a Date object through', function () {
        let date = new Date('2020-01-02T03:04:05Z');
        expect(parseDate(date)).to.equal(date);
    });

    it('returns the calendar day the header names, disregarding time and zone', function () {
        // RFC 3501 6.4.4 for SENTBEFORE, SENTON and SENTSINCE
        let header = 'Thu, 15 May 2014 23:30:00 -0700';
        let day = parseDate.getCalendarDay(parseDate(header), header);
        expect(day.toISOString()).to.equal('2014-05-15T00:00:00.000Z');

        header = 'Fri, 16 May 2014 00:30:00 +0300';
        day = parseDate.getCalendarDay(parseDate(header), header);
        expect(day.toISOString()).to.equal('2014-05-16T00:00:00.000Z');
    });
});
