'use strict';

// Header access for JMAP Email objects (RFC 8621 4.1.2 and 4.1.3): the raw header fields of a MIME
// node, the parsed forms (Raw, Text, Addresses, GroupedAddresses, MessageIds, Date, URLs) and which
// form is allowed for which field.

const libmime = require('libmime');
const addressparser = require('nodemailer/lib/addressparser');

// fields RFC 8621 4.1.2 names per form; a field not listed in any of these may use every form
const ADDRESS_FIELDS = [
    'from',
    'sender',
    'reply-to',
    'to',
    'cc',
    'bcc',
    'resent-from',
    'resent-sender',
    'resent-reply-to',
    'resent-to',
    'resent-cc',
    'resent-bcc'
];
const MESSAGE_ID_FIELDS = ['message-id', 'in-reply-to', 'references', 'resent-message-id'];
const DATE_FIELDS = ['date', 'resent-date'];
const URL_FIELDS = ['list-help', 'list-unsubscribe', 'list-subscribe', 'list-post', 'list-owner', 'list-archive'];
const TEXT_FIELDS = ['subject', 'comments', 'keywords', 'list-id'];
// RFC 8621 4.1.2: the forms are restricted for the fields RFC 5322 and RFC 2369 define (and List-Id);
// any other field, MIME fields included, may use every form
const KNOWN = new Set([...ADDRESS_FIELDS, ...MESSAGE_ID_FIELDS, ...DATE_FIELDS, ...URL_FIELDS, ...TEXT_FIELDS, 'return-path', 'received']);

const FORM_FIELDS = {
    asAddresses: ADDRESS_FIELDS,
    asGroupedAddresses: ADDRESS_FIELDS,
    asMessageIds: MESSAGE_ID_FIELDS,
    asDate: DATE_FIELDS,
    asURLs: URL_FIELDS,
    asText: TEXT_FIELDS
};
const FORMS = ['asRaw', 'asText', 'asAddresses', 'asGroupedAddresses', 'asMessageIds', 'asDate', 'asURLs'];

/** True when the form may be requested for the field (RFC 8621 4.1.2). Raw is always allowed. */
function formAllowed(field, form) {
    const name = field.toLowerCase();
    if (form === 'asRaw' || !KNOWN.has(name)) {
        return FORMS.includes(form);
    }
    return (FORM_FIELDS[form] || []).includes(name);
}

/**
 * Parses a header property name "header:{name}[:as{Form}][:all]".
 *
 * @returns {{field: String, form: String, all: Boolean}|null}
 */
function parseHeaderProperty(property) {
    const match = /^header:([\x21-\x39\x3b-\x7e]+)(?::(as[A-Za-z]+))?(:all)?$/.exec(property);
    if (!match || (match[2] && !FORMS.includes(match[2]))) {
        return null;
    }
    return { field: match[1], form: match[2] || 'asRaw', all: !!match[3] };
}

// stored header lines are binary strings of the original bytes; most of them are UTF-8 or ASCII
function decodeLine(line) {
    const buffer = Buffer.from(line, 'binary');
    const text = buffer.toString('utf8');
    return text.includes('�') ? buffer.toString('latin1') : text;
}

/** The header fields of a MIME node, in order: [{name, value}] with the raw value after the colon */
function headerFields(node) {
    const fields = [];
    for (const line of node.header || []) {
        const decoded = decodeLine(line);
        const colon = decoded.indexOf(':');
        if (colon > 0) {
            fields.push({ name: decoded.slice(0, colon), value: decoded.slice(colon + 1) });
        }
    }
    return fields;
}

const unfold = value => value.replace(/\r?\n(?=[ \t])/g, '').replace(/\r?\n$/, '');

function decodeWords(value) {
    try {
        return libmime.decodeWords(value);
    } catch {
        return value;
    }
}

/** Text form: unfolded, leading spaces removed, encoded words decoded, NFC normalised */
const asText = value =>
    decodeWords(
        unfold(value)
            .replace(/^[ \t]+/, '')
            .replace(/[ \t]+$/, '')
    ).normalize('NFC');

function toAddress(entry) {
    return { name: entry.name ? decodeWords(entry.name).normalize('NFC') : null, email: entry.address || '' };
}

function asGroupedAddresses(value) {
    const groups = [];
    let loose = null;
    for (const entry of addressparser(unfold(value))) {
        if (entry.group) {
            loose = null;
            groups.push({ name: entry.name ? decodeWords(entry.name) : '', addresses: entry.group.map(toAddress) });
        } else {
            if (!loose) {
                loose = { name: null, addresses: [] };
                groups.push(loose);
            }
            loose.addresses.push(toAddress(entry));
        }
    }
    return groups;
}

const asAddresses = value => asGroupedAddresses(value).flatMap(group => group.addresses);

function asMessageIds(value) {
    const ids = unfold(value).match(/<[^<>\s]+>/g);
    if (ids) {
        return ids.map(id => id.slice(1, -1));
    }
    // a bare id without angle brackets (not RFC 5322 conformant, but common)
    const bare = unfold(value).trim();
    return /^[^\s<>@]+@[^\s<>@]+$/.test(bare) ? [bare] : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ZONES = { ut: 0, gmt: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 };

/** Date form: an RFC 3339 date-time keeping the zone offset of the header, or null if not parsable */
function asDate(value) {
    const match = /(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[a-z]{1,5})?/i.exec(
        unfold(value).replace(/\([^)]*\)/g, ' ')
    );
    if (!match || !(match[2].toLowerCase() in MONTHS)) {
        return null;
    }
    let year = Number(match[3]);
    year += year < 50 ? 2000 : year < 1000 ? 1900 : 0;
    const zone = (match[7] || '+0000').toLowerCase();
    const offset = /^[+-]\d{4}$/.test(zone) ? (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) : ZONES[zone] || 0;
    const local = Date.UTC(year, MONTHS[match[2].toLowerCase()], Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
    if (isNaN(local)) {
        return null;
    }
    const pad = n => String(n).padStart(2, '0');
    const date = new Date(local);
    const sign = offset < 0 ? '-' : '+';
    const zoneText = offset === 0 ? 'Z' : `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${zoneText}`;
}

function asURLs(value) {
    const urls = unfold(value).match(/<[^<>]+>/g);
    return urls ? urls.map(url => url.slice(1, -1).replace(/\s+/g, '')) : null;
}

const PARSERS = { asRaw: value => value, asText, asAddresses, asGroupedAddresses, asMessageIds, asDate, asURLs };

/**
 * The value of a header property for a list of header fields.
 *
 * @param {Array} fields headerFields() of the node
 * @param {{field, form, all}} property parseHeaderProperty() result
 */
function headerValue(fields, property) {
    const name = property.field.toLowerCase();
    const values = fields.filter(field => field.name.toLowerCase() === name).map(field => PARSERS[property.form](field.value));
    if (property.all) {
        return values;
    }
    return values.length ? values[values.length - 1] : null;
}

module.exports = {
    headerFields,
    headerValue,
    parseHeaderProperty,
    formAllowed,
    asText,
    asAddresses,
    asGroupedAddresses,
    asMessageIds,
    asDate,
    asURLs,
    decodeWords
};
