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

            obj.pipe(this.connection[!this.connection.compression ? '_socket' : '_deflate'], {
                end: false
            });
            obj.once('error', err => this.emit('error', err));
            obj.once('end', () => {
                this.push('\r\n');
                done();
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
