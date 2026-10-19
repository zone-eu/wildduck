/* eslint-env mocha */
/* eslint-disable no-unused-expressions, prefer-arrow-callback */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const Duplex = require('stream').Duplex;
const { IMAPConnection } = require('../lib/imap-connection');

chai.config.includeStack = true;

class MockSocket extends Duplex {
    constructor() {
        super();
        this.remoteAddress = '127.0.0.1';
        this.readyState = 'open';
    }

    _read() {}

    _write(chunk, encoding, callback) {
        callback();
    }

    setTimeout() {}
}

function createConnection(uidList) {
    const server = {
        logger: { debug: () => {}, info: () => {}, error: () => {} },
        options: {},
        connections: new Set(),
        notifier: {}
    };

    const connection = new IMAPConnection(server, new MockSocket(), {});
    connection.state = 'Selected';
    connection.selected = connection.session.selected = {
        mailbox: 'mailbox',
        uidList: [].concat(uidList || [])
    };

    return connection;
}

describe('IMAPConnection formatResponse', function () {
    it('should add a new uid and report its sequence number', function () {
        const connection = createConnection([1, 2, 3]);

        const response = connection.formatResponse('EXISTS', 4);

        expect(response.command).to.equal('4');
        expect(connection.selected.uidList).to.deep.equal([1, 2, 3, 4]);
    });

    it('should ignore an EXISTS for a uid that is already known', function () {
        // a duplicate entry would shift the sequence number of every later message
        const connection = createConnection([1, 2, 3]);

        expect(connection.formatResponse('EXISTS', 3)).to.be.false;
        expect(connection.formatResponse('EXISTS', 2)).to.be.false;
        expect(connection.selected.uidList).to.deep.equal([1, 2, 3]);
    });

    it('should still report EXPUNGE and FETCH for known uids', function () {
        const connection = createConnection([1, 2, 3]);

        expect(connection.formatResponse('FETCH', 2).command).to.equal('2');
        expect(connection.formatResponse('EXPUNGE', 2).command).to.equal('2');
        expect(connection.selected.uidList).to.deep.equal([1, 3]);
        expect(connection.formatResponse('EXPUNGE', 99)).to.be.false;
    });

    it('should leave out a stored flag that can not be compiled as an atom', function () {
        // RFC 3501 9: flag-keyword = atom. A keyword stored before STORE and APPEND validated
        // keywords could only go out as a quoted string, which is not a flag at all
        const connection = createConnection([1, 2, 3]);

        const response = connection.formatResponse('FETCH', 2, {
            query: [{ item: 'flags', original: { type: 'ATOM', value: 'FLAGS' } }],
            values: [['\\Seen', 'a]b', 'a b', 'töö', 'Junk']]
        });

        expect(response.attributes[1][1]).to.deep.equal([
            { type: 'ATOM', value: '\\Seen' },
            { type: 'ATOM', value: 'töö' },
            { type: 'ATOM', value: 'Junk' }
        ]);
    });

    it('should leave out an unemittable flag from a notification too', function () {
        // the unsolicited * n FETCH (FLAGS ...) sent to the other sessions on the mailbox
        const connection = createConnection([1, 2, 3]);

        const response = connection.formatResponse('FETCH', 2, { flags: ['\\Seen', 'a]b', 'Junk'] });

        expect(response.attributes[1][1]).to.deep.equal([
            { type: 'ATOM', value: '\\Seen' },
            { type: 'ATOM', value: 'Junk' }
        ]);
    });

    it('should keep every modseq value', function () {
        const connection = createConnection([1, 2, 3]);

        const response = connection.formatResponse('FETCH', 2, {
            query: [{ item: 'modseq', original: { type: 'ATOM', value: 'MODSEQ' } }],
            values: [[7]]
        });

        expect(response.attributes[1][1]).to.deep.equal([{ type: 'ATOM', value: '7' }]);
    });
});
