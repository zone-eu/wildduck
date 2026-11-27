/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file wildduck.yaml, phase 4: IMAP OBJECTID (RFC 8474) reports the JMAP ids (WDX-006).
// The IMAP side is driven with raw commands, so the exact response syntax is checked.

const tls = require('tls');
const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, accounts, seed, clock, jmap } = require('../harness');

/** A raw IMAP session: run(command) answers every line up to and including the tagged response */
class RawImap {
    async connect() {
        this.buffer = '';
        this.waiting = null;
        this.socket = tls.connect({ host: '127.0.0.1', port: config.imap.port, rejectUnauthorized: false });
        this.socket.on('data', chunk => {
            this.buffer += chunk.toString('binary');
            if (this.waiting) {
                this.waiting();
            }
        });
        this.socket.on('error', () => false);
        await this.until(/^\* OK/m);
        this.counter = 0;
    }

    until(pattern) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no ${pattern} in ${this.buffer}`)), 10000);
            const check = () => {
                const match = pattern.exec(this.buffer);
                if (match) {
                    clearTimeout(timer);
                    this.waiting = null;
                    const end = match.index + match[0].length;
                    const text = this.buffer.slice(0, end);
                    this.buffer = this.buffer.slice(end);
                    resolve(text);
                }
            };
            this.waiting = check;
            check();
        });
    }

    async run(command) {
        const tag = `T${++this.counter}`;
        this.socket.write(`${tag} ${command}\r\n`);
        const text = await this.until(new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, 'm'));
        return text.split('\r\n').filter(line => line);
    }

    close() {
        this.socket.destroy();
    }
}

const tagged = lines => lines[lines.length - 1];

describe('IMAP OBJECTID (wildduck.yaml)', function () {
    this.timeout(60000);

    let user;
    let client;
    let imap;

    before(async () => {
        user = await accounts.createUser();
        client = jmap.forUser(user);
        await client.session();
        imap = new RawImap();
        await imap.connect();
    });

    after(() => imap && imap.close());

    scenario('WDX-006', async () => {
        const capability = await imap.run('CAPABILITY');
        expect(capability.find(line => line.startsWith('* CAPABILITY'))).to.match(/ OBJECTID( |$)/);
        expect(tagged(await imap.run(`LOGIN ${user.username} ${user.password}`))).to.match(/^T\d+ OK/);

        const subject = `Objectid ${crypto.randomBytes(4).toString('hex')}`;
        const raw = await seed.withImap(user, async session => {
            const message = Buffer.from(
                [
                    'From: sender@example.net',
                    `To: ${user.address}`,
                    `Subject: ${subject}`,
                    `Message-ID: <${crypto.randomBytes(6).toString('hex')}@objectid.example>`,
                    'Date: Mon, 06 Jan 2020 10:00:00 +0000',
                    '',
                    'Hello',
                    ''
                ].join('\r\n')
            );
            await session.append('INBOX', message);
            return message;
        });
        expect(raw.length).to.be.above(0);

        const emails = await clock.waitFor(async () => {
            const res = await client.method('Email/query', { filter: { subject } });
            return res.ids.length === 1 && res.ids;
        });
        const [email] = (await client.method('Email/get', { ids: emails, properties: ['threadId', 'mailboxIds'] })).list;
        const inboxId = Object.keys(email.mailboxIds)[0];

        // SELECT reports the mailbox id
        const select = await imap.run('SELECT INBOX');
        expect(select).to.include(`* OK [MAILBOXID (${inboxId})] Ok`);

        // FETCH EMAILID and THREADID
        const fetched = await imap.run('FETCH 1 (EMAILID THREADID)');
        expect(fetched).to.include(`* 1 FETCH (EMAILID (${email.id}) THREADID (${email.threadId}))`);
        const uidFetched = await imap.run('UID FETCH 1:* (EMAILID)');
        expect(uidFetched.some(line => line.includes(`EMAILID (${email.id})`))).to.be.true;

        // STATUS MAILBOXID
        const status = await imap.run('STATUS INBOX (MAILBOXID MESSAGES)');
        expect(status).to.include(`* STATUS INBOX (MAILBOXID (${inboxId}) MESSAGES 1)`);

        // SEARCH EMAILID and THREADID (RFC 8474 6)
        expect(await imap.run(`SEARCH EMAILID ${email.id}`)).to.include('* SEARCH 1');
        expect(await imap.run(`SEARCH THREADID ${email.threadId}`)).to.include('* SEARCH 1');
        expect(await imap.run(`SEARCH EMAILID M${crypto.randomBytes(12).toString('hex')}`)).to.include('* SEARCH');
        expect(await imap.run('SEARCH NOT EMAILID notanid')).to.include('* SEARCH 1');

        // CREATE answers the new mailbox id
        const name = `Objid${crypto.randomBytes(3).toString('hex')}`;
        const created = tagged(await imap.run(`CREATE ${name}`));
        const createdId = /^T\d+ OK \[MAILBOXID \((F[0-9a-f]{24})\)\]/.exec(created);
        expect(createdId, created).to.exist;
        const mailboxes = (await client.method('Mailbox/get', { ids: null, properties: ['name'] })).list;
        expect(mailboxes.find(mailbox => mailbox.name === name).id).to.equal(createdId[1]);

        // EMAILID stays the same over a MOVE
        expect(tagged(await imap.run(`MOVE 1 ${name}`))).to.match(/^T\d+ OK/);
        await imap.run(`SELECT ${name}`);
        const moved = await imap.run('FETCH 1 (EMAILID THREADID)');
        expect(moved).to.include(`* 1 FETCH (EMAILID (${email.id}) THREADID (${email.threadId}))`);
        const [afterMove] = (await client.method('Email/get', { ids: [email.id], properties: ['mailboxIds'] })).list;
        expect(afterMove.mailboxIds).to.deep.equal({ [createdId[1]]: true });
    });

    it('SEARCH THREADID finds the messages of the thread on the {user, thread} index (NV-26)', async () => {
        const owner = await accounts.createUser();
        const session = new RawImap();
        await session.connect();
        try {
            expect(tagged(await session.run(`LOGIN ${owner.username} ${owner.password}`))).to.match(/^T\d+ OK/);
            await seed.withImap(owner, async append => {
                for (const subject of ['First thread', 'Second thread']) {
                    const message = [
                        'From: sender@example.net',
                        `To: ${owner.address}`,
                        `Subject: ${subject}`,
                        `Message-ID: <${crypto.randomBytes(6).toString('hex')}@objectid.example>`,
                        '',
                        'Hello',
                        ''
                    ].join('\r\n');
                    await append.append('INBOX', Buffer.from(message));
                }
            });
            await session.run('SELECT INBOX');
            const threadOf = async seq => /THREADID \((T[0-9a-f]{24})\)/.exec((await session.run(`FETCH ${seq} (THREADID)`)).join('\n'))[1];
            const [first, second] = [await threadOf(1), await threadOf(2)];
            expect(first).to.not.equal(second);
            expect(await session.run(`SEARCH THREADID ${first}`)).to.include('* SEARCH 1');
            expect(await session.run(`SEARCH NOT THREADID ${first}`)).to.include('* SEARCH 2');

            // the query on-search builds for the key: the planner picks user_messages_by_thread
            const { searchCondition } = require('../../../lib/object-ids'); // eslint-disable-line global-require
            const db = await seed.db();
            const inbox = await db.collection('mailboxes').findOne({ user: new seed.ObjectId(owner.id), path: 'INBOX' });
            const explained = await db
                .collection('messages')
                .find({ mailbox: inbox._id, $and: [searchCondition('threadid', first, inbox.user)] })
                .explain();
            expect(JSON.stringify(explained.queryPlanner.winningPlan)).to.include('user_messages_by_thread');
        } finally {
            session.close();
        }
    });
});
