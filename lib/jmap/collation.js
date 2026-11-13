'use strict';

// RFC 4790 collations as sort keys, for the string sorts of Mailbox/query and Email/query. Two strings
// compare under a collation like their keys compare with `<`. i;unicode-casemap (RFC 5051) is the
// default: names and subjects are expected in case insensitive order, with accented letters next to
// their base letters.

const { COLLATIONS } = require('./capabilities');

const NUMERIC = /^[0-9]+/;
// width of the digit count in front of a number key (base 36, up to 1.6 million digits)
const COUNT_WIDTH = 4;

const KEYS = {
    'i;ascii-casemap': value => value.replace(/[a-z]+/g, letters => letters.toUpperCase()),
    'i;unicode-casemap': value => value.normalize('NFKD').toUpperCase(),
    // the leading number as (digit count, digits): a longer number is larger, numbers of the same length
    // compare digit by digit. A string without a number sorts last
    'i;ascii-numeric': value => {
        const match = NUMERIC.exec(value);
        if (!match) {
            return '\uffff';
        }
        const digits = match[0].replace(/^0+(?=.)/, '');
        return digits.length.toString(36).padStart(COUNT_WIDTH, '0') + digits;
    }
};

const DEFAULT_COLLATION = 'i;unicode-casemap';

/**
 * The sort key function of a collation, or null when the collation is not supported.
 *
 * @param {String} [collation] Defaults to i;unicode-casemap
 * @returns {Function|null} string -> key
 */
function collationKey(collation = DEFAULT_COLLATION) {
    return COLLATIONS.includes(collation) && KEYS[collation] ? KEYS[collation] : null;
}

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

module.exports = { collationKey, compareStrings, DEFAULT_COLLATION };
