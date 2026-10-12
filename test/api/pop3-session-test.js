/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const tls = require('tls');
const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// Minimal POP3 client for the test server: one command at a time, multiline
// replies end with a lone dot
const connectPop3 = () =>
    new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port: config.pop3.port, rejectUnauthorized: false });
        let buffer = '';
        const waiters = [];

        const settle = () => {
            while (waiters.length) {
                const { multiline, resolveReply } = waiters[0];
                const isError = buffer.startsWith('-ERR');
                const end = multiline && !isError ? buffer.indexOf('\r\n.\r\n') : buffer.indexOf('\r\n');
                if (end < 0) {
                    return;
                }
                const reply = buffer.slice(0, end);
                buffer = buffer.slice(end + (multiline && !isError ? 5 : 2));
                waiters.shift();
                resolveReply(reply);
            }
        };

        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            buffer += chunk;
            settle();
        });
        socket.on('error', reject);

        const read = multiline => new Promise(resolveReply => waiters.push({ multiline, resolveReply }));
        const command = (line, multiline = false) => {
            const reply = read(multiline);
            socket.write(line + '\r\n');
            return reply;
        };

        socket.once('secureConnect', async () => {
            const greeting = await read(false);
            resolve({ greeting, command, close: () => socket.end() });
        });
    });

// the POP3 server applies the session updates after QUIT, poll for them
const waitFor = async (check, timeout = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await check()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
};

describe('POP3 session', function () {
    this.timeout(15000); // eslint-disable-line no-invalid-this

    const runId = Date.now().toString(36);
    const username = `pop3user-${runId}`;
    const password = 'pop3secretpassword';

    let user;
    let inbox;
    let trash;

    const listMessages = async mailbox => {
        const response = await server.get(`/users/${user}/mailboxes/${mailbox}/messages`).expect(200);
        return response.body.results.map(message => ({ subject: message.subject, seen: message.seen }));
    };

    before(async () => {
        const userResponse = await server
            .post('/users')
            .send({
                username,
                password,
                address: `${username}@web.zone.test`,
                name: 'pop3 user'
            })
            .expect(200);
        expect(userResponse.body.success).to.be.true;
        user = userResponse.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxesResponse.body.results.find(entry => entry.path === 'INBOX').id;
        trash = mailboxesResponse.body.results.find(entry => entry.specialUse === '\\Trash').id;

        for (let i = 1; i <= 3; i++) {
            await server
                .post(`/users/${user}/mailboxes/${inbox}/messages`)
                .send({
                    unseen: true,
                    from: { address: 'pop3-sender@example.com' },
                    to: [{ address: `${username}@web.zone.test` }],
                    subject: `POP3 message ${i}`,
                    text: `Body ${i}`
                })
                .expect(200);
        }
    });

    after(async () => {
        if (user) {
            await server.delete(`/users/${user}`).expect(200);
        }
    });

    it('should refuse a wrong password', async () => {
        const session = await connectPop3();
        expect(session.greeting).to.match(/^\+OK/);
        expect(await session.command(`USER ${username}`)).to.match(/^\+OK/);
        expect(await session.command('PASS wrongpassword')).to.match(/^-ERR/);
        session.close();
    });

    it('should list, retrieve and delete messages', async () => {
        const session = await connectPop3();
        expect(await session.command(`USER ${username}`)).to.match(/^\+OK/);
        expect(await session.command(`PASS ${password}`)).to.match(/^\+OK maildrop has 3 messages/);
        expect(await session.command('STAT')).to.match(/^\+OK 3 \d+$/);

        const list = await session.command('LIST', true);
        expect(list.split('\r\n')).to.have.length(4);

        // the oldest message is listed first
        const retrieved = await session.command('RETR 1', true);
        expect(retrieved).to.include('Subject: POP3 message 1');
        expect(retrieved).to.include('Body 1');

        expect(await session.command('DELE 2')).to.match(/^\+OK/);
        expect(await session.command('QUIT')).to.match(/^\+OK/);
        session.close();

        // RETR marks the message as seen, DELE moves it to Trash
        expect(
            await waitFor(async () => {
                const inboxMessages = await listMessages(inbox);
                const trashMessages = await listMessages(trash);
                return inboxMessages.length === 2 && trashMessages.length === 1;
            })
        ).to.be.true;

        const inboxMessages = await listMessages(inbox);
        expect(inboxMessages.find(message => message.subject === 'POP3 message 1').seen).to.be.true;
        expect(inboxMessages.find(message => message.subject === 'POP3 message 3').seen).to.be.false;

        const trashMessages = await listMessages(trash);
        expect(trashMessages).to.deep.equal([{ subject: 'POP3 message 2', seen: true }]);
    });

    it('should not list messages already deleted by a previous session', async () => {
        const session = await connectPop3();
        expect(await session.command(`USER ${username}`)).to.match(/^\+OK/);
        expect(await session.command(`PASS ${password}`)).to.match(/^\+OK maildrop has 2 messages/);
        expect(await session.command('QUIT')).to.match(/^\+OK/);
        session.close();
    });
});
