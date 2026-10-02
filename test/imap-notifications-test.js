/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const { ImapFlow } = require('imapflow');

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

            for (let i = 0; i < 10 && flagged < MESSAGE_COUNT; i++) {
                await new Promise(resolve => setTimeout(resolve, 300));
                await watcher.noop();
            }

            expect(flagged).to.equal(MESSAGE_COUNT);
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

            // the journal is written in batches, give the watcher time to collect all of them
            for (let i = 0; i < 10 && expunged < MESSAGE_COUNT; i++) {
                await new Promise(resolve => setTimeout(resolve, 300));
                await watcher.noop();
            }

            expect(expunged).to.equal(MESSAGE_COUNT);
            expect(watcher.mailbox.exists).to.equal(0);
        } finally {
            await watcher.logout();
            await mover.logout();
        }
    });
});
