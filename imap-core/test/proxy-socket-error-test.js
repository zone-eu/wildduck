'use strict';

/* eslint-disable no-unused-expressions */

// Regression tests for the PROXY-protocol parsing window in IMAPServer.
//
// _handleProxy runs on the raw accepted socket before the connection object
// (and its error handler) exists. If the client resets or half-closes while
// the server is waiting for the PROXY header, the socket used to emit 'error'
// with no listener, which crashes the whole process with an unhandled
// ECONNRESET. These tests drive those paths and assert the server survives.

const chai = require('chai');
const expect = chai.expect;
const IMAPServer = require('../index.js').IMAPServer;
const net = require('net');

chai.config.includeStack = true;

const TEST_PORT = 0; // let the OS assign an available port

describe('IMAP PROXY socket error handling', () => {
    let server;

    afterEach(done => {
        if (server) {
            return server.close(() => {
                server = false;
                done();
            });
        }
        return done();
    });

    it('should survive a client reset while waiting for the PROXY header', done => {
        let finished = false;

        const onUncaught = err => {
            if (finished) {
                return;
            }
            finished = true;
            process.removeListener('uncaughtException', onUncaught);
            done(new Error('unhandled socket error during PROXY window: ' + (err && err.message)));
        };
        // run before mocha's own handler so the failure names the real cause
        process.prependOnceListener('uncaughtException', onUncaught);

        server = new IMAPServer({ useProxy: ['*'], logger: false });
        server.on('error', () => {}); // must not throw at the server level either

        server.listen(TEST_PORT, '127.0.0.1', () => {
            const port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1', () => {
                client.on('error', () => {}); // client-side RST noise, irrelevant
                client.resetAndDestroy(); // send RST before any PROXY header
            });

            // if no uncaughtException fires within the grace window, the fix held
            setTimeout(() => {
                if (finished) {
                    return;
                }
                finished = true;
                process.removeListener('uncaughtException', onUncaught);
                done();
            }, 200);
        });
    });

    it('should survive a malformed PROXY header followed by a reset', done => {
        let finished = false;

        const onUncaught = err => {
            if (finished) {
                return;
            }
            finished = true;
            process.removeListener('uncaughtException', onUncaught);
            done(new Error('unhandled socket error after invalid PROXY header: ' + (err && err.message)));
        };
        process.prependOnceListener('uncaughtException', onUncaught);

        server = new IMAPServer({ useProxy: ['*'], logger: false });
        server.on('error', () => {});

        server.listen(TEST_PORT, '127.0.0.1', () => {
            const port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1', () => {
                client.on('error', () => {});
                // a non-PROXY line makes the server flush "* BAD" and reject; the
                // reset that follows must not surface as a late unhandled error
                client.write('GARBAGE not-a-proxy-line\r\n');
                setImmediate(() => client.resetAndDestroy());
            });

            setTimeout(() => {
                if (finished) {
                    return;
                }
                finished = true;
                process.removeListener('uncaughtException', onUncaught);
                done();
            }, 200);
        });
    });

    it('should still parse a valid PROXY header and expose the proxied address', done => {
        let finished = false;

        server = new IMAPServer({ useProxy: ['*'], logger: false });
        server.on('error', () => {});
        server.onAuth = (login, session, callback) => callback(null, { user: { id: '1' } });

        server.listen(TEST_PORT, '127.0.0.1', () => {
            const port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1', () => {
                client.write('PROXY TCP4 203.0.113.7 10.0.0.1 51234 143\r\n');
            });

            let buf = '';
            client.on('data', data => {
                buf += data.toString();
                if (finished || !/\* OK/.test(buf)) {
                    return;
                }
                finished = true;
                expect(buf).to.include('* OK');
                // the greeting reports the address carried by the PROXY header,
                // proving the header was parsed rather than the socket peer used
                expect(buf).to.include('203.0.113.7');
                client.end();
                return done();
            });

            client.on('error', err => {
                if (!finished) {
                    finished = true;
                    return done(err);
                }
            });
        });
    });
});
