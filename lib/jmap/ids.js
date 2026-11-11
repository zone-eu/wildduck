'use strict';

// JMAP ids (RFC 8620 1.2): letter prefixed, only A-Za-z0-9-_. Every id maps to one ObjectId (or, for
// a MIME part blob, an ObjectId and a part path), and parsing is strict, so a malformed or foreign
// shaped id never reaches a database query as anything but an ObjectId.

const { ObjectId } = require('mongodb');

const HEX = '[0-9a-f]{24}';

// type -> single letter prefix
const PREFIX = {
    account: 'u',
    email: 'M',
    thread: 'T',
    mailbox: 'F',
    identity: 'I',
    submission: 'S',
    pushSubscription: 'P'
};

const PATTERNS = Object.fromEntries(Object.entries(PREFIX).map(([type, prefix]) => [type, new RegExp(`^${prefix}(${HEX})$`)]));

// blob ids: raw message, decoded MIME part (part path 1.2.3 written as 1-2-3), temporary upload
const BLOB_MESSAGE = new RegExp(`^Bm(${HEX})$`);
const BLOB_PART = new RegExp(`^Bp(${HEX})_([1-9][0-9]{0,4}(?:-[1-9][0-9]{0,4}){0,49})$`);
const BLOB_UPLOAD = new RegExp(`^Bu(${HEX})$`);

/**
 * Formats an id.
 *
 * @param {String} type One of the PREFIX keys
 * @param {ObjectId|String} value
 */
function formatId(type, value) {
    return PREFIX[type] + value.toString();
}

/**
 * Parses an id of the given type into an ObjectId, or null if it is not one.
 */
function parseId(type, id) {
    const match = typeof id === 'string' && PATTERNS[type].exec(id);
    return match ? new ObjectId(match[1]) : null;
}

const blobId = {
    message: root => `Bm${root}`,
    part: (root, partPath) => `Bp${root}_${String(partPath).replace(/\./g, '-')}`,
    upload: fileId => `Bu${fileId}`
};

/**
 * Parses a blob id.
 *
 * @returns {{kind: 'message'|'part'|'upload', id: ObjectId, part?: String}|null} part is the IMAP part path (1.2.3)
 */
function parseBlobId(id) {
    if (typeof id !== 'string') {
        return null;
    }
    let match = BLOB_MESSAGE.exec(id);
    if (match) {
        return { kind: 'message', id: new ObjectId(match[1]) };
    }
    match = BLOB_PART.exec(id);
    if (match) {
        return { kind: 'part', id: new ObjectId(match[1]), part: match[2].replace(/-/g, '.') };
    }
    match = BLOB_UPLOAD.exec(id);
    if (match) {
        return { kind: 'upload', id: new ObjectId(match[1]) };
    }
    return null;
}

/** True for a syntactically valid JMAP Id (RFC 8620 1.2): 1 to 255 octets of A-Za-z0-9-_ */
const isValidId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(id);

// a media type as a client gives it for a blob (upload Content-Type, download type parameter)
const MEDIA_TYPE = /^[\x21-\x7e]+\/[\x20-\x7e]+$/;

module.exports = { MEDIA_TYPE, formatId, parseId, blobId, parseBlobId, isValidId, PREFIX };
