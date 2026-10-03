/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const { ImapFlow } = require('imapflow');
const tls = require('tls');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// has to be larger than consts.BULK_BATCH_SIZE so that the journal is written in several batches
const MESSAGE_COUNT = 400;
const PASSWORD = 'secretpass';

describe('IMAP cross session notifications', function () {
    this.timeout(120000); // eslint-disable-line no-invalid-this

    let userId;
    let username;
    let inboxId;
    let trashPath;

    const connect = async () => {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: config.imap.port,
            secure: true,
            auth: { user: username, pass: PASSWORD },
            tls: { rejectUnauthorized: false },
            logger: false
        });
        await client.connect();
        return client;
    };

    // driven over a raw socket so the session sits in an explicit IDLE command for the whole test
    const rawConnect = async () => {
        const socket = tls.connect({ host: '127.0.0.1', port: config.imap.port, rejectUnauthorized: false });
        let buffer = '';

        socket.on('data', chunk => {
            buffer += chunk.toString('binary');
        });

        // keeps a socket error from throwing between waits
        socket.on('error', () => false);

        const waitFor = pattern =>
            new Promise((resolve, reject) => {
                let timer;

                const settle = (err, value) => {
                    clearTimeout(timer);
                    socket.removeListener('data', onData);
                    socket.removeListener('error', settle);
                    return err ? reject(err) : resolve(value);
                };

                function onData() {
                    if (pattern.test(buffer)) {
                        settle(null, buffer);
                    }
                }

                timer = setTimeout(() => settle(new Error('Timed out waiting for ' + pattern)), 15000);

                // the listener that fills the buffer is registered first, so it has already run
                socket.on('data', onData);
                socket.on('error', settle);
                onData();
            });

        await new Promise((resolve, reject) => {
            socket.once('secureConnect', resolve);
            socket.once('error', reject);
        });
        await waitFor(/^\* OK /m);

        return {
            waitFor,
            exec: (command, pattern) => {
                buffer = '';
                socket.write(command + '\r\n');
                return waitFor(pattern);
            },
            close: () => socket.destroy()
        };
    };

    // the journal is written in batches, so the notifications arrive over several rounds
    const collect = async (client, count, read) => {
        const deadline = Date.now() + 60000;
        while (read() < count && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 300));
            await client.noop();
        }
        return read();
    };

    before(async () => {
        username = 'notifyuser' + Date.now();

        const userResponse = await server
            .post('/users')
            .send({
                username,
                password: PASSWORD,
                address: `${username}@example.com`,
                name: 'Notify User'
            })
            .expect(200);
        expect(userResponse.body.success).to.be.true;
        userId = userResponse.body.id;

        const mailboxResponse = await server.get(`/users/${userId}/mailboxes`).expect(200);
        inboxId = mailboxResponse.body.results.find(mailbox => mailbox.path === 'INBOX').id;
        trashPath = mailboxResponse.body.results.find(mailbox => mailbox.specialUse === '\\Trash').path;

        let pending = Array.from({ length: MESSAGE_COUNT }, (_, i) => i);
        const upload = async () => {
            while (pending.length) {
                let i = pending.shift();
                await server
                    .post(`/users/${userId}/mailboxes/${inboxId}/messages`)
                    .set('Content-Type', 'message/rfc822')
                    .send(`From: sender@example.com\r\nTo: receiver@example.com\r\nSubject: msg ${i}\r\n\r\nbody ${i}\r\n`)
                    .expect(200);
            }
        };
        await Promise.all(Array.from({ length: 25 }, upload));
    });

    after(async () => {
        if (userId) {
            await server.delete(`/users/${userId}`).expect(200);
        }
    });

    it('should deliver every flag update of a bulk STORE to another session', async () => {
        // RFC 3501 5.2: a server SHOULD send message flag updates automatically
        const watcher = await connect();
        const storer = await connect();

        try {
            let flagged = 0;
            watcher.on('flags', () => flagged++);

            const watched = await watcher.mailboxOpen('INBOX');
            expect(watched.exists).to.equal(MESSAGE_COUNT);

            await storer.mailboxOpen('INBOX');
            await storer.messageFlagsAdd('1:*', ['\\Flagged'], { uid: true });

            expect(await collect(watcher, MESSAGE_COUNT, () => flagged)).to.equal(MESSAGE_COUNT);
        } finally {
            await watcher.logout();
            await storer.logout();
        }
    });
    it('should deliver every EXPUNGE of a bulk MOVE to another session', async () => {
        // RFC 3501 5.2: a server MUST send mailbox size updates when a change is observed
        const watcher = await connect();
        const mover = await connect();

        try {
            let expunged = 0;
            watcher.on('expunge', () => expunged++);

            const watched = await watcher.mailboxOpen('INBOX');
            expect(watched.exists).to.equal(MESSAGE_COUNT);

            await mover.mailboxOpen('INBOX');
            await mover.messageMove('1:*', trashPath, { uid: true });

            expect(await collect(watcher, MESSAGE_COUNT, () => expunged)).to.equal(MESSAGE_COUNT);
            expect(watcher.mailbox.exists).to.equal(0);
        } finally {
            await watcher.logout();
            await mover.logout();
        }
    });

    it('should push EXISTS to a session that is idling', async () => {
        // RFC 2177: the point of IDLE is that the server may send updates at any time while the
        // command runs, without waiting for the client to poll
        const idler = await rawConnect();

        try {
            await idler.exec('A1 LOGIN ' + username + ' ' + PASSWORD, /^A1 OK/m);

            // the earlier tests in this file change how many messages INBOX holds
            const selected = await idler.exec('A2 SELECT INBOX', /^A2 OK/m);
            const existing = Number(/^\* (\d+) EXISTS$/m.exec(selected)[1]);

            await idler.exec('A3 IDLE', /^\+ /m);

            // nothing is sent from this connection while the message is uploaded over the API
            await server
                .post(`/users/${userId}/mailboxes/${inboxId}/messages`)
                .set('Content-Type', 'message/rfc822')
                .send('From: sender@example.com\r\nTo: receiver@example.com\r\nSubject: pushed\r\n\r\npushed\r\n')
                .expect(200);

            await idler.waitFor(new RegExp('^\\* ' + (existing + 1) + ' EXISTS$', 'm'));

            await idler.exec('DONE', /^A3 OK/m);
        } finally {
            idler.close();
        }
    });
});
