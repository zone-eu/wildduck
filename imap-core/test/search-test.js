/* eslint-disable no-invalid-this */
/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const parseQueryTerms = require('../lib/commands/search').parseQueryTerms;
const matchSearchQuery = require('../lib/search').matchSearchQuery;
const Indexer = require('../lib/indexer/indexer');
const indexer = new Indexer();
const crypto = require('crypto');

const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

function seededRandom(seed) {
    let counter = 0;
    const seedStr = String(seed);
    return () => {
        const hash = crypto.createHash('sha256').update(seedStr).update(':').update(String(counter++)).digest();
        return hash.readUInt32BE(0) / 0x100000000;
    };
}

function shuffleArray(values, seed) {
    const rng = seededRandom(seed);
    for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
}

function buildLargeSequenceSet(options) {
    options = options || {};
    let parts = [];
    for (let i = 1; i <= 500; i++) {
        parts.push(String(i * 2));
    }
    for (let i = 0; i < 200; i++) {
        let start = 2000 + i * 10;
        parts.push(start + ':' + (start + 5));
    }
    if (options.randomize) {
        shuffleArray(parts, options.seed || 1337);
    }
    return parts.join(',');
}

function buildWeirdSequenceSet() {
    return ['9:5', '2', '2', '7:7', '*', '1:3', '8:10', '4'].join(',');
}

describe('#parseQueryTerms', function () {
    let uidList = [39, 40, 44, 52, 53, 54, 59, 72];

    describe('<sequence set>', function () {
        it('should detect sequence as first argument', function () {
            expect(parseQueryTerms('1,2,4:6'.split(' '), uidList).query).to.deep.equal([
                {
                    key: 'uid',
                    value: [39, 40, 52, 53, 54]
                }
            ]);
        });

        it('should detect sequence as subargument', function () {
            expect(parseQueryTerms('NOT 1,2,4:6'.split(' '), uidList).query).to.deep.equal([
                {
                    key: 'not',
                    value: {
                        key: 'uid',
                        value: [39, 40, 52, 53, 54]
                    }
                }
            ]);
        });
    });

    it('should handle ALL', function () {
        expect(parseQueryTerms('ALL'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'all',
                value: true
            }
        ]);
    });

    it('should handle ANSWERED', function () {
        expect(parseQueryTerms('ANSWERED'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Answered',
                exists: true
            }
        ]);
    });

    it('should handle BCC', function () {
        expect(parseQueryTerms('BCC query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'header',
                header: 'bcc',
                value: 'query'
            }
        ]);
    });

    it('should handle BEFORE', function () {
        expect(parseQueryTerms('BEFORE 1-Feb-1994'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'internaldate',
                operator: '<',
                value: '1-Feb-1994'
            }
        ]);
    });

    it('should handle BODY', function () {
        expect(parseQueryTerms('BODY query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'body',
                value: 'query'
            }
        ]);
    });

    it('should handle CC', function () {
        expect(parseQueryTerms('CC query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'header',
                header: 'cc',
                value: 'query'
            }
        ]);
    });

    it('should handle DELETED', function () {
        expect(parseQueryTerms('DELETED'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Deleted',
                exists: true
            }
        ]);
    });

    it('should handle DRAFT', function () {
        expect(parseQueryTerms('DRAFT'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Draft',
                exists: true
            }
        ]);
    });

    it('should handle FLAGGED', function () {
        expect(parseQueryTerms('FLAGGED'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Flagged',
                exists: true
            }
        ]);
    });

    it('should handle FROM', function () {
        expect(parseQueryTerms('FROM query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'header',
                header: 'from',
                value: 'query'
            }
        ]);
    });

    it('should handle HEADER', function () {
        expect(parseQueryTerms('HEADER X-FOO query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'header',
                header: 'x-foo',
                value: 'query'
            }
        ]);

        expect(parseQueryTerms(['HEADER', 'X-FOO', null], uidList).query).to.deep.equal([
            {
                key: 'header',
                header: 'x-foo',
                value: ''
            }
        ]);
    });

    it('should handle KEYWORD', function () {
        expect(parseQueryTerms('KEYWORD $MyFlag'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '$MyFlag',
                exists: true
            }
        ]);
    });

    it('should handle LARGER', function () {
        expect(parseQueryTerms('LARGER 123'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'size',
                value: 123,
                operator: '>'
            }
        ]);
    });

    describe('MODSEQ', function () {
        it('should handle only required param', function () {
            expect(parseQueryTerms('MODSEQ 123'.split(' '), uidList).query).to.deep.equal([
                {
                    key: 'modseq',
                    value: 123
                }
            ]);
        });

        it('should handle optional params', function () {
            expect(parseQueryTerms('MODSEQ "/flags/\\\\draft" all 123'.split(' '), uidList).query).to.deep.equal([
                {
                    key: 'modseq',
                    value: 123
                }
            ]);
        });
    });

    it('should handle NEW', function () {
        expect(parseQueryTerms('NEW'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Recent',
                exists: true
            },
            {
                key: 'flag',
                value: '\\Seen',
                exists: false
            }
        ]);
    });

    it('should handle NOT', function () {
        expect(parseQueryTerms('NOT ALL'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'not',
                value: {
                    key: 'all',
                    value: true
                }
            }
        ]);

        expect(parseQueryTerms('NOT NOT ALL'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'not',
                value: {
                    key: 'not',
                    value: {
                        key: 'all',
                        value: true
                    }
                }
            }
        ]);
    });

    it('should handle OLD', function () {
        expect(parseQueryTerms('OLD'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Recent',
                exists: false
            }
        ]);
    });

    it('should handle ON', function () {
        expect(parseQueryTerms('ON 1-Feb-1994'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'internaldate',
                operator: '=',
                value: '1-Feb-1994'
            }
        ]);
    });

    it('should handle OR', function () {
        expect(parseQueryTerms('OR ALL NOT ALL'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'or',
                value: [
                    {
                        key: 'all',
                        value: true
                    },
                    {
                        key: 'not',
                        value: {
                            key: 'all',
                            value: true
                        }
                    }
                ]
            }
        ]);
    });

    it('should handle RECENT', function () {
        expect(parseQueryTerms('RECENT'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Recent',
                exists: true
            }
        ]);
    });

    it('should handle SEEN', function () {
        expect(parseQueryTerms('SEEN'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Seen',
                exists: true
            }
        ]);
    });

    it('should handle SENTBEFORE', function () {
        expect(parseQueryTerms('SENTBEFORE 1-Feb-1994'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'date',
                operator: '<',
                value: '1-Feb-1994'
            }
        ]);
    });

    it('should handle SENTON', function () {
        expect(parseQueryTerms('SENTON 1-Feb-1994'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'date',
                operator: '=',
                value: '1-Feb-1994'
            }
        ]);
    });

    it('should handle SENTSINCE', function () {
        expect(parseQueryTerms('SENTSINCE 1-Feb-1994'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'date',
                operator: '>=',
                value: '1-Feb-1994'
            }
        ]);
    });

    it('should handle SINCE', function () {
        expect(parseQueryTerms('SINCE 1-Feb-1994'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'internaldate',
                operator: '>=',
                value: '1-Feb-1994'
            }
        ]);

        let fn = parseQueryTerms.bind(null, 'SINCE XX-ZZZ-YYY'.split(' '), uidList);
        expect(fn).to.throw(Error);
    });

    it('should handle SMALLER', function () {
        expect(parseQueryTerms('SMALLER 123'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'size',
                value: 123,
                operator: '<'
            }
        ]);
    });

    it('should handle SUBJECT', function () {
        expect(parseQueryTerms('SUBJECT query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'header',
                header: 'subject',
                value: 'query'
            }
        ]);
    });

    it('should handle TEXT', function () {
        expect(parseQueryTerms('TEXT query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'text',
                value: 'query'
            }
        ]);
    });

    it('should handle TO', function () {
        expect(parseQueryTerms('TO query'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'header',
                header: 'to',
                value: 'query'
            }
        ]);
    });

    it('should handle UID', function () {
        expect(parseQueryTerms('UID 44,54:*'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'uid',
                value: [44, 54, 59, 72]
            }
        ]);
    });

    it('should handle UNANSWERED', function () {
        expect(parseQueryTerms('UNANSWERED'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Answered',
                exists: false
            }
        ]);
    });

    it('should handle UNDELETED', function () {
        expect(parseQueryTerms('UNDELETED'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Deleted',
                exists: false
            }
        ]);
    });

    it('should handle UNDRAFT', function () {
        expect(parseQueryTerms('UNDRAFT'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Draft',
                exists: false
            }
        ]);
    });

    it('should handle UNFLAGGED', function () {
        expect(parseQueryTerms('UNFLAGGED'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Flagged',
                exists: false
            }
        ]);
    });

    it('should handle UNKEYWORD', function () {
        expect(parseQueryTerms('UNKEYWORD $MyFlag'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '$MyFlag',
                exists: false
            }
        ]);
    });

    it('should handle UNSEEN', function () {
        expect(parseQueryTerms('UNSEEN'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'flag',
                value: '\\Seen',
                exists: false
            }
        ]);
    });

    it('should handle complex query', function () {
        // this is a query by iOS Mail app
        // UID SEARCH (OR FROM "Time" (OR SUBJECT "Time" (OR TO "Time" (OR CC "Time" BODY "Time")))) NOT DELETED
        expect(parseQueryTerms('OR FROM Time OR SUBJECT Time OR TO Time OR CC Time BODY Time NOT DELETED'.split(' '), uidList).query).to.deep.equal([
            {
                key: 'or',
                value: [
                    {
                        key: 'header',
                        header: 'from',
                        value: 'Time'
                    },
                    {
                        key: 'or',
                        value: [
                            {
                                key: 'header',
                                header: 'subject',
                                value: 'Time'
                            },
                            {
                                key: 'or',
                                value: [
                                    {
                                        key: 'header',
                                        header: 'to',
                                        value: 'Time'
                                    },
                                    {
                                        key: 'or',
                                        value: [
                                            {
                                                key: 'header',
                                                header: 'cc',
                                                value: 'Time'
                                            },
                                            {
                                                key: 'body',
                                                value: 'Time'
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            },
            {
                key: 'not',
                value: {
                    key: 'flag',
                    value: '\\Deleted',
                    exists: true
                }
            }
        ]);
    });
});

describe('UID sequence edge cases', function () {
    this.timeout(1000);
    it('should treat bare sequence set as sequence numbers in UID SEARCH', function () {
        const testUidList = [39, 40, 44, 52, 53, 54, 59, 72];

        const parsed = parseQueryTerms(['1:3'], testUidList, true);

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.deep.equal([39, 40, 44]);
    });

    it('should handle overlaps, duplicates, reversed ranges, and *', function () {
        const testUidList = [2, 4, 6, 8, 10, 12];
        const seq = buildWeirdSequenceSet();

        const parsed = parseQueryTerms(['UID', seq], testUidList, true);

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.deep.equal([2, 4, 6, 8, 10, 12]);
    });

    it('should map sequence numbers (non-UID SEARCH) correctly', function () {
        const testUidList = [10, 20, 30, 40, 50];

        const parsed = parseQueryTerms(['2:4'], testUidList, false);

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.deep.equal([20, 30, 40]);
    });

    it('should ignore ranges above max and clamp * to max', function () {
        const testUidList = [5, 7, 9];

        const parsed = parseQueryTerms(['UID', '1:*,100:200'], testUidList, true);

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.deep.equal([5, 7, 9]);
    });

    it('should return empty list for out-of-range only', function () {
        const testUidList = [5, 7, 9];

        const parsed = parseQueryTerms(['UID', '100:200'], testUidList, true);

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.deep.equal([]);
    });
});

describe('UID SEARCH parse performance', function () {
    this.timeout(3000);

    const largeUidList = Array.from({ length: 200000 }, (_, i) => i + 1);
    const largeSequenceSet = buildLargeSequenceSet({ randomize: true, seed: 7331 });
    const orderedSequenceSet = buildLargeSequenceSet();

    it('should parse many individual and ranged UIDs quickly', function () {
        const start = process.hrtime.bigint();
        const parsed = parseQueryTerms(['UID', largeSequenceSet], largeUidList, true);
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.be.an('array');
        expect(elapsedMs).to.be.below(1500);
    });

    it('should parse a large contiguous range quickly', function () {
        const start = process.hrtime.bigint();
        const parsed = parseQueryTerms(['UID', '1:*'], largeUidList, true);
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.have.length(largeUidList.length);
        expect(elapsedMs).to.be.below(1500);
    });

    it('should parse many ordered individual and ranged UIDs quickly', function () {
        const start = process.hrtime.bigint();
        const parsed = parseQueryTerms(['UID', orderedSequenceSet], largeUidList, true);
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.be.an('array');
        expect(elapsedMs).to.be.below(1500);
    });

    it('should parse a very large mixed sequence set quickly', function () {
        const hugeUidList = Array.from({ length: 500000 }, (_, i) => i + 1);
        let parts = [];
        for (let i = 1; i <= 2000; i++) {
            parts.push(String(i * 3));
        }
        for (let i = 0; i < 1000; i++) {
            let start = 100000 + i * 20;
            parts.push(start + ':' + (start + 10));
        }
        parts.push('1:*');
        parts.push('300000:100000'); // reversed range
        parts.push('*'); // max
        const seq = shuffleArray(parts, 4242).join(',');

        const start = process.hrtime.bigint();
        const parsed = parseQueryTerms(['UID', seq], hugeUidList, true);
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

        expect(parsed.query).to.have.length(1);
        expect(parsed.query[0].key).to.equal('uid');
        expect(parsed.query[0].value).to.have.length(hugeUidList.length);
        expect(elapsedMs).to.be.below(3000);
    });
});

describe('Search term match tests', function () {
    describe('AND', function () {
        it('should find all matches', function (done) {
            matchSearchQuery(
                {},
                [
                    {
                        key: 'all',
                        value: true
                    },
                    {
                        key: 'all',
                        value: true
                    },
                    {
                        key: 'all',
                        value: true
                    },
                    {
                        key: 'all',
                        value: true
                    }
                ],
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should fail on single error', function (done) {
            matchSearchQuery(
                {},
                [
                    {
                        key: 'all',
                        value: true
                    },
                    {
                        key: 'all',
                        value: true
                    },
                    {
                        key: 'all',
                        value: true
                    },
                    {
                        key: 'flag',
                        value: 'zzzzzzz',
                        exists: true
                    }
                ],
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('OR', function () {
        it('should succeed with at least one match', function (done) {
            matchSearchQuery(
                {},
                {
                    key: 'or',
                    value: [
                        {
                            key: 'flag',
                            value: 'zzzzzzz',
                            exists: true
                        },
                        {
                            key: 'all',
                            value: true
                        },
                        {
                            key: 'flag',
                            value: 'zzzzzzz',
                            exists: true
                        }
                    ]
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should fail with no matches', function (done) {
            matchSearchQuery(
                {},
                {
                    key: 'or',
                    value: [
                        {
                            key: 'flag',
                            value: 'zzzzzzz',
                            exists: true
                        },
                        {
                            key: 'flag',
                            value: 'zzzzzzz',
                            exists: true
                        }
                    ]
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('NOT', function () {
        it('should succeed with false value', function (done) {
            matchSearchQuery(
                {},
                {
                    key: 'not',
                    value: {
                        key: 'flag',
                        value: 'zzzzzzz',
                        exists: true
                    }
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should fail with thruthy value', function (done) {
            matchSearchQuery(
                {},
                {
                    key: 'not',
                    value: {
                        key: 'all',
                        value: true
                    }
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('ALL', function () {
        it('should match ALL', function (done) {
            matchSearchQuery(
                {},
                {
                    key: 'all',
                    value: true
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });
    });

    describe('FLAG', function () {
        it('should match existing flag', function (done) {
            matchSearchQuery(
                {
                    flags: ['abc', 'def', 'ghi']
                },
                {
                    key: 'flag',
                    value: 'def',
                    exists: true
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should match non-existing flag', function (done) {
            matchSearchQuery(
                {
                    flags: ['abc', 'def', 'ghi']
                },
                {
                    key: 'flag',
                    value: 'zzzzz',
                    exists: false
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should fail non-existing flag', function (done) {
            matchSearchQuery(
                {
                    flags: ['abc', 'def', 'ghi']
                },
                {
                    key: 'flag',
                    value: 'zzzzz',
                    exists: true
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });

        it('should fail existing flag', function (done) {
            matchSearchQuery(
                {
                    flags: ['abc', 'def', 'ghi']
                },
                {
                    key: 'flag',
                    value: 'abc',
                    exists: false
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('INTERNALDATE', function () {
        it('should match <', function (done) {
            matchSearchQuery(
                {
                    idate: new Date('1999-01-01')
                },
                {
                    key: 'internaldate',
                    value: '2001-01-01',
                    operator: '<'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match <', function (done) {
            matchSearchQuery(
                {
                    idate: new Date('1999-01-01')
                },
                {
                    key: 'internaldate',
                    value: '1998-01-01',
                    operator: '<'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });

        it('should match =', function (done) {
            matchSearchQuery(
                {
                    idate: new Date('1999-01-01')
                },
                {
                    key: 'internaldate',
                    value: '1999-01-01',
                    operator: '='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match <', function (done) {
            matchSearchQuery(
                {
                    idate: new Date('1999-01-01')
                },
                {
                    key: 'internaldate',
                    value: '1999-01-02',
                    operator: '='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });

        it('should match >=', function (done) {
            matchSearchQuery(
                {
                    idate: new Date('1999-01-01')
                },
                {
                    key: 'internaldate',
                    value: '1999-01-01',
                    operator: '>='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;

                    matchSearchQuery(
                        {
                            internaldate: new Date('1999-01-02')
                        },
                        {
                            key: 'internaldate',
                            value: '1999-01-01',
                            operator: '>='
                        },
                        (err, match) => {
                            expect(err).to.not.exist;
                            expect(match).to.be.true;
                            done();
                        }
                    );
                }
            );
        });

        it('should not match >=', function (done) {
            matchSearchQuery(
                {
                    idate: new Date('1999-01-01')
                },
                {
                    key: 'internaldate',
                    value: '1999-01-02',
                    operator: '>='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('DATE', function () {
        let raw = 'Subject: test\r\nDate: 1999-01-01\r\n\r\nHello world!';

        it('should match <', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'date',
                    value: '2001-01-01',
                    operator: '<'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match <', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'date',
                    value: '1998-01-01',
                    operator: '<'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });

        it('should match =', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'date',
                    value: '1999-01-01',
                    operator: '='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match <', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'date',
                    value: '1999-01-02',
                    operator: '='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });

        it('should match >=', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'date',
                    value: '1999-01-01',
                    operator: '>='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;

                    matchSearchQuery(
                        {
                            mimeTree: indexer.parseMimeTree(raw)
                        },
                        {
                            key: 'date',
                            value: '1998-01-01',
                            operator: '>='
                        },
                        (err, match) => {
                            expect(err).to.not.exist;
                            expect(match).to.be.true;
                            done();
                        }
                    );
                }
            );
        });

        it('should not match >=', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'date',
                    value: '1999-01-02',
                    operator: '>='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('BODY', function () {
        let raw = 'Subject: test\r\n\r\nHello world!';

        it('should match a string', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'body',
                    value: 'hello'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match a string', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'body',
                    value: 'test'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('TEXT', function () {
        let raw = 'Subject: test\r\n\r\nHello world!';

        it('should match a string', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'text',
                    value: 'hello'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;

                    matchSearchQuery(
                        {
                            mimeTree: indexer.parseMimeTree(raw)
                        },
                        {
                            key: 'text',
                            value: 'test'
                        },
                        (err, match) => {
                            expect(err).to.not.exist;
                            expect(match).to.be.true;
                            done();
                        }
                    );
                }
            );
        });

        it('should not match a string', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'text',
                    value: 'zzzzz'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('UID', function () {
        it('should match message uid', function (done) {
            matchSearchQuery(
                {
                    uid: 123
                },
                {
                    key: 'uid',
                    value: [11, 123, 134]
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match message uid', function (done) {
            matchSearchQuery(
                {
                    uid: 124
                },
                {
                    key: 'uid',
                    value: [11, 123, 134]
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('SIZE', function () {
        it('should match <', function (done) {
            matchSearchQuery(
                {
                    size: 10
                },
                {
                    key: 'size',
                    value: 11,
                    operator: '<'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match <', function (done) {
            matchSearchQuery(
                {
                    size: 10
                },
                {
                    key: 'size',
                    value: 9,
                    operator: '<'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });

        it('should match =', function (done) {
            matchSearchQuery(
                {
                    size: 10
                },
                {
                    key: 'size',
                    value: 10,
                    operator: '='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match =', function (done) {
            matchSearchQuery(
                {
                    size: 10
                },
                {
                    key: 'size',
                    value: 11,
                    operator: '='
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });

        it('should match >', function (done) {
            matchSearchQuery(
                {
                    size: 10
                },
                {
                    key: 'size',
                    value: 9,
                    operator: '>'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match <', function (done) {
            matchSearchQuery(
                {
                    size: 10
                },
                {
                    key: 'size',
                    value: 11,
                    operator: '>'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('header', function () {
        let raw = 'Subject: test\r\n\r\nHello world!';

        it('should match header value', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'header',
                    value: 'test',
                    header: 'subject'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should match empty header value', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'header',
                    value: '',
                    header: 'subject'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match header value', function (done) {
            matchSearchQuery(
                {
                    mimeTree: indexer.parseMimeTree(raw)
                },
                {
                    key: 'header',
                    value: 'tests',
                    header: 'subject'
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.false;
                    done();
                }
            );
        });
    });

    describe('MODSEQ', function () {
        it('should match equal modseq', function (done) {
            matchSearchQuery(
                {
                    modseq: 500
                },
                {
                    key: 'modseq',
                    value: [500]
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should match greater modseq', function (done) {
            matchSearchQuery(
                {
                    modseq: 1000
                },
                {
                    key: 'modseq',
                    value: [500]
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });

        it('should not match lesser modseq', function (done) {
            matchSearchQuery(
                {
                    modseq: 500
                },
                {
                    key: 'modseq',
                    value: [100]
                },
                (err, match) => {
                    expect(err).to.not.exist;
                    expect(match).to.be.true;
                    done();
                }
            );
        });
    });
});
