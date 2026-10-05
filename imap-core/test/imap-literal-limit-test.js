/* eslint-env mocha */
/* eslint-disable no-invalid-this, prefer-arrow-callback, no-unused-expressions */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const net = require('net');
const testServer = require('./test-server.js');

chai.config.includeStack = true;

// Raw IMAP client: collect server output, wait for a pattern, send bytes.
function rawClient(port) {
    const socket = net.connect(port, '127.0.0.1');
    const client = {
        socket,
        output: '',
        closed: false,
        write(data) {
            socket.write(data);
        },
        count(re) {
            return (client.output.match(re) || []).length;
        },
        until(re, timeout = 5000) {
            return new Promise((resolve, reject) => {
                const started = Date.now();
                const timer = setInterval(() => {
                    if (re.test(client.output)) {
                        clearInterval(timer);
                        return resolve(true);
                    }
                    if (client.closed) {
                        clearInterval(timer);
                        return resolve(false);
                    }
                    if (Date.now() - started > timeout) {
                        clearInterval(timer);
                        return reject(new Error(`timeout waiting for ${re} in ${JSON.stringify(client.output.slice(-200))}`));
                    }
                }, 5);
            });
        }
    };
    socket.on('data', chunk => (client.output += chunk.toString('binary')));
    socket.on('error', () => {});
    socket.on('close', () => (client.closed = true));
    return client;
}

describe('IMAP literal limits', function () {
    this.timeout(20000);

    let server;
    let port;
    let client;

    const start = options =>
        new Promise(resolve => {
            server = testServer(Object.assign({ secure: false, logger: false, ignoreSTARTTLS: true }, options || {}));
            server.listen(0, '127.0.0.1', () => {
                port = server.server.address().port;
                resolve();
            });
        });

    afterEach(function (done) {
        if (client && client.socket) {
            client.socket.destroy();
        }
        if (server) {
            return server.close(() => done());
        }
        return done();
    });

    it('refuses a literal for a command that may not run before authentication', async function () {
        await start();
        client = rawClient(port);
        await client.until(/^\* OK/m);

        // APPEND is only valid once authenticated; its literal must not be
        // accepted or buffered while in the Not Authenticated state. The size is
        // within the per-literal limit, so only the state gate can refuse it.
        client.write('a APPEND INBOX {500000}\r\n');
        await client.until(/^a NO APPEND not allowed now/m);
        expect(client.output.includes('+ Go ahead')).to.be.false;
    });

    it('still accepts LOGIN with literals before authentication', async function () {
        await start();
        client = rawClient(port);
        await client.until(/^\* OK/m);

        client.write('a LOGIN {8}\r\n');
        await client.until(/^\+ /m);
        client.write('testuser {4}\r\n');
        await client.until(/(?:^\+ [\s\S]*){2}/m);
        client.write('pass\r\n');
        await client.until(/^a OK/m);
    });

    it('bounds the number of literals in a single command', async function () {
        await start({ maxLiterals: 3 });
        client = rawClient(port);
        await client.until(/^\* OK/m);

        client.write('a LOGIN {1}\r\n');
        for (let i = 0; i < 3; i++) {
            await client.until(new RegExp(`(?:\\+ Go ahead\\r\\n){${i + 1}}`));
            client.write('x {1}\r\n');
        }
        await client.until(/^a NO \[TOOBIG\] Too many literals in command/m);
    });

    it('bounds the cumulative literal size in a single command after login', async function () {
        // maxMessage 2 MB => a single literal may be up to 2 MB, cumulative up to
        // 2 MB + 1 MB allowance = 3 MB. Chaining 2 MB literals must be refused.
        await start({ maxMessage: 2 * 1024 * 1024 });
        client = rawClient(port);
        await client.until(/^\* OK/m);

        client.write('a LOGIN testuser pass\r\n');
        await client.until(/^a OK/m);

        const block = Buffer.alloc(2 * 1024 * 1024, 'x');
        client.write('b APPEND INBOX {' + block.length + '}\r\n');
        await client.until(/(?:\+ Go ahead\r\n){1}/);
        client.write(block);
        // chain a second 2 MB literal onto the same command -> cumulative 4 MB > 3 MB
        client.write(' {' + block.length + '}\r\n');
        await client.until(/^b NO \[TOOBIG\] Too many literals in command/m);
    });

    it('accepts a single large APPEND literal within the message limit', async function () {
        await start({ maxMessage: 5 * 1024 * 1024 });
        client = rawClient(port);
        await client.until(/^\* OK/m);

        client.write('a LOGIN testuser pass\r\n');
        await client.until(/^a OK/m);

        const message = Buffer.concat([Buffer.from('Subject: hi\r\n\r\n'), Buffer.alloc(2 * 1024 * 1024, 'x')]);
        // append to a non-existent mailbox: the literal is fully accepted and the
        // handler responds TRYCREATE, which proves the guard did not reject it.
        client.write('b APPEND nonexistentbox {' + message.length + '}\r\n');
        await client.until(/^\+ Go ahead/m);
        client.write(message);
        client.write('\r\n');
        await client.until(/^b NO \[TRYCREATE\]/m);
        expect(client.output.includes('[TOOBIG]')).to.be.false;
    });
});
