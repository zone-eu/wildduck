'use strict';

const libbase64 = require('libbase64');

function prepareAttachment(attachment, decodeBase64) {
    const metadata = {
        m: attachment.magic,
        c: 1,
        cu: new Date(),
        esize: attachment.body.length,
        transferEncoding: attachment.transferEncoding
    };
    const body = attachment.body;
    if (!decodeBase64 || attachment.transferEncoding !== 'base64') {
        return { body, metadata };
    }

    // Keep the existing first-line and line-count checks before attempting a decode.
    const firstLine = /^([A-Za-z0-9+/=]{1,998})(?:\r\n|$)/.exec(body.subarray(0, 1000).toString('latin1'));
    if (!firstLine) {
        return { body, metadata };
    }
    let lineLen = firstLine[1].length;
    if (body.length === lineLen && lineLen < 76) {
        lineLen = 76;
    }
    const expectedLineCount = Math.ceil(body.length / (lineLen + 2));
    if (attachment.lineCount < expectedLineCount - 1 || attachment.lineCount > expectedLineCount + 1 || !Number.isFinite(attachment.lineCount)) {
        return { body, metadata };
    }

    const encoded = body.toString('latin1');
    const decoded = libbase64.decode(encoded);
    // Uneven folding, whitespace and noncanonical padding must retain their original MIME bytes.
    if (libbase64.wrap(decoded.toString('base64'), lineLen) !== encoded) {
        return { body, metadata };
    }
    metadata.decoded = true;
    metadata.lineLen = lineLen;
    return { body: decoded, metadata };
}

module.exports = prepareAttachment;
