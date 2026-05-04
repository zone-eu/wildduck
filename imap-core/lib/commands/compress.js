'use strict';

const zlib = require('zlib');
const InflateLimitStream = require('../inflate-limit-stream');

// tag COMPRESS DEFLATE
module.exports = {
    state: ['Authenticated', 'Selected'],

    schema: [
        {
            name: 'mechanism',
            type: 'string'
        }
    ],

    handler(command, callback) {
        let mechanism = ((command.attributes[0] && command.attributes[0].value) || '').toString().toUpperCase().trim();

        if (!mechanism) {
            return callback(null, {
                response: 'BAD'
            });
        }

        if (mechanism !== 'DEFLATE') {
            return callback(null, {
                response: 'BAD',
                code: 'CANNOT',
                message: 'Unsupported compression mechanism'
            });
        }

        setImmediate(() => {
            // Check if connection is already closed or closing
            if (!this._parser) {
                return this.close();
            }

            this.compression = true;

            this._deflate = zlib.createDeflateRaw({
                windowBits: 15
            });
            this._inflate = zlib.createInflateRaw();
            this._inflateLimit = new InflateLimitStream({
                maxInflatedBytes: Number(this._server.options.maxCompressionInflateBytes)
            });

            let onCompressionError = (err, tnx) => {
                this._server.logger.debug(
                    {
                        err,
                        tnx,
                        cid: this.id
                    },
                    '[%s] %s error %s',
                    this.id,
                    tnx,
                    err.message
                );
                this.close();
            };

            this._deflate.once('error', err => {
                onCompressionError(err, 'deflate');
            });

            this._inflate.once('error', err => {
                onCompressionError(err, 'inflate');
            });

            this._inflateLimit.once('error', err => {
                onCompressionError(err, 'inflate-limit');
            });

            this.writeStream.unpipe(this._socket);
            this._deflate.pipe(this._socket);
            let reading = false;
            let readNext = () => {
                reading = true;

                let chunk;
                while ((chunk = this.writeStream.read()) !== null) {
                    if (this._deflate && this._deflate.write(chunk) === false) {
                        return this._deflate.once('drain', readNext);
                    }
                }

                // flush data to socket
                if (this._deflate) {
                    this._deflate.flush();
                }

                reading = false;
            };
            this.writeStream.on('readable', () => {
                if (!reading) {
                    readNext();
                }
            });

            this._socket.unpipe(this._parser);
            this._socket.pipe(this._inflate).pipe(this._inflateLimit).pipe(this._parser);
        });

        callback(null, {
            response: 'OK',
            message: 'DEFLATE active'
        });
    }
};
