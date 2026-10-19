/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

// A client that goes away stops a pipe without ending it. These check that every link between the socket and
// the storage stream passes the teardown on, so an abandoned download releases its storage read.

const { expect } = require('chai');
const { PassThrough, Readable } = require('stream');
const { IMAPComposer } = require('../imap-core/lib/imap-composer');
const compileStream = require('../imap-core/lib/handler/imap-compile-stream');

function endless() {
    // a storage stream that would go on for a long time
    return new Readable({
        read() {
            // one chunk per turn of the event loop, like data arriving from the network
            setImmediate(() => this.push(Buffer.alloc(16 * 1024, 120)));
        }
    });
}

function tick(ms = 20) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Attachment stream teardown', function () {
    it('destroys a literal stream when the IMAP socket closes while it is being sent', async function () {
        let socket = new PassThrough({ highWaterMark: 1024 });
        let composer = new IMAPComposer({ connection: { _socket: socket, logger: { debug() {} }, id: 'test' }, skipFetchLog: true });
        let literal = endless();
        let written = false;
        composer.write(literal, () => {
            written = true;
        });
        await tick();
        socket.destroy();
        await tick();
        expect(literal.destroyed).to.be.true;
        // the composer moves on instead of waiting for the end of the literal forever
        expect(written).to.be.true;
    });

    it('does not start sending a literal to a socket that is already closed', async function () {
        let socket = new PassThrough();
        socket.destroy();
        let composer = new IMAPComposer({ connection: { _socket: socket, logger: { debug() {} }, id: 'test' }, skipFetchLog: true });
        let literal = endless();
        await new Promise(resolve => composer.write(literal, resolve));
        expect(literal.destroyed).to.be.true;
    });

    it('destroys the message stream of a FETCH response when the response is destroyed', async function () {
        let source = endless();
        source.isLimited = false;
        let response = compileStream({
            tag: '*',
            command: 'FETCH',
            attributes: [
                { type: 'ATOM', value: '1' },
                [
                    { type: 'ATOM', value: 'BODY[]' },
                    { type: 'LITERAL', value: source, expectedLength: 10 * 1024 * 1024 }
                ]
            ]
        });
        let errors = [];
        response.on('error', err => errors.push(err));
        response.resume();
        await tick();
        response.destroy();
        await tick();
        expect(source.destroyed).to.be.true;
        expect(errors).to.deep.equal([]);
    });
});
