'use strict';

const EventEmitter = require('events');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const tlsOptions = require('../../imap-core/lib/tls-options');
const shared = require('nodemailer/lib/shared');
const POP3Connection = require('./connection');
const punycode = require('punycode.js');
const base32 = require('base32.js');
const errors = require('../errors');

const CLOSE_TIMEOUT = 1 * 1000; // how much to wait until pending connections are terminated

class POP3Server extends EventEmitter {
    constructor(options) {
        super();

        this.options = options || {};

        this.updateSecureContext();

        // apply shorthand handlers
        ['onAuth', 'onListMessages', 'onFetchMessage', 'onUpdate', 'onConnect', 'onClose'].forEach(handler => {
            if (typeof this.options[handler] === 'function') {
                this[handler] = this.options[handler];
            }
        });

        /**
         * Timeout after close has been called until pending connections are forcibly closed
         */
        this._closeTimeout = false;

        /**
         * A set of all currently open connections
         */
        this.connections = new Set();

        this.logger = shared.getLogger(this.options, {
            component: this.options.component || 'pop3-server'
        });

        if (this.options.secure && !this.options.needsUpgrade) {
            this.server = net.createServer(this.options, socket => {
                this._handleProxy(socket, (err, socketOptions) => {
                    if (err) {
                        // ignore, should not happen
                    }
                    if (this.options.secured) {
                        return this.connect(socket, socketOptions);
                    }
                    this._upgrade(socket, (err, tlsSocket) => {
                        if (err) {
                            return this._onError(err);
                        }
                        this.connect(tlsSocket, socketOptions);
                    });
                });
            });
        } else {
            this.server = net.createServer(this.options, socket => {
                this._handleProxy(socket, (err, socketOptions) => {
                    if (err) {
                        // ignore, should not happen
                    }
                    this.connect(socket, socketOptions);
                });
            });
        }

        this._setListeners();
    }

    _upgrade(socket, callback) {
        let socketOptions = {
            secureContext: this.secureContext.get('*'),
            isServer: true,
            server: this.server,
            SNICallback: (servername, cb) => {
                const opts = {
                    servername: this._normalizeHostname(this.server),
                    meta: {
                        remoteAddress: socket.remoteAddress
                    }
                };

                // eslint-disable-next-line new-cap
                this.options.SNICallback(opts, (err, context) => {
                    if (err) {
                        this.logger.error(
                            {
                                tnx: 'sni',
                                servername,
                                err
                            },
                            'Failed to fetch SNI context for servername %s',
                            servername
                        );
                    }
                    return cb(null, context || this.secureContext.get('*'));
                });
            }
        };

        let remoteAddress = socket.remoteAddress;

        let returned = false;
        let tlsSocket;
        let onError = err => {
            if (returned) {
                return;
            }
            returned = true;

            const meta = {};
            if (tlsSocket) {
                meta.tlsProtocol = tlsSocket.getProtocol();
            }
            meta.protocol = 'pop3';
            meta.stage = 'connect';
            meta.ip = remoteAddress;

            if (err) {
                err.meta = meta;
            }

            if (err && /SSL[23]*_GET_CLIENT_HELLO|ssl[23]*_read_bytes|ssl_bytes_to_cipher_list/i.test(err.message)) {
                let message = err.message;
                err.message = 'Failed to establish TLS session';
                err.code = err.code || 'TLSError';
                meta.message = message;
            }

            if (!err || !err.message) {
                err = new Error('Socket closed while initiating TLS');
                err.code = 'SocketError';
                err.meta = meta;
            }
            callback(err);
        };

        // remove all listeners from the original socket besides the error handler
        socket.once('error', onError);

        // upgrade connection
        tlsSocket = new tls.TLSSocket(socket, socketOptions);

        let onCloseError = hadError => {
            if (hadError) {
                return onError();
            }
        };

        tlsSocket.once('close', onCloseError);
        tlsSocket.once('error', onError);
        tlsSocket.once('_tlsError', onError);
        tlsSocket.once('clientError', onError);
        tlsSocket.once('tlsClientError', onError);

        tlsSocket.on('secure', () => {
            socket.removeListener('error', onError);
            tlsSocket.removeListener('close', onCloseError);
            tlsSocket.removeListener('error', onError);
            tlsSocket.removeListener('_tlsError', onError);
            tlsSocket.removeListener('clientError', onError);
            tlsSocket.removeListener('tlsClientError', onError);
            if (returned) {
                try {
                    tlsSocket.end();
                } catch (E) {
                    //
                }
                return;
            }
            returned = true;
            return callback(null, tlsSocket);
        });
    }

    updateSecureContext(options) {
        Object.keys(options || {}).forEach(key => {
            this.options[key] = options[key];
        });

        let defaultTlsOptions = tlsOptions(this.options);

        this.secureContext = new Map();
        this.secureContext.set('*', tls.createSecureContext(defaultTlsOptions));

        let ctxMap = this.options.sniOptions || {};
        // sniOptions is either an object or a Map with domain names as keys and TLS option objects as values
        if (typeof ctxMap.get === 'function') {
            ctxMap.forEach((ctx, servername) => {
                this.secureContext.set(this._normalizeHostname(servername), tls.createSecureContext(tlsOptions(ctx)));
            });
        } else {
            Object.keys(ctxMap).forEach(servername => {
                this.secureContext.set(this._normalizeHostname(servername), tls.createSecureContext(tlsOptions(ctxMap[servername])));
            });
        }

        if (this.options.secure) {
            // apply changes
            Object.keys(defaultTlsOptions || {}).forEach(key => {
                if (!(key in this.options)) {
                    this.options[key] = defaultTlsOptions[key];
                }
            });
        } else if (typeof this.options.SNICallback !== 'function') {
            // create a default SNI handler
            this.options.SNICallback = (servername, cb) => {
                cb(null, this.secureContext.get(servername));
            };
        }
    }

    _normalizeHostname(hostname) {
        return punycode.toUnicode((hostname || '').toString().trim()).toLowerCase();
    }

    _setListeners() {
        this.server.on('listening', () => this._onListening());
        this.server.on('close', () => this._onClose());
        this.server.on('error', err => this._onError(err));
    }

    /**
     * Called when server started listening
     *
     * @event
     */
    _onListening() {
        let address = this.server.address();
        this.logger.info(
            //
            {
                tnx: 'listen',
                host: address.address,
                port: address.port,
                secure: !!this.options.secure,
                protocol: 'POP3'
            },
            '%s%s Server listening on %s:%s',
            this.options.secure ? 'Secure ' : '',
            'POP3',
            address.family === 'IPv4' ? address.address : '[' + address.address + ']',
            address.port
        );
    }

    /**
     * Called when server is closed
     *
     * @event
     */
    _onClose() {
        this.logger.info(
            {
                tnx: 'closed'
            },
            'POP3 Server closed'
        );
        this.emit('close');
    }

    /**
     * Called when an error occurs with the server
     *
     * @event
     */
    _onError(err) {
        errors.notifyConnection(false, err);
        this.emit('error', err);
    }

    _handleProxy(socket, callback) {
        let socketOptions = {
            id: base32.encode(crypto.randomBytes(10)).toLowerCase()
        };

        if (
            !this.options.useProxy ||
            (Array.isArray(this.options.useProxy) && !this.options.useProxy.includes(socket.remoteAddress) && !this.options.useProxy.includes('*'))
        ) {
            socketOptions.ignore = this.options.ignoredHosts && this.options.ignoredHosts.includes(socket.remoteAddress);
            return setImmediate(() => callback(null, socketOptions));
        }

        if (!this.options.useProxy) {
            return setImmediate(callback);
        }

        let chunks = [];
        let chunklen = 0;
        let socketReader = () => {
            let chunk;
            while ((chunk = socket.read()) !== null) {
                for (let i = 0, len = chunk.length; i < len; i++) {
                    let chr = chunk[i];
                    if (chr === 0x0a) {
                        socket.removeListener('readable', socketReader);
                        chunks.push(chunk.slice(0, i + 1));
                        chunklen += i + 1;
                        let remainder = chunk.slice(i + 1);
                        if (remainder.length) {
                            socket.unshift(remainder);
                        }

                        let header = Buffer.concat(chunks, chunklen).toString().trim();

                        let params = (header || '').toString().split(' ');
                        let commandName = params.shift().toUpperCase();
                        if (commandName !== 'PROXY') {
                            try {
                                socket.end('-ERR Invalid PROXY header\r\n');
                            } catch (E) {
                                // ignore
                            }
                            return;
                        }

                        if (params[1]) {
                            socketOptions.remoteAddress = params[1].trim().toLowerCase();

                            socketOptions.ignore = this.options.ignoredHosts && this.options.ignoredHosts.includes(socketOptions.remoteAddress);

                            if (!socketOptions.ignore) {
                                this.logger.info(
                                    {
                                        tnx: 'proxy',
                                        cid: socketOptions.id,
                                        proxy: params[1].trim().toLowerCase()
                                    },
                                    '[%s] PROXY from %s through %s',
                                    socketOptions.id,
                                    params[1].trim().toLowerCase(),
                                    params[2].trim().toLowerCase()
                                );
                            }

                            if (params[3]) {
                                socketOptions.remotePort = Number(params[3].trim()) || socketOptions.remotePort;
                            }
                        }

                        return callback(null, socketOptions);
                    }
                }
                chunks.push(chunk);
                chunklen += chunk.length;
            }
        };
        socket.on('readable', socketReader);
    }

    connect(socket, socketOptions) {
        let connection = new POP3Connection(this, socket, socketOptions);
        this.connections.add(connection);
        connection.once('error', err => {
            this.connections.delete(connection);
            this._onError(err);
        });
        connection.once('close', () => {
            this.connections.delete(connection);
        });

        // Call onConnect handler if provided
        if (this.onConnect) {
            this.onConnect(connection.session, err => {
                if (err) {
                    connection.logger.info(
                        {
                            tnx: 'connect',
                            cid: connection.id,
                            err
                        },
                        'Connection rejected by onConnect handler: %s',
                        err.message
                    );
                    connection.send('-ERR ' + (err.message || 'Connection rejected'));
                    setImmediate(() => connection.close());
                    return;
                }
                connection.init();
            });
        } else {
            connection.init();
        }
    }

    close(callback) {
        let connections = this.connections.size;
        let timeout = this.options.closeTimeout || CLOSE_TIMEOUT;

        // stop accepting new connections
        this.server.close(() => {
            clearTimeout(this._closeTimeout);
            if (typeof callback === 'function') {
                return callback();
            }
        });

        // close active connections
        if (connections) {
            this.logger.info(
                {
                    tnx: 'close'
                },
                'Server closing with %s pending connection%s, waiting %s seconds before terminating',
                connections,
                connections !== 1 ? 's' : '',
                timeout / 1000
            );
        }

        this._closeTimeout = setTimeout(() => {
            connections = this.connections.size;
            if (connections) {
                this.logger.info(
                    {
                        tnx: 'close'
                    },
                    'Closing %s pending connection%s to close the server',
                    connections,
                    connections !== 1 ? 's' : ''
                );

                this.connections.forEach(connection => {
                    connection.close();
                });
            }
        }, timeout);
    }

    /**
     * Authentication handler. Override this
     *
     * @param {Object} auth Authentication options
     * @param {Object} session Session object
     * @param {Function} callback Callback to run once the user is authenticated
     */
    onAuth(auth, session, callback) {
        return callback(null, {
            message: 'Authentication not implemented'
        });
    }

    // called when a message body needs to be fetched
    onFetchMessage(message, session, callback) {
        // should return a stream object
        return callback(null, false);
    }

    // called when session is finished and messages need to be updated/deleted
    onUpdate(update, session, callback) {
        return callback(null, false);
    }

    /**
     * Message listing handler. Override this
     *
     * @param {Object} session Session object
     * @param {Function} callback Callback to run with message listing
     */
    onListMessages(session, callback) {
        // messages are objects {id: 'abc', size: 123, seen: true}
        return callback(null, {
            messages: [],
            count: 0,
            size: 0
        });
    }

    listen(...args) {
        this.server.listen(...args);
    }
}

module.exports = POP3Server;
