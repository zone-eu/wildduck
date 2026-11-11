'use strict';
/* eslint no-control-regex: 0 */ // the header checks look for control characters on purpose

// Email/set create (RFC 8621 4.6): validates the Email object of a create and builds the RFC 5322
// message. planEmail() checks every header and body property and answers a plan, or throws
// invalidProperties naming the offending property. buildEmail() turns a plan and the loaded blobs
// into the message bytes.
//
// The message header is written here, not by MimeNode: MimeNode reformats address and date headers,
// and every header form must round trip through Email/get. MimeNode builds the body tree (boundaries,
// transfer encodings, RFC 2231 file names), and its root header is reduced to the Content-* fields.

const crypto = require('crypto');
const MimeNode = require('nodemailer/lib/mime-node');
const mimeFuncs = require('nodemailer/lib/mime-funcs');
const punycode = require('nodemailer/lib/punycode');
const { parseHeaderProperty, formAllowed } = require('./email-headers');
const { invalidProperties } = require('./set-errors');

const MAX_DEPTH = 10;
const MAX_PARTS = 250;
const MAX_LINE = 998;

// Email properties that write a header field, with their form
const CONVENIENCE = {
    messageId: ['Message-ID', 'asMessageIds'],
    inReplyTo: ['In-Reply-To', 'asMessageIds'],
    references: ['References', 'asMessageIds'],
    sender: ['Sender', 'asAddresses'],
    from: ['From', 'asAddresses'],
    to: ['To', 'asAddresses'],
    cc: ['Cc', 'asAddresses'],
    bcc: ['Bcc', 'asAddresses'],
    replyTo: ['Reply-To', 'asAddresses'],
    subject: ['Subject', 'asText'],
    sentAt: ['Date', 'asDate']
};
const BODY = ['bodyStructure', 'bodyValues', 'textBody', 'htmlBody', 'attachments'];
// handled by the type module
const STORE = ['mailboxIds', 'keywords', 'receivedAt'];
const SERVER_SET = ['id', 'blobId', 'threadId', 'size', 'hasAttachment', 'preview', 'headers'];

const PART_PROPERTIES = ['partId', 'blobId', 'type', 'charset', 'disposition', 'cid', 'language', 'location', 'name', 'subParts', 'size'];
// part headers that a part property represents
const PART_FIELDS = ['content-type', 'content-disposition', 'content-id', 'content-language', 'content-location', 'content-transfer-encoding'];

const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MIME_TYPE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const VISIBLE = /^[\x21-\x7e]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------- header values

/** Phrase for a display name: atom, quoted string, or an encoded word when not printable ASCII */
function phrase(name) {
    if (/^[\x20-\x7e]*$/.test(name)) {
        return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name) ? name : `"${name.replace(/["\\]/g, '\\$&')}"`;
    }
    return mimeFuncs.encodeWord(name, 'Q', 52);
}

function encodeAddress(address) {
    if (!isObject(address) || typeof address.email !== 'string' || (address.name !== undefined && address.name !== null && typeof address.name !== 'string')) {
        return null;
    }
    const at = address.email.lastIndexOf('@');
    // no white space, controls, brackets or separators that could end the address
    if (!/^[^\s\x00-\x1f\x7f<>(),;:"[\]\\]+$/.test(address.email) || at < 1 || at === address.email.length - 1) {
        return null;
    }
    const email = address.email.slice(0, at + 1) + punycode.toASCII(address.email.slice(at + 1));
    if (!address.name) {
        return email;
    }
    if (address.name.includes('\x00')) {
        return null;
    }
    return `${phrase(address.name)} <${email}>`;
}

function encodeAddresses(value) {
    if (!Array.isArray(value)) {
        return null;
    }
    const list = value.map(encodeAddress);
    return list.includes(null) ? null : list.join(', ');
}

function encodeGroups(value) {
    if (!Array.isArray(value)) {
        return null;
    }
    const groups = value.map(group => {
        if (!isObject(group) || (group.name !== null && group.name !== undefined && typeof group.name !== 'string')) {
            return null;
        }
        const addresses = encodeAddresses(group.addresses);
        if (addresses === null || (group.name && group.name.includes('\x00'))) {
            return null;
        }
        return group.name ? `${phrase(group.name)}: ${addresses};` : addresses;
    });
    return groups.includes(null) ? null : groups.filter(group => group.length).join(', ');
}

function encodeText(value) {
    if (typeof value !== 'string' || value.includes('\x00')) {
        return null;
    }
    // line breaks and other controls travel inside an encoded word, so they never end the field
    return /[\x01-\x08\x0a-\x1f\x7f]/.test(value) ? mimeFuncs.encodeWord(value, 'Q', 52) : mimeFuncs.encodeWords(value, 'Q', 52);
}

const encodeMessageIds = value =>
    Array.isArray(value) && value.every(id => typeof id === 'string' && VISIBLE.test(id) && !/[<>]/.test(id)) ? value.map(id => `<${id}>`).join(' ') : null;

const encodeUrls = value =>
    Array.isArray(value) && value.every(url => typeof url === 'string' && VISIBLE.test(url) && !/[<>]/.test(url))
        ? value.map(url => `<${url}>`).join(', ')
        : null;

/** An RFC 3339 date-time as an RFC 5322 date keeping its offset */
function encodeDate(value) {
    const match = typeof value === 'string' && DATE.exec(value);
    if (!match) {
        return null;
    }
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (isNaN(wall) || wall.getUTCDate() !== day || hour > 23 || minute > 59 || second > 60) {
        return null;
    }
    const zone = match[7].toUpperCase() === 'Z' ? '+0000' : match[7].replace(':', '');
    const pad = n => String(n).padStart(2, '0');
    return `${DAYS[wall.getUTCDay()]}, ${pad(day)} ${MONTHS[month - 1]} ${year} ${pad(hour)}:${pad(minute)}:${pad(second)} ${zone}`;
}

/** A raw value is written as given; it may only hold folded line breaks and no line may be too long */
function checkRaw(value, name) {
    if (typeof value !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(value.replace(/\r\n(?=[ \t])/g, ''))) {
        return null;
    }
    const lines = `${name}:${value}`.split('\r\n');
    return lines.every(line => Buffer.byteLength(line) <= MAX_LINE) ? value : null;
}

const ENCODERS = {
    asText: encodeText,
    asAddresses: encodeAddresses,
    asGroupedAddresses: encodeGroups,
    asMessageIds: encodeMessageIds,
    asDate: encodeDate,
    asURLs: encodeUrls
};

/**
 * The header lines of one header property.
 *
 * @returns {String[]|null} folded lines, null when the value is invalid
 */
function headerLines(name, form, all, value) {
    const values = all ? value : [value];
    if (!Array.isArray(values)) {
        return null;
    }
    const lines = [];
    for (const entry of values) {
        if (form === 'asRaw') {
            const raw = checkRaw(entry, name);
            if (raw === null) {
                return null;
            }
            lines.push(`${name}:${raw}`);
            continue;
        }
        const encoded = ENCODERS[form](entry);
        if (encoded === null || /[\r\n\x00]/.test(encoded)) {
            return null;
        }
        lines.push(mimeFuncs.foldLines(`${name}: ${encoded}`, 76));
    }
    return lines;
}

// ---------------------------------------------------------------- header properties

/**
 * Collects the header properties of an Email or a body part.
 *
 * @param {Object} object Email or EmailBodyPart
 * @param {Object} options {top: Boolean, property: name to report for errors on a part}
 * @returns {Array<{field: String, lines: String[]}>}
 */
function collectHeaders(object, options) {
    const headers = [];
    const fields = new Map();
    const add = (property, field, form, all, value) => {
        const lower = field.toLowerCase();
        if (fields.has(lower)) {
            throw invalidProperties(options.top ? [fields.get(lower), property] : options.property, `${field} is given twice`);
        }
        fields.set(lower, property);
        if (value === null) {
            return;
        }
        const lines = headerLines(field, form, all, value);
        if (!lines) {
            throw invalidProperties(options.top ? property : options.property, `invalid value for ${property}`);
        }
        headers.push({ field: lower, lines });
    };

    for (const key of Object.keys(object)) {
        if (options.top && CONVENIENCE[key]) {
            add(key, CONVENIENCE[key][0], CONVENIENCE[key][1], false, object[key]);
        } else if (key.startsWith('header:')) {
            const parsed = parseHeaderProperty(key);
            const report = options.top ? key : options.property;
            if (!parsed || !formAllowed(parsed.field, parsed.form)) {
                throw invalidProperties(report, `invalid header property ${key}`);
            }
            const lower = parsed.field.toLowerCase();
            if (options.top && lower.startsWith('content-')) {
                throw invalidProperties(report, 'Content-* header fields belong on body parts');
            }
            if (!options.top && PART_FIELDS.includes(lower)) {
                throw invalidProperties(report, `${parsed.field} is set through the body part properties`);
            }
            add(key, parsed.field, parsed.form, parsed.all, object[key]);
        }
    }
    return headers;
}

// ---------------------------------------------------------------- body

function checkBodyValues(bodyValues) {
    if (bodyValues === undefined || bodyValues === null) {
        return {};
    }
    if (!isObject(bodyValues)) {
        throw invalidProperties('bodyValues', 'bodyValues must be an object');
    }
    for (const value of Object.values(bodyValues)) {
        const valid =
            isObject(value) &&
            typeof value.value === 'string' &&
            Object.keys(value).every(key => ['value', 'isEncodingProblem', 'isTruncated'].includes(key)) &&
            !value.isEncodingProblem &&
            !value.isTruncated;
        if (!valid) {
            throw invalidProperties('bodyValues', 'invalid EmailBodyValue');
        }
    }
    return bodyValues;
}

const optionalString = (value, pattern) => value === undefined || value === null || (typeof value === 'string' && pattern.test(value));

function checkPartFields(part, fail) {
    for (const key of Object.keys(part)) {
        if (!PART_PROPERTIES.includes(key) && !key.startsWith('header:')) {
            fail(`unknown body part property ${key}`);
        }
    }
    if (!optionalString(part.type, MIME_TYPE) || !optionalString(part.disposition, TOKEN) || !optionalString(part.charset, TOKEN)) {
        fail('invalid type, disposition or charset');
    }
    if (!optionalString(part.cid, VISIBLE) || /[<>]/.test(part.cid || '') || !optionalString(part.location, VISIBLE)) {
        fail('invalid cid or location');
    }
    if (part.language !== undefined && part.language !== null && !(Array.isArray(part.language) && part.language.every(tag => /^[A-Za-z0-9-]+$/.test(tag)))) {
        fail('invalid language');
    }
    if (part.name !== undefined && part.name !== null && (typeof part.name !== 'string' || /[\x00-\x1f\x7f]/.test(part.name))) {
        fail('invalid name');
    }
}

/**
 * Validates an EmailBodyPart tree into a plan node.
 *
 * @param {Object} part
 * @param {Object} context {property, bodyValues, depth, count: {parts}, blobIds: Set, defaultType}
 */
function planPart(part, context) {
    const fail = description => {
        throw invalidProperties(context.property, description);
    };
    if (!isObject(part)) {
        fail('a body part must be an object');
    }
    if (++context.count.parts > MAX_PARTS || context.depth > MAX_DEPTH) {
        fail('the body structure is too large or too deeply nested');
    }
    checkPartFields(part, fail);
    const type = (part.type || context.defaultType || '').toLowerCase();
    const node = {
        type,
        disposition: part.disposition || null,
        cid: part.cid || null,
        language: part.language || null,
        location: part.location || null,
        name: part.name || null,
        charset: part.charset || null,
        headers: collectHeaders(part, { top: false, property: context.property })
    };

    if (type.startsWith('multipart/')) {
        if (!Array.isArray(part.subParts) || part.partId !== undefined || part.blobId !== undefined) {
            fail('a multipart part needs subParts and no content');
        }
        node.subParts = part.subParts.map(child => planPart(child, Object.assign({}, context, { depth: context.depth + 1, defaultType: null })));
        return node;
    }
    if (part.subParts !== undefined && part.subParts !== null) {
        fail('only multipart parts have subParts');
    }
    if (part.partId !== undefined && part.blobId !== undefined) {
        fail('a part has either partId or blobId');
    }
    if (part.partId !== undefined) {
        if (typeof part.partId !== 'string' || !Object.prototype.hasOwnProperty.call(context.bodyValues, part.partId)) {
            fail(`partId ${part.partId} is not in bodyValues`);
        }
        if (part.charset !== undefined || part.size !== undefined) {
            fail('charset and size are not given for a part with a partId');
        }
        node.type = node.type || 'text/plain';
        node.text = context.bodyValues[part.partId].value;
    } else if (part.blobId !== undefined) {
        if (typeof part.blobId !== 'string') {
            fail('invalid blobId');
        }
        node.blobId = part.blobId;
        context.blobIds.add(part.blobId);
    } else {
        node.text = '';
        node.type = node.type || 'text/plain';
    }
    return node;
}

function singlePart(input, property, mime, context) {
    if (input[property] === undefined || input[property] === null) {
        return null;
    }
    if (!Array.isArray(input[property]) || input[property].length !== 1) {
        throw invalidProperties(property, `${property} holds exactly one part`);
    }
    const node = planPart(input[property][0], Object.assign({}, context, { property, defaultType: mime }));
    if (node.type !== mime) {
        throw invalidProperties(property, `${property} must be ${mime}`);
    }
    return node;
}

const multipart = (subtype, subParts) => ({ type: `multipart/${subtype}`, headers: [], subParts });

/** The body tree from textBody, htmlBody and attachments (RFC 8621 4.6) */
function assembleBody(input, context) {
    const text = singlePart(input, 'textBody', 'text/plain', context);
    const html = singlePart(input, 'htmlBody', 'text/html', context);
    let attachments = [];
    if (input.attachments !== undefined && input.attachments !== null) {
        if (!Array.isArray(input.attachments)) {
            throw invalidProperties('attachments', 'attachments must be a list');
        }
        attachments = input.attachments.map(part => planPart(part, Object.assign({}, context, { property: 'attachments', defaultType: null })));
    }
    // inline parts referenced from the html go next to it in multipart/related
    const inline = html ? attachments.filter(part => part.disposition === 'inline' && part.cid) : [];
    const regular = attachments.filter(part => !inline.includes(part));
    const htmlNode = inline.length ? multipart('related', [html, ...inline]) : html;
    const body = text && htmlNode ? multipart('alternative', [text, htmlNode]) : htmlNode || text;
    if (!regular.length) {
        return body || { type: 'text/plain', headers: [], text: '' };
    }
    return multipart('mixed', body ? [body, ...regular] : regular);
}

// ---------------------------------------------------------------- plan

/**
 * Validates the header and body properties of an Email/set create.
 *
 * @param {Object} input The Email object of the create
 * @returns {{headers: Array, body: Object, blobIds: String[]}}
 * @throws {SetError} invalidProperties
 */
function planEmail(input) {
    const known = [...STORE, ...Object.keys(CONVENIENCE), ...BODY];
    const unknown = Object.keys(input).filter(key => !known.includes(key) && !key.startsWith('header:'));
    if (unknown.length) {
        const serverSet = unknown.filter(key => SERVER_SET.includes(key));
        throw invalidProperties(serverSet.length ? serverSet : unknown, serverSet.length ? 'server set properties can not be given' : 'unknown properties');
    }
    const headers = collectHeaders(input, { top: true });
    const context = { bodyValues: checkBodyValues(input.bodyValues), depth: 1, count: { parts: 0 }, blobIds: new Set() };

    let body;
    if (input.bodyStructure !== undefined && input.bodyStructure !== null) {
        const extra = ['textBody', 'htmlBody', 'attachments'].filter(key => input[key] !== undefined && input[key] !== null);
        if (extra.length) {
            throw invalidProperties(['bodyStructure', ...extra], 'bodyStructure excludes textBody, htmlBody and attachments');
        }
        body = planPart(input.bodyStructure, Object.assign({}, context, { property: 'bodyStructure', defaultType: null }));
        if (!body.type && !body.blobId) {
            throw invalidProperties('bodyStructure', 'the body part needs a type');
        }
        // header fields of the top part are message header fields
        const fields = new Set(headers.map(header => header.field));
        if (body.headers.some(header => fields.has(header.field))) {
            throw invalidProperties('bodyStructure', 'a header field is given on both the Email and its bodyStructure');
        }
        headers.push(...body.headers);
        body.headers = [];
    } else {
        body = assembleBody(input, context);
    }
    return { headers, body, blobIds: [...context.blobIds] };
}

// ---------------------------------------------------------------- build

function partNode(plan, parent, blobs) {
    const type = plan.type || (plan.blobId && blobs.get(plan.blobId).type) || 'application/octet-stream';
    const options = plan.name ? { filename: plan.name } : {};
    const node = parent ? parent.createChild(type, options) : new MimeNode(type, options);
    if (plan.subParts) {
        plan.subParts.forEach(child => partNode(child, node, blobs));
    } else if (plan.blobId) {
        node.setHeader('Content-Type', plan.charset ? `${type}; charset=${plan.charset}` : type);
        node.setHeader('Content-Transfer-Encoding', 'base64');
        node.setContent(blobs.get(plan.blobId).content);
    } else {
        node.setHeader('Content-Type', `${type}; charset=utf-8`);
        node.setContent(plan.text.replace(/\r\n|\r|\n/g, '\r\n'));
    }
    if (plan.disposition) {
        node.setHeader('Content-Disposition', plan.disposition);
    }
    if (plan.cid) {
        node.setHeader('Content-ID', `<${plan.cid}>`);
    }
    if (plan.language) {
        node.setHeader('Content-Language', plan.language.join(', '));
    }
    if (plan.location) {
        node.setHeader('Content-Location', plan.location);
    }
    for (const header of plan.headers) {
        header.lines.forEach(line =>
            node.addHeader(line.slice(0, line.indexOf(':')), { prepared: true, value: line.slice(line.indexOf(':') + 1).replace(/^ /, '') })
        );
    }
    return node;
}

/** The fields of a header block, each with its folded lines */
const splitFields = block => block.split(/\r\n(?![ \t])/).filter(field => field.length);

/**
 * Builds the message.
 *
 * @param {Object} plan planEmail() result
 * @param {Object} options
 * @param {Map<String, {content: Buffer|Readable, type: String}>} options.blobs the loaded blobs of plan.blobIds
 * @param {Date} [options.date] Date header when none is given
 * @param {String} [options.hostname] domain of a generated Message-ID when there is no From address
 * @returns {Promise<Buffer>}
 */
async function buildEmail(plan, options = {}) {
    const blobs = options.blobs || new Map();
    const root = partNode(plan.body, null, blobs);
    const built = await root.build();
    const split = built.indexOf('\r\n\r\n');
    // MimeNode adds Date, Message-ID and MIME-Version; only its Content-* fields are kept
    const content = splitFields(built.slice(0, split).toString()).filter(field => /^content-/i.test(field));

    const lines = plan.headers.flatMap(header => header.lines);
    const has = field => plan.headers.some(header => header.field === field);
    if (!has('date')) {
        lines.push(`Date: ${encodeDate((options.date || new Date()).toISOString().replace(/\.\d+Z$/, 'Z'))}`);
    }
    if (!has('message-id')) {
        lines.push(`Message-ID: <${crypto.randomUUID()}@${messageIdDomain(plan, options.hostname)}>`);
    }
    if (!has('mime-version')) {
        lines.push('MIME-Version: 1.0');
    }
    return Buffer.concat([Buffer.from([...lines, ...content].join('\r\n')), built.subarray(split)]);
}

function messageIdDomain(plan, hostname) {
    const from = plan.headers.find(header => header.field === 'from');
    const match = from && /@([A-Za-z0-9.-]+)>?\s*$/.exec(from.lines[0]);
    return (match && match[1]) || hostname || 'localhost';
}

module.exports = { planEmail, buildEmail, encodeDate, MAX_DEPTH, MAX_PARTS };
