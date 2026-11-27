/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { nameComparator } = require('../../../lib/jmap/types/mailbox');

const sorted = (names, collation) =>
    names
        .map(name => ({ name }))
        .sort(nameComparator(collation))
        .map(doc => doc.name);

describe('JMAP Mailbox name sort', () => {
    it('sorts case insensitively by default, with byte order for names that differ only in case', () => {
        expect(sorted(['Charlie', 'alpha', 'Bravo', 'ALPHA'])).to.deep.equal(['ALPHA', 'alpha', 'Bravo', 'Charlie']);
    });

    it('folds non ASCII letters with i;unicode-casemap but not with i;ascii-casemap', () => {
        expect(sorted(['Ä2', 'ä1'], 'i;unicode-casemap')).to.deep.equal(['ä1', 'Ä2']);
        expect(sorted(['b', 'B', 'a'], 'i;ascii-casemap')).to.deep.equal(['a', 'B', 'b']);
    });

    it('compares leading numbers with i;ascii-numeric and puts names without one last', () => {
        expect(sorted(['10 Ten', 'Zero', '9 Nine', '010 Padded', '2'], 'i;ascii-numeric')).to.deep.equal(['2', '9 Nine', '010 Padded', '10 Ten', 'Zero']);
    });

    it('rejects an unknown collation with unsupportedSort', () => {
        expect(() => nameComparator('i;nosuch'))
            .to.throw()
            .with.property('type', 'unsupportedSort');
    });
});
