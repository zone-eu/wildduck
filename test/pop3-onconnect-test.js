'use strict';

/* eslint-disable no-unused-expressions */

const chai = require('chai');
const expect = chai.expect;
const POP3Server = require('../lib/pop3/server');
const net = require('net');

chai.config.includeStack = true;

const TEST_PORT = 0; // Use port 0 to let OS assign available port

describe('POP3 onConnect Handler Tests', () => {
    let server;
    let port;

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

            server = new POP3Server({
                onConnect: (session, callback) => {
                    onConnectCalled = true;
                    sessionData = session;
                    expect(session).to.be.an('object');
                    expect(session.remoteAddress).to.be.a('string');
                    expect(session.id).to.be.a('string');
                    expect(session.state).to.equal('AUTHORIZATION');
                    return callback();
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('+OK');
                    expect(onConnectCalled).to.be.true;
                    expect(sessionData).to.not.be.null;
                    client.end();
                    return done();
                });

                client.on('error', done);
            });
        });

        it('should reject connection when onConnect handler returns error', done => {
            let onConnectCalled = false;
            let finished = false;

            server = new POP3Server({
                onConnect: (session, callback) => {
                    onConnectCalled = true;
                    return callback(new Error('Connection rejected'));
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('-ERR');
                    expect(onConnectCalled).to.be.true;
                    client.end();
                });

                client.on('close', () => {
                    if (!finished) {
                        finished = true;
                        return done();
                    }
                });

                client.on('error', () => {
                    if (!finished) {
                        finished = true;
                        return done();
                    }
                });
            });
        });

        it('should allow connection filtering by IP address', done => {
            let onConnectCalled = false;
            let finished = false;

            server = new POP3Server({
                onConnect: (session, callback) => {
                    onConnectCalled = true;
                    if (session.remoteAddress === '127.0.0.1') {
                        return callback(new Error('IP blocked'));
                    }
                    return callback();
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('-ERR');
                    expect(onConnectCalled).to.be.true;
                    client.end();
                });

                client.on('close', () => {
                    if (!finished) {
                        finished = true;
                        return done();
                    }
                });

                client.on('error', () => {
                    if (!finished) {
                        finished = true;
                        return done();
                    }
                });
            });
        });

        it('should work without onConnect handler (backward compatibility)', done => {
            server = new POP3Server({});

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('+OK');
                    client.end();
                    return done();
                });

                client.on('error', done);
            });
        });

        it('should handle rate limiting in onConnect', done => {
            let connectionCount = 0;
            let finished = false;

            server = new POP3Server({
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
                // First connection should succeed
                let client1 = net.connect(port, '127.0.0.1');

                client1.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('+OK');
                    client1.end();

                    // Second connection should succeed
                    let client2 = net.connect(port, '127.0.0.1');

                    client2.on('data', data2 => {
                        let response2 = data2.toString();
                        expect(response2).to.include('+OK');
                        client2.end();

                        // Third connection should be rejected
                        let client3 = net.connect(port, '127.0.0.1');

                        client3.on('data', data3 => {
                            let response3 = data3.toString();
                            expect(response3).to.include('-ERR');
                            client3.end();
                        });

                        client3.on('close', () => {
                            if (!finished) {
                                finished = true;
                                return done();
                            }
                        });

                        client3.on('error', () => {
                            if (!finished) {
                                finished = true;
                                return done();
                            }
                        });
                    });

                    client2.on('error', done);
                });

                client1.on('error', done);
            });
        });

        it('should handle abrupt connection close properly', done => {
            let onConnectCalled = false;
            let onCloseCalled = false;
            let sessionData = null;
            let finished = false;

            server = new POP3Server({
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

            server = new POP3Server({
                onConnect: async (session, callback) => {
                    onConnectCalled = true;
                    // Simulate async operation (e.g., Redis call)
                    await new Promise(resolve => setTimeout(resolve, 10));
                    expect(session).to.be.an('object');
                    expect(session.remoteAddress).to.be.a('string');
                    expect(session.id).to.be.a('string');
                    expect(session.state).to.equal('AUTHORIZATION');
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
                    expect(response).to.include('+OK');
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
            let sessionData = null;

            server = new POP3Server({
                onClose: session => {
                    onCloseCalled = true;
                    sessionData = session;
                    expect(session).to.be.an('object');
                    expect(session.remoteAddress).to.be.a('string');
                    expect(session.id).to.be.a('string');
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('+OK');
                    client.end();
                });

                client.on('close', () => {
                    // Give some time for onClose to be called
                    setTimeout(() => {
                        expect(onCloseCalled).to.be.true;
                        expect(sessionData).to.not.be.null;
                        return done();
                    }, 100);
                });

                client.on('error', done);
            });
        });

        it('should handle onClose without errors', done => {
            let onCloseCalled = false;

            server = new POP3Server({
                onClose: session => {
                    onCloseCalled = true;
                    expect(session).to.be.an('object');
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('+OK');
                    client.end();
                });

                client.on('close', () => {
                    setTimeout(() => {
                        expect(onCloseCalled).to.be.true;
                        return done();
                    }, 100);
                });

                client.on('error', done);
            });
        });

        it('should work without onClose handler (backward compatibility)', done => {
            server = new POP3Server({});

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('+OK');
                    client.end();
                });

                client.on('close', () => done());

                client.on('error', done);
            });
        });

        it('should call onClose for both successful and failed connections', done => {
            let onCloseCallCount = 0;
            let finished = false;

            server = new POP3Server({
                onConnect: (session, callback) => {
                    if (session.remoteAddress === '127.0.0.1') {
                        return callback(new Error('Connection rejected'));
                    }
                    return callback();
                },
                onClose: session => {
                    onCloseCallCount++;
                    expect(session).to.be.an('object');

                    if (onCloseCallCount === 1 && !finished) {
                        finished = true;
                        return done();
                    }
                }
            });

            server.listen(TEST_PORT, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');

                client.on('data', data => {
                    let response = data.toString();
                    expect(response).to.include('-ERR');
                    client.end();
                });

                client.on('error', () => {
                    // Connection error is expected
                });
            });
        });
    });
});

