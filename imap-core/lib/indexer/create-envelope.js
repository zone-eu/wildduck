'use strict';

const libmime = require('libmime');
const punycode = require('punycode.js');

// This module converts message structure into an ENVELOPE object

/**
 * Decodes RFC 2047 encoded words in a header value, keeping the value as it is when it can not be
 * decoded (an unknown charset, most of the time)
 *
 * @param {String} value Header value
 * @returns {String} Decoded value
 */
function decodeWordsSafe(value) {
    value = (value || '').toString();
    try {
        return libmime.decodeWords(value);
    } catch (E) {
        return value;
    }
}

/**
 * Convert a message header object to an ENVELOPE object
 *
 * @param {Object} header A parsed mime tree node
 * @return {Object} ENVELOPE compatible object
 */
module.exports = function (header) {
    // the last non-empty Subject header wins. The parsed value is already a string, decoding it as
    // bytes again would turn every non-ASCII character into U+FFFD (RFC 6532 raw UTF-8 subjects)
    let subject = Array.isArray(header.subject) ? header.subject.findLast(line => line.trim()) : header.subject;
    subject = Buffer.from(decodeWordsSafe(subject).trim());

    // RFC 3501 7.4.2: the date is a string. Trees written before the parser reduced duplicate Date
    // headers to one value may hold a list, the last header wins like everywhere else
    let date = Array.isArray(header.date) ? header.date[header.date.length - 1] : header.date;

    return [
        date || null,
        subject,
        processAddress(header.from),
        processAddress(header.sender, header.from),
        processAddress(header['reply-to'], header.from),
        processAddress(header.to),
        processAddress(header.cc),
        processAddress(header.bcc),
        header['in-reply-to'] || null,
        header['message-id'] || null
    ];
};

module.exports.decodeWordsSafe = decodeWordsSafe;

/**
 * Converts an address object to a list of arrays
 * [{name: 'User Name', address:'user@example.com'}] -> [['User Name', null, 'user', 'example.com']]
 *
 * @param {Array} arr An array of address objects
 * @return {Array} A list of addresses
 */
function processAddress(arr, defaults) {
    arr = [].concat(arr || []);
    if (!arr.length) {
        arr = [].concat(defaults || []);
    }
    if (!arr.length) {
        return null;
    }
    let result = [];
    arr.forEach(addr => {
        if (addr.group) {
            // Handle group syntax
            result.push([null, null, Buffer.from(decodeWordsSafe(addr.name)), null]);
            result = result.concat(processAddress(addr.group) || []);
            result.push([null, null, null, null]);
            return;
        }

        let name = addr.name || null;
        let user = (addr.address || '').split('@').shift() || null;
        let domain = (addr.address || '').split('@').pop() || null;

        if (!addr.address && name) {
            // a bare word without a domain ("To: localuser"). RFC 3501 7.4.2 reserves a NIL host
            // for group markers, so the token becomes the mailbox with the placeholder host that
            // Dovecot uses for the same input
            user = name;
            name = null;
            domain = 'MISSING_DOMAIN';
        }

        if (domain) {
            try {
                domain = punycode.toUnicode(domain);
            } catch (E) {
                // keep as is
            }
        }

        result.push([name ? Buffer.from(decodeWordsSafe(name)) : null, null, user ? Buffer.from(decodeWordsSafe(user)) : null, domain ? Buffer.from(domain) : null]);
    });

    return result;
}
