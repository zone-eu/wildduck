/* eslint-env mocha */
/* eslint-disable no-invalid-this, prefer-arrow-callback, no-unused-expressions */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const EventEmitter = require('events');
const { IMAPConnection } = require('../lib/imap-connection');

chai.config.includeStack = true;

describe('IMAP line length limits', function () {
    this.timeout(10000);

    it('should reject an oversized command line and continue with the next command', function (done) {
        const sent = [];
        const mockServer = {
            logger: {
                debug: () => {},
                info: () => {},
                error: () => {}
            },
            options: {
                maxLineLength: 8000,
                socketTimeout: 30000
            },
            connections: new Set(),
            notifier: {}
        };

        class MockSocket extends EventEmitter {
            constructor() {
                super();
                this.destroyed = false;
                this.writable = true;
                this.readyState = 'open';
            }

            pipe(dest) {
                return dest;
            }

            write(chunk, encoding, callback) {
                sent.push(chunk.toString());
                if (typeof callback === 'function') {
                    return callback();
                }
                return true;
            }

            end() {
                this.readyState = 'closed';
                this.emit('end');
            }

            destroy() {
                this.destroyed = true;
                this.readyState = 'closed';
                this.emit('close');
            }

            setTimeout() {}
        }

        const mockSocket = new MockSocket();
        const connection = new IMAPConnection(mockServer, mockSocket, {});
        mockServer.connections.add(connection);

        connection._parser.write(Buffer.from('A1 ' + 'X'.repeat(9000), 'binary'), err => {
            expect(err).to.not.exist;

            connection._parser.write(Buffer.from('\r\nA2 NOOP\r\n', 'binary'), nextErr => {
                expect(nextErr).to.not.exist;

                setTimeout(() => {
                    expect(sent).to.include('* BAD Command line too long\r\n');
                    expect(sent).to.include('A2 OK Nothing done\r\n');
                    expect(connection._closing || connection._closed).to.be.false;
                    expect(mockSocket.destroyed).to.be.false;
                    done();
                }, 20);
            });
        });
    });
});
