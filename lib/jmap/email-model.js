'use strict';

// Message documents as JMAP Email objects (RFC 8621 4.1).

const { formatId, blobId } = require('./ids');
const { headerFields, headerValue, parseHeaderProperty, formAllowed, CONVENIENCE, EMAIL_BODY_PROPERTIES } = require('./email-headers');
const { bodyStructure, parseStructure, pickPart, bodyValue, DEFAULT_BODY_PROPERTIES, BODY_PROPERTIES } = require('./email-body');
const { rootOf } = require('../message-roots');
const { invalidArguments } = require('./errors');

const METADATA = ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt'];
const BODY = EMAIL_BODY_PROPERTIES;
const PROPERTIES = [...METADATA, 'headers', ...Object.keys(CONVENIENCE), ...BODY, 'hasAttachment', 'preview'];

// RFC 8621 4.2 default properties of Email/get
const DEFAULT_PROPERTIES = [...METADATA, ...Object.keys(CONVENIENCE), 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments'];
// RFC 8621 4.9 default properties of Email/parse: no metadata
const PARSE_PROPERTIES = [...Object.keys(CONVENIENCE), 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments'];

const SYSTEM_KEYWORDS = { '\\seen': '$seen', '\\flagged': '$flagged', '\\answered': '$answered', '\\draft': '$draft' };

/** keywords of a message: IMAP flags in JMAP form and active labels; \Deleted and \Recent never appear */
function keywordsOf(doc, labelIds) {
    const keywords = {};
    for (const flag of doc.flags || []) {
        const lower = flag.toLowerCase();
        if (lower === '\\deleted' || lower === '\\recent') {
            continue;
        }
        keywords[SYSTEM_KEYWORDS[lower] || lower] = true;
    }
    for (const label of doc.labels || []) {
        if (labelIds.has(label.toString())) {
            keywords[`$wdlabel$${label.toString()}`] = true;
        }
    }
    return keywords;
}

const utcDate = date => (date ? new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/**
 * Validates and expands Email/get (or Email/parse) properties.
 *
 * @param {String[]} [requested]
 * @param {Object} [options] {defaults: the default property list, withId: false leaves out the id Email/get always returns}
 * @returns {{properties: String[], headers: Array, needsTree: Boolean, needsHeaders: Boolean}}
 */
function resolveProperties(requested, options = {}) {
    const properties = requested === undefined || requested === null ? options.defaults || DEFAULT_PROPERTIES : requested;
    if (!Array.isArray(properties) || !properties.every(property => typeof property === 'string')) {
        throw invalidArguments('properties must be a list of property names');
    }
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
    const list = options.withId === false ? [...new Set(properties)] : ['id', ...properties.filter(property => property !== 'id')];
    return {
        properties: list,
        headers,
        needsTree: list.some(property => BODY.includes(property)),
        needsHeaders: headers.length > 0 || list.some(property => property === 'headers' || property in CONVENIENCE)
    };
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
    const bodyProperties = args.bodyProperties === undefined || args.bodyProperties === null ? DEFAULT_BODY_PROPERTIES : args.bodyProperties;
    if (!Array.isArray(bodyProperties)) {
        throw invalidArguments('bodyProperties must be a list of property names');
    }
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
    for (const [partId, part] of wanted) {
        values[partId] = await bodyValue(context.messageHandler, doc.mimeTree, part, body.maxBytes);
    }
    return values;
}

module.exports = { resolveProperties, projectionFor, bodyArguments, toEmail, keywordsOf, PROPERTIES, PARSE_PROPERTIES };
