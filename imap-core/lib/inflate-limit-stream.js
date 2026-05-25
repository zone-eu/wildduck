'use strict';

const Transform = require('stream').Transform;

const DEFAULT_MAX_INFLATED_BYTES = 100 * 1024 * 1024; // 100MB
const ERROR_MESSAGE = 'Compressed input exceeds maximum inflated command size';
const ERROR_CODE = 'CompressedInputTooLarge';
const RESPONSE_CODE = 400;

class InflateLimitStream extends Transform {
    constructor(options) {
        options = options || {};
        super(options);

        this.maxInflatedBytes = Number.isFinite(options.maxInflatedBytes) ? Math.max(options.maxInflatedBytes, 0) : DEFAULT_MAX_INFLATED_BYTES;
        this.inflatedBytes = 0;
    }

    resetInflatedBytes() {
        this.inflatedBytes = 0;
    }

    _transform(chunk, encoding, callback) {
        if (!chunk || !chunk.length) {
            return callback();
        }

        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }

        if (!this.maxInflatedBytes) {
            this.push(chunk);
            return callback();
        }

        this.inflatedBytes += chunk.length;

        if (this.inflatedBytes > this.maxInflatedBytes) {
            let err = new Error(ERROR_MESSAGE);
            err.code = ERROR_CODE;
            err.responseCode = RESPONSE_CODE;
            return callback(err);
        }

        this.push(chunk);
        callback();
    }
}

module.exports = InflateLimitStream;
