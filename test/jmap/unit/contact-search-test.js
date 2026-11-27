/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const search = require('../../../lib/jmap/contact-search');
const { sniff, mediaTypeFor, parseDataUri } = require('../../../lib/jmap/contact-media');

const SARAH = {
    name: {
        components: [
            { kind: 'given', value: 'Sarah' },
            { kind: 'surname', value: 'Johnson' }
        ],
        sortAs: { surname: 'Johnsson' }
    },
    emails: { e: { address: 'sarah.johnson@example.com', label: 'Work mail' } },
    notes: { n: { note: 'She said "hello" at the  conference' } }
};

const matches = (card, property, value) => search.matchesSearch(search.searchFields(card), search.FILTER_FIELDS[property], search.parseSearch(value));

describe('ContactCard text search', () => {
    it('splits tokens and phrases', () => {
        expect(search.parseSearch("  Sarah   \"cats and dogs\" 'O\\'Brien'  ")).to.deep.equal(['sarah', 'cats and dogs', "o'brien"]);
        expect(search.parseSearch('"said \\"hello\\""')).to.deep.equal(['said "hello"']);
        expect(search.parseSearch('"unbalanced')).to.deep.equal(['"unbalanced']);
        expect(search.parseSearch('   ')).to.deep.equal([]);
    });

    it('matches on word boundaries, case insensitively', () => {
        expect(search.containsWord('cats and dogs', 'and')).to.be.true;
        expect(search.containsWord('sandra', 'and')).to.be.false;
        expect(search.containsWord('carlos@example.org', 'example.org')).to.be.true;
        expect(search.containsWord('+1-555-0100', '0100')).to.be.true;
        expect(matches(SARAH, 'name', 'SARAH johnson')).to.be.true;
        expect(matches(SARAH, 'name', 'tallinn')).to.be.false;
        expect(matches(SARAH, 'email', 'work mail')).to.be.true;
        expect(matches(SARAH, 'note', '"said \\"hello\\" at the conference"')).to.be.true;
        expect(matches(SARAH, 'text', 'sarah conference')).to.be.true;
        expect(matches(SARAH, 'name/given', 'Johnson')).to.be.false;
    });

    it('derives search terms and a narrowing condition', () => {
        const { terms, truncated } = search.termsOf(SARAH);
        expect(terms).to.include.members(['n:sarah', 'g:sarah', 's:johnson', 'e:example', 't:conference']);
        expect(truncated).to.be.false;
        expect(search.termsCondition(['e'], search.parseSearch('example.org'))).to.deep.equal({
            $or: [{ $and: [{ terms: 'e:example' }, { terms: 'e:org' }] }, { termsTruncated: true }]
        });
        expect(search.termsCondition(['e'], search.parseSearch('.*'))).to.equal(null);
        const many = { notes: { n: { note: Array.from({ length: 1500 }, (_, index) => `word${index}`).join(' ') } } };
        expect(search.termsOf(many).truncated).to.be.true;
    });

    it('sorts by name components with sortAs, missing values last', () => {
        expect(search.sortValues(SARAH)).to.deep.equal({ given: 'Sarah', surname: 'Johnsson' });
        const compare = search.compileSort([{ property: 'name/surname', isAscending: false }]);
        const records = [
            { id: 'a', sort: { surname: 'adams' } },
            { id: 'b', sort: {} },
            { id: 'c', sort: { surname: 'Brown' } }
        ];
        expect(records.sort(compare).map(record => record.id)).to.deep.equal(['c', 'a', 'b']);
        expect(search.compileSort([{ property: 'uid' }])).to.equal(null);
        expect(search.compileSort([{ property: 'created', collation: 'i;nonsense' }])).to.equal(null);
    });
});

describe('ContactCard media', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

    it('recognises image and audio files by their content', () => {
        expect(sniff(PNG)).to.equal('image/png');
        expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).to.equal('image/jpeg');
        expect(sniff(Buffer.from('GIF89a...'))).to.equal('image/gif');
        expect(sniff(Buffer.from('OggS....'))).to.equal('audio/ogg');
        expect(sniff(Buffer.from('%PDF-1.4'))).to.equal(null);
        expect(mediaTypeFor('photo', PNG, 'image/jpeg')).to.equal('image/png');
        expect(mediaTypeFor('photo', Buffer.from('text'), 'image/png')).to.equal(null);
        expect(mediaTypeFor('sound', PNG, null)).to.equal(null);
        expect(mediaTypeFor('example.com:x', Buffer.from('text'), 'text/plain')).to.equal('text/plain');
        expect(mediaTypeFor('photo', Buffer.alloc(0), 'image/png')).to.equal(null);
    });

    it('parses data URIs', () => {
        expect(parseDataUri(`data:image/png;base64,${PNG.toString('base64')}`, 1000)).to.deep.equal({ type: 'image/png', content: PNG });
        expect(parseDataUri('data:,hello%20world', 1000)).to.deep.equal({ type: null, content: Buffer.from('hello world') });
        expect(parseDataUri('data:image/png;base64,###', 1000)).to.equal(null);
        expect(parseDataUri('https://example.com/', 1000)).to.equal(null);
        expect(() => parseDataUri(`data:image/png;base64,${Buffer.alloc(2000).toString('base64')}`, 1000)).to.throw(/too large/);
    });
});
