'use strict';

// The SMTP side of EmailSubmission/set create (RFC 8621 7.5): the addresses of the message header,
// the envelope a client gives or the server derives, and the FUTURERELEASE hold parameters
// (RFC 4865). Pure functions, no database.
//
// Every address that may end up in the outbound queue passes validAddress(): an ASCII dot-atom local
// part and a host name (an internationalised one is converted to its A-label form). Quoted local
// parts, address literals and anything else that could carry SMTP syntax (spaces, angle brackets,
// line breaks) are refused, so an envelope address can never inject a command or a parameter.
// Header values are parsed strictly and never decoded: an encoded word stays text and never turns
// into an address.

const { domainToASCII } = require('url');
const { parseUTCDate } = require('./utcdate');
const { SetError, invalidProperties } = require('./set-errors');

// RFC 5322 3.2.3 atext
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const DOT_ATOM = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*$`);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const MAX_LOCAL = 64;
const MAX_ADDRESS = 254;
// RFC 5321 4.1.2 esmtp-keyword and esmtp-value
const PARAMETER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const PARAMETER_VALUE = /^[\x21-\x3c\x3e-\x7e]+$/;
const HOLD_FOR = /^\d{1,10}$/;
const ADDRESS_KEYS = ['email', 'parameters'];
const ENVELOPE_KEYS = ['mailFrom', 'rcptTo'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks an address for use in the SMTP envelope.
 *
 * @param {String} address
 * @returns {{email: String, address: String, key: String}|null} email: as given, address: the form handed
 *   to the queue (A-label domain), key: the form two addresses are compared in (lowercase); null when
 *   the address is not usable
 */
function validAddress(address) {
    if (typeof address !== 'string' || address.length > MAX_ADDRESS * 4) {
        return null;
    }
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1) {
        return null;
    }
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    if (local.length > MAX_LOCAL || !DOT_ATOM.test(local)) {
        return null;
    }
    // characters domainToASCII would silently drop or map are refused before it sees them
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x20\x7f<>()[\]\\,;:"@%]/.test(domain)) {
        return null;
    }
    const ascii = domainToASCII(domain);
    if (!ascii || !ascii.split('.').every(label => LABEL.test(label))) {
        return null;
    }
    const result = `${local}@${ascii}`;
    if (result.length > MAX_ADDRESS) {
        return null;
    }
    return { email: address, address: result, key: result.toLowerCase() };
}

// ---------------------------------------------------------------- header values

/**
 * Splits a header value at the top level separators of an address list: commas, and the colon and
 * semicolon of a group. Quoted strings, comments and angle addresses are kept whole; comments are
 * dropped.
 *
 * @returns {Array<{type: 'part'|'groupStart'|'groupEnd', text: String}>|null} null when quotes, comments
 *   or angle brackets do not balance
 */
function tokenize(value) {
    const tokens = [];
    let text = '';
    let depth = 0;
    let quoted = false;
    let angle = false;
    const flush = () => {
        tokens.push({ type: 'part', text: text.trim() });
        text = '';
    };
    for (let i = 0; i < value.length; i++) {
        const chr = value[i];
        if (quoted) {
            text += chr;
            if (chr === '\\' && i + 1 < value.length) {
                text += value[++i];
            } else if (chr === '"') {
                quoted = false;
            }
            continue;
        }
        if (depth) {
            if (chr === '\\') {
                i++;
            } else if (chr === '(') {
                depth++;
            } else if (chr === ')') {
                depth--;
            }
            continue;
        }
        if (chr === '(') {
            depth = 1;
            text += ' ';
        } else if (chr === '"') {
            quoted = true;
            text += chr;
        } else if (chr === '<') {
            if (angle) {
                return null;
            }
            angle = true;
            text += chr;
        } else if (chr === '>') {
            if (!angle) {
                return null;
            }
            angle = false;
            text += chr;
        } else if (angle) {
            text += chr;
        } else if (chr === ',') {
            flush();
        } else if (chr === ':') {
            tokens.push({ type: 'groupStart', text: text.trim() });
            text = '';
        } else if (chr === ';') {
            flush();
            tokens.push({ type: 'groupEnd', text: '' });
        } else {
            text += chr;
        }
    }
    if (quoted || depth || angle) {
        return null;
    }
    flush();
    return tokens;
}

/** The addr-spec of one mailbox: the angle address, or the whole text when there is none */
function addrSpecOf(text) {
    const open = text.indexOf('<');
    if (open < 0) {
        return text;
    }
    // anything after the closing bracket makes the mailbox unusable
    return /^[^<>]*<([^<>]*)>$/.test(text) ? text.slice(open + 1, -1).trim() : null;
}

/**
 * Parses an address list header value (RFC 5322 3.4) strictly. Group members count as addresses,
 * the group name does not.
 *
 * @param {String} value unfolded header value, encoded words left as they are
 * @returns {{addresses: Array<{email, address, key}>, invalid: String[]}} invalid lists the
 *   mailboxes that are not usable, as they appear in the header
 */
function parseAddressList(value) {
    const result = { addresses: [], invalid: [] };
    const tokens = tokenize(value || '');
    if (!tokens) {
        result.invalid.push(String(value).trim());
        return result;
    }
    for (const token of tokens) {
        if (token.type !== 'part' || !token.text) {
            continue;
        }
        const spec = addrSpecOf(token.text);
        const valid = spec !== null && validAddress(spec);
        if (valid) {
            result.addresses.push(valid);
        } else {
            result.invalid.push(token.text);
        }
    }
    return result;
}

/**
 * The header fields of a stored message, from its MIME tree.
 *
 * @param {Object} mimeTree
 * @returns {Map<String, String[]>} lowercase field name -> unfolded values, in order
 */
function headerFields(mimeTree) {
    const fields = new Map();
    for (const line of (mimeTree && mimeTree.header) || []) {
        const colon = line.indexOf(':');
        if (colon <= 0) {
            continue;
        }
        const name = line.slice(0, colon).trim().toLowerCase();
        // the stored lines are raw octets in a binary string; UTF-8 header values read as text
        const value = Buffer.from(line.slice(colon + 1), 'binary')
            .toString()
            .replace(/\r?\n(?=[ \t])/g, '')
            .trim();
        if (!fields.has(name)) {
            fields.set(name, []);
        }
        fields.get(name).push(value);
    }
    return fields;
}

/**
 * The single address of a From or Sender field.
 *
 * @returns {String|null|undefined} the address, null when the field is not usable, undefined when it is absent
 */
function singleAddress(fields, name) {
    const values = (fields.get(name) || []).filter(value => value.length);
    if (!values.length) {
        return undefined;
    }
    if (values.length > 1) {
        return null;
    }
    const { addresses, invalid } = parseAddressList(values[0]);
    return addresses.length === 1 && !invalid.length ? addresses[0].email : null;
}

/**
 * The addresses a submission takes from the message header.
 *
 * @param {Map} fields headerFields() of the message
 * @returns {{from: String, sender: String|null, recipients: Array<{email, address, key}>, invalidRecipients: String[]}}
 *   from and sender as written in the header
 * @throws {SetError} invalidEmail naming from or sender when one is missing, repeated or not a single usable address
 */
function messageAddresses(fields) {
    const from = singleAddress(fields, 'from');
    const sender = singleAddress(fields, 'sender');
    const bad = [];
    if (!from) {
        bad.push('from');
    }
    if (sender === null) {
        bad.push('sender');
    }
    if (bad.length) {
        throw new SetError('invalidEmail', `the message needs exactly one usable ${bad.join(' and ')} address`, { properties: bad });
    }
    const recipients = [];
    const invalidRecipients = [];
    for (const name of ['to', 'cc', 'bcc']) {
        for (const value of fields.get(name) || []) {
            const parsed = parseAddressList(value);
            recipients.push(...parsed.addresses);
            invalidRecipients.push(...parsed.invalid);
        }
    }
    return { from, sender: sender || null, recipients, invalidRecipients };
}

/** Recipients without repeats (compared case insensitively), the first spelling kept */
function uniqueRecipients(recipients) {
    const seen = new Map();
    for (const recipient of recipients) {
        if (!seen.has(recipient.key)) {
            seen.set(recipient.key, recipient);
        }
    }
    return [...seen.values()];
}

// ---------------------------------------------------------------- envelope

/** Checks a parameters object: esmtp-keyword names, string or null values without controls */
function checkParameters(parameters) {
    if (parameters === undefined || parameters === null) {
        return null;
    }
    if (!isObject(parameters)) {
        throw invalidProperties('envelope', 'parameters must be an object');
    }
    for (const [name, value] of Object.entries(parameters)) {
        if (!PARAMETER_NAME.test(name) || (value !== null && (typeof value !== 'string' || !PARAMETER_VALUE.test(value)))) {
            throw invalidProperties('envelope', 'parameters must map SMTP parameter names to values');
        }
    }
    return parameters;
}

function checkAddressObject(value) {
    if (!isObject(value) || typeof value.email !== 'string' || Object.keys(value).some(key => !ADDRESS_KEYS.includes(key))) {
        throw invalidProperties('envelope', 'an envelope address is {email, parameters}');
    }
    return { email: value.email, parameters: checkParameters(value.parameters) };
}

/**
 * Checks the shape of a client given Envelope (RFC 8621 7). Addresses are checked later: a bad mailFrom
 * is invalidProperties, a bad rcptTo invalidRecipients.
 *
 * @returns {{mailFrom: {email, parameters}, rcptTo: Array<{email, parameters}>}}
 * @throws {SetError} invalidProperties naming envelope
 */
function checkEnvelope(envelope) {
    if (!isObject(envelope) || Object.keys(envelope).some(key => !ENVELOPE_KEYS.includes(key)) || !Array.isArray(envelope.rcptTo)) {
        throw invalidProperties('envelope', 'envelope must be {mailFrom, rcptTo}');
    }
    const mailFrom = checkAddressObject(envelope.mailFrom);
    const rcptTo = envelope.rcptTo.map(checkAddressObject);
    if (rcptTo.some(address => address.parameters && Object.keys(address.parameters).length)) {
        // no RCPT TO extension is advertised (DSN NOTIFY and ORCPT are not passed on to the MTA)
        throw invalidProperties('envelope', 'rcptTo parameters are not supported');
    }
    return { mailFrom, rcptTo };
}

/**
 * The time a submission is released (RFC 4865 FUTURERELEASE, RFC 8621 7). HOLDFOR and HOLDUNTIL are
 * the only MAIL FROM parameters accepted; a hold in the past sends at once.
 *
 * @param {Object|null} parameters mailFrom.parameters, already shape checked
 * @param {Object} options {now: Date, maxDelayedSend: seconds}
 * @returns {Date} sendAt
 * @throws {SetError} invalidProperties naming envelope
 */
function releaseTime(parameters, options) {
    const now = options.now;
    const holds = {};
    for (const [name, value] of Object.entries(parameters || {})) {
        const upper = name.toUpperCase();
        if ((upper !== 'HOLDFOR' && upper !== 'HOLDUNTIL') || upper in holds) {
            throw invalidProperties('envelope', `the SMTP parameter ${name} is not supported`);
        }
        holds[upper] = value;
    }
    if ('HOLDFOR' in holds && 'HOLDUNTIL' in holds) {
        throw invalidProperties('envelope', 'HOLDFOR and HOLDUNTIL can not be combined');
    }
    let sendAt = now;
    if ('HOLDFOR' in holds) {
        if (typeof holds.HOLDFOR !== 'string' || !HOLD_FOR.test(holds.HOLDFOR)) {
            throw invalidProperties('envelope', 'HOLDFOR must be a number of seconds');
        }
        sendAt = new Date(now.getTime() + Number(holds.HOLDFOR) * 1000);
    } else if ('HOLDUNTIL' in holds) {
        const until = parseUTCDate(holds.HOLDUNTIL);
        if (!until) {
            throw invalidProperties('envelope', 'HOLDUNTIL must be a UTC date-time');
        }
        sendAt = until < now ? now : until;
    }
    if (sendAt.getTime() - now.getTime() > options.maxDelayedSend * 1000) {
        throw invalidProperties('envelope', `a message can be held for at most ${options.maxDelayedSend} seconds`);
    }
    return sendAt;
}

module.exports = {
    validAddress,
    parseAddressList,
    headerFields,
    messageAddresses,
    uniqueRecipients,
    checkEnvelope,
    releaseTime
};
