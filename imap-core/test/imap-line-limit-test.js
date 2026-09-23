/* eslint-env mocha */
/* eslint-disable no-invalid-this, prefer-arrow-callback, no-unused-expressions */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const EventEmitter = require('events');
const { IMAPConnection } = require('../lib/imap-connection');
const { IMAPStream } = require('../lib/imap-stream');

chai.config.includeStack = true;

describe('IMAP line length limits', function () {
    this.timeout(10000);

    function parseChunks(maxLineLength, chunks, onLineTooLong) {
        return new Promise((resolve, reject) => {
            const parser = new IMAPStream({ maxLineLength, onLineTooLong });
            const commands = [];

            parser.oncommand = (command, callback) => {
                commands.push(command);
                callback();
            };

            let index = 0;
            const writeNext = err => {
                if (err) {
                    return reject(err);
                }
                if (index >= chunks.length) {
                    return resolve({ parser, commands });
                }
                parser.write(Buffer.from(chunks[index++], 'binary'), writeNext);
            };
            writeNext();
        });
    }

    it('should accept a line exactly at the configured limit', async function () {
        const { commands } = await parseChunks(16384, ['A1 ' + 'X'.repeat(16381) + '\r\n']);

        expect(commands).to.deep.equal([
            {
                value: 'A1 ' + 'X'.repeat(16381),
                final: true
            }
        ]);
    });

    it('should reject an oversized line received in one chunk', async function () {
        const oversizedLine = 'A1 ' + 'X'.repeat(16382);
        const reported = [];
        const { commands } = await parseChunks(16384, [oversizedLine + '\r\n'], value => reported.push(value));

        expect(reported).to.deep.equal([oversizedLine]);
        expect(commands).to.deep.equal([
            {
                lineTooLong: true,
                final: true,
                tag: 'A1'
            }
        ]);
    });

    it('should stop retaining data after an incomplete line exceeds the limit', async function () {
        const partialLine = 'A1 ' + 'X'.repeat(100);
        const reported = [];
        const { parser, commands } = await parseChunks(8, [partialLine], value => reported.push(value));

        expect(parser._remainder).to.equal('');
        expect(parser._discarding).to.be.true;
        expect(reported).to.deep.equal([partialLine]);
        expect(commands).to.deep.equal([]);

        await new Promise((resolve, reject) => {
            parser.write(Buffer.from('\r\n', 'binary'), err => (err ? reject(err) : resolve()));
        });
        expect(commands).to.deep.equal([
            {
                lineTooLong: true,
                final: true,
                tag: 'A1'
            }
        ]);
    });

    it('should allow unlimited lines when the limit is disabled', async function () {
        const line = 'A1 ' + 'X'.repeat(20000);
        const { commands } = await parseChunks(0, [line + '\r\n']);

        expect(commands).to.deep.equal([
            {
                value: line,
                final: true
            }
        ]);
    });

    it('should reject an oversized command line and continue with the next command', function (done) {
        const sent = [];
        const logs = [];
        const consoleLogs = [];
        const mockServer = {
            logger: {
                debug: () => {},
                info: () => {},
                error: (...args) => consoleLogs.push(args)
            },
            options: {
                maxLineLength: 8000,
                socketTimeout: 30000
            },
            loggelf: entry => logs.push(entry),
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
                    expect(sent).to.include('A1 BAD Command line too long\r\n');
                    expect(sent).to.include('A2 OK Nothing done\r\n');
                    expect(logs[0]).to.include({
                        short_message: '[IMAPCMDERR] Command line too long',
                        _code: 'CommandLineTooLong',
                        _response: 'BAD',
                        _tag: 'A1',
                        _max_line_length: 8000
                    });
                    expect(consoleLogs).to.have.length(1);
                    expect(consoleLogs[0][1]).to.equal('[%s] Command line too long, C: %s');
                    expect(consoleLogs[0][3]).to.equal('A1 ' + 'X'.repeat(9000));
                    expect(connection._closing || connection._closed).to.be.false;
                    expect(mockSocket.destroyed).to.be.false;
                    done();
                }, 20);
            });
        });
    });

    it('should log accepted command lines larger than 64 kB to GELF without an error', function (done) {
        const logs = [];
        const mockServer = {
            logger: {
                debug: () => {},
                info: () => {},
                error: () => {}
            },
            options: {
                maxLineLength: 128 * 1024,
                socketTimeout: 30000
            },
            loggelf: entry => logs.push(entry),
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
                if (typeof callback === 'function') {
                    return callback();
                }
                return true;
            }

            setTimeout() {}
        }

        const mockSocket = new MockSocket();
        const connection = new IMAPConnection(mockServer, mockSocket, {});
        const command = 'A1 NOOP ' + 'X'.repeat(64 * 1024);

        connection._parser.write(Buffer.from(command + '\r\n', 'binary'), err => {
            expect(err).to.not.exist;

            setTimeout(() => {
                expect(logs[0]).to.deep.include({
                    short_message: '[IMAPCMD] Command larger than 64 kB',
                    _service: 'imap',
                    _command: 'NOOP',
                    _tag: 'A1',
                    _payload: command,
                    _command_length: command.length
                });
                expect(logs[0]).to.not.have.any.keys('_failure_msg', '_code', '_response');
                done();
            }, 20);
        });
    });
});
