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

    function parseChunks(maxLineLength, chunks) {
        return new Promise((resolve, reject) => {
            const parser = new IMAPStream({ maxLineLength });
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
        const { commands } = await parseChunks(16384, ['A1 ' + 'X'.repeat(16382) + '\r\n']);

        expect(commands).to.deep.equal([
            {
                lineTooLong: true,
                final: true,
                tag: 'A1'
            }
        ]);
    });

    it('should stop retaining data after an incomplete line exceeds the limit', async function () {
        const { parser, commands } = await parseChunks(8, ['A1 ' + 'X'.repeat(100)]);

        expect(parser._remainder).to.equal('');
        expect(parser._discarding).to.be.true;
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
                    expect(connection._closing || connection._closed).to.be.false;
                    expect(mockSocket.destroyed).to.be.false;
                    done();
                }, 20);
            });
        });
    });
});
