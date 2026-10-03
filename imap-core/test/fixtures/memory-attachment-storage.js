'use strict';

// In-memory attachment storage for tests: the same interface as lib/attachment-storage.js, the same
// metadata decisions and read windows as the GridFS driver (through lib/attachments/base64-codec.js),
// bytes held in a Map. `chunkSize` controls how stored bytes are delivered, since the base64 encoder's
// output depends on chunk boundaries the same way it does with GridFS chunks.

const crypto = require('crypto');
const { Readable } = require('stream');
const libbase64 = require('libbase64');
const { inspectBase64, createEncodedStream } = require('../../../lib/attachments/base64-codec');

/**
 * The acceptance rule used before base64-codec existed: look at the first line only and allow the line
 * count to be off by one. Kept to produce the metadata shape of attachments that are already in
 * production stores, so the read side can be tested against it.
 */
function legacyLineLength(attachment) {
    let lineLen = 0;
    let expectBr = false;
    for (let i = 0, len = Math.min(1000, attachment.body.length); i < len; i++) {
        let chr = attachment.body[i];
        if (expectBr && chr === 0x0a) {
            break;
        } else if (expectBr) {
            return 0;
        } else if ((chr >= 0x30 && chr <= 0x39) || (chr >= 0x41 && chr <= 0x5a) || (chr >= 0x61 && chr <= 0x7a) || chr === 0x2b || chr === 0x2f || chr === 0x3d) {
            lineLen++;
        } else if (chr === 0x0d) {
            expectBr = true;
        } else {
            return 0;
        }
    }

    if (!lineLen || lineLen > 998) {
        return 0;
    }
    if (attachment.body.length === lineLen && lineLen < 76) {
        lineLen = 76;
    }
    let expectedLineCount = Math.ceil(attachment.body.length / (lineLen + 2));
    if (attachment.lineCount >= expectedLineCount - 1 && attachment.lineCount <= expectedLineCount + 1) {
        return lineLen;
    }
    return 0;
}

function chunked(buf, chunkSize) {
    let parts = [];
    for (let i = 0; i < buf.length; i += chunkSize) {
        parts.push(buf.subarray(i, i + chunkSize));
    }
    return Readable.from(parts);
}

class MemoryAttachmentStorage {
    constructor(options) {
        options = options || {};
        this.decodeBase64 = options.decodeBase64 !== false;
        this.chunkSize = options.chunkSize || 255 * 1024;
        this.legacyDecoding = !!options.legacyDecoding;
        this.files = new Map();
    }

    create(attachment, callback) {
        let hash = crypto.createHash('sha256').update(attachment.body).digest();
        let key = hash.toString('hex');

        let metadata = { esize: attachment.body.length, transferEncoding: attachment.transferEncoding };
        let data = attachment.body;

        if (attachment.transferEncoding === 'base64' && this.decodeBase64) {
            if (this.legacyDecoding) {
                let lineLen = legacyLineLength(attachment);
                if (lineLen) {
                    metadata.decoded = true;
                    metadata.lineLen = lineLen;
                    data = libbase64.decode(attachment.body.toString('latin1'));
                }
            } else {
                let base64 = inspectBase64(attachment.body);
                if (base64) {
                    metadata.decoded = true;
                    metadata.lineLen = base64.lineLen;
                    data = base64.data;
                }
            }
        }

        if (this.files.has(key)) {
            this.files.get(key).count++;
        } else {
            this.files.set(key, { contentType: attachment.contentType, data, metadata, count: 1 });
        }

        setImmediate(() => callback(null, hash, 'test-content-hash'));
    }

    async get(id) {
        let file = this.files.get(id.toString('hex'));
        if (!file) {
            let err = new Error('This attachment does not exist');
            err.code = 'FileNotFound';
            throw err;
        }
        return {
            contentType: file.contentType,
            transferEncoding: file.metadata.transferEncoding,
            length: file.data.length,
            count: file.count,
            hash: id,
            metadata: file.metadata
        };
    }

    createReadStream(id, attachmentData, options) {
        options = options || {};
        let file = this.files.get(id.toString('hex'));
        if (!file) {
            let stream = new Readable({ read() {} });
            setImmediate(() => {
                let err = new Error('FileNotFound');
                err.code = 'ENOENT';
                stream.destroy(err);
            });
            return stream;
        }

        let read = (start, end) => chunked(file.data.subarray(start, end), this.chunkSize);
        let metadata = (attachmentData && attachmentData.metadata) || {};

        if (metadata.decoded) {
            return createEncodedStream(read, { length: file.data.length, lineLen: metadata.lineLen, esize: metadata.esize }, options);
        }

        let start = Math.min(Math.max(Number(options.startFrom) || 0, 0), file.data.length);
        let end = options.maxLength ? Math.min(start + Number(options.maxLength), file.data.length) : file.data.length;
        return read(start, end);
    }

    async deleteManyAsync() {
        return true;
    }
}

module.exports = MemoryAttachmentStorage;
