'use strict';

const errors = require('../../lib/errors.js');
const imapHandler = require('./handler/imap-handler');
const MAX_MESSAGE_SIZE = 1 * 1024 * 1024;
const MAX_BAD_COMMANDS = 50;

const commands = new Map([
    /*eslint-disable global-require*/
    // require must normally be on top of the module
    ['NOOP', require('./commands/noop')],
    ['CAPABILITY', require('./commands/capability')],
    ['LOGOUT', require('./commands/logout')],
    ['ID', require('./commands/id')],
    ['STARTTLS', require('./commands/starttls')],
    ['LOGIN', require('./commands/login')],
    ['AUTHENTICATE PLAIN', require('./commands/authenticate-plain')],
    ['AUTHENTICATE PLAIN-CLIENTTOKEN', require('./commands/authenticate-plain')],
    ['NAMESPACE', require('./commands/namespace')],
    ['LIST', require('./commands/list')],
    ['XLIST', require('./commands/list')],
    ['LSUB', require('./commands/lsub')],
    ['SUBSCRIBE', require('./commands/subscribe')],
    ['UNSUBSCRIBE', require('./commands/unsubscribe')],
    ['CREATE', require('./commands/create')],
    ['DELETE', require('./commands/delete')],
    ['RENAME', require('./commands/rename')],
    ['SELECT', require('./commands/select')],
    ['EXAMINE', require('./commands/select')],
    ['IDLE', require('./commands/idle')],
    ['CHECK', require('./commands/check')],
    ['STATUS', require('./commands/status')],
    ['APPEND', require('./commands/append')],
    ['STORE', require('./commands/store')],
    ['UID STORE', require('./commands/uid-store')],
    ['EXPUNGE', require('./commands/expunge')],
    ['UID EXPUNGE', require('./commands/uid-expunge')],
    ['CLOSE', require('./commands/close')],
    ['UNSELECT', require('./commands/unselect')],
    ['COPY', require('./commands/copy')],
    ['UID COPY', require('./commands/copy')],
    ['MOVE', require('./commands/move')],
    ['UID MOVE', require('./commands/move')],
    ['FETCH', require('./commands/fetch')],
    ['UID FETCH', require('./commands/fetch')],
    ['SEARCH', require('./commands/search')],
    ['UID SEARCH', require('./commands/search')],
    ['ENABLE', require('./commands/enable')],
    ['GETQUOTAROOT', require('./commands/getquotaroot')],
    ['SETQUOTA', require('./commands/setquota')],
    ['GETQUOTA', require('./commands/getquota')],
    ['COMPRESS', require('./commands/compress')],
    ['XAPPLEPUSHSERVICE', require('./commands/xapplepushservice')]
    /*eslint-enable global-require*/
]);

function createCommandFailureLogEntry(connection, err, extra = {}) {
    let logEntry = {
        short_message: `[IMAPCMDERR] ${err.message}`,
        _service: 'imap',
        _failure_msg: err.message,
        _code: err.code,
        _response: err.response,
        _responseCode: err.responseCode,
        _selected: connection.selected?.mailbox,
        _userId: connection.session?.user?.id?.toString(),
        _sess: connection.id,
        _remoteAddress: connection.session?.remoteAddress,
        _isUTF8Enabled: !!connection.acceptUTF8Enabled,
        ...extra
    };

    return errors.applyErrorLogMeta(logEntry, err);
}

class IMAPCommand {
    constructor(connection) {
        this.connection = connection;
        this.payload = '';
        this.literals = [];
        this.first = true;
        this.connection._badCount = this.connection._badCount || 0;
    }

    append(command, callback) {
        let chunks = [];
        let chunklen = 0;

        this.payload += command.value;

        if (this.first) {
            // fetch tag and command name
            this.first = false;

            // only check payload if it is a regular command, not input for something else
            if (typeof this.connection._nextHandler !== 'function') {
                let match = /^([^\s]+)(?:\s+((?:AUTHENTICATE |UID )?[^\s]+)|$)/i.exec(command.value) || [];
                this.tag = match[1];
                this.command = (match[2] || '').trim().toUpperCase();

                if (!this.command || !this.tag) {
                    let err = new Error('Invalid tag');
                    err.responseCode = 400;
                    err.code = 'InvalidTag';
                    if (this.payload && this.connection && typeof this.connection.loggelf === 'function') {
                        // no payload means empty line
                        // Log malformed client input where the line can not be matched to a valid IMAP tag.
                        let logEntry = createCommandFailureLogEntry(this.connection, err, {
                            _payload: this.payload.length < 256 ? this.payload : this.payload.toString().substr(0, 150) + '...'
                        });
                        this.connection.loggelf(logEntry);
                    }
                    this.connection.send('* BAD Invalid tag');
                    return callback(err);
                }

                if (!commands.has(this.command)) {
                    let err = new Error('Unknown command');
                    err.responseCode = 400;
                    err.code = 'UnknownCommand';
                    if (this.connection && typeof this.connection.loggelf === 'function') {
                        // Log tagged IMAP input that names a command this server does not implement.
                        let logEntry = createCommandFailureLogEntry(this.connection, err, {
                            _command: this.command,
                            _payload: this.payload ? (this.payload.length < 256 ? this.payload : this.payload.toString().substr(0, 150) + '...') : false
                        });
                        this.connection.loggelf(logEntry);
                    }
                    this.connection.send(this.tag + ' BAD Unknown command: ' + this.command);
                    return callback(err);
                }
            }
        }

        if (command.literal) {
            // check if the literal size is in acceptable bounds
            if (isNaN(command.expecting) || command.expecting < 0 || command.expecting > Number.MAX_SAFE_INTEGER) {
                let err = new Error('Invalid literal size');
                err.responseCode = 400;
                err.code = 'InvalidLiteralSize';
                if (this.connection && typeof this.connection.loggelf === 'function') {
                    // Log commands that advertise an invalid literal byte count before literal parsing starts.
                    let logEntry = createCommandFailureLogEntry(this.connection, err, {
                        _command: this.command,
                        _literal_expecting: command.expecting
                    });
                    this.connection.loggelf(logEntry);
                }
                this.connection.send(this.tag + ' BAD Invalid literal size');
                this.payload = '';
                this.literals = [];
                this.first = true;
                return callback(err);
            }

            let maxAllowed = Math.max(Number(this.connection._server.options.maxMessage) || 0, MAX_MESSAGE_SIZE);
            if (
                // Allow large literals for selected commands only
                (!['APPEND'].includes(this.command) && command.expecting > 1024) ||
                // Deny all literals bigger than maxMessage
                command.expecting > maxAllowed
            ) {
                this.connection.logger.debug(
                    {
                        tnx: 'client',
                        cid: this.connection.id
                    },
                    '[%s] C:',
                    this.connection.id,
                    this.payload
                );

                this.payload = ''; // reset payload
                this.literals = [];

                if (command.expecting > maxAllowed) {
                    // APPENDLIMIT response for too large messages
                    // TOOBIG: https://tools.ietf.org/html/rfc4469#section-4.2

                    let errorMessage;
                    if (this.command === 'APPEND') {
                        errorMessage = `Message size exceeds allowed limit: attempted ${command.expecting} bytes, but maximum allowed is ${maxAllowed} bytes.`;
                    } else {
                        errorMessage = 'Literal too large';
                    }

                    // Log literals rejected by the IMAP APPENDLIMIT/size gate while keeping the connection open.
                    this.connection?.loggelf({
                        short_message: `[TOOBIG] Literal too large`,
                        _failure_msg: 'toobig',
                        _error_response: `${this.tag} NO [TOOBIG] ${errorMessage}`,
                        _service: 'imap',
                        _command: this.command,
                        _payload: this.payload ? (this.payload.length < 256 ? this.payload : this.payload.toString().substring(0, 256) + '...') : command.value,
                        _literal_expecting: command.expecting,
                        _literal_allowed: maxAllowed,
                        _sess: this.connection?.session?.id,
                        _user: this.connection?.user?.id,
                        _cid: this.connection?.id,
                        _ip: this.remoteAddress
                    });

                    this.connection.send(`${this.tag} NO [TOOBIG] ${errorMessage}`);
                } else {
                    this.connection.send(`${this.tag} NO Literal too large`);
                }

                let err = new Error('Literal too large');
                err.responseCode = 400;
                err.code = 'InvalidLiteralSize';
                return callback(err);
            }

            // Accept literal input
            this.connection.send('+ Go ahead');

            // currently the stream is buffered into a large string and thats it.
            // in the future we might consider some kind of actual stream usage
            command.literal.on('data', chunk => {
                chunks.push(chunk);
                chunklen += chunk.length;
            });

            command.literal.on('end', () => {
                this.payload += '\r\n'; //  + Buffer.concat(chunks, chunklen).toString('binary');
                this.literals.push(Buffer.concat(chunks, chunklen));
                command.readyCallback(); // call this once stream is fully processed and ready to accept next data
            });
        }

        callback();
    }

    end(command, callback) {
        let callbackSent = false;
        let next = err => {
            if (!callbackSent) {
                callbackSent = true;
                return callback(err);
            }
        };

        this.append(command, err => {
            if (err) {
                this.connection.logger.debug(
                    {
                        err,
                        tnx: 'client',
                        cid: this.connection.id
                    },
                    '[%s] C: %s',
                    this.connection.id,
                    this.payload || ''
                );
                if (!this.countBadResponses()) {
                    // stop processing
                    return;
                }
                return next(err);
            }

            // check if the payload needs to be directed to a preset handler
            if (typeof this.connection._nextHandler === 'function') {
                this.connection.logger.debug(
                    {
                        tnx: 'client',
                        cid: this.connection.id
                    },
                    '[%s] C: <%s bytes of data>',
                    this.connection.id,
                    (this.payload && this.payload.length) || 0
                );
                return this.connection._nextHandler(this.payload, next);
            }

            try {
                this.parsed = imapHandler.parser(this.payload, { literals: this.literals });
            } catch (E) {
                if (this.connection && typeof this.connection.loggelf === 'function') {
                    // Log IMAP parser failures where the raw command can not be tokenized into a valid request.
                    let logEntry = createCommandFailureLogEntry(this.connection, E, {
                        _command: this.command,
                        _payload: this.payload ? (this.payload.length < 256 ? this.payload : this.payload.toString().substr(0, 150) + '...') : false
                    });
                    this.connection.loggelf(logEntry);
                }
                this.connection.logger.debug(
                    {
                        err: E,
                        tnx: 'client',
                        cid: this.connection.id
                    },
                    '[%s] C:',
                    this.connection.id,
                    this.payload
                );
                this.connection.send(this.tag + ' BAD ' + E.message);
                if (!this.countBadResponses()) {
                    // stop processing
                    return;
                }
                return next();
            }

            let handler = commands.get(this.command);

            if (/^(AUTHENTICATE|LOGIN)/.test(this.command) && Array.isArray(this.parsed.attributes)) {
                this.parsed.attributes.forEach(attr => {
                    if (attr && typeof attr === 'object' && attr.value) {
                        attr.sensitive = true;
                    }
                });
            }

            if (!this.connection.session.commandCounters[this.command]) {
                this.connection.session.commandCounters[this.command] = 1;
            } else {
                this.connection.session.commandCounters[this.command]++;
            }

            this.connection.logger.debug(
                {
                    tnx: 'client',
                    cid: this.connection.id
                },
                '[%s] C:',
                this.connection.id,
                imapHandler.compiler(this.parsed, false, true)
            );

            this.validateCommand(this.parsed, handler, err => {
                if (err) {
                    let payload = imapHandler.compiler(this.parsed, false, true);
                    if (this.connection && typeof this.connection.loggelf === 'function') {
                        // Log IMAP state/schema validation failures before the command handler is invoked.
                        let logEntry = createCommandFailureLogEntry(this.connection, err, {
                            _command: this.command,
                            _payload: payload ? (payload.length < 256 ? payload : payload.toString().substr(0, 150) + '...') : false
                        });
                        this.connection.loggelf(logEntry);
                    }
                    this.connection.send(this.tag + ' ' + (err.response || 'BAD') + ' ' + err.message);
                    if (!this.countBadResponses()) {
                        // stop processing
                        return;
                    }
                    return next(err);
                }

                if (typeof handler.handler === 'function') {
                    handler.handler.call(
                        this.connection,
                        this.parsed,
                        (err, response) => {
                            if (err) {
                                let payload = imapHandler.compiler(this.parsed, false, true);
                                if (this.connection && typeof this.connection.loggelf === 'function') {
                                    // Log command handler failures that return BAD/NO without destroying the IMAP connection.
                                    let logEntry = createCommandFailureLogEntry(this.connection, err, {
                                        _command: this.command,
                                        _payload: payload ? (payload.length < 256 ? payload : payload.toString().substr(0, 150) + '...') : false
                                    });
                                    this.connection.loggelf(logEntry);
                                }
                                this.connection.send(this.tag + ' ' + (err.response || 'BAD') + ' ' + err.message);
                                if (!err.response || err.response === 'BAD') {
                                    if (!this.countBadResponses()) {
                                        // stop processing
                                        return;
                                    }
                                }
                                return next(err);
                            }

                            // send EXPUNGE, EXISTS etc queued notices
                            this.sendNotifications(handler, () => {
                                // send command ready response
                                this.connection.writeStream.write({
                                    tag: this.tag,
                                    command: response.response,
                                    attributes: []
                                        .concat(
                                            response.code
                                                ? {
                                                      type: 'SECTION',
                                                      section: [
                                                          {
                                                              type: 'TEXT',
                                                              value: response.code
                                                          }
                                                      ]
                                                  }
                                                : []
                                        )
                                        .concat({
                                            type: 'TEXT',
                                            value: response.message || this.command + ' completed'
                                        })
                                });

                                next();
                            });
                        },
                        next
                    );
                } else {
                    this.connection.send(this.tag + ' NO Not implemented: ' + this.command);
                    return next();
                }
            });
        });
    }

    sendNotifications(handler, callback) {
        if (this.connection.state !== 'Selected' || !!handler.disableNotifications) {
            // nothing to advertise if not in Selected state
            return callback();
        }

        this.connection.emitNotifications();

        return callback();
    }

    validateCommand(parsed, handler, callback) {
        let schema = handler.schema || [];
        let maxArgs = schema.length;
        let minArgs = schema.filter(item => !item.optional).length;

        // Check if the command can be run in current state
        if (handler.state && [].concat(handler.state || []).indexOf(this.connection.state) < 0) {
            let err = new Error(parsed.command.toUpperCase() + ' not allowed now');
            err.responseCode = 500;
            err.code = 'InvalidState';
            return callback(err);
        }

        if (handler.schema === false) {
            //schema check is disabled
            return callback();
        }

        // Deny commands with too many arguments
        if (parsed.attributes && parsed.attributes.length > maxArgs) {
            let err = new Error('Too many arguments provided');
            err.responseCode = 400;
            err.code = 'InvalidArguments';
            return callback(err);
        }

        // Deny commands with too little arguments
        if (((parsed.attributes && parsed.attributes.length) || 0) < minArgs) {
            let err = new Error('Not enough arguments provided');
            err.responseCode = 400;
            err.code = 'InvalidArguments';
            err.meta = {
                validation_command: this.command,
                validation_schema: JSON.stringify(schema || null).substring(0, 255),
                validation_minArgs: minArgs,
                validation_attributes: JSON.stringify(parsed.attributes || null).substring(0, 255)
            };
            return callback(err);
        }

        callback();
    }

    countBadResponses() {
        this.connection._badCount++;
        if (this.connection._badCount > MAX_BAD_COMMANDS) {
            this.connection.clearNotificationListener();
            this.connection.send('* BYE Too many protocol errors');
            setImmediate(() => this.connection.close(true));
            return false;
        }
        return true;
    }
}

module.exports.IMAPCommand = IMAPCommand;
