/* eslint-env mocha */
/* eslint-disable no-invalid-this, prefer-arrow-callback, no-unused-expressions, global-require, callback-return */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const { IMAPConnection } = require('../lib/imap-connection');
const zlib = require('zlib');
const EventEmitter = require('events');

chai.config.includeStack = true;

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
        setTimeout(() => {
            try {
                // Simulate what happens in compress.js with the fix
                const compress = require('../lib/commands/compress');

                // Create mock command
                const command = {
                    attributes: [{ value: 'DEFLATE' }]
                };

                // Try to execute the handler
                compress.handler.call(connection, command, () => {
                    // Wait for setImmediate in compress handler
                    setTimeout(() => {
                        // With the fix, no error should be thrown
                        done();
                    }, 100);
                });
            } catch (err) {
                // This should not happen with the fix
                done(err);
            }
        }, 50);
    });

    it('should successfully compress when connection is active', function (done) {
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
                this.pipedTo = null;
            }

            pipe(dest) {
                if (!dest || typeof dest.on !== 'function') {
                    throw new TypeError('dest.on is not a function');
                }
                this.pipedTo = dest;
                return dest;
            }

            unpipe() {
                this.pipedTo = null;
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

        // Create connection instance with active parser
        const connection = new IMAPConnection(mockServer, mockSocket, {});

        // Ensure connection has an active parser
        expect(connection._parser).to.exist;
        expect(typeof connection._parser.on).to.equal('function');

        // Create mock command
        const compress = require('../lib/commands/compress');
        const command = {
            attributes: [{ value: 'DEFLATE' }]
        };

        // Execute compress handler
        compress.handler.call(connection, command, (err, response) => {
            expect(err).to.not.exist;
            expect(response.response).to.equal('OK');
            expect(response.message).to.equal('DEFLATE active');

            // Wait for setImmediate
            setTimeout(() => {
                // Verify compression was set up
                expect(connection.compression).to.be.true;
                expect(connection._deflate).to.exist;
                expect(connection._inflate).to.exist;
                done();
            }, 100);
        });
    });
});
