'use strict';

const addressparser = require('nodemailer/lib/addressparser');
const libmime = require('libmime');

const SORT_KEYS = new Set(['arrival', 'cc', 'date', 'from', 'size', 'subject', 'to']);

module.exports.SORT_KEYS = SORT_KEYS;
module.exports.sortSearchResults = sortSearchResults;

function sortSearchResults(messages, sortCriteria, options) {
    messages = [].concat(messages || []);
    sortCriteria = []
        .concat(sortCriteria || [])
        .map(entry => ({
            key: (entry?.key || '').toString().toLowerCase().trim(),
            reverse: !!entry?.reverse
        }))
        .filter(entry => SORT_KEYS.has(entry.key));

    if (!messages.length || !sortCriteria.length) {
        return messages;
    }

    options = options || {};
    const uidList = [].concat(options.uidList || []);
    const uidIndex = new Map();
    for (let i = 0; i < uidList.length; i++) {
        uidIndex.set(uidList[i], i + 1);
    }

    const collator = options.collator || new Intl.Collator(undefined, { sensitivity: 'base', usage: 'sort' }); // i;unicode-casemap collation

    const decorated = messages.map((message, index) => {
        const values = {};
        for (let i = 0; i < sortCriteria.length; i++) {
            values[sortCriteria[i].key] = getSortValue(message, sortCriteria[i].key);
        }

        let seq = Number(message?.seq) || 0;
        if (!seq) {
            seq = uidIndex.get(message?.uid) || index + 1;
        }

        return {
            message,
            seq,
            values
        };
    });

    decorated.sort((a, b) => {
        for (let i = 0; i < sortCriteria.length; i++) {
            const criterion = sortCriteria[i];
            const key = criterion.key;
            const aValue = a.values[key];
            const bValue = b.values[key];

            let cmp = 0;
            if (key === 'arrival' || key === 'date' || key === 'size') {
                cmp = compareNumbers(aValue, bValue);
            } else {
                cmp = collator.compare(aValue || '', bValue || '');
            }

            if (cmp) {
                return criterion.reverse ? -cmp : cmp;
            }
        }

        // RFC 5256 tie-breaker: mailbox order (sequence number)
        return a.seq - b.seq;
    });

    return decorated.map(entry => entry.message);
}

function compareNumbers(a, b) {
    a = Number(a) || 0;
    b = Number(b) || 0;

    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
}

function getSortValue(message, key) {
    switch (key) {
        case 'arrival':
            return getTimestamp(message?.idate);

        case 'date':
            return getTimestamp(resolveSentDate(message));

        case 'size':
            return Number(message?.size) || 0;

        case 'subject':
            return normalizeBaseSubject(resolveSubject(message));

        case 'from':
        case 'to':
        case 'cc':
            return resolveFirstMailbox(message, key);
    }

    return '';
}

function getTimestamp(value) {
    if (!value) {
        return false;
    }

    if ('getTime' in value) {
        value = value.getTime();
    }

    if (typeof value === 'string') {
        value = new Date(value).getTime();
    }

    if (!Number.isFinite(value)) {
        return false;
    }

    return value || false;
}

function resolveSentDate(message) {
    let headerDate = message?.hdate;
    if (!headerDate && message?.mimeTree?.parsedHeader) {
        headerDate = [].concat(message.mimeTree.parsedHeader.date || []).pop() || false;
    }

    return headerDate || message?.idate || false;
}

function resolveSubject(message) {
    let subject = (message && message.subject) || '';

    if (!subject) {
        subject = getIndexedHeaderValue(message, 'subject');
    }

    if (!subject && message && message.mimeTree && message.mimeTree.parsedHeader) {
        subject = [].concat(message.mimeTree.parsedHeader.subject || []).pop() || '';
    }

    subject = (subject || '').toString();
    try {
        subject = libmime.decodeWords(subject);
    } catch (E) {
        // ignore decode errors
    }

    return subject;
}

function normalizeBaseSubject(subject) {
    subject = (subject || '')
        .toString()
        .replace(/\r?\n|\t/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Keep behavior aligned with existing WildDuck subject normalization
    let match = true;
    while (match) {
        match = false;

        // RFC 5256 step 6 style wrapper: [fwd: ...]
        // Unwrap and re-run normalization from the start.
        let fwdWrapper = subject.match(/^\[fwd:\s*(.*?)\s*\]$/i);
        if (fwdWrapper) {
            subject = (fwdWrapper[1] || '').trim();
            match = true;
            continue;
        }

        subject = subject
            .replace(/^(re|fwd?)\s*:|^\[.+?\](?=\s.+)|\s*\(fwd\)\s*$/gi, () => {
                match = true;
                return '';
            })
            .trim();
    }

    return subject;
}

function resolveFirstMailbox(message, key) {
    // Prefer parsed address objects from mime tree (imap-core test server messages)
    let parsed = resolveParsedHeaderAddresses(message, key);
    if (parsed.length) {
        return parsed[0];
    }

    // Fall back to indexed header value (WildDuck DB messages)
    parsed = parseAddressList(getIndexedHeaderValue(message, key));
    if (parsed.length) {
        return parsed[0];
    }

    // Fall back to ENVELOPE if available
    const envelopePos = {
        from: 2,
        to: 5,
        cc: 6
    }[key];

    const envelopeAddresses = message && Array.isArray(message.envelope) && Array.isArray(message.envelope[envelopePos]) ? message.envelope[envelopePos] : [];
    if (envelopeAddresses.length && Array.isArray(envelopeAddresses[0])) {
        const first = envelopeAddresses[0];
        const user = (first[2] || '').toString().trim();
        const domain = (first[3] || '').toString().trim();
        return normalizeMailboxAddress(user && domain ? `${user}@${domain}` : user);
    }

    return '';
}

function resolveParsedHeaderAddresses(message, key) {
    const value =
        message && message.mimeTree && message.mimeTree.parsedHeader && Object.prototype.hasOwnProperty.call(message.mimeTree.parsedHeader, key)
            ? message.mimeTree.parsedHeader[key]
            : false;

    if (!value) {
        return [];
    }

    if (Array.isArray(value) && value.length && value[0] && typeof value[0] === 'object' && value[0].address) {
        return value.map(entry => normalizeMailboxAddress(entry && entry.address)).filter(Boolean);
    }

    return parseAddressList(value);
}

function parseAddressList(value) {
    if (!value) {
        return [];
    }

    let input = value;
    if (Array.isArray(input)) {
        input = input.map(entry => (entry || '').toString()).join(', ');
    }

    try {
        return addressparser((input || '').toString())
            .map(entry => normalizeMailboxAddress(entry && entry.address))
            .filter(Boolean);
    } catch (E) {
        return [];
    }
}

function getIndexedHeaderValue(message, key) {
    const headers = (message && message.headers) || [];

    for (let i = 0; i < headers.length; i++) {
        const entry = headers[i];
        if (!entry) {
            continue;
        }

        if (entry?.key && entry?.value && entry.key.toString().toLowerCase() === key) {
            return entry.value.toString();
        }

        if (typeof entry === 'string') {
            const splitPos = entry.indexOf(':');
            if (splitPos < 0) {
                continue;
            }

            const headerKey = entry.substring(0, splitPos).trim().toLowerCase();
            if (headerKey === key) {
                return entry.substring(splitPos + 1).trim();
            }
        }
    }

    return '';
}

function normalizeMailboxAddress(address) {
    address = (address || '').toString().trim();
    if (!address) {
        return '';
    }

    if (address.charAt(0) === '<' && address.charAt(address.length - 1) === '>') {
        address = address.substring(1, address.length - 1);
    }

    return address.toLowerCase();
}
