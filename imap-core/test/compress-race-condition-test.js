/* eslint-env mocha */
/* eslint-disable no-invalid-this, prefer-arrow-callback, no-unused-expressions, global-require, callback-return */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const { IMAPConnection } = require('../lib/imap-connection');
const zlib = require('zlib');
const EventEmitter = require('events');
const Duplex = require('stream').Duplex;
const compress = require('../lib/commands/compress');

chai.config.includeStack = true;

class TestSocket extends Duplex {
    constructor() {
        super();
        this.remoteAddress = '127.0.0.1';
        this.readyState = 'open';
        this.serverWrites = [];
    }

    _read() {}

    _write(chunk, encoding, callback) {
        this.serverWrites.push(Buffer.from(chunk));
        this.emit('server-write', chunk);
        callback();
    }

    pushClientData(chunk) {
        this.push(chunk);
    }

    setTimeout() {}

    end() {
        this.readyState = 'closed';
        super.end();
        this.emit('end');
    }

    destroy(err) {
        this.readyState = 'closed';
        return super.destroy(err);
    }
}

function createMockServer(options) {
    return {
        logger: {
            debug: () => {},
            info: () => {},
            error: () => {}
        },
        options: Object.assign(
            {
                socketTimeout: 30000
            },
            options || {}
        ),
        connections: new Set(),
        notifier: {}
    };
}

function createCompressedConnection(options) {
    const mockSocket = new TestSocket();
    const connection = new IMAPConnection(createMockServer(options), mockSocket, {});

    let closed = false;
    let closePromise = new Promise(resolve => {
        connection.once('close', resolve);
    });

    connection.close = () => {
        if (closed) {
            return;
        }
        closed = true;
        mockSocket.destroy();
        connection.emit('close');
    };

    return {
        connection,
        mockSocket,
        closePromise,
        isClosed: () => closed
    };
}

function trackParserCommands(connection) {
    let originalOnCommand = connection._parser.oncommand;
    let finalCommands = 0;
    let nonFinalCommands = 0;
    let waiters = [];

    let notifyWaiters = () => {
        waiters = waiters.filter(waiter => {
            if (waiter()) {
                return false;
            }
            return true;
        });
    };

    connection._parser.oncommand = (command, callback) => {
        originalOnCommand(command, (...args) => {
            if (command && command.final) {
                finalCommands++;
            } else {
                nonFinalCommands++;
            }
            notifyWaiters();
            callback(...args);
        });
    };

    return {
        waitForFinal(count) {
            if (finalCommands >= count) {
                return Promise.resolve();
            }
            return new Promise(resolve => {
                waiters.push(() => {
                    if (finalCommands >= count) {
                        resolve();
                        return true;
                    }
                    return false;
                });
            });
        },

        waitForNonFinal(count) {
            if (nonFinalCommands >= count) {
                return Promise.resolve();
            }
            return new Promise(resolve => {
                waiters.push(() => {
                    if (nonFinalCommands >= count) {
                        resolve();
                        return true;
                    }
                    return false;
                });
            });
        }
    };
}

function activateCompression(connection) {
    return new Promise((resolve, reject) => {
        const command = {
            attributes: [{ value: 'DEFLATE' }]
        };

        compress.handler.call(connection, command, (err, response) => {
            if (err) {
                return reject(err);
            }

            try {
                expect(response.response).to.equal('OK');
            } catch (expectErr) {
                return reject(expectErr);
            }

            setImmediate(resolve);
        });
    });
}

function createCompressedClient(mockSocket) {
    const deflate = zlib.createDeflateRaw();

    deflate.on('data', chunk => {
        mockSocket.pushClientData(chunk);
    });

    return {
        write(payload) {
            let chunk = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'binary');
            return new Promise((resolve, reject) => {
                deflate.write(chunk, err => {
                    if (err) {
                        return reject(err);
                    }
                    deflate.flush(flushErr => {
                        if (flushErr) {
                            return reject(flushErr);
                        }
                        resolve();
                    });
                });
            });
        }
    };
}

function waitForOpen(waitPromise, connectionState) {
    return Promise.race([
        waitPromise.then(() => 'open'),
        connectionState.closePromise.then(() => 'closed')
    ]).then(result => {
        expect(result).to.equal('open');
        expect(connectionState.isClosed()).to.be.false;
    });
}

describe('COMPRESS command race condition tests', function () {
    this.timeout(10000);

    it('should reproduce the bug: dest.on is not a function when _parser is false', function (done) {
        // Create a mock server
        const mockServer = {
            logger: {
                debug: () => {},
                info: () => {},
                error: () => {}
            },
            options: {
                socketTimeout: 30000
            },
            connections: new Set(),
            notifier: {}
        };

        // Create a mock socket
        class MockSocket extends EventEmitter {
            constructor() {
                super();
                this.destroyed = false;
                this.writable = true;
            }

            pipe(dest) {
                // This will throw if dest is false or not a stream
                if (!dest || typeof dest.on !== 'function') {
                    throw new TypeError('dest.on is not a function');
                }
                return dest;
            }

            unpipe() {
                return this;
            }

            write() {
                return true;
            }

            end() {
                this.emit('end');
            }

            destroy() {
                this.destroyed = true;
                this.emit('close');
            }

            setTimeout() {}

            removeAllListeners() {
                return this;
            }

            on(event, handler) {
                return super.on(event, handler);
            }
        }

        const mockSocket = new MockSocket();

        // Create connection instance
        const connection = new IMAPConnection(mockServer, mockSocket, {});

        // Ensure connection has a parser initially
        expect(connection._parser).to.exist;

        // Simulate the race condition by setting _parser to false
        // (as happens in _onClose)
        connection._parser = false;
        connection._inflate = zlib.createInflateRaw();

        // Now try to execute the problematic code from compress.js line 98-99
        let errorCaught = false;
        try {
            // This is the buggy code without the fix
            mockSocket.unpipe(connection._parser);
            mockSocket.pipe(connection._inflate).pipe(connection._parser);
        } catch (err) {
            errorCaught = true;
            expect(err.message).to.include('dest.on is not a function');
        }

        // The bug should be reproduced
        expect(errorCaught).to.be.true;
        done();
    });

    it('should handle compress when connection is closing (with fix)', function (done) {
        // Create a mock server
        const mockServer = {
            logger: {
                debug: () => {},
                info: () => {},
                error: () => {}
            },
            options: {
                socketTimeout: 30000
            },
            connections: new Set(),
            notifier: {}
        };

        // Create a mock socket
        class MockSocket extends EventEmitter {
            constructor() {
                super();
                this.destroyed = false;
                this.writable = true;
            }

            pipe(dest) {
                if (!dest || typeof dest.on !== 'function') {
                    throw new TypeError('dest.on is not a function');
                }
                return dest;
            }

            unpipe() {
                return this;
            }

            write() {
                return true;
            }

            end() {
                this.emit('end');
            }

            destroy() {
                this.destroyed = true;
                this.emit('close');
            }

            setTimeout() {}

            removeAllListeners() {
                return this;
            }

            on(event, handler) {
                return super.on(event, handler);
            }
        }

        const mockSocket = new MockSocket();

        // Create connection instance
        const connection = new IMAPConnection(mockServer, mockSocket, {});

        // Simulate the race condition:
        // 1. Start closing the connection (which sets _parser to false)
        connection.close();

        // 2. Try to execute COMPRESS command after close has been initiated
        // This should trigger the error if not properly handled
        setImmediate(() => {
            try {
                // Simulate what happens in compress.js with the fix
                const command = {
                    attributes: [{ value: 'DEFLATE' }]
                };

                // Try to execute the handler
                compress.handler.call(connection, command, () => {
                    // Wait for setImmediate in compress handler
                    setImmediate(() => {
                        // With the fix, no error should be thrown
                        done();
                    });
                });
            } catch (err) {
                // This should not happen with the fix
                done(err);
            }
        });
    });

    it('should successfully compress when connection is active', async function () {
        const { connection } = createCompressedConnection();

        expect(connection._parser).to.exist;
        expect(typeof connection._parser.on).to.equal('function');

        await activateCompression(connection);

        expect(connection.compression).to.be.true;
        expect(connection._deflate).to.exist;
        expect(connection._inflate).to.exist;
        expect(connection._inflateLimit).to.exist;
    });

    it('should close compressed connection when inflated input exceeds configured limit', async function () {
        const connectionState = createCompressedConnection({
            maxCompressionInflateBytes: 64
        });
        const client = createCompressedClient(connectionState.mockSocket);

        await activateCompression(connectionState.connection);

        expect(connectionState.connection._inflateLimit).to.exist;

        await client.write(Buffer.alloc(128, 0x41));
        await connectionState.closePromise;

        expect(connectionState.isClosed()).to.be.true;
    });

    it('should reset compressed input count between commands', async function () {
        const commandLength = Buffer.byteLength('A1 NOOP\r\n');
        const connectionState = createCompressedConnection({
            maxCompressionInflateBytes: commandLength
        });
        const tracker = trackParserCommands(connectionState.connection);
        const client = createCompressedClient(connectionState.mockSocket);

        await activateCompression(connectionState.connection);

        await client.write('A1 NOOP\r\n');
        await waitForOpen(tracker.waitForFinal(1), connectionState);

        await client.write('A2 NOOP\r\n');
        await waitForOpen(tracker.waitForFinal(2), connectionState);
    });

    it('should skip compressed input limit when disabled', async function () {
        const connectionState = createCompressedConnection({
            maxCompressionInflateBytes: 0,
            maxLineLength: 0
        });
        const tracker = trackParserCommands(connectionState.connection);
        const client = createCompressedClient(connectionState.mockSocket);
        const payload = Buffer.concat([Buffer.alloc(1024 * 1024, 0x41), Buffer.from('\r\n', 'binary')]);

        await activateCompression(connectionState.connection);

        expect(connectionState.connection._inflateLimit).to.equal(false);

        await client.write(payload);
        await waitForOpen(tracker.waitForFinal(1), connectionState);
    });

    it('should allow multipart literals at the compressed input limit boundary', async function () {
        const literal = Buffer.alloc(16, 0x41);
        const line = `A1 APPEND INBOX {${literal.length}}\r\n`;
        const final = Buffer.from('\r\n', 'binary');
        const connectionState = createCompressedConnection({
            maxCompressionInflateBytes: Buffer.byteLength(line) + literal.length + final.length
        });
        const tracker = trackParserCommands(connectionState.connection);
        const client = createCompressedClient(connectionState.mockSocket);

        connectionState.connection.state = 'Authenticated';

        await activateCompression(connectionState.connection);

        await client.write(line);
        await waitForOpen(tracker.waitForNonFinal(1), connectionState);

        await client.write(Buffer.concat([literal, final]));
        await waitForOpen(tracker.waitForFinal(1), connectionState);
    });

    it('should close multipart literals when compressed fragments exceed the input limit', async function () {
        const literal = Buffer.alloc(16, 0x41);
        const line = `A1 APPEND INBOX {${literal.length}}\r\n`;
        const final = Buffer.from('\r\n', 'binary');
        const connectionState = createCompressedConnection({
            maxCompressionInflateBytes: Buffer.byteLength(line) + literal.length + final.length - 1
        });
        const tracker = trackParserCommands(connectionState.connection);
        const client = createCompressedClient(connectionState.mockSocket);

        connectionState.connection.state = 'Authenticated';

        await activateCompression(connectionState.connection);

        await client.write(line);
        await waitForOpen(tracker.waitForNonFinal(1), connectionState);

        await client.write(Buffer.concat([literal, final]));
        await connectionState.closePromise;

        expect(connectionState.isClosed()).to.be.true;
    });
});
