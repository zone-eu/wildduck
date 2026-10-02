/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { expect } = require('chai');
const { parseListId, parseListUnsubscribe } = require('../lib/list-headers');

describe('#parseListUnsubscribe', function () {
    it('should return an empty list for missing or empty headers', function () {
        expect(parseListUnsubscribe()).to.deep.equal([]);
        expect(parseListUnsubscribe(null)).to.deep.equal([]);
        expect(parseListUnsubscribe('')).to.deep.equal([]);
        expect(parseListUnsubscribe('   ')).to.deep.equal([]);
        expect(parseListUnsubscribe([null, '', '   '])).to.deep.equal([]);
    });

    const validValues = [
        {
            title: 'a mailto URI',
            value: '<mailto:unsub@example.com>',
            expected: [{ address: 'mailto:unsub@example.com', name: '' }]
        },
        {
            title: 'an HTTPS URI',
            value: '<https://example.com/unsubscribe?id=12345>',
            expected: [{ address: 'https://example.com/unsubscribe?id=12345', name: '' }]
        },
        {
            title: 'an HTTP URI',
            value: '<http://example.com/unsubscribe?id=12345>',
            expected: [{ address: 'http://example.com/unsubscribe?id=12345', name: '' }]
        },
        {
            title: 'mailto and HTTPS URIs',
            value: '<mailto:unsub@example.com>, <https://example.com/unsubscribe?id=12345>',
            expected: [
                { address: 'mailto:unsub@example.com', name: '' },
                { address: 'https://example.com/unsubscribe?id=12345', name: '' }
            ]
        },
        {
            title: 'three mixed unsubscribe URIs',
            value: '<https://example.com/unsub>, <https://example.com/unsub-alt>, <mailto:unsub@example.com>',
            expected: [
                { address: 'https://example.com/unsub', name: '' },
                { address: 'https://example.com/unsub-alt', name: '' },
                { address: 'mailto:unsub@example.com', name: '' }
            ]
        },
        {
            title: 'a mailto URI with a subject',
            value: '<mailto:unsub@example.com?subject=unsubscribe>',
            expected: [{ address: 'mailto:unsub@example.com?subject=unsubscribe', name: '' }]
        },
        {
            title: 'a mailto URI with a subject and body',
            value: '<mailto:unsub@example.com?subject=unsubscribe&body=please%20remove%20me>',
            expected: [{ address: 'mailto:unsub@example.com?subject=unsubscribe&body=please%20remove%20me', name: '' }]
        },
        {
            title: 'a comment before the URI',
            value: '(Use this command to get off the list) <mailto:list-manager@host.com?body=unsubscribe%20list>',
            expected: [
                {
                    address: 'mailto:list-manager@host.com?body=unsubscribe%20list',
                    name: 'Use this command to get off the list'
                }
            ]
        },
        {
            title: 'a comment after the URI',
            value: '<mailto:unsub@example.com> (send blank email to unsubscribe)',
            expected: [{ address: 'mailto:unsub@example.com', name: 'send blank email to unsubscribe' }]
        },
        {
            title: 'comments for multiple URIs',
            value: '(Unsubscribe) <mailto:unsub@example.com>, (Web) <https://example.com/unsub>',
            expected: [
                { address: 'mailto:unsub@example.com', name: 'Unsubscribe' },
                { address: 'https://example.com/unsub', name: 'Web' }
            ]
        },
        {
            title: 'a folded header value',
            value: '<mailto:unsub@example.com>,\r\n <https://example.com/unsubscribe?id=12345>',
            expected: [
                { address: 'mailto:unsub@example.com', name: '' },
                { address: 'https://example.com/unsubscribe?id=12345', name: '' }
            ]
        },
        {
            title: 'a folded comment',
            value: '(Click here to\r\n unsubscribe) <mailto:unsub@example.com>',
            expected: [{ address: 'mailto:unsub@example.com', name: 'Click here to unsubscribe' }]
        },
        {
            title: 'an FTP URI',
            value: '<ftp://example.com/unsub>',
            expected: [{ address: 'ftp://example.com/unsub', name: '' }]
        },
        {
            title: 'a news URI (RFC 2369 example scheme)',
            value: '<news:example.list>',
            expected: [{ address: 'news:example.list', name: '' }]
        },
        {
            title: 'an unregistered URI scheme',
            value: '<htps://example.com/unsub>',
            expected: [{ address: 'htps://example.com/unsub', name: '' }]
        },
        {
            title: 'a URI with unencoded non-ASCII characters',
            value: '<https://例え.jp/unsub>',
            expected: [{ address: 'https://例え.jp/unsub', name: '' }]
        },
        {
            title: 'a URI with an unescaped percent sign',
            value: '<https://example.com/unsub?discount=100%>',
            expected: [{ address: 'https://example.com/unsub?discount=100%', name: '' }]
        },
        {
            title: 'leading CFWS',
            value: '  <mailto:unsub@example.com>',
            expected: [{ address: 'mailto:unsub@example.com', name: '' }]
        },
        {
            title: 'commas inside a URI and a comment',
            value: '<https://example.com/unsub?a=1,b=2> (web, preferred), <mailto:unsub@example.com> (email)',
            expected: [
                { address: 'https://example.com/unsub?a=1,b=2', name: 'web, preferred' },
                { address: 'mailto:unsub@example.com', name: 'email' }
            ]
        }
    ];

    for (const test of validValues) {
        it(`should parse ${test.title}`, function () {
            expect(parseListUnsubscribe(test.value)).to.deep.equal(test.expected);
        });
    }

    // malformed values where valid <URI> entries can still be extracted
    const salvagedValues = [
        {
            title: 'URIs without a separating comma',
            value: '<mailto:unsub@example.com> <https://example.com/unsub>',
            expected: [
                { address: 'mailto:unsub@example.com', name: '' },
                { address: 'https://example.com/unsub', name: '' }
            ]
        },
        {
            title: 'a trailing comma',
            value: '<mailto:unsub@example.com>,',
            expected: [{ address: 'mailto:unsub@example.com', name: '' }]
        },
        {
            title: 'a leading comma',
            value: ',<mailto:unsub@example.com>',
            expected: [{ address: 'mailto:unsub@example.com', name: '' }]
        },
        {
            title: 'a double comma',
            value: '<mailto:unsub@example.com>,,<https://example.com/unsub>',
            expected: [
                { address: 'mailto:unsub@example.com', name: '' },
                { address: 'https://example.com/unsub', name: '' }
            ]
        },
        {
            title: 'display-name syntax',
            value: 'Unsubscribe here <mailto:unsub@example.com>',
            expected: [{ address: 'mailto:unsub@example.com', name: '' }]
        },
        {
            title: 'a valid URI followed by an invalid one',
            value: '<mailto:unsub@example.com>, <https://example.com/unsub?id=John Doe>',
            expected: [{ address: 'mailto:unsub@example.com', name: '' }]
        },
        {
            title: 'an unescaped closing angle bracket inside a query string',
            value: '<https://example.com/unsub?id=123>456>',
            expected: [{ address: 'https://example.com/unsub?id=123', name: '' }]
        },
        {
            title: 'a display name and trailing junk around a punycode-like domain',
            value: 'Unsub <mailto:x@xn--foo>, bogus',
            expected: [{ address: 'mailto:x@xn--foo', name: '' }]
        }
    ];

    for (const test of salvagedValues) {
        it(`should salvage valid URIs from ${test.title}`, function () {
            expect(parseListUnsubscribe(test.value)).to.deep.equal(test.expected);
        });
    }

    // values without any valid URI, preserved as the display name with an empty address
    const unparseableValues = [
        {
            title: 'an HTTPS URI without angle brackets',
            value: 'https://example.com/unsubscribe?id=12345'
        },
        {
            title: 'a mailto URI without angle brackets',
            value: 'mailto:unsub@example.com'
        },
        {
            title: 'an email address without a mailto scheme',
            value: '<unsub@example.com>'
        },
        {
            title: 'an unescaped space inside a URI',
            value: '<https://example.com/unsubscribe?id=12345&name=John Doe>'
        },
        {
            title: 'empty angle brackets',
            value: '<>'
        },
        {
            title: 'whitespace inside angle brackets',
            value: '< mailto:unsub@example.com >'
        },
        {
            title: 'RFC 5322 group syntax',
            value: 'Support Team: unsub@example.com;'
        },
        {
            title: 'RFC 5322 group syntax inside angle brackets',
            value: '<Support Team: unsub@example.com;>'
        },
        {
            title: 'a missing closing angle bracket',
            value: '<mailto:unsub@example.com'
        },
        {
            title: 'a missing opening angle bracket',
            value: 'mailto:unsub@example.com>'
        },
        {
            title: 'an unescaped opening angle bracket inside a query string',
            value: '<https://example.com/unsub?id=123<456>>'
        },
        {
            title: 'two URIs separated by a semicolon inside one pair of angle brackets',
            value: '<mailto:unsub@example.com; https://example.com/unsub>'
        }
    ];

    for (const test of unparseableValues) {
        it(`should preserve ${test.title} as the display name`, function () {
            expect(parseListUnsubscribe(test.value)).to.deep.equal([
                {
                    address: '',
                    name: test.value
                }
            ]);
        });
    }

    it('should parse repeated header values', function () {
        expect(parseListUnsubscribe(['<https://example.com/unsub/first>, <mailto:unsub@example.com>', '<https://example.com/unsub/second>'])).to.deep.equal([
            { address: 'https://example.com/unsub/first', name: '' },
            { address: 'mailto:unsub@example.com', name: '' },
            { address: 'https://example.com/unsub/second', name: '' }
        ]);
    });

    it('should handle repeated header values independently', function () {
        expect(parseListUnsubscribe(['<https://example.com/unsub>', 'not a URI'])).to.deep.equal([
            { address: 'https://example.com/unsub', name: '' },
            { address: '', name: 'not a URI' }
        ]);
    });

    it('should skip empty repeated header values', function () {
        expect(parseListUnsubscribe([null, '', undefined, '<https://example.com/unsub>'])).to.deep.equal([
            {
                address: 'https://example.com/unsub',
                name: ''
            }
        ]);
    });

    it('should decode encoded words in comments', function () {
        expect(parseListUnsubscribe('(=?utf-8?q?T=C3=BChista?=) <mailto:unsub@example.com>')).to.deep.equal([
            {
                address: 'mailto:unsub@example.com',
                name: 'Tühista'
            }
        ]);
    });

    it('should accept header values provided as buffers', function () {
        expect(parseListUnsubscribe(Buffer.from('<https://example.com/unsub>'))).to.deep.equal([
            {
                address: 'https://example.com/unsub',
                name: ''
            }
        ]);
    });
});

describe('#parseListId', function () {
    it('should return false for missing or empty headers', function () {
        expect(parseListId()).to.be.false;
        expect(parseListId(null)).to.be.false;
        expect(parseListId('')).to.be.false;
        expect(parseListId('   ')).to.be.false;
        expect(parseListId([])).to.be.false;
    });

    it('should parse a bare list id', function () {
        expect(parseListId('<commonspace-users.host.com>')).to.deep.equal({
            address: 'commonspace-users.host.com',
            name: ''
        });
    });

    it('should parse a quoted display name', function () {
        expect(parseListId('"Commonspace users" <commonspace-users.host.com>')).to.deep.equal({
            address: 'commonspace-users.host.com',
            name: 'Commonspace users'
        });
    });

    it('should parse an unquoted display name', function () {
        expect(parseListId('Commonspace users <commonspace-users.host.com>')).to.deep.equal({
            address: 'commonspace-users.host.com',
            name: 'Commonspace users'
        });
    });

    it('should parse a folded header value', function () {
        expect(parseListId('"Commonspace users"\r\n <commonspace-users.host.com>')).to.deep.equal({
            address: 'commonspace-users.host.com',
            name: 'Commonspace users'
        });
    });

    it('should use the first value of a repeated header', function () {
        expect(parseListId(['<first-list.host.com>', '<second-list.host.com>'])).to.deep.equal({
            address: 'first-list.host.com',
            name: ''
        });
    });

    it('should decode an encoded word display name', function () {
        expect(parseListId('=?utf-8?q?Minu_=C3=BChing?= <commonspace-users.host.com>')).to.deep.equal({
            address: 'commonspace-users.host.com',
            name: 'Minu ühing'
        });
    });

    it('should preserve a malformed value as the display name', function () {
        expect(parseListId('mylist.example.com')).to.deep.equal({
            address: '',
            name: 'mylist.example.com'
        });
    });
});
