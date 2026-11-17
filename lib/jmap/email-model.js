'use strict';

// Message documents as JMAP Email objects (RFC 8621 4.1).

const { formatId, blobId } = require('./ids');
const { headerFields, headerValue, parseHeaderProperty, formAllowed, CONVENIENCE, EMAIL_BODY_PROPERTIES } = require('./email-headers');
const { bodyStructure, parseStructure, pickPart, bodyValue, DEFAULT_BODY_PROPERTIES, BODY_PROPERTIES } = require('./email-body');
const { rootOf } = require('../message-roots');
const { invalidArguments } = require('./errors');
const { formatUTCDate } = require('./utcdate');

const METADATA = ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt'];
const BODY = EMAIL_BODY_PROPERTIES;
const PROPERTIES = [...METADATA, 'headers', ...Object.keys(CONVENIENCE), ...BODY, 'hasAttachment', 'preview'];

// RFC 8621 4.2 default properties of Email/get
const DEFAULT_PROPERTIES = [...METADATA, ...Object.keys(CONVENIENCE), 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments'];
// RFC 8621 4.9 default properties of Email/parse: no metadata
const PARSE_PROPERTIES = [...Object.keys(CONVENIENCE), 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments'];

// RFC 8621 4.1.1: a keyword is 1 to 255 printable ASCII characters, without the IMAP atom specials
const KEYWORD = /^[\x21-\x7e]{1,255}$/;
const KEYWORD_SPECIALS = /[(){\]%*"\\]/;
// a WildDuck label as a keyword: $wdlabel$<label id>
const LABEL_KEYWORD = /^\$wdlabel\$([0-9a-f]{24})$/;
// \Deleted is set by destroying an Email, \Recent only by the server; neither is ever a keyword
const HIDDEN_KEYWORDS = new Set(['$deleted', '$recent']);
const HIDDEN_FLAGS = new Set(['\\deleted', '\\recent']);

// keywords stored as IMAP system flags, and registered keywords in the spelling IMAP clients use
const KEYWORD_FLAGS = {
    $seen: '\\Seen',
    $flagged: '\\Flagged',
    $answered: '\\Answered',
    $draft: '\\Draft',
    $forwarded: '$Forwarded',
    $junk: '$Junk',
    $notjunk: '$NotJunk',
    $phishing: '$Phishing',
    $mdnsent: '$MDNSent'
};
// the other way round: lowercase IMAP flag -> keyword
const FLAG_KEYWORDS = new Map(Object.entries(KEYWORD_FLAGS).map(([keyword, flag]) => [flag.toLowerCase(), keyword]));

/** True for a string that is a keyword (RFC 8621 4.1.1) */
const isKeyword = value => typeof value === 'string' && KEYWORD.test(value) && !KEYWORD_SPECIALS.test(value);

/** The IMAP flag a keyword is stored as */
const flagOfKeyword = keyword => KEYWORD_FLAGS[keyword.toLowerCase()] || keyword;

/** The keyword of a stored IMAP flag, lowercase as JMAP keywords are */
const keywordOfFlag = flag => FLAG_KEYWORDS.get(flag.toLowerCase()) || flag.toLowerCase();

/** keywords of a message: IMAP flags in JMAP form and active labels; \Deleted and \Recent never appear */
function keywordsOf(doc, labelIds) {
    const keywords = {};
    for (const flag of doc.flags || []) {
        if (!HIDDEN_FLAGS.has(flag.toLowerCase())) {
            keywords[keywordOfFlag(flag)] = true;
        }
    }
    for (const label of doc.labels || []) {
        if (labelIds.has(label.toString())) {
            keywords[`$wdlabel$${label.toString()}`] = true;
        }
    }
    return keywords;
}

// IMAP INTERNALDATE has whole seconds, so has receivedAt
const utcDate = date => (date ? formatUTCDate(date, { seconds: true }) : null);

/**
 * Validates and expands Email/get (or Email/parse) properties.
 *
 * @param {String[]} [requested]
 * @param {Object} [options] {defaults: the default property list, withId: false leaves out the id Email/get always returns}
 * @returns {{properties: String[], headers: Array, needsTree: Boolean, needsHeaders: Boolean}}
 */
function resolveProperties(requested, options = {}) {
    const given = requested === undefined || requested === null ? options.defaults || DEFAULT_PROPERTIES : requested;
    if (!Array.isArray(given) || !given.every(property => typeof property === 'string')) {
        throw invalidArguments('properties must be a list of property names');
    }
    // a repeated property would be rendered once per copy
    const properties = [...new Set(given)];
    const headers = [];
    for (const property of properties) {
        if (property.startsWith('header:')) {
            const parsed = parseHeaderProperty(property);
            if (!parsed || !formAllowed(parsed.field, parsed.form)) {
                throw invalidArguments(`invalid header property ${property}`);
            }
            headers.push([property, parsed]);
        } else if (!PROPERTIES.includes(property)) {
            throw invalidArguments(`unknown property ${property}`);
        }
    }
    const list = options.withId === false ? properties : ['id', ...properties.filter(property => property !== 'id')];
    return {
        properties: list,
        headers,
        needsTree: list.some(property => BODY.includes(property)),
        needsHeaders: headers.length > 0 || list.some(property => property === 'headers' || property in CONVENIENCE)
    };
}

/**
 * Estimated octets of the header values an Email object shows, for the response budget without
 * rendering: the length of every stored header line when any header property is requested. Cheap
 * and covers what the properties show, unless one field is requested in several forms.
 *
 * @param {Object} doc Message document with the fields projectionFor() selected
 * @param {Object} resolved resolveProperties() result
 * @returns {Number}
 */
function headerBytes(doc, resolved) {
    let bytes = 0;
    if (resolved.needsHeaders) {
        for (const line of (doc.mimeTree && doc.mimeTree.header) || []) {
            bytes += line.length;
        }
    }
    return bytes;
}

/** The message fields a set of properties needs, as a MongoDB projection */
function projectionFor(resolved) {
    const projection = {
        _id: true,
        root: true,
        mailbox: true,
        thread: true,
        flags: true,
        labels: true,
        size: true,
        idate: true,
        ha: true,
        intro: true,
        undeleted: true
    };
    if (resolved.needsTree) {
        projection.mimeTree = true;
    } else if (resolved.needsHeaders) {
        projection['mimeTree.header'] = true;
    }
    return projection;
}

// an EmailBodyPart property, or a header:{name}[:as{Form}][:all] property of the part
function bodyPropertyAllowed(property) {
    if (typeof property !== 'string') {
        return false;
    }
    if (property.startsWith('header:')) {
        const parsed = parseHeaderProperty(property);
        return !!parsed && formAllowed(parsed.field, parsed.form);
    }
    return BODY_PROPERTIES.has(property);
}

/**
 * Body arguments of Email/get (RFC 8621 4.2).
 */
function bodyArguments(args) {
    const given = args.bodyProperties === undefined || args.bodyProperties === null ? DEFAULT_BODY_PROPERTIES : args.bodyProperties;
    if (!Array.isArray(given)) {
        throw invalidArguments('bodyProperties must be a list of property names');
    }
    // pickPart recurses once per subParts entry, so copies would cost copies^depth
    const bodyProperties = [...new Set(given)];
    for (const property of bodyProperties) {
        if (!bodyPropertyAllowed(property)) {
            throw invalidArguments(`unknown body property ${property}`);
        }
    }
    for (const flag of ['fetchTextBodyValues', 'fetchHTMLBodyValues', 'fetchAllBodyValues']) {
        if (args[flag] !== undefined && typeof args[flag] !== 'boolean') {
            throw invalidArguments(`${flag} must be a boolean`);
        }
    }
    const maxBytes = args.maxBodyValueBytes === undefined || args.maxBodyValueBytes === null ? 0 : args.maxBodyValueBytes;
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
        throw invalidArguments('maxBodyValueBytes must be a positive integer');
    }
    return {
        // the default list leaves out subParts, but bodyStructure is useless without them
        bodyProperties: args.bodyProperties === undefined || args.bodyProperties === null ? [...DEFAULT_BODY_PROPERTIES, 'subParts'] : bodyProperties,
        partProperties: bodyProperties,
        text: !!args.fetchTextBodyValues,
        html: !!args.fetchHTMLBodyValues,
        all: !!args.fetchAllBodyValues,
        maxBytes
    };
}

/**
 * Builds the Email object of a message document.
 *
 * @param {Object} doc Message document with the fields projectionFor() selected
 * @param {Object} resolved resolveProperties() result
 * @param {Object} body bodyArguments() result
 * @param {Object} context {labelIds: Set, messageHandler, sizes: attachmentSizes() result, partBlobId: function of a part path
 *   answering its blob id (default: a part of the stored message), values: property -> function answering the value, over the
 *   values of a stored message (Email/parse)}
 */
async function toEmail(doc, resolved, body, context) {
    const fields = resolved.needsHeaders ? headerFields(doc.mimeTree || {}) : [];
    const email = {};
    let structure = null;
    let parsed = null;
    const getStructure = () => {
        structure = structure || bodyStructure(doc.mimeTree, context.partBlobId || rootOf(doc).toString(), context.sizes);
        return structure;
    };
    const getParsed = () => {
        parsed = parsed || parseStructure(getStructure());
        return parsed;
    };

    const values = {
        id: () => formatId('email', rootOf(doc)),
        blobId: () => blobId.message(rootOf(doc)),
        threadId: () => formatId('thread', doc.thread),
        mailboxIds: () => ({ [formatId('mailbox', doc.mailbox)]: true }),
        keywords: () => keywordsOf(doc, context.labelIds),
        size: () => doc.size || 0,
        receivedAt: () => utcDate(doc.idate),
        headers: () => fields,
        hasAttachment: () => !!doc.ha,
        preview: () => (doc.intro || '').replace(/\s+/g, ' ').trim().slice(0, 256),
        bodyStructure: () => pickPart(getStructure(), body.bodyProperties),
        textBody: () => getParsed().textBody.map(part => pickPart(part, body.partProperties)),
        htmlBody: () => getParsed().htmlBody.map(part => pickPart(part, body.partProperties)),
        attachments: () => getParsed().attachments.map(part => pickPart(part, body.partProperties)),
        ...context.values
    };

    for (const property of resolved.properties) {
        if (property in CONVENIENCE) {
            email[property] = headerValue(fields, CONVENIENCE[property]);
        } else if (property !== 'bodyValues' && !property.startsWith('header:')) {
            email[property] = values[property]();
        }
    }
    for (const [property, parsedProperty] of resolved.headers) {
        email[property] = headerValue(fields, parsedProperty);
    }
    if (resolved.properties.includes('bodyValues')) {
        email.bodyValues = await bodyValuesOf(doc, getParsed(), body, context, getStructure());
    }
    return email;
}

async function bodyValuesOf(doc, parsed, body, context, structure) {
    const wanted = new Map();
    const add = parts => parts.filter(part => part.type.startsWith('text/')).forEach(part => wanted.set(part.partId, part));
    if (body.all) {
        add([...parsed.textBody, ...parsed.htmlBody]);
        const walk = part => (part.subParts ? part.subParts.forEach(walk) : part.type.startsWith('text/') && wanted.set(part.partId, part));
        walk(structure);
    } else {
        if (body.text) {
            add(parsed.textBody);
        }
        if (body.html) {
            add(parsed.htmlBody);
        }
    }
    const values = {};
    const budget = context.bodyBudget;
    for (const [partId, part] of wanted) {
        if (budget && budget.remaining <= 0) {
            // the request has used its body value budget: later values are left empty and marked truncated
            values[partId] = { value: '', isEncodingProblem: false, isTruncated: true };
            continue;
        }
        // a value never takes more than what is left of the budget of the request
        const maxBytes = budget ? Math.min(body.maxBytes || Infinity, budget.remaining) : body.maxBytes;
        values[partId] = await bodyValue(context.messageHandler, doc.mimeTree, part, maxBytes === Infinity ? 0 : maxBytes);
        if (budget) {
            budget.remaining -= Buffer.byteLength(values[partId].value);
        }
    }
    return values;
}

module.exports = {
    resolveProperties,
    projectionFor,
    headerBytes,
    bodyArguments,
    toEmail,
    keywordsOf,
    isKeyword,
    flagOfKeyword,
    PROPERTIES,
    PARSE_PROPERTIES,
    LABEL_KEYWORD,
    HIDDEN_KEYWORDS,
    HIDDEN_FLAGS
};
