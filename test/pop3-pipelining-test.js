'use strict';

/* eslint-disable no-unused-expressions */

const chai = require('chai');
const expect = chai.expect;
const POP3Server = require('../lib/pop3/server');
const net = require('net');
const { PassThrough } = require('stream');
const fs = require('fs');

chai.config.includeStack = true;

const TEST_PORT = 0; // Use port 0 to let OS assign available port

// Mock loggelf function for testing
const mockLoggelf = () => {};

/**
 * Helper function to create a POP3 server with proper test configuration
 * @param {Object} options - Server options
 * @returns {POP3Server} - Configured POP3 server instance
 */
function createTestServer(options) {
    const server = new POP3Server({
        disableSTARTTLS: true,
        ...options
    });
    // Set loggelf directly on the server instance (as done in pop3.js)
    server.loggelf = mockLoggelf;
    return server;
}

describe('POP3 Pipelining Tests', () => {
    let server;
    let port;

    afterEach(done => {
        if (server) {
            return server.close(done);
        }
        return done();
    });

    describe('Pipelined RETR Commands', () => {
        it('should handle multiple pipelined RETR commands without interleaving responses', done => {
            // Create test messages of varying sizes
            const testMessages = [
                { id: '1', uid: '1', content: 'Subject: Test 1\r\n\r\n' + 'A'.repeat(80) + '\r\n' },
                { id: '2', uid: '2', content: 'Subject: Test 2\r\n\r\n' + 'B'.repeat(180) + '\r\n' },
                { id: '3', uid: '3', content: 'Subject: Test 3\r\n\r\n' + 'C'.repeat(130) + '\r\n' }
            ];

            // Add size and mailbox to messages
            testMessages.forEach(msg => {
                msg.size = msg.content.length;
                msg.mailbox = 'INBOX';
            });

            server = createTestServer({
                onAuth: (auth, session, callback) => {
                    callback(null, { user: { id: 'testuser', username: 'test@example.com' } });
                },
                onListMessages: (session, callback) => {
                    callback(null, {
                        messages: testMessages,
                        count: testMessages.length,
                        size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                    });
                },
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 1000000
                    };
                    stream.bytes = testMsg.content.length;
                    // Simulate async message retrieval with small delay
                    setImmediate(() => {
                        stream.end(testMsg.content);
                    });
                    callback(null, stream);
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');
                let buffer = '';
                let state = 'greeting';
                let messageResponses = [];
                let currentMessageContent = '';
                let inMessageBody = false;
                let finished = false;

                const finish = (err) => {
                    if (finished) return;
                    finished = true;
                    client.destroy();
                    done(err);
                };

                client.on('data', data => {
                    if (finished) return;
                    buffer += data.toString();

                    // Process complete lines
                    while (buffer.includes('\r\n')) {
                        const lineEnd = buffer.indexOf('\r\n');
                        const line = buffer.substring(0, lineEnd);
                        buffer = buffer.substring(lineEnd + 2);

                        if (state === 'greeting') {
                            if (line.includes('+OK')) {
                                state = 'auth_user';
                                client.write('USER test@example.com\r\n');
                            }
                        } else if (state === 'auth_user') {
                            if (line.includes('+OK')) {
                                state = 'auth_pass';
                                client.write('PASS testpass\r\n');
                            }
                        } else if (state === 'auth_pass') {
                            if (line.includes('+OK') && line.includes('maildrop')) {
                                state = 'pipelining';
                                // Send pipelined RETR commands (like mpop does)
                                client.write('RETR 1\r\nRETR 2\r\nRETR 3\r\n');
                            } else if (line.includes('-ERR')) {
                                return finish(new Error('Auth failed: ' + line));
                            }
                        } else if (state === 'pipelining') {
                            if (line.startsWith('+OK') && line.includes('octets')) {
                                // Start of a new message response
                                if (inMessageBody) {
                                    // Previous message didn't end properly - this is the bug!
                                    return finish(new Error('Received +OK for next message before previous message ended with dot'));
                                }
                                inMessageBody = true;
                                currentMessageContent = '';
                            } else if (line === '.') {
                                // End of message
                                inMessageBody = false;
                                messageResponses.push(currentMessageContent);
                                currentMessageContent = '';

                                if (messageResponses.length === 3) {
                                    // All messages received correctly
                                    state = 'quit';
                                    client.write('QUIT\r\n');
                                }
                            } else if (inMessageBody) {
                                // Message content line (handle dot-stuffing)
                                const contentLine = line.startsWith('..') ? line.substring(1) : line;
                                currentMessageContent += contentLine + '\r\n';
                            } else if (line.startsWith('-ERR')) {
                                return finish(new Error('Received error: ' + line));
                            }
                        } else if (state === 'quit') {
                            if (line.includes('+OK') || line.includes('signing off')) {
                                // Verify all messages were received correctly and in order
                                try {
                                    expect(messageResponses).to.have.length(3);
                                    expect(messageResponses[0]).to.include('Test 1');
                                    expect(messageResponses[0]).to.include('A'.repeat(10));
                                    expect(messageResponses[1]).to.include('Test 2');
                                    expect(messageResponses[1]).to.include('B'.repeat(10));
                                    expect(messageResponses[2]).to.include('Test 3');
                                    expect(messageResponses[2]).to.include('C'.repeat(10));
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

        it('should ensure message terminating dot is sent before next +OK response', done => {
            // This test specifically checks that the terminating dot appears
            // before the +OK of the next message in the raw response stream
            const testMessages = [
                { id: '1', uid: '1', content: 'Subject: Msg1\r\n\r\nBody1\r\n' },
                { id: '2', uid: '2', content: 'Subject: Msg2\r\n\r\nBody2\r\n' }
            ];

            testMessages.forEach(msg => {
                msg.size = msg.content.length;
                msg.mailbox = 'INBOX';
            });

            server = createTestServer({
                onAuth: (auth, session, callback) => {
                    callback(null, { user: { id: 'testuser', username: 'test@example.com' } });
                },
                onListMessages: (session, callback) => {
                    callback(null, {
                        messages: testMessages,
                        count: testMessages.length,
                        size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                    });
                },
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 1000000
                    };
                    stream.bytes = testMsg.content.length;
                    setImmediate(() => {
                        stream.end(testMsg.content);
                    });
                    callback(null, stream);
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');
                let rawData = '';
                let state = 'greeting';
                let finished = false;
                let quitSent = false;

                const finish = (err) => {
                    if (finished) return;
                    finished = true;
                    client.destroy();
                    done(err);
                };

                client.on('data', data => {
                    if (finished) return;
                    const chunk = data.toString();
                    rawData += chunk;

                    // Simple state machine to get through auth
                    if (state === 'greeting' && rawData.includes('+OK')) {
                        state = 'auth_user';
                        client.write('USER test@example.com\r\n');
                    } else if (state === 'auth_user' && rawData.includes('send PASS')) {
                        state = 'auth_pass';
                        client.write('PASS testpass\r\n');
                    } else if (state === 'auth_pass' && rawData.includes('maildrop has')) {
                        state = 'pipelining';
                        rawData = ''; // Reset to capture only RETR responses
                        // Send pipelined RETR commands
                        client.write('RETR 1\r\nRETR 2\r\n');
                    } else if (state === 'pipelining' && !quitSent) {
                        // Check if we have both message responses (both dots received)
                        const dotCount = (rawData.match(/\r\n\.\r\n/g) || []).length;

                        if (dotCount >= 2) {
                            quitSent = true;
                            // We have both messages complete, now verify the order
                            // The pattern should be: +OK...content...\r\n.\r\n+OK...
                            const correctPattern = /\+OK \d+ octets\r\n[\s\S]*?\r\n\.\r\n\+OK \d+ octets/;
                            const correctOrder = correctPattern.test(rawData);

                            // Check if there's an interleaving issue
                            const badPattern = /\+OK \d+ octets\r\n\+OK \d+ octets/;
                            const hasInterleaving = badPattern.test(rawData);

                            client.write('QUIT\r\n');

                            setTimeout(() => {
                                try {
                                    expect(hasInterleaving).to.be.false;
                                    expect(correctOrder).to.be.true;
                                    finish();
                                } catch (e) {
                                    finish(e);
                                }
                            }, 100);
                        }
                    }
                });

                client.on('error', err => {
                    finish(err);
                });

                client.on('close', () => {
                    if (!finished && !quitSent) {
                        finish(new Error('Connection closed unexpectedly'));
                    }
                });
            });
        });

        it('should verify pipelining fix code exists in connection.js', () => {
            // This is a code verification test to ensure the fix is present
            const connectionCode = fs.readFileSync('./lib/pop3/connection.js', 'utf8');

            // Verify that dataStream is created and used for the 'end' event
            expect(connectionCode).to.include('const dataStream = new DataStream()');
            expect(connectionCode).to.include("dataStream.once('end'");
            expect(connectionCode).to.include('stream.pipe(dataStream)');
            expect(connectionCode).to.include('dataStream.pipe(this._socket');

            // Verify the comment explaining the fix
            expect(connectionCode).to.include('terminating dot has been written before processing next pipelined command');
        });

        it('should handle rapid pipelined RETR commands for many messages', done => {
            // Create 10 test messages to simulate aggressive pipelining like mpop
            const messageCount = 10;
            const testMessages = [];
            for (let i = 0; i < messageCount; i++) {
                testMessages.push({
                    id: String(i + 1),
                    uid: String(i + 1),
                    mailbox: 'INBOX',
                    content: `Subject: Test ${i + 1}\r\n\r\n${'X'.repeat(100 + i * 50)}\r\n`
                });
            }
            testMessages.forEach(msg => {
                msg.size = msg.content.length;
            });

            server = createTestServer({
                onAuth: (auth, session, callback) => {
                    callback(null, { user: { id: 'testuser', username: 'test@example.com' } });
                },
                onListMessages: (session, callback) => {
                    callback(null, {
                        messages: testMessages,
                        count: testMessages.length,
                        size: testMessages.reduce((sum, msg) => sum + msg.size, 0)
                    });
                },
                onFetchMessage: (message, session, callback) => {
                    const testMsg = testMessages.find(m => m.id === message.id);
                    if (!testMsg) {
                        return callback(new Error('Message not found'));
                    }
                    const stream = new PassThrough();
                    stream.options = {
                        ttlcounter: (key, bytes, maxBytes, flag, cb) => cb(),
                        key: 'test',
                        maxBytes: 1000000
                    };
                    stream.bytes = testMsg.content.length;
                    // Random small delay to simulate real-world async behavior
                    setTimeout(() => {
                        stream.end(testMsg.content);
                    }, Math.random() * 10);
                    callback(null, stream);
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');
                let buffer = '';
                let state = 'greeting';
                let messagesReceived = 0;
                let inMessageBody = false;
                let finished = false;

                const finish = (err) => {
                    if (finished) return;
                    finished = true;
                    client.destroy();
                    done(err);
                };

                client.on('data', data => {
                    if (finished) return;
                    buffer += data.toString();

                    while (buffer.includes('\r\n')) {
                        const lineEnd = buffer.indexOf('\r\n');
                        const line = buffer.substring(0, lineEnd);
                        buffer = buffer.substring(lineEnd + 2);

                        if (state === 'greeting') {
                            if (line.includes('+OK')) {
                                state = 'auth_user';
                                client.write('USER test@example.com\r\n');
                            }
                        } else if (state === 'auth_user') {
                            if (line.includes('+OK')) {
                                state = 'auth_pass';
                                client.write('PASS testpass\r\n');
                            }
                        } else if (state === 'auth_pass') {
                            if (line.includes('+OK') && line.includes('maildrop')) {
                                state = 'pipelining';
                                // Send all RETR commands at once (aggressive pipelining)
                                let commands = '';
                                for (let i = 1; i <= messageCount; i++) {
                                    commands += `RETR ${i}\r\n`;
                                }
                                client.write(commands);
                            }
                        } else if (state === 'pipelining') {
                            if (line.startsWith('+OK') && line.includes('octets')) {
                                if (inMessageBody) {
                                    // Bug detected: +OK before previous message ended
                                    return finish(new Error(`Message ${messagesReceived + 1}: Received +OK before previous message dot terminator`));
                                }
                                inMessageBody = true;
                            } else if (line === '.') {
                                inMessageBody = false;
                                messagesReceived++;

                                if (messagesReceived === messageCount) {
                                    state = 'quit';
                                    client.write('QUIT\r\n');
                                }
                            } else if (line.startsWith('-ERR')) {
                                return finish(new Error('Received error: ' + line));
                            }
                        } else if (state === 'quit') {
                            if (line.includes('+OK') || line.includes('signing off')) {
                                try {
                                    expect(messagesReceived).to.equal(messageCount);
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
                        if (messagesReceived < messageCount) {
                            finish(new Error(`Connection closed after receiving only ${messagesReceived}/${messageCount} messages`));
                        }
                    }
                });
            });
        });
    });
});
