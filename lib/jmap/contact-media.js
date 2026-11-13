'use strict';

// Media of ContactCards (RFC 9610 3): photos, logos and sounds are kept as blobs. A data: URI sent by a
// client and a blob it uploaded are stored as a contact media file and the card names it by blobId.
// The content decides the type: a photo or logo must be an image the server recognises, a sound an
// audio file, whatever type the client declared (RFC 9610 3.5).

// media kind -> recognised types
const ACCEPTED = {
    photo: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    logo: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    sound: ['audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/flac']
};

const startsWith = (buffer, bytes, offset = 0) => buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);
const ascii = text => [...Buffer.from(text, 'latin1')];

/**
 * The media type of a file by its first bytes, or null when it is not one of the recognised types.
 *
 * @param {Buffer} content
 * @returns {String|null}
 */
function sniff(content) {
    if (startsWith(content, [0xff, 0xd8, 0xff])) {
        return 'image/jpeg';
    }
    if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return 'image/png';
    }
    if (startsWith(content, ascii('GIF87a')) || startsWith(content, ascii('GIF89a'))) {
        return 'image/gif';
    }
    if (startsWith(content, ascii('RIFF')) && startsWith(content, ascii('WEBP'), 8)) {
        return 'image/webp';
    }
    if (startsWith(content, ascii('RIFF')) && startsWith(content, ascii('WAVE'), 8)) {
        return 'audio/wav';
    }
    if (startsWith(content, ascii('OggS'))) {
        return 'audio/ogg';
    }
    if (startsWith(content, ascii('fLaC'))) {
        return 'audio/flac';
    }
    if (startsWith(content, ascii('ID3')) || (content.length > 1 && content[0] === 0xff && content[1] >= 0xe0)) {
        return 'audio/mpeg';
    }
    return null;
}

/**
 * The type a media file of a kind is stored with: the recognised type of its content. A vendor kind
 * takes any non empty content with the declared type.
 *
 * @param {String} kind Media kind
 * @param {Buffer} content
 * @param {String|null} declared the type the client named
 * @returns {String|null} null when the content is not acceptable for the kind
 */
function mediaTypeFor(kind, content, declared) {
    if (!content.length) {
        return null;
    }
    const type = sniff(content);
    if (ACCEPTED[kind]) {
        return type && ACCEPTED[kind].includes(type) ? type : null;
    }
    return type || (typeof declared === 'string' && /^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(declared) ? declared.toLowerCase() : 'application/octet-stream');
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Parses a data: URI (RFC 2397).
 *
 * @param {String} uri
 * @param {Number} limit most octets the content may have
 * @returns {{type: String|null, content: Buffer}|null} null when it is not a data: URI or is malformed
 * @throws {Error} code TooLarge when the content is longer than the limit
 */
function parseDataUri(uri, limit) {
    const match = /^data:([^,]*),(.*)$/is.exec(uri);
    if (!match) {
        return null;
    }
    const params = match[1].split(';').map(param => param.trim());
    const base64 = params[params.length - 1].toLowerCase() === 'base64';
    const type = params[0] && params[0].includes('/') ? params[0].toLowerCase() : null;
    const data = match[2];
    // a decoded length that is certainly too large is refused before decoding
    if ((base64 ? Math.floor((data.length * 3) / 4) - 2 : data.length / 3) > limit) {
        const err = new Error('The data is too large');
        err.code = 'TooLarge';
        throw err;
    }
    let content;
    if (base64) {
        const compact = data.replace(/\s+/g, '');
        if (!BASE64.test(compact) || compact.length % 4 === 1) {
            return null;
        }
        content = Buffer.from(compact, 'base64');
    } else {
        try {
            content = Buffer.from(decodeURIComponent(data), 'utf-8');
        } catch {
            return null;
        }
    }
    if (content.length > limit) {
        const err = new Error('The data is too large');
        err.code = 'TooLarge';
        throw err;
    }
    return { type, content };
}

module.exports = { sniff, mediaTypeFor, parseDataUri, ACCEPTED };
