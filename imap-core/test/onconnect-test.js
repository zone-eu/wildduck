'use strict';

/* eslint-disable no-unused-expressions */

const chai = require('chai');
const expect = chai.expect;
const IMAPServer = require('../index.js').IMAPServer;
const net = require('net');

chai.config.includeStack = true;

const TEST_PORT = 0; // Use port 0 to let OS assign available port

describe('IMAP onConnect Handler Tests', () => {
    let port;
    let server;

    afterEach(done => {
        if (server) {
            return server.close(done);
        }
        return done();
    });

    describe('onConnect Handler', () => {
        it('should call onConnect handler when connection is established', done => {
            let onConnectCalled = false;
            let sessionData = null;
            let finished = false;

            server = new IMAPServer({
                onConnect: (session, callback) => {
                    onConnectCalled = true;
                    sessionData = session;
                    expect(session).to.be.an('object');
                    expect(session.remoteAddress).to.be.a('string');
                    expect(session.id).to.be.a('string');
                    return callback();
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    if (finished) return;
                    finished = true;

                    let response = data.toString();
                    expect(response).to.include('* OK');
                    expect(onConnectCalled).to.be.true;
                    expect(sessionData).to.not.be.null;
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

        it('should reject connection when onConnect handler returns error', done => {
            let onConnectCalled = false;
            let finished = false;

            server = new IMAPServer({
                onConnect: (session, callback) => {
                    onConnectCalled = true;
                    return callback(new Error('Connection rejected'));
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    if (finished) return;
                    finished = true;

                    let response = data.toString();
                    expect(response).to.include('BYE');
                    expect(onConnectCalled).to.be.true;
                    client.end();
                    return done();
                });

                client.on('error', () => {
                    if (!finished) {
                        finished = true;
                        expect(onConnectCalled).to.be.true;
                        return done();
                    }
                });

                client.on('close', () => {
                    if (!finished) {
                        finished = true;
                        expect(onConnectCalled).to.be.true;
                        return done();
                    }
                });
            });
        });

        it('should allow connection filtering by IP address', done => {
            let onConnectCalled = false;
            let finished = false;

            server = new IMAPServer({
                onConnect: (session, callback) => {
                    onConnectCalled = true;
                    if (session.remoteAddress === '127.0.0.1') {
                        return callback();
                    }
                    return callback(new Error('IP not allowed'));
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    if (finished) return;
                    finished = true;

                    let response = data.toString();
                    expect(response).to.include('* OK');
                    expect(onConnectCalled).to.be.true;
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

        it('should work without onConnect handler (backward compatibility)', done => {
            let finished = false;

            server = new IMAPServer({});

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    if (finished) return;
                    finished = true;

                    let response = data.toString();
                    expect(response).to.include('* OK');
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

        it('should handle rate limiting in onConnect', done => {
            let connectionCount = 0;
            let finished = false;

            server = new IMAPServer({
                onConnect: (session, callback) => {
                    connectionCount++;
                    if (connectionCount > 2) {
                        return callback(new Error('Too many connections'));
                    }
                    return callback();
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    if (finished) return;
                    finished = true;

                    let response = data.toString();
                    expect(response).to.include('* OK');
                    expect(connectionCount).to.equal(1);
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

        it('should handle abrupt connection close properly', done => {
            let onConnectCalled = false;
            let onCloseCalled = false;
            let sessionData = null;
            let finished = false;

            server = new IMAPServer({
                onConnect: (session, callback) => {
                    onConnectCalled = true;
                    sessionData = session;
                    return callback();
                },
                onClose: (session) => {
                    onCloseCalled = true;
                    expect(session).to.be.an('object');
                    expect(session.id).to.be.a('string');
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', () => {
                    // Immediately destroy the connection after receiving data (abrupt close)
                    client.destroy();
                });

                client.on('close', () => {
                    if (!finished) {
                        finished = true;
                        setTimeout(() => {
                            expect(onConnectCalled).to.be.true;
                            expect(onCloseCalled).to.be.true;
                            expect(sessionData).to.not.be.null;
                            return done();
                        }, 100);
                    }
                });

                client.on('error', () => {
                    // Connection error is expected due to abrupt close
                });
            });
        });

        it('should work with async onConnect handler', done => {
            let onConnectCalled = false;
            let finished = false;

            server = new IMAPServer({
                onConnect: async (session, callback) => {
                    onConnectCalled = true;
                    // Simulate async operation (e.g., Redis call)
                    await new Promise(resolve => setTimeout(resolve, 10));
                    expect(session).to.be.an('object');
                    expect(session.remoteAddress).to.be.a('string');
                    expect(session.id).to.be.a('string');
                    return callback();
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    if (finished) return;
                    finished = true;

                    let response = data.toString();
                    expect(response).to.include('* OK');
                    expect(onConnectCalled).to.be.true;
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

    describe('onClose Handler', () => {
        it('should call onClose handler when connection is closed', done => {
            let onCloseCalled = false;
            let finished = false;

            server = new IMAPServer({
                onClose: (session) => {
                    onCloseCalled = true;
                    expect(session).to.be.an('object');
                    expect(session.id).to.be.a('string');
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', () => {
                    client.end();
                });

                client.on('close', () => {
                    if (!finished) {
                        finished = true;
                        setTimeout(() => {
                            expect(onCloseCalled).to.be.true;
                            return done();
                        }, 100);
                    }
                });

                client.on('error', err => {
                    if (!finished) {
                        finished = true;
                        return done(err);
                    }
                });
            });
        });

        it('should work without onClose handler (backward compatibility)', done => {
            let finished = false;

            server = new IMAPServer({});

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', () => {
                    client.end();
                });

                client.on('close', () => {
                    if (!finished) {
                        finished = true;
                        return done();
                    }
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
});

