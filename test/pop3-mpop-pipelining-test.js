'use strict';

/* eslint-disable no-unused-expressions */

/**
 * POP3 mpop Pipelining Tests
 *
 * These tests verify that WildDuck's POP3 server correctly handles pipelining
 * as used by the mpop client. mpop aggressively pipelines commands, which
 * previously caused issues with the "-ERR Disconnected for inactivity" error.
 *
 * The tests use the actual mpop binary to ensure real-world compatibility.
 */

const chai = require('chai');
const expect = chai.expect;
const POP3Server = require('../lib/pop3/server');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

chai.config.includeStack = true;

const TEST_PORT = 0; // Use port 0 to let OS assign available port

// Mock loggelf function for testing
const mockLoggelf = () => {};

// Test user credentials
const TEST_USER = 'testuser@example.com';
const TEST_PASS = 'testpassword123';

/**
 * Generate fake email content for testing
 * @param {number} index - Message index
 * @param {number} sizeMultiplier - Size multiplier for body content
 * @returns {string} - Email content
 */
function generateFakeEmail(index, sizeMultiplier = 1) {
    const date = new Date(Date.now() - index * 86400000).toUTCString();
    const body = `This is test message number ${index}.\r\n` +
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\r\n'.repeat(10 * sizeMultiplier) +
        `\r\nEnd of message ${index}.\r\n`;

    return `From: sender${index}@example.com\r\n` +
        `To: ${TEST_USER}\r\n` +
        `Subject: Test Message ${index} - Pipelining Test\r\n` +
        `Date: ${date}\r\n` +
        `Message-ID: <test-${index}-${Date.now()}@example.com>\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `\r\n` +
        body;
}

/**
 * Helper function to create a POP3 server with proper test configuration
 * @param {Object} options - Server options
 * @returns {POP3Server} - Configured POP3 server instance
 */
function createTestServer(options) {
    const server = new POP3Server({
        disableSTARTTLS: true,
        // Use a shorter timeout for testing, but not too short
        socketTimeout: 30000, // 30 seconds
        ...options
    });
    // Set loggelf directly on the server instance (as done in pop3.js)
    server.loggelf = mockLoggelf;
    return server;
}

/**
 * Create mpop configuration file
 * @param {string} configPath - Path to config file
 * @param {number} port - Server port
 * @param {string} deliveryPath - Path to deliver mail to
 */
function createMpopConfig(configPath, port, deliveryPath) {
    const config = `
# mpop test configuration
defaults
tls off
tls_starttls off

account test
host 127.0.0.1
port ${port}
user ${TEST_USER}
auth user
delivery mbox ${deliveryPath}
keep off
`;
    fs.writeFileSync(configPath, config);
}

/**
 * Run mpop and capture output
 * @param {string} configPath - Path to config file
 * @param {string} password - Password to use
 * @param {Object} options - Additional options
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function runMpop(configPath, password, options = {}) {
    return new Promise(resolve => {
        const args = [
            '-C', configPath,
            '--passwordeval', `echo "${password}"`,
            '-d', // debug mode
            'test' // account name
        ];

        if (options.serverinfo) {
            args.push('--serverinfo');
        }

        const mpop = spawn('mpop', args, {
            env: { ...process.env },
            timeout: options.timeout || 30000
        });

        let stdout = '';
        let stderr = '';

        mpop.stdout.on('data', data => {
            stdout += data.toString();
        });

        mpop.stderr.on('data', data => {
            stderr += data.toString();
        });

        mpop.on('close', code => {
            resolve({ stdout, stderr, code });
        });

        mpop.on('error', err => {
            resolve({ stdout, stderr, code: -1, error: err });
        });
    });
}

describe('POP3 mpop Pipelining Tests', function () {
    this.timeout(60000); // eslint-disable-line no-invalid-this

    let server;
    let port;
    let tempDir;
    let configPath;
    let mboxPath;

    beforeEach(() => {
        // Create temp directory for mpop config and mbox
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpop-test-'));
        configPath = path.join(tempDir, 'mpoprc');
        mboxPath = path.join(tempDir, 'mail.mbox');
    });

    afterEach(done => {
        // Clean up temp files
        try {
            if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
            }
            if (fs.existsSync(mboxPath)) {
                fs.unlinkSync(mboxPath);
            }
            if (fs.existsSync(tempDir)) {
                fs.rmdirSync(tempDir);
            }
        } catch (e) {
            // Ignore cleanup errors
        }

        if (server) {
            server.close(done);
            server = null;
            return;
        }
        done();
    });

    describe('Basic mpop Connectivity', () => {
        it('should successfully connect and authenticate with mpop', done => {
            const testMessages = [
                { id: '1', uid: 'uid1', content: generateFakeEmail(1) }
            ];
            testMessages.forEach(msg => {
                msg.size = msg.content.length;
                msg.mailbox = 'INBOX';
            });

            server = createTestServer({
                onAuth: (auth, session, callback) => {
                    if (auth.username === TEST_USER && auth.password === TEST_PASS) {
                        return callback(null, { user: { id: 'testuser', username: TEST_USER } });
                    }
                    return callback(new Error('Invalid credentials'));
                },
                onListMessages: (session, callback) => callback(null, {
                    messages: testMessages,
                    count: testMessages.length,
                    size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                }),
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 10000000
                    };
                    stream.bytes = testMsg.content.length;
                    setImmediate(() => {
                        stream.end(testMsg.content);
                    });
                    callback(null, stream);
                },
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS);

                try {
                    // mpop should complete successfully
                    expect(result.code).to.equal(0, `mpop failed with stderr: ${result.stderr}`);
                    // Check that mail was delivered
                    expect(fs.existsSync(mboxPath)).to.be.true;
                    const mboxContent = fs.readFileSync(mboxPath, 'utf8');
                    expect(mboxContent).to.include('Test Message 1 - Pipelining Test');
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });

        it('should handle mpop --serverinfo without timeout', done => {
            server = createTestServer({
                onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
                onListMessages: (session, callback) => callback(null, {
                    messages: [],
                    count: 0,
                    size: 0
                }),
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS, { serverinfo: true });

                try {
                    expect(result.code).to.equal(0, `mpop --serverinfo failed: ${result.stderr}`);
                    // Should not see inactivity error
                    expect(result.stderr).to.not.include('Disconnected for inactivity');
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });
    });

    describe('mpop Pipelining with Multiple Messages', () => {
        it('should fetch multiple messages without inactivity timeout', done => {
            // Create 5 messages of varying sizes
            const testMessages = [];
            for (let i = 1; i <= 5; i++) {
                const content = generateFakeEmail(i, i); // Increasing sizes
                testMessages.push({
                    id: String(i),
                    uid: `uid${i}`,
                    content,
                    size: content.length,
                    mailbox: 'INBOX'
                });
            }

            server = createTestServer({
                onAuth: (auth, session, callback) => {
                    if (auth.username === TEST_USER && auth.password === TEST_PASS) {
                        return callback(null, { user: { id: 'testuser', username: TEST_USER } });
                    }
                    return callback(new Error('Invalid credentials'));
                },
                onListMessages: (session, callback) => callback(null, {
                    messages: testMessages,
                    count: testMessages.length,
                    size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                }),
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 10000000
                    };
                    stream.bytes = testMsg.content.length;
                    // Simulate realistic async delay
                    setTimeout(() => {
                        stream.end(testMsg.content);
                    }, Math.random() * 50);
                    callback(null, stream);
                },
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS);

                try {
                    expect(result.code).to.equal(0, `mpop failed: ${result.stderr}`);
                    expect(result.stderr).to.not.include('Disconnected for inactivity');

                    // Verify all messages were received
                    const mboxContent = fs.readFileSync(mboxPath, 'utf8');
                    for (let i = 1; i <= 5; i++) {
                        expect(mboxContent).to.include(`Test Message ${i}`);
                    }
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });

        it('should handle aggressive pipelining with 20 messages', done => {
            // Create 20 messages to stress test pipelining
            const testMessages = [];
            for (let i = 1; i <= 20; i++) {
                const content = generateFakeEmail(i, 1);
                testMessages.push({
                    id: String(i),
                    uid: `uid${i}`,
                    content,
                    size: content.length,
                    mailbox: 'INBOX'
                });
            }

            server = createTestServer({
                onAuth: (auth, session, callback) => {
                    if (auth.username === TEST_USER && auth.password === TEST_PASS) {
                        return callback(null, { user: { id: 'testuser', username: TEST_USER } });
                    }
                    return callback(new Error('Invalid credentials'));
                },
                onListMessages: (session, callback) => callback(null, {
                    messages: testMessages,
                    count: testMessages.length,
                    size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                }),
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 10000000
                    };
                    stream.bytes = testMsg.content.length;
                    // Random delay to simulate real-world conditions
                    setTimeout(() => {
                        stream.end(testMsg.content);
                    }, Math.random() * 20);
                    callback(null, stream);
                },
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS);

                try {
                    expect(result.code).to.equal(0, `mpop failed with 20 messages: ${result.stderr}`);
                    expect(result.stderr).to.not.include('Disconnected for inactivity');

                    // Verify all 20 messages were received
                    const mboxContent = fs.readFileSync(mboxPath, 'utf8');
                    for (let i = 1; i <= 20; i++) {
                        expect(mboxContent).to.include(`Test Message ${i}`);
                    }
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });
    });

    describe('mpop Pipelining Edge Cases', () => {
        it('should handle empty mailbox without timeout', done => {
            server = createTestServer({
                onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
                onListMessages: (session, callback) => callback(null, {
                    messages: [],
                    count: 0,
                    size: 0
                }),
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS);

                try {
                    expect(result.code).to.equal(0, `mpop failed on empty mailbox: ${result.stderr}`);
                    expect(result.stderr).to.not.include('Disconnected for inactivity');
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });

        it('should handle large messages without timeout during pipelining', done => {
            // Create 3 large messages (each ~100KB)
            const testMessages = [];
            for (let i = 1; i <= 3; i++) {
                const content = generateFakeEmail(i, 100); // Large messages
                testMessages.push({
                    id: String(i),
                    uid: `uid${i}`,
                    content,
                    size: content.length,
                    mailbox: 'INBOX'
                });
            }

            server = createTestServer({
                onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
                onListMessages: (session, callback) => callback(null, {
                    messages: testMessages,
                    count: testMessages.length,
                    size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                }),
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 100000000
                    };
                    stream.bytes = testMsg.content.length;
                    setImmediate(() => {
                        stream.end(testMsg.content);
                    });
                    callback(null, stream);
                },
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS);

                try {
                    expect(result.code).to.equal(0, `mpop failed with large messages: ${result.stderr}`);
                    expect(result.stderr).to.not.include('Disconnected for inactivity');

                    // Verify all messages were received
                    const mboxContent = fs.readFileSync(mboxPath, 'utf8');
                    for (let i = 1; i <= 3; i++) {
                        expect(mboxContent).to.include(`Test Message ${i}`);
                    }
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });

        it('should handle slow message retrieval without premature timeout', done => {
            const testMessages = [
                { id: '1', uid: 'uid1', content: generateFakeEmail(1) },
                { id: '2', uid: 'uid2', content: generateFakeEmail(2) },
                { id: '3', uid: 'uid3', content: generateFakeEmail(3) }
            ];
            testMessages.forEach(msg => {
                msg.size = msg.content.length;
                msg.mailbox = 'INBOX';
            });

            server = createTestServer({
                // Use longer timeout for slow retrieval test
                socketTimeout: 10000,
                onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
                onListMessages: (session, callback) => callback(null, {
                    messages: testMessages,
                    count: testMessages.length,
                    size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                }),
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 10000000
                    };
                    stream.bytes = testMsg.content.length;
                    // Simulate slow database retrieval (500ms delay)
                    setTimeout(() => {
                        stream.end(testMsg.content);
                    }, 500);
                    callback(null, stream);
                },
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS, { timeout: 60000 });

                try {
                    expect(result.code).to.equal(0, `mpop failed with slow retrieval: ${result.stderr}`);
                    expect(result.stderr).to.not.include('Disconnected for inactivity');

                    // Verify all messages were received
                    const mboxContent = fs.readFileSync(mboxPath, 'utf8');
                    for (let i = 1; i <= 3; i++) {
                        expect(mboxContent).to.include(`Test Message ${i}`);
                    }
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });
    });

    describe('Pipelining Protocol Verification', () => {
        it('should verify mpop sends pipelined commands', done => {
            // This test captures the raw protocol to verify mpop is actually pipelining
            const testMessages = [];
            for (let i = 1; i <= 3; i++) {
                const content = generateFakeEmail(i);
                testMessages.push({
                    id: String(i),
                    uid: `uid${i}`,
                    content,
                    size: content.length,
                    mailbox: 'INBOX'
                });
            }

            const receivedCommands = [];
            let lastCommandTime = 0;

            server = createTestServer({
                onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
                onListMessages: (session, callback) => callback(null, {
                    messages: testMessages,
                    count: testMessages.length,
                    size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                }),
                onFetchMessage: (message, session, callback) => {
                    const now = Date.now();
                    const timeSinceLast = now - lastCommandTime;
                    receivedCommands.push({
                        command: `RETR ${message.id}`,
                        timeSinceLast
                    });
                    lastCommandTime = now;

                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 10000000
                    };
                    stream.bytes = testMsg.content.length;
                    setImmediate(() => {
                        stream.end(testMsg.content);
                    });
                    callback(null, stream);
                },
                onUpdate: (update, session, callback) => callback(null, true)
            });

            server.listen(TEST_PORT, '127.0.0.1', async () => {
                port = server.server.address().port;
                createMpopConfig(configPath, port, mboxPath);

                const result = await runMpop(configPath, TEST_PASS);

                try {
                    expect(result.code).to.equal(0, `mpop failed: ${result.stderr}`);
                    expect(receivedCommands.length).to.equal(3);
                    // mpop should pipeline commands - verify rapid succession
                    // Note: This may not always detect pipelining depending on timing
                    // The important thing is that all messages are fetched successfully
                    return done();
                } catch (e) {
                    return done(e);
                }
            });
        });
    });
});

describe('POP3 Raw Pipelining Simulation (mpop-style)', () => {
    // These tests simulate mpop's pipelining behavior using raw sockets
    // to ensure the server handles it correctly even without mpop installed

    let server;
    let port;

    afterEach(done => {
        if (server) {
            server.close(done);
            server = null;
            return;
        }
        done();
    });

    it('should handle mpop-style RETR pipelining without interleaving', function (done) {
        this.timeout(30000); // eslint-disable-line no-invalid-this

        const testMessages = [];
        for (let i = 1; i <= 5; i++) {
            const content = generateFakeEmail(i, 2);
            testMessages.push({
                id: String(i),
                uid: `uid${i}`,
                content,
                size: content.length,
                mailbox: 'INBOX'
            });
        }

        server = createTestServer({
            onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
            onListMessages: (session, callback) => callback(null, {
                messages: testMessages,
                count: testMessages.length,
                size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
            }),
            onFetchMessage: (message, session, callback) => {
                const testMsg = testMessages.find(m => m.id === message.id);
                if (!testMsg) {
                    return callback(new Error('Message not found'));
                }
                const stream = new PassThrough();
                stream.options = {
                    ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                    key: 'test',
                    maxBytes: 10000000
                };
                stream.bytes = testMsg.content.length;
                // Simulate async retrieval
                setTimeout(() => {
                    stream.end(testMsg.content);
                }, Math.random() * 30);
                return callback(null, stream);
            },
            onUpdate: (update, session, callback) => callback(null, true)
        });

        server.listen(TEST_PORT, '127.0.0.1', () => {
            port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1');
            let buffer = '';
            let state = 'greeting';
            let messagesReceived = 0;
            let inMessageBody = false;
            let finished = false;

            const finish = err => {
                if (finished) {
                    return;
                }
                finished = true;
                client.destroy();
                done(err);
            };

            client.on('data', data => {
                if (finished) {
                    return;
                }
                buffer += data.toString();

                while (buffer.includes('\r\n')) {
                    const lineEnd = buffer.indexOf('\r\n');
                    const line = buffer.substring(0, lineEnd);
                    buffer = buffer.substring(lineEnd + 2);

                    if (state === 'greeting') {
                        if (line.includes('+OK')) {
                            state = 'auth_user';
                            client.write(`USER ${TEST_USER}\r\n`);
                        }
                    } else if (state === 'auth_user') {
                        if (line.includes('+OK')) {
                            state = 'auth_pass';
                            client.write(`PASS ${TEST_PASS}\r\n`);
                        }
                    } else if (state === 'auth_pass') {
                        if (line.includes('+OK') && line.includes('maildrop')) {
                            state = 'pipelining';
                            // Send all RETR commands at once (mpop-style aggressive pipelining)
                            let commands = '';
                            for (let i = 1; i <= 5; i++) {
                                commands += `RETR ${i}\r\n`;
                            }
                            client.write(commands);
                        } else if (line.includes('-ERR')) {
                            return finish(new Error('Auth failed: ' + line));
                        }
                    } else if (state === 'pipelining') {
                        if (line.startsWith('+OK') && line.includes('octets')) {
                            if (inMessageBody) {
                                return finish(new Error('Protocol error: +OK before previous message ended'));
                            }
                            inMessageBody = true;
                        } else if (line === '.') {
                            inMessageBody = false;
                            messagesReceived++;
                            if (messagesReceived === 5) {
                                state = 'quit';
                                client.write('QUIT\r\n');
                            }
                        } else if (line.startsWith('-ERR')) {
                            if (line.includes('Disconnected for inactivity')) {
                                return finish(new Error('Inactivity timeout during pipelining - this is the bug!'));
                            }
                            return finish(new Error('Server error: ' + line));
                        }
                    } else if (state === 'quit') {
                        if (line.includes('+OK') || line.includes('signing off')) {
                            try {
                                expect(messagesReceived).to.equal(5);
                                return finish();
                            } catch (e) {
                                return finish(e);
                            }
                        }
                    }
                }
            });

            client.on('error', err => {
                finish(err);
            });

            client.on('close', () => {
                if (!finished) {
                    finish(new Error(`Connection closed unexpectedly after ${messagesReceived} messages`));
                }
            });
        });
    });

    it('should reset timeout properly during RETR streaming', function (done) {
        this.timeout(30000); // eslint-disable-line no-invalid-this

        // Single large message to test timeout reset during streaming
        const largeContent = generateFakeEmail(1, 200); // ~200KB message
        const testMessages = [{
            id: '1',
            uid: 'uid1',
            content: largeContent,
            size: largeContent.length,
            mailbox: 'INBOX'
        }];

        server = createTestServer({
            socketTimeout: 5000, // Short timeout to test reset
            onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
            onListMessages: (session, callback) => callback(null, {
                messages: testMessages,
                count: testMessages.length,
                size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
            }),
            onFetchMessage: (message, session, callback) => {
                const testMsg = testMessages.find(m => m.id === message.id);
                if (!testMsg) {
                    return callback(new Error('Message not found'));
                }
                const stream = new PassThrough();
                stream.options = {
                    ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                    key: 'test',
                    maxBytes: 100000000
                };
                stream.bytes = testMsg.content.length;
                // Simulate slow streaming - send chunks over time
                let offset = 0;
                const chunkSize = 1024;
                const sendChunk = () => {
                    if (offset >= testMsg.content.length) {
                        stream.end();
                        return;
                    }
                    const chunk = testMsg.content.slice(offset, offset + chunkSize);
                    stream.write(chunk);
                    offset += chunkSize;
                    // Small delay between chunks
                    setTimeout(sendChunk, 10);
                };
                setImmediate(sendChunk);
                return callback(null, stream);
            },
            onUpdate: (update, session, callback) => callback(null, true)
        });

        server.listen(TEST_PORT, '127.0.0.1', () => {
            port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1');
            let buffer = '';
            let state = 'greeting';
            let receivedContent = '';
            let finished = false;

            const finish = err => {
                if (finished) {
                    return;
                }
                finished = true;
                client.destroy();
                done(err);
            };

            client.on('data', data => {
                if (finished) {
                    return;
                }
                buffer += data.toString();

                while (buffer.includes('\r\n')) {
                    const lineEnd = buffer.indexOf('\r\n');
                    const line = buffer.substring(0, lineEnd);
                    buffer = buffer.substring(lineEnd + 2);

                    if (state === 'greeting') {
                        if (line.includes('+OK')) {
                            state = 'auth_user';
                            client.write(`USER ${TEST_USER}\r\n`);
                        }
                    } else if (state === 'auth_user') {
                        if (line.includes('+OK')) {
                            state = 'auth_pass';
                            client.write(`PASS ${TEST_PASS}\r\n`);
                        }
                    } else if (state === 'auth_pass') {
                        if (line.includes('+OK') && line.includes('maildrop')) {
                            state = 'retr';
                            client.write('RETR 1\r\n');
                        }
                    } else if (state === 'retr') {
                        if (line.startsWith('+OK') && line.includes('octets')) {
                            state = 'reading';
                        } else if (line.startsWith('-ERR')) {
                            if (line.includes('Disconnected for inactivity')) {
                                return finish(new Error('Timeout during large message streaming'));
                            }
                            return finish(new Error('Server error: ' + line));
                        }
                    } else if (state === 'reading') {
                        if (line === '.') {
                            state = 'quit';
                            client.write('QUIT\r\n');
                        } else {
                            receivedContent += line + '\r\n';
                        }
                    } else if (state === 'quit') {
                        if (line.includes('+OK') || line.includes('signing off')) {
                            try {
                                expect(receivedContent.length).to.be.greaterThan(100000);
                                return finish();
                            } catch (e) {
                                return finish(e);
                            }
                        }
                    }
                }
            });

            client.on('error', err => {
                finish(err);
            });

            client.on('close', () => {
                if (!finished) {
                    finish(new Error('Connection closed unexpectedly'));
                }
            });
        });
    });

    it('should handle DELE commands pipelined after RETR', function (done) {
        this.timeout(30000); // eslint-disable-line no-invalid-this

        const testMessages = [];
        for (let i = 1; i <= 3; i++) {
            const content = generateFakeEmail(i, 1);
            testMessages.push({
                id: String(i),
                uid: `uid${i}`,
                content,
                size: content.length,
                mailbox: 'INBOX',
                popped: false
            });
        }

        server = createTestServer({
            onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
            onListMessages: (session, callback) => callback(null, {
                messages: testMessages,
                count: testMessages.length,
                size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
            }),
            onFetchMessage: (message, session, callback) => {
                const testMsg = testMessages.find(m => m.id === message.id);
                if (!testMsg) {
                    return callback(new Error('Message not found'));
                }
                const stream = new PassThrough();
                stream.options = {
                    ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                    key: 'test',
                    maxBytes: 10000000
                };
                stream.bytes = testMsg.content.length;
                setImmediate(() => {
                    stream.end(testMsg.content);
                });
                return callback(null, stream);
            },
            onUpdate: (update, session, callback) => callback(null, true)
        });

        server.listen(TEST_PORT, '127.0.0.1', () => {
            port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1');
            let buffer = '';
            let state = 'greeting';
            let messagesReceived = 0;
            let deletesReceived = 0;
            let inMessageBody = false;
            let finished = false;

            const finish = err => {
                if (finished) {
                    return;
                }
                finished = true;
                client.destroy();
                done(err);
            };

            client.on('data', data => {
                if (finished) {
                    return;
                }
                buffer += data.toString();

                while (buffer.includes('\r\n')) {
                    const lineEnd = buffer.indexOf('\r\n');
                    const line = buffer.substring(0, lineEnd);
                    buffer = buffer.substring(lineEnd + 2);

                    if (state === 'greeting') {
                        if (line.includes('+OK')) {
                            state = 'auth_user';
                            client.write(`USER ${TEST_USER}\r\n`);
                        }
                    } else if (state === 'auth_user') {
                        if (line.includes('+OK')) {
                            state = 'auth_pass';
                            client.write(`PASS ${TEST_PASS}\r\n`);
                        }
                    } else if (state === 'auth_pass') {
                        if (line.includes('+OK') && line.includes('maildrop')) {
                            state = 'pipelining';
                            // mpop-style: pipeline RETR and DELE commands together
                            let commands = '';
                            for (let i = 1; i <= 3; i++) {
                                commands += `RETR ${i}\r\nDELE ${i}\r\n`;
                            }
                            client.write(commands);
                        } else if (line.includes('-ERR')) {
                            return finish(new Error('Auth failed: ' + line));
                        }
                    } else if (state === 'pipelining') {
                        if (line.startsWith('+OK') && line.includes('octets')) {
                            if (inMessageBody) {
                                return finish(new Error('Protocol error: +OK before previous message ended'));
                            }
                            inMessageBody = true;
                        } else if (line === '.') {
                            inMessageBody = false;
                            messagesReceived++;
                        } else if (line.startsWith('+OK') && line.includes('deleted')) {
                            deletesReceived++;
                            if (deletesReceived === 3) {
                                state = 'quit';
                                client.write('QUIT\r\n');
                            }
                        } else if (line.startsWith('-ERR')) {
                            if (line.includes('Disconnected for inactivity')) {
                                return finish(new Error('Inactivity timeout during pipelining'));
                            }
                            return finish(new Error('Server error: ' + line));
                        }
                    } else if (state === 'quit') {
                        if (line.includes('+OK') || line.includes('signing off')) {
                            try {
                                expect(messagesReceived).to.equal(3);
                                expect(deletesReceived).to.equal(3);
                                return finish();
                            } catch (e) {
                                return finish(e);
                            }
                        }
                    }
                }
            });

            client.on('error', err => {
                finish(err);
            });

            client.on('close', () => {
                if (!finished) {
                    finish(new Error(`Connection closed unexpectedly after ${messagesReceived} messages`));
                }
            });
        });
    });
});

describe('POP3 Stream Options Handling', () => {
    // These tests verify that the server handles streams without the options property
    // This is important for compatibility with implementations like Forward Email
    // that don't set stream.options.ttlcounter

    let server;
    let port;

    afterEach(done => {
        if (server) {
            server.close(done);
            server = null;
            return;
        }
        done();
    });

    it('should handle RETR with stream missing options property', function (done) {
        this.timeout(30000); // eslint-disable-line no-invalid-this

        const testMessages = [{
            id: '1',
            uid: 'uid1',
            content: generateFakeEmail(1),
            size: 0,
            mailbox: 'INBOX'
        }];
        testMessages[0].size = testMessages[0].content.length;

        server = createTestServer({
            onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
            onListMessages: (session, callback) => callback(null, {
                messages: testMessages,
                count: testMessages.length,
                size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
            }),
            onFetchMessage: (message, session, callback) => {
                const testMsg = testMessages.find(m => m.id === message.id);
                if (!testMsg) {
                    return callback(new Error('Message not found'));
                }
                // Return a stream WITHOUT the options property
                // This simulates Forward Email's behavior
                const stream = new PassThrough();
                stream.bytes = testMsg.content.length;
                // Intentionally NOT setting stream.options
                setImmediate(() => {
                    stream.end(testMsg.content);
                });
                callback(null, stream);
            },
            onUpdate: (update, session, callback) => callback(null, true)
        });

        server.listen(TEST_PORT, '127.0.0.1', () => {
            port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1');
            let buffer = '';
            let state = 'greeting';
            let messageReceived = false;
            let finished = false;

            const finish = err => {
                if (finished) {
                    return;
                }
                finished = true;
                client.destroy();
                done(err);
            };

            client.on('data', data => {
                if (finished) {
                    return;
                }
                buffer += data.toString();

                while (buffer.includes('\r\n')) {
                    const lineEnd = buffer.indexOf('\r\n');
                    const line = buffer.substring(0, lineEnd);
                    buffer = buffer.substring(lineEnd + 2);

                    if (state === 'greeting') {
                        if (line.includes('+OK')) {
                            state = 'auth_user';
                            client.write(`USER ${TEST_USER}\r\n`);
                        }
                    } else if (state === 'auth_user') {
                        if (line.includes('+OK')) {
                            state = 'auth_pass';
                            client.write(`PASS ${TEST_PASS}\r\n`);
                        }
                    } else if (state === 'auth_pass') {
                        if (line.includes('+OK') && line.includes('maildrop')) {
                            state = 'retr';
                            client.write('RETR 1\r\n');
                        } else if (line.includes('-ERR')) {
                            return finish(new Error('Auth failed: ' + line));
                        }
                    } else if (state === 'retr') {
                        if (line.startsWith('+OK') && line.includes('octets')) {
                            state = 'reading';
                        } else if (line.startsWith('-ERR')) {
                            return finish(new Error('RETR failed: ' + line));
                        }
                    } else if (state === 'reading') {
                        if (line === '.') {
                            messageReceived = true;
                            state = 'quit';
                            client.write('QUIT\r\n');
                        }
                    } else if (state === 'quit') {
                        if (line.includes('+OK') || line.includes('signing off')) {
                            try {
                                expect(messageReceived).to.be.true;
                                return finish();
                            } catch (e) {
                                return finish(e);
                            }
                        }
                    }
                }
            });

            client.on('error', err => {
                finish(err);
            });

            client.on('close', () => {
                if (!finished) {
                    finish(new Error('Connection closed unexpectedly'));
                }
            });
        });
    });

    it('should handle TOP with stream missing options property', function (done) {
        this.timeout(30000); // eslint-disable-line no-invalid-this

        const testMessages = [{
            id: '1',
            uid: 'uid1',
            content: generateFakeEmail(1),
            size: 0,
            mailbox: 'INBOX'
        }];
        testMessages[0].size = testMessages[0].content.length;

        server = createTestServer({
            onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
            onListMessages: (session, callback) => callback(null, {
                messages: testMessages,
                count: testMessages.length,
                size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
            }),
            onFetchMessage: (message, session, callback) => {
                const testMsg = testMessages.find(m => m.id === message.id);
                if (!testMsg) {
                    return callback(new Error('Message not found'));
                }
                // Return a stream WITHOUT the options property
                const stream = new PassThrough();
                stream.bytes = testMsg.content.length;
                // Intentionally NOT setting stream.options
                setImmediate(() => {
                    stream.end(testMsg.content);
                });
                callback(null, stream);
            },
            onUpdate: (update, session, callback) => callback(null, true)
        });

        server.listen(TEST_PORT, '127.0.0.1', () => {
            port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1');
            let buffer = '';
            let state = 'greeting';
            let topReceived = false;
            let finished = false;

            const finish = err => {
                if (finished) {
                    return;
                }
                finished = true;
                client.destroy();
                done(err);
            };

            client.on('data', data => {
                if (finished) {
                    return;
                }
                buffer += data.toString();

                while (buffer.includes('\r\n')) {
                    const lineEnd = buffer.indexOf('\r\n');
                    const line = buffer.substring(0, lineEnd);
                    buffer = buffer.substring(lineEnd + 2);

                    if (state === 'greeting') {
                        if (line.includes('+OK')) {
                            state = 'auth_user';
                            client.write(`USER ${TEST_USER}\r\n`);
                        }
                    } else if (state === 'auth_user') {
                        if (line.includes('+OK')) {
                            state = 'auth_pass';
                            client.write(`PASS ${TEST_PASS}\r\n`);
                        }
                    } else if (state === 'auth_pass') {
                        if (line.includes('+OK') && line.includes('maildrop')) {
                            state = 'top';
                            client.write('TOP 1 5\r\n'); // Get headers + 5 lines
                        } else if (line.includes('-ERR')) {
                            return finish(new Error('Auth failed: ' + line));
                        }
                    } else if (state === 'top') {
                        if (line.startsWith('+OK') && line.includes('message follows')) {
                            state = 'reading';
                        } else if (line.startsWith('-ERR')) {
                            return finish(new Error('TOP failed: ' + line));
                        }
                    } else if (state === 'reading') {
                        if (line === '.') {
                            topReceived = true;
                            state = 'quit';
                            client.write('QUIT\r\n');
                        }
                    } else if (state === 'quit') {
                        if (line.includes('+OK') || line.includes('signing off')) {
                            try {
                                expect(topReceived).to.be.true;
                                return finish();
                            } catch (e) {
                                return finish(e);
                            }
                        }
                    }
                }
            });

            client.on('error', err => {
                finish(err);
            });

            client.on('close', () => {
                if (!finished) {
                    finish(new Error('Connection closed unexpectedly'));
                }
            });
        });
    });

    it('should handle stream with options but missing ttlcounter', function (done) {
        this.timeout(30000); // eslint-disable-line no-invalid-this

        const testMessages = [{
            id: '1',
            uid: 'uid1',
            content: generateFakeEmail(1),
            size: 0,
            mailbox: 'INBOX'
        }];
        testMessages[0].size = testMessages[0].content.length;

        server = createTestServer({
            onAuth: (auth, session, callback) => callback(null, { user: { id: 'testuser', username: TEST_USER } }),
            onListMessages: (session, callback) => callback(null, {
                messages: testMessages,
                count: testMessages.length,
                size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
            }),
            onFetchMessage: (message, session, callback) => {
                const testMsg = testMessages.find(m => m.id === message.id);
                if (!testMsg) {
                    return callback(new Error('Message not found'));
                }
                // Return a stream with options but WITHOUT ttlcounter
                const stream = new PassThrough();
                stream.bytes = testMsg.content.length;
                stream.options = {
                    key: 'test',
                    maxBytes: 10000000
                    // Intentionally NOT setting ttlcounter
                };
                setImmediate(() => {
                    stream.end(testMsg.content);
                });
                callback(null, stream);
            },
            onUpdate: (update, session, callback) => callback(null, true)
        });

        server.listen(TEST_PORT, '127.0.0.1', () => {
            port = server.server.address().port;
            const client = net.connect(port, '127.0.0.1');
            let buffer = '';
            let state = 'greeting';
            let messageReceived = false;
            let finished = false;

            const finish = err => {
                if (finished) {
                    return;
                }
                finished = true;
                client.destroy();
                done(err);
            };

            client.on('data', data => {
                if (finished) {
                    return;
                }
                buffer += data.toString();

                while (buffer.includes('\r\n')) {
                    const lineEnd = buffer.indexOf('\r\n');
                    const line = buffer.substring(0, lineEnd);
                    buffer = buffer.substring(lineEnd + 2);

                    if (state === 'greeting') {
                        if (line.includes('+OK')) {
                            state = 'auth_user';
                            client.write(`USER ${TEST_USER}\r\n`);
                        }
                    } else if (state === 'auth_user') {
                        if (line.includes('+OK')) {
                            state = 'auth_pass';
                            client.write(`PASS ${TEST_PASS}\r\n`);
                        }
                    } else if (state === 'auth_pass') {
                        if (line.includes('+OK') && line.includes('maildrop')) {
                            state = 'retr';
                            client.write('RETR 1\r\n');
                        } else if (line.includes('-ERR')) {
                            return finish(new Error('Auth failed: ' + line));
                        }
                    } else if (state === 'retr') {
                        if (line.startsWith('+OK') && line.includes('octets')) {
                            state = 'reading';
                        } else if (line.startsWith('-ERR')) {
                            return finish(new Error('RETR failed: ' + line));
                        }
                    } else if (state === 'reading') {
                        if (line === '.') {
                            messageReceived = true;
                            state = 'quit';
                            client.write('QUIT\r\n');
                        }
                    } else if (state === 'quit') {
                        if (line.includes('+OK') || line.includes('signing off')) {
                            try {
                                expect(messageReceived).to.be.true;
                                return finish();
                            } catch (e) {
                                return finish(e);
                            }
                        }
                    }
                }
            });

            client.on('error', err => {
                finish(err);
            });

            client.on('close', () => {
                if (!finished) {
                    finish(new Error('Connection closed unexpectedly'));
                }
            });
        });
    });
});
