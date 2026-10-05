'use strict';

// Base64 attachments are stored decoded to save space and to deduplicate the same file across messages.
// This module holds the two decisions that keep that lossless: whether a transfer-encoded body can be
// stored decoded at all, and how to serve any byte window of its re-encoded form exactly as the body
// appeared in the message. It knows nothing about where the bytes live: the storage driver supplies a
// reader for a range of decoded bytes.

const libbase64 = require('libbase64');
const { Transform, pipeline } = require('stream');
const base64Offset = require('./base64-offset');

// RFC 5322 2.1.1: a line must not be longer than 998 characters
const MAX_LINE_LENGTH = 998;
const DEFAULT_LINE_LENGTH = 76;

/**
 * Number of bytes `decodedLength` bytes take up as base64 wrapped at `lineLen` with CRLF line breaks and
 * no line break after the last line
 *
 * @param {Number} decodedLength Length of the decoded data
 * @param {Number} lineLen Line length of the wrapped output
 * @returns {Number} Length of the encoded form
 */
function encodedLength(decodedLength, lineLen) {
    let chars = Math.ceil(decodedLength / 3) * 4;
    let breaks = chars && lineLen ? Math.ceil(chars / lineLen) - 1 : 0;
    return chars + breaks * 2;
}

/**
 * Approximate number of decoded bytes behind `encodedLength` bytes of wrapped base64, for size estimates
 *
 * @param {Number} encodedLength Length of the encoded form
 * @param {Number} [lineLen] Line length of the wrapped output
 * @returns {Number} Decoded length
 */
function decodedLength(encodedLength, lineLen) {
    encodedLength = Number(encodedLength) || 0;
    if (encodedLength <= 0) {
        return 0;
    }
    let breaks = Math.floor(encodedLength / ((lineLen || DEFAULT_LINE_LENGTH) + 2));
    return Math.ceil(((encodedLength - breaks * 2) / 4) * 3);
}

/**
 * The byte range `{ start, end }` that `{ startFrom, maxLength }` selects out of `total` bytes
 */
function byteWindow(options, total) {
    options = options || {};
    let start = Math.min(Math.max(Number(options.startFrom) || 0, 0), total);
    let maxLength = Math.max(Number(options.maxLength) || 0, 0);
    return { start, end: Math.min(maxLength ? start + maxLength : total, total) };
}

/**
 * Line break bytes used to fill a gap. `phase` is 1 when the gap starts at the LF of a CRLF pair
 */
function filler(length, phase) {
    phase = phase ? 1 : 0;
    return Buffer.from('\r\n'.repeat(Math.ceil((length + phase) / 2))).subarray(phase, phase + length);
}

/**
 * Checks whether a base64 transfer-encoded body can be stored decoded and served again byte for byte.
 *
 * The body qualifies when it is a canonical base64 encoding wrapped at one line length, followed by
 * nothing but CRLFs (the blank line some composers put before the next boundary). The proof is a
 * decode and re-encode: unpadded data, uneven wrapping, foreign characters and anything else that the
 * encoder would not reproduce is rejected and stored verbatim instead.
 *
 * @param {Buffer} body Transfer-encoded body bytes, CRLF line endings
 * @returns {Object|Boolean} `{ data, lineLen }` with the decoded bytes and the wrap length, or false
 */
function inspectBase64(body) {
    if (!Buffer.isBuffer(body) || !body.length) {
        return false;
    }

    let end = body.length;
    while (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) {
        end -= 2;
    }
    if (!end) {
        return false;
    }

    let text = body.subarray(0, end);
    let firstBreak = text.indexOf('\r\n');
    // a single line shorter than the default wrap length is served with the default wrap length
    let lineLen = firstBreak < 0 ? Math.max(text.length, DEFAULT_LINE_LENGTH) : firstBreak;
    if (!lineLen || lineLen > MAX_LINE_LENGTH) {
        return false;
    }

    let latin1 = text.toString('latin1');
    let data = libbase64.decode(latin1);
    if (encodedLength(data.length, lineLen) !== text.length) {
        return false;
    }

    // the proof: a line break after every lineLen characters (the length check fixes their number, so a
    // break anywhere else would shift one of these), and the text without them is the encoding itself
    for (let pos = lineLen; pos < text.length; pos += lineLen + 2) {
        if (text[pos] !== 0x0d || text[pos + 1] !== 0x0a) {
            return false;
        }
    }
    if (latin1.replace(/\r\n/g, '') !== libbase64.encode(data)) {
        return false;
    }

    return { data, lineLen };
}

/**
 * Decides how a transfer-encoded body is stored: decoded when it is base64 that re-encodes byte for
 * byte and decoding is enabled, as it is otherwise. Every storage driver stores what this returns
 *
 * @param {Object} attachment `{ body, transferEncoding }` as handed to a storage's create()
 * @param {Object} [options] `{ decodeBase64 }`
 * @returns {Object} `{ data, metadata }`: the bytes to store and the metadata to keep with them
 */
function prepareStoredBody(attachment, options) {
    let metadata = { esize: attachment.body.length, transferEncoding: attachment.transferEncoding };
    let data = attachment.body;

    if (attachment.transferEncoding === 'base64' && options && options.decodeBase64) {
        let base64 = inspectBase64(attachment.body);
        if (base64) {
            metadata.decoded = true;
            metadata.lineLen = base64.lineLen;
            data = base64.data;
        }
    }

    return { data, metadata };
}

/**
 * Cuts the re-encoded stream at the length the message holds and appends the line breaks that follow
 * the encoded text, so the body occupies exactly the bytes it occupied when it was stored, whatever
 * the encoder produced
 */
class EncodedWindow extends Transform {
    constructor(need, tail, tailPhase) {
        super();
        // bytes to take from the encoder
        this.need = need;
        // CRLF bytes after the encoded text that fall inside the window, and whether they start at a LF
        this.tail = tail;
        this.tailPhase = tailPhase;
        this.produced = 0;
    }

    _transform(chunk, encoding, done) {
        if (this.produced >= this.need) {
            // the encoder may append a line break after a chunk that ends exactly at the line length;
            // past the canonical length that is not part of the message
            return done();
        }
        let take = Math.min(chunk.length, this.need - this.produced);
        this.produced += take;
        done(null, take === chunk.length ? chunk : chunk.subarray(0, take));
    }

    _flush(done) {
        if (this.tail > 0) {
            this.push(filler(this.tail, this.tailPhase));
        }
        done();
    }
}

/**
 * Serves a byte window of a decoded attachment as it appeared in the message.
 *
 * The body occupies `file.esize` bytes in the message. The first `encodedLength(file.length, lineLen)`
 * of them are the wrapped base64 text, anything after that is CRLF. When `esize` is shorter than the
 * canonical encoding (a body stored decoded by an earlier acceptance rule although it lacked base64
 * padding) the output is cut at `esize`.
 *
 * @param {Function} readDecoded `(start, end) => Readable` yielding decoded bytes [start, end)
 * @param {Object} file `{ length, lineLen, esize }`: decoded length, wrap length, bytes the body occupies in the message
 * @param {Object} [options] `{ startFrom, maxLength }` window in message bytes, relative to the body start
 * @returns {Readable} Stream of exactly the requested window
 */
function createEncodedStream(readDecoded, file, options) {
    options = options || {};

    let lineLen = Number(file.lineLen) || DEFAULT_LINE_LENGTH;
    let canonical = encodedLength(file.length, lineLen);
    let total = Number.isFinite(file.esize) && file.esize >= 0 ? file.esize : canonical;

    let { start: startFrom, end } = byteWindow(options, total);

    let need = Math.max(0, Math.min(end, canonical) - startFrom);
    let tailStart = Math.max(startFrom, canonical);
    let tail = Math.max(0, end - tailStart);
    let window = new EncodedWindow(need, tail, (tailStart - canonical) % 2);

    if (!need) {
        // nothing to read, the window is empty or lies entirely in the trailing line breaks
        setImmediate(() => window.end());
        return window;
    }

    let offsets = base64Offset(lineLen, startFrom, need);
    let binaryStart = Math.min(offsets.binaryStartOffset, file.length);
    let binaryEnd = Math.min(offsets.binaryEndOffset, file.length);

    let source = readDecoded(binaryStart, binaryEnd);
    let encoder = new libbase64.Encoder({
        lineLength: lineLen,
        skipStartBytes: offsets.base64SkipStartBytes,
        startPadding: offsets.base64Padding
    });

    // an error or the consumer going away tears the whole chain down, the source included
    pipeline(source, encoder, window, () => false);

    return window;
}

/**
 * Serves a byte window of a stored attachment body as it appeared in the message, whether the body was
 * stored decoded (re-encoded on the way out) or as it was
 *
 * @param {Function} readRange `(start, end) => Readable` yielding stored bytes [start, end)
 * @param {Object} attachmentData `{ length, metadata: { decoded, lineLen, esize } }` as returned by a storage's get()
 * @param {Object} [options] `{ startFrom, maxLength }` window relative to the body start, whole body when omitted
 * @returns {Readable}
 */
function createReadWindow(readRange, attachmentData, options) {
    options = options || {};
    let metadata = (attachmentData && attachmentData.metadata) || {};
    let length = Number(attachmentData && attachmentData.length) || 0;

    if (metadata.decoded) {
        return createEncodedStream(readRange, { length, lineLen: metadata.lineLen, esize: metadata.esize }, options);
    }

    let { start, end } = byteWindow(options, length);
    return readRange(start, end);
}

module.exports = { byteWindow, decodedLength, inspectBase64, prepareStoredBody, createReadWindow, filler };
