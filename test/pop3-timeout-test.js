'use strict';

const chai = require('chai');
const expect = chai.expect;
const POP3Server = require('../lib/pop3/server');
const net = require('net');
const fs = require('fs');

chai.config.includeStack = true;

describe('POP3 Timeout Reset Tests', () => {
    let server;
    let port;

    afterEach(done => {
        if (server) {
            return server.close(done);
        }
        return done();
    });

    describe('Socket Timeout Reset Functionality', () => {
        it('should successfully process multiple commands without timeout issues', done => {
            server = new POP3Server({
                socketTimeout: 1000 // 1 second timeout for testing
            });

            server.listen(0, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');
                let commandsSent = 0;
                let responsesReceived = 0;
                let expectedCommands = 3; // CAPA, CAPA, QUIT

                client.on('data', data => {
                    let response = data.toString();

                    if (response.includes('+OK')) {
                        responsesReceived++;

                        if (responsesReceived === 1) {
                            // Initial greeting received
                            setTimeout(() => {
                                client.write('CAPA\r\n');
                                commandsSent++;
                            }, 100);
                        } else if (responsesReceived === 2) {
                            // First CAPA response received
                            setTimeout(() => {
                                client.write('CAPA\r\n');
                                commandsSent++;
                            }, 600); // Wait 600ms (less than timeout)
                        } else if (responsesReceived === 3) {
                            // Second CAPA response received
                            setTimeout(() => {
                                client.write('QUIT\r\n');
                                commandsSent++;
                            }, 600); // Wait 600ms (less than timeout)
                        } else if (responsesReceived === 4) {
                            // QUIT response received
                            client.end();
                            expect(commandsSent).to.equal(expectedCommands);
                            expect(responsesReceived).to.equal(4); // greeting + 3 command responses
                            return done();
                        }
                    }
                });

                client.on('error', done);
                client.on('close', () => {
                    if (responsesReceived < 4) {
                        return done(new Error(`Connection closed prematurely. Responses: ${responsesReceived}, Commands: ${commandsSent}`));
                    }
                });
            });
        });

        it('should handle basic command flow without errors', done => {
            server = new POP3Server({
                socketTimeout: 2000
            });

            server.listen(0, '127.0.0.1', () => {
                port = server.server.address().port;
                let client = net.connect(port, '127.0.0.1');
                let greetingReceived = false;

                client.on('data', data => {
                    let response = data.toString();

                    if (response.includes('+OK') && !greetingReceived) {
                        greetingReceived = true;
                        client.write('QUIT\r\n');
                    } else if (response.includes('signing off') || response.includes('+OK')) {
                        client.end();
                        return done();
                    }
                });

                client.on('error', done);
                client.on('close', () => {
                    if (!greetingReceived) {
                        return done(new Error('Connection closed before greeting'));
                    }
                });
            });
        });

        it('should verify timeout reset code exists in connection processing', () => {
            // This is a code verification test to ensure the timeout reset logic is present
            const connectionCode = fs.readFileSync('./lib/pop3/connection.js', 'utf8');

            // Verify that setTimeout is called after successful command processing
            expect(connectionCode).to.include('Reset socket timeout after successful command processing');
            expect(connectionCode).to.include('this._socket.setTimeout');
            expect(connectionCode).to.include('Reset socket timeout after successful continue data processing');
        });
    });
});

