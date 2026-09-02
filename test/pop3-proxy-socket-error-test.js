'use strict';

/* eslint-disable no-unused-expressions */

// Regression tests for the PROXY-protocol parsing window in POP3Server.
// Mirrors imap-core/test/proxy-socket-error-test.js: a client that resets
// while the server waits for the PROXY header used to crash the process with
// an unhandled ECONNRESET, because the raw socket had no error handler yet.

const chai = require('chai');
const expect = chai.expect;
const POP3Server = require('../lib/pop3/server');
const net = require('net');

chai.config.includeStack = true;

const TEST_PORT = 0; // let the OS assign an available port

describe('POP3 PROXY socket error handling', () => {
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
        process.prependOnceListener('uncaughtException', onUncaught);

        server = new POP3Server({ useProxy: ['*'], logger: false });
        server.on('error', () => {});

        server.listen(TEST_PORT, '127.0.0.1', () => {
            const port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1', () => {
                client.on('error', () => {});
                client.resetAndDestroy();
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

    it('should still parse a valid PROXY header and greet the client', done => {
        let finished = false;

        server = new POP3Server({ useProxy: ['*'], logger: false });
        server.on('error', () => {});

        server.listen(TEST_PORT, '127.0.0.1', () => {
            const port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1', () => {
                client.write('PROXY TCP4 203.0.113.7 10.0.0.1 51234 110\r\n');
            });

            let buf = '';
            client.on('data', data => {
                buf += data.toString();
                if (finished || !/\+OK/.test(buf)) {
                    return;
                }
                finished = true;
                expect(buf).to.include('+OK');
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
