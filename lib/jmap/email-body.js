'use strict';

// The body model of JMAP Email objects (RFC 8621 4.1.4): bodyStructure, textBody, htmlBody,
// attachments and bodyValues, derived from the stored MIME tree. Part content comes from the tree for
// inline parts and from the attachment storage for the others, decoded from its transfer encoding.

const { Readable } = require('stream');
const { buffer: streamToBuffer } = require('stream/consumers');
const libmime = require('libmime');
const libqp = require('libqp');
const libbase64 = require('libbase64');
const iconv = require('iconv-lite');
const { headerFields, decodeWords } = require('./email-headers');
const { blobId } = require('./ids');
const { decodedLength } = require('../attachments/base64-codec');

const DEFAULT_BODY_PROPERTIES = ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location'];
const BODY_PROPERTIES = new Set([...DEFAULT_BODY_PROPERTIES, 'headers', 'subParts']);

const lower = value => (value || '').toString().toLowerCase().trim();

function contentType(node) {
    const ct = node.parsedHeader && node.parsedHeader['content-type'];
    return lower((ct && ct.value) || ct || 'text/plain');
}

const isMultipart = node => contentType(node).startsWith('multipart/') && Array.isArray(node.childNodes);

// the last instance of a raw header field, parsed with RFC 2231 parameter decoding
function rawHeader(node, name) {
    const fields = headerFields(node).filter(field => field.name.toLowerCase() === name);
    return fields.length ? fields[fields.length - 1].value.replace(/\r?\n(?=[ \t])/g, '') : null;
}

function partName(node) {
    for (const [header, param] of [
        ['content-disposition', 'filename'],
        ['content-type', 'name']
    ]) {
        const raw = rawHeader(node, header);
        if (raw) {
            const parsed = libmime.parseHeaderValue(raw);
            if (parsed.params && parsed.params[param]) {
                return decodeWords(parsed.params[param]).normalize('NFC');
            }
        }
    }
    return null;
}

function transferEncoding(node) {
    return lower((node.parsedHeader && node.parsedHeader['content-transfer-encoding']) || '7bit');
}

// the body of a node kept in the tree: a Buffer, a MongoDB Binary (bytes in .buffer) or a binary string.
// A Buffer is checked first, because it has a .buffer too (its whole backing ArrayBuffer)
function bodyBuffer(node) {
    const body = node.body;
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (body && Buffer.isBuffer(body.buffer)) {
        return body.buffer;
    }
    return Buffer.from(typeof body === 'string' ? body : '', 'binary');
}

/**
 * Decoded size of a part (RFC 8621: after the transfer encoding is removed). Exact for parts kept in
 * the tree; for a base64 part in the attachment storage it is computed from the encoded length, which
 * avoids reading the attachment just to size it.
 */
function decodedSize(node) {
    const encoding = transferEncoding(node);
    if (node.attachmentId || node.body === undefined) {
        return encoding === 'base64' ? decodedLength(Number(node.size) || 0) : Number(node.size) || 0;
    }
    const body = bodyBuffer(node);
    if (encoding === 'base64') {
        const text = body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
        const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
        return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
    }
    if (encoding === 'quoted-printable') {
        return libqp.decode(body.toString('latin1')).length;
    }
    return body.length;
}

/**
 * The EmailBodyPart tree of a MIME node (RFC 8621 4.1.4). Part ids are IMAP part paths.
 *
 * @param {Object} node MIME node
 * @param {String} path IMAP part path of the node ('' for a multipart root)
 * @param {String} root Message root (hex) for blob ids
 */
function bodyPart(node, path, root) {
    const multipart = isMultipart(node);
    const type = contentType(node);
    const params = (node.parsedHeader['content-type'] && node.parsedHeader['content-type'].params) || {};
    const disposition = node.parsedHeader['content-disposition'];
    const cid = node.parsedHeader['content-id'];
    const language = node.parsedHeader['content-language'];
    const location = node.parsedHeader['content-location'];

    const part = {
        partId: multipart ? null : path || '1',
        blobId: multipart ? null : blobId.part(root, path || '1'),
        size: multipart ? 0 : decodedSize(node),
        headers: headerFields(node),
        name: multipart ? null : partName(node),
        type,
        charset: params.charset ? lower(params.charset) : type.startsWith('text/') ? 'us-ascii' : null,
        disposition: disposition ? lower(disposition.value || disposition) || null : null,
        cid: cid ? cid.replace(/^\s*<|>\s*$/g, '').trim() || null : null,
        language: language
            ? language
                  .split(',')
                  .map(entry => entry.trim())
                  .filter(Boolean)
            : null,
        location: location ? location.trim() : null,
        subParts: null
    };
    if (multipart) {
        part.subParts = node.childNodes.map((child, index) => bodyPart(child, path ? `${path}.${index + 1}` : String(index + 1), root));
    }
    return part;
}

/** The root EmailBodyPart of a message document */
const bodyStructure = (mimeTree, root) => bodyPart(mimeTree, isMultipart(mimeTree) ? '' : '1', root);

const INLINE_MEDIA = /^(image|audio|video)\//;

/**
 * textBody, htmlBody and attachments from the body structure: the algorithm of RFC 8621 4.1.4.
 */
function parseStructure(rootPart) {
    const textBody = [];
    const htmlBody = [];
    const attachments = [];

    const isInlineMediaType = type => INLINE_MEDIA.test(type);

    const walk = (parts, multipartType, inAlternative, htmlBodyList, textBodyList) => {
        const textLength = textBodyList ? textBodyList.length : -1;
        const htmlLength = htmlBodyList ? htmlBodyList.length : -1;

        parts.forEach((part, i) => {
            const isMultipartPart = part.type.startsWith('multipart/');
            // RFC 8621: a part is inline unless it has a disposition of attachment, or it is a text part with a name
            const isInline =
                part.disposition !== 'attachment' &&
                (part.type === 'text/plain' || part.type === 'text/html' || isInlineMediaType(part.type)) &&
                (i === 0 || (multipartType !== 'related' && (isInlineMediaType(part.type) || !part.name)));

            if (isMultipartPart) {
                const subMultiType = part.type.split('/')[1];
                walk(part.subParts || [], subMultiType, inAlternative || subMultiType === 'alternative', htmlBodyList, textBodyList);
            } else if (isInline) {
                if (multipartType === 'alternative') {
                    if (part.type === 'text/plain') {
                        textBodyList && textBodyList.push(part);
                    } else if (part.type === 'text/html') {
                        htmlBodyList && htmlBodyList.push(part);
                    } else {
                        attachments.push(part);
                    }
                    return;
                } else if (inAlternative) {
                    if (part.type === 'text/plain') {
                        htmlBodyList = null;
                    }
                    if (part.type === 'text/html') {
                        textBodyList = null;
                    }
                }
                if (textBodyList) {
                    textBodyList.push(part);
                }
                if (htmlBodyList) {
                    htmlBodyList.push(part);
                }
                if ((!textBodyList || !htmlBodyList) && isInlineMediaType(part.type)) {
                    attachments.push(part);
                }
            } else {
                attachments.push(part);
            }
        });

        if (multipartType === 'alternative' && textBodyList && htmlBodyList) {
            // if one of the alternatives had nothing, use the other
            if (textLength === textBodyList.length && htmlLength !== htmlBodyList.length) {
                for (let i = htmlLength; i < htmlBodyList.length; i++) {
                    textBodyList.push(htmlBodyList[i]);
                }
            }
            if (htmlLength === htmlBodyList.length && textLength !== textBodyList.length) {
                for (let i = textLength; i < textBodyList.length; i++) {
                    htmlBodyList.push(textBodyList[i]);
                }
            }
        }
    };

    walk([rootPart], 'mixed', false, htmlBody, textBody);
    return { textBody, htmlBody, attachments };
}

/** Copies the requested properties of a body part (recursively for subParts). */
function pickPart(part, properties) {
    const result = {};
    for (const property of properties) {
        if (property === 'subParts') {
            result.subParts = part.subParts ? part.subParts.map(sub => pickPart(sub, properties)) : null;
        } else {
            result[property] = part[property];
        }
    }
    return result;
}

function decoderFor(encoding) {
    if (encoding === 'base64') {
        return new libbase64.Decoder();
    }
    if (encoding === 'quoted-printable') {
        return new libqp.Decoder();
    }
    return null;
}

/**
 * Decoded content of a MIME part as a stream, from the tree or from the attachment storage.
 *
 * @param {Object} messageHandler Its indexer resolves parts, its attachment storage holds external bodies
 * @param {Object} mimeTree
 * @param {String} partPath IMAP part path
 * @returns {Promise<{stream: Readable, node: Object}|null>} null for an unknown part
 */
async function openPart(messageHandler, mimeTree, partPath) {
    const node = messageHandler.indexer.resolveContentNode(mimeTree, partPath);
    if (!node || isMultipart(node)) {
        return null;
    }
    let encoding = transferEncoding(node);
    let source;
    const attachmentId = node.attachmentId && messageHandler.indexer.resolveAttachmentId(mimeTree, node.attachmentId);
    if (attachmentId) {
        const attachmentData = await messageHandler.attachmentStorage.get(attachmentId);
        if (attachmentData.metadata && attachmentData.metadata.decoded) {
            // stored decoded: read the stored bytes as they are instead of the re-encoded form
            attachmentData.metadata.decoded = false;
            encoding = 'binary';
        } else {
            encoding = lower(attachmentData.transferEncoding || encoding);
        }
        source = messageHandler.attachmentStorage.createReadStream(attachmentId, attachmentData);
    } else {
        source = Readable.from([bodyBuffer(node)]);
    }
    const decoder = decoderFor(encoding);
    if (decoder) {
        source.once('error', err => decoder.destroy(err));
        source = source.pipe(decoder);
    }
    return { stream: source, node };
}

/**
 * A body value (RFC 8621 4.1.4 EmailBodyValue) of a text part.
 *
 * @param {Object} messageHandler
 * @param {Object} mimeTree
 * @param {Object} part EmailBodyPart
 * @param {Number} maxBytes 0 for no limit
 */
async function bodyValue(messageHandler, mimeTree, part, maxBytes) {
    const opened = await openPart(messageHandler, mimeTree, part.partId);
    if (!opened) {
        return { value: '', isEncodingProblem: true, isTruncated: false };
    }
    let isEncodingProblem = false;
    let content;
    try {
        content = await streamToBuffer(opened.stream);
    } catch {
        isEncodingProblem = true;
        content = Buffer.alloc(0);
    }

    let value;
    const charset = part.charset || 'us-ascii';
    if (/^(us-ascii|ascii|utf-?8)$/.test(charset)) {
        value = content.toString('utf8');
        isEncodingProblem = isEncodingProblem || value.includes('�');
    } else if (iconv.encodingExists(charset)) {
        value = iconv.decode(content, charset);
    } else {
        // unknown charset: show what decodes as UTF-8 and say so
        value = content.toString('utf8');
        isEncodingProblem = true;
    }
    value = value.replace(/\r\n/g, '\n');
    const params = (opened.node.parsedHeader['content-type'] && opened.node.parsedHeader['content-type'].params) || {};
    if (lower(params.format) === 'flowed') {
        value = libmime.decodeFlowed(value, lower(params.delsp) === 'yes');
    }

    let isTruncated = false;
    if (maxBytes && Buffer.byteLength(value) > maxBytes) {
        isTruncated = true;
        value = truncateUtf8(value, maxBytes);
    }
    return { value, isEncodingProblem, isTruncated };
}

// cuts a string to at most maxBytes UTF-8 bytes without splitting a character: when the first byte
// after the cut continues a character, the cut moves back to where that character starts
function truncateUtf8(value, maxBytes) {
    const buffer = Buffer.from(value, 'utf8');
    let end = Math.min(maxBytes, buffer.length);
    // continuation bytes are 0x80 to 0xbf
    while (end > 0 && end < buffer.length && buffer[end] >= 0x80 && buffer[end] < 0xc0) {
        end--;
    }
    return buffer.subarray(0, end).toString('utf8');
}

module.exports = { bodyStructure, parseStructure, pickPart, openPart, bodyValue, truncateUtf8, DEFAULT_BODY_PROPERTIES, BODY_PROPERTIES };
