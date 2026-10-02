/* eslint-env mocha */
/* eslint-disable no-invalid-this, prefer-arrow-callback, no-unused-expressions */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const { IMAPStream } = require('../lib/imap-stream');

chai.config.includeStack = true;

describe('IMAP stream pipelining', function () {
    this.timeout(10000);

    it('should avoid recursive command processing for pipelined synchronous commands', function (done) {
        const parser = new IMAPStream();
        const commandCount = 2048;
        const payload = Array.from({ length: commandCount }, (_, i) => `A${i + 1} NOOP\r\n`).join('');

        let seen = 0;
        let activeHandlers = 0;
        let maxActiveHandlers = 0;

        parser.oncommand = (command, callback) => {
            activeHandlers++;
            maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
            seen++;

            expect(command.final).to.be.true;
            expect(command.value).to.match(/^A\d+ NOOP$/);

            activeHandlers--;
            return callback();
        };

        parser.write(Buffer.from(payload, 'binary'), err => {
            if (err) {
                return done(err);
            }

            expect(seen).to.equal(commandCount);
            expect(maxActiveHandlers).to.equal(1);
            done();
        });
    });

    // emulates what imap-command.js does with the parts the stream emits
    const collectParts = parser => {
        const seen = [];

        parser.oncommand = (command, callback) => {
            if (command.final) {
                seen.push({ type: 'final', value: command.value });
                return callback();
            }

            if (Number(command.expecting) === 0) {
                seen.push({ type: 'empty-literal', value: command.value });
                command.readyCallback();
                return callback();
            }

            let chunks = [];
            command.literal.on('data', chunk => chunks.push(chunk));
            command.literal.on('end', () => {
                seen.push({ type: 'literal', value: Buffer.concat(chunks).toString('binary') });
                command.readyCallback();
            });
            seen.push({ type: 'start-literal', value: command.value });
            callback();
        };

        return seen;
    };

    it('should hand over a literal before the rest of the command', function (done) {
        const parser = new IMAPStream();
        const seen = collectParts(parser);

        parser.write(Buffer.from('A1 ID ({4}\r\nname "x")\r\n', 'binary'), err => {
            if (err) {
                return done(err);
            }

            expect(seen).to.deep.equal([
                { type: 'start-literal', value: 'A1 ID ({4}' },
                { type: 'literal', value: 'name' },
                { type: 'final', value: ' "x")' }
            ]);
            done();
        });
    });

    it('should not leak the ready state of a zero length literal into the next command', function (done) {
        const parser = new IMAPStream();
        const seen = collectParts(parser);

        // RFC 3501 4.3: {0} is a legal literal and must not change how later commands are processed
        parser.write(Buffer.from('A0 ID ({0}\r\n "x")\r\nA1 ID ({4}\r\nname "x")\r\n', 'binary'), err => {
            if (err) {
                return done(err);
            }

            expect(seen).to.deep.equal([
                { type: 'empty-literal', value: 'A0 ID ({0}' },
                { type: 'final', value: ' "x")' },
                { type: 'start-literal', value: 'A1 ID ({4}' },
                { type: 'literal', value: 'name' },
                { type: 'final', value: ' "x")' }
            ]);
            done();
        });
    });

    it('should surface negative literal sizes to the command handler', function (done) {
        const parser = new IMAPStream();
        let seen = false;

        parser.oncommand = (command, callback) => {
            seen = true;
            expect(command.final).to.be.false;
            expect(command.value).to.equal('A1 APPEND INBOX {-1}');
            expect(command.expecting).to.equal(-1);
            expect(command.literal).to.exist;
            expect(command.readyCallback).to.be.a('function');
            callback();
        };

        parser.write(Buffer.from('A1 APPEND INBOX {-1}\r\n', 'binary'), err => {
            if (err) {
                return done(err);
            }

            expect(seen).to.be.true;
            done();
        });
    });
});
