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
});
