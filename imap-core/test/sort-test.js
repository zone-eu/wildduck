/* eslint-disable no-invalid-this */
/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { parseSortCommand } = require('../lib/commands/sort');
const { sortSearchResults } = require('../lib/sort-search-results');

const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

describe('#parseSortCommand', function () {
    const uidList = [45, 49, 50, 52, 53, 60];

    it('should parse SORT arguments', function () {
        const parsed = parseSortCommand(
            [
                [{ type: 'ATOM', value: 'SUBJECT' }, { type: 'ATOM', value: 'REVERSE' }, { type: 'ATOM', value: 'DATE' }],
                { type: 'ATOM', value: 'UTF-8' },
                { type: 'ATOM', value: 'ALL' }
            ],
            uidList
        );

        expect(parsed.sort).to.deep.equal([
            { key: 'subject', reverse: false },
            { key: 'date', reverse: true }
        ]);
        expect(parsed.charset).to.equal('UTF-8');
        expect(parsed.query).to.deep.equal([
            {
                key: 'all',
                value: true
            }
        ]);
    });

    it('should fail on invalid sort criteria', function () {
        const fn = parseSortCommand.bind(null, [[{ type: 'ATOM', value: 'THREADID' }], { type: 'ATOM', value: 'UTF-8' }, { type: 'ATOM', value: 'ALL' }], uidList);
        expect(fn).to.throw(/Invalid sort criterion/i);
    });

    it('should fail when search criteria is missing', function () {
        const fn = parseSortCommand.bind(null, [[{ type: 'ATOM', value: 'FROM' }], { type: 'ATOM', value: 'UTF-8' }], uidList);
        expect(fn).to.throw(/Invalid arguments for SORT|Missing search criteria for SORT/i);
    });
});

describe('#sortSearchResults', function () {
    it('should sort by FROM with empty values first', function () {
        const messages = [
            { uid: 10, seq: 1, headers: [{ key: 'from', value: 'z@example.com' }] },
            { uid: 20, seq: 2, headers: [{ key: 'from', value: 'a@example.com' }] },
            { uid: 30, seq: 3, headers: [] }
        ];

        const sorted = sortSearchResults(messages, [{ key: 'from', reverse: false }]).map(message => message.uid);
        expect(sorted).to.deep.equal([30, 20, 10]);
    });

    it('should keep sequence order for equal values even with REVERSE', function () {
        const messages = [
            { uid: 10, seq: 1, headers: [{ key: 'from', value: 'same@example.com' }] },
            { uid: 20, seq: 2, headers: [{ key: 'from', value: 'same@example.com' }] },
            { uid: 30, seq: 3, headers: [{ key: 'from', value: 'same@example.com' }] }
        ];

        const sorted = sortSearchResults(messages, [{ key: 'from', reverse: true }]).map(message => message.uid);
        expect(sorted).to.deep.equal([10, 20, 30]);
    });

    it('should normalize subject prefixes for SUBJECT sort', function () {
        const messages = [
            { uid: 10, seq: 1, subject: 'Re: hello' },
            { uid: 20, seq: 2, subject: 'hello' },
            { uid: 30, seq: 3, subject: '[ext] Fwd: hello' }
        ];

        const sorted = sortSearchResults(messages, [{ key: 'subject', reverse: false }]).map(message => message.uid);
        expect(sorted).to.deep.equal([10, 20, 30]);
    });

    it('should unwrap [fwd: ...] wrapper for SUBJECT sort', function () {
        const messages = [
            { uid: 10, seq: 1, subject: '[fwd: Re: hello]' },
            { uid: 20, seq: 2, subject: 'hello' },
            { uid: 30, seq: 3, subject: '[fwd: [ext] Fwd: hello]' }
        ];

        const sorted = sortSearchResults(messages, [{ key: 'subject', reverse: false }]).map(message => message.uid);
        expect(sorted).to.deep.equal([10, 20, 30]);
    });
});
