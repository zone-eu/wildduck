'use strict';

const imapHandler = require('./handler/imap-handler');
const Transform = require('stream').Transform;

class IMAPComposer extends Transform {
    constructor(options) {
        super();
        Transform.call(this, {
            writableObjectMode: true
        });
        options = options || {};
        this.connection = options.connection;
        this.skipFetchLog = options.skipFetchLog;
    }

    _transform(obj, encoding, done) {
        if (!obj) {
            return done();
        }

        if (typeof obj.pipe === 'function') {
            // pipe stream to socket and wait until it finishes before continuing

            if (!this.skipFetchLog) {
                let description = [obj.description, obj._mailbox, obj._message, obj._uid].filter(v => v).join('/');
                this.connection.logger.debug(
                    {
                        tnx: 'pipeout',
                        cid: this.connection.id
                    },
                    '[%s] S: <fetch response%s>',
                    this.connection.id,
                    description ? ' ' + description : ''
                );
            }

            let target = this.connection[!this.connection.compression ? '_socket' : '_deflate'];
            // with COMPRESS the target is the deflate stream, the socket is what closes
            let socket = this.connection._socket;
            if (target.destroyed || socket.destroyed) {
                obj.destroy();
                return done();
            }

            let finished = false;
            let onClose;
            let finish = () => {
                if (finished) {
                    return false;
                }
                finished = true;
                socket.removeListener('close', onClose);
                return true;
            };
            // a closed connection does not end a pipe, it only stops it: tear the stream down, so its source
            // (an attachment read from storage) is released, and move on
            onClose = () => {
                if (finish()) {
                    obj.destroy();
                    return done();
                }
            };
            socket.once('close', onClose);

            obj.pipe(target, {
                end: false
            });
            obj.once('error', err => {
                if (finish()) {
                    this.emit('error', err);
                }
            });
            obj.once('end', () => {
                if (finish()) {
                    this.push('\r\n');
                    return done();
                }
            });
            return;
        }

        let compiled = obj.compiled ? obj.compiled : imapHandler.compiler(obj);

        if (!this.skipFetchLog || (!obj.compiled && this.skipFetchLog)) {
            this.connection.logger.debug(
                {
                    tnx: 'send',
                    cid: this.connection.id
                },
                '[%s] S:',
                this.connection.id,
                compiled
            );
        }

        // <https://github.com/zone-eu/wildduck/issues/563>
        // <https://github.com/zone-eu/wildduck/pull/564
        if (typeof compiled === 'object') {
            this.push(compiled);
            this.push('\r\n');
        } else if (typeof compiled === 'string') {
            this.push(Buffer.from(compiled + '\r\n', 'binary'));
        } else {
            return done(new TypeError('"compiled" was not an object or string'));
        }

        done();
    }

    _flush(done) {
        done();
    }
}

module.exports.IMAPComposer = IMAPComposer;
