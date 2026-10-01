'use strict';

const { Transform, pipeline } = require('stream');
const libbase64 = require('libbase64');
const base64Offset = require('./base64-offset');

function getReadOptions(attachmentData, options = {}) {
    const metadata = attachmentData.metadata || {};
    const startFrom = Math.max(0, options.startFrom || 0);
    let start = startFrom;
    let end = options.maxLength ? start + options.maxLength : attachmentData.length;
    let encoderOptions;
    if (metadata.decoded) {
        const offsets = base64Offset(metadata.lineLen, startFrom, options.maxLength);
        start = offsets.binaryStartOffset;
        end = offsets.binaryEndOffset || attachmentData.length;
        encoderOptions = {
            lineLength: metadata.lineLen,
            skipStartBytes: offsets.base64SkipStartBytes,
            startPadding: offsets.base64Padding
        };
    }
    start = Math.min(Math.max(0, start), attachmentData.length);
    end = Math.min(Math.max(start, end), attachmentData.length);

    // libbase64's encoder can emit a final CRLF or bytes beyond a partial read.
    // Enforce the length here; its limitOutputBytes option is misspelled in libbase64.
    let outputLength = options.maxLength || Infinity;
    if (metadata.decoded && Number.isSafeInteger(metadata.esize)) {
        outputLength = Math.min(outputLength, Math.max(0, metadata.esize - startFrom));
    }
    return { streamOptions: { start, end }, encoderOptions, outputLength };
}

function createOutputStream(outputLength) {
    const output = new Transform({
        transform(chunk, encoding, callback) {
            const remaining = Math.max(0, outputLength - this.outputBytes);
            const selected = chunk.subarray(0, remaining);
            this.outputBytes += selected.length;
            callback(null, selected);
        }
    });
    output.outputBytes = 0;
    return output;
}

function pipeAttachment(input, output, encoderOptions) {
    if (output.destroyed) {
        input.destroy();
        return;
    }
    const streams = encoderOptions ? [input, new libbase64.Encoder(encoderOptions), output] : [input, output];
    pipeline(...streams, err => {
        if (err) {
            output.destroy(err);
        }
    });
}

module.exports = { getReadOptions, createOutputStream, pipeAttachment };
