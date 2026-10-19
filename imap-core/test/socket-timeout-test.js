/* eslint-env mocha */
/* eslint-disable no-unused-expressions, prefer-arrow-callback */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const Duplex = require('stream').Duplex;
const { IMAPConnection } = require('../lib/imap-connection');

chai.config.includeStack = true;

// RFC 3501 5.4: an inactivity autologout timer must be at least 30 minutes
const MIN_AUTOLOGOUT = 30 * 60 * 1000;

class TimeoutSocket extends Duplex {
    constructor() {
        super();
        this.remoteAddress = '127.0.0.1';
        this.readyState = 'open';
        this.timeouts = [];
    }

    _read() {}

    _write(chunk, encoding, callback) {
        callback();
    }

    setTimeout(ms) {
        this.timeouts.push(ms);
    }
}

function createConnection(options) {
    const socket = new TimeoutSocket();
    const server = {
        logger: { debug: () => {}, info: () => {}, error: () => {} },
        options: options || {},
        connections: new Set(),
        notifier: {}
    };

    const connection = new IMAPConnection(server, socket, {});
    connection._setListeners();

    return { connection, socket };
}

describe('IMAP inactivity timeout', function () {
    it('should not disconnect an authenticated idle client before the RFC minimum', function () {
        const { connection, socket } = createConnection();

        connection.setUser({ id: 'user', username: 'user' });

        expect(socket.timeouts).to.have.length(2);
        expect(socket.timeouts[1]).to.be.at.least(MIN_AUTOLOGOUT);
    });

    it('should use the configured socket timeout for an authenticated client', function () {
        const { connection, socket } = createConnection({ socketTimeout: 45 * 60 * 1000 });

        connection.setUser({ id: 'user', username: 'user' });

        expect(socket.timeouts[1]).to.equal(45 * 60 * 1000);
    });

    it('should keep a shorter timeout before authentication', function () {
        // RFC 9051 5.4 allows a shortened pre-authentication timer
        const { socket } = createConnection();

        expect(socket.timeouts).to.deep.equal([5 * 60 * 1000 + 37 * 1000]);
    });

    it('should use the configured pre authentication timeout', function () {
        const { socket } = createConnection({ preAuthSocketTimeout: 60 * 1000 });

        expect(socket.timeouts).to.deep.equal([60 * 1000]);
    });
});
