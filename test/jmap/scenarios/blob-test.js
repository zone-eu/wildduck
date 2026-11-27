/* eslint no-unused-expressions: 0 */
/* globals before: false */
'use strict';

// Catalogue file blob.yaml, phase 1: the download endpoint and Blob/copy (BLOB).

const crypto = require('crypto');
const libqp = require('libqp');
const openpgp = require('openpgp');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');

const tag = () => crypto.randomBytes(4).toString('hex');
const CRLF = '\r\n';

/** The stored document of a message by its Message-ID, once it exists */
async function storedDoc(user, messageId, collection = 'messages') {
    const db = await seed.db();
    return clock.waitFor(
        () =>
            db.collection(collection).findOne({ user: new seed.ObjectId(user.id), msgid: messageId }, { projection: { root: true, uid: true, mailbox: true } }),
        { message: `message ${messageId} not in ${collection}` }
    );
}

const messageIdOf = raw => /^Message-ID: (.*)$/im.exec(raw.toString())[1].trim();

/** Appends a raw message over IMAP and answers its Email id */
async function append(user, raw, flags = []) {
    await seed.withImap(user, client => client.append('INBOX', raw, flags));
    const doc = await storedDoc(user, messageIdOf(raw));
    return `M${doc.root}`;
}

/** A multipart message assembled from raw parts, so the bytes of every part are known */
function multipart(subject, parts, type = 'multipart/mixed') {
    const boundary = `b-${tag()}`;
    const head = [
        'From: Sender <sender@example.net>',
        'To: Recipient <recipient@example.com>',
        `Subject: ${subject}`,
        `Message-ID: <${tag()}.${Date.now()}@scenario.example>`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        `Content-Type: ${type}; boundary="${boundary}"`
    ].join(CRLF);
    const body = parts.map(part => `--${boundary}${CRLF}${part}${CRLF}`).join('') + `--${boundary}--${CRLF}`;
    return Buffer.from(`${head}${CRLF}${CRLF}${body}`, 'binary');
}

// a binary attachment with known decoded bytes
const BINARY = crypto.randomBytes(3000);
const binaryPart = name =>
    [
        `Content-Type: application/octet-stream; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        BINARY.toString('base64').replace(/.{76}/g, `$&${CRLF}`)
    ].join(CRLF);
const textPart = text => ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', text].join(CRLF);

/** A message with a text body and a binary attachment; answers the raw bytes */
const messageWithAttachment = (subject = `Attachment ${tag()}`) => multipart(subject, [textPart('See the attachment.'), binaryPart('data.bin')]);

class Downloader {
    constructor(client, session) {
        this.client = client;
        this.template = session.downloadUrl;
        this.accountId = client.accountId;
    }

    url(blobId, options = {}) {
        const values = Object.assign({ accountId: this.accountId, blobId, name: 'file.bin', type: 'application/octet-stream' }, options);
        let url = this.template.replace(/\{(\w+)\}/g, (match, key) =>
            options.raw && options.raw[key] !== undefined ? options.raw[key] : encodeURIComponent(values[key])
        );
        if (options.dropType) {
            url = url.replace(/[?&]type=[^&]*/, '');
        }
        return url;
    }

    get(blobId, options = {}) {
        return this.client.raw(this.url(blobId, options), { method: options.method || 'GET', headers: options.headers });
    }
}

/** A user with a JMAP client and a downloader */
async function setupUser(options) {
    const user = await accounts.createUser(options);
    const client = jmap.forUser(user);
    const session = await client.session();
    return { user, client, download: new Downloader(client, session) };
}

async function emailOf(client, emailId, properties = ['blobId', 'size', 'attachments', 'textBody', 'bodyStructure']) {
    const res = await client.method('Email/get', { ids: [emailId], properties, bodyProperties: ['partId', 'blobId', 'size', 'type', 'name', 'subParts'] });
    expect(res.notFound).to.deep.equal([]);
    return res.list[0];
}

function expectNotFound(res) {
    expect(res.status).to.equal(404);
    expect(res.headers.get('content-type')).to.match(/^application\/problem\+json/);
    expect(res.json).to.be.an('object');
    expect(res.json.status).to.equal(404);
    expect(String(res.headers.get('cache-control') || '')).to.not.include('immutable');
}

async function imapFlags(user, emailId, action, flags) {
    const db = await seed.db();
    const [doc] = await db
        .collection('messages')
        .find({ user: new seed.ObjectId(user.id), root: new seed.ObjectId(emailId.slice(1)) })
        .sort({ _id: -1 })
        .limit(1)
        .toArray();
    const mailbox = await db.collection('mailboxes').findOne({ _id: doc.mailbox });
    await seed.withImap(user, async client => {
        await client.mailboxOpen(mailbox.path);
        if (action === 'add') {
            await client.messageFlagsAdd(String(doc.uid), flags, { uid: true });
        } else if (action === 'remove') {
            await client.messageFlagsRemove(String(doc.uid), flags, { uid: true });
        } else {
            await client.messageDelete(String(doc.uid), { uid: true });
        }
    });
    return doc;
}

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
    return err.response;
}

describe('JMAP blobs (blob.yaml)', () => {
    describe('Download', () => {
        // a shared account for read only download scenarios
        let user;
        let client;
        let download;
        let raw;
        let emailId;
        let email;
        let attachmentBlob;
        let textBlob;

        before(async () => {
            ({ user, client, download } = await setupUser());
            raw = messageWithAttachment();
            emailId = await append(user, raw);
            email = await emailOf(client, emailId);
            attachmentBlob = email.attachments[0].blobId;
            textBlob = email.textBody[0].blobId;
        });

        scenario('BLOB-001', async () => {
            const res = await download.get(email.blobId, { name: 'email.eml', type: 'message/rfc822' });
            expect(res.status).to.equal(200);
            expect(res.body.equals(raw)).to.be.true;
            expect(Number(res.headers.get('content-length'))).to.equal(email.size);
            const imapBytes = await seed.withImap(user, async imapClient => {
                await imapClient.mailboxOpen('INBOX');
                const db = await seed.db();
                const doc = await db.collection('messages').findOne({ user: new seed.ObjectId(user.id), root: new seed.ObjectId(emailId.slice(1)) });
                const message = await imapClient.fetchOne(String(doc.uid), { source: true }, { uid: true });
                return message.source;
            });
            expect(res.body.equals(imapBytes)).to.be.true;
        });

        scenario('BLOB-003', async () => {
            const res = await download.get(attachmentBlob, { name: 'data.bin' });
            expect(res.status).to.equal(200);
            expect(res.body.equals(BINARY)).to.be.true;
            expect(res.body.length).to.equal(email.attachments[0].size);
        });

        scenario('BLOB-004', async () => {
            const qp = 'Gr=FC=DFe aus M=FCnchen,=0D=0Aund =E9t=E9 =3D sch=F6n.\r\nZweite Zeile =A9';
            const latin = multipart(`Latin ${tag()}`, [
                ['Content-Type: text/plain; charset=ISO-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', qp].join(CRLF)
            ]);
            const id = await append(user, latin);
            const message = await client.method('Email/get', { ids: [id], properties: ['textBody', 'bodyValues'], fetchTextBodyValues: true });
            const part = message.list[0].textBody[0];
            const res = await download.get(part.blobId, { type: 'text/plain' });
            expect(res.status).to.equal(200);
            const expected = libqp.decode(qp);
            expect(res.body.equals(expected)).to.be.true;
            expect(res.body.includes(Buffer.from('Grüße', 'latin1'))).to.be.true;
            expect(res.body.includes(Buffer.from('Grüße', 'utf8'))).to.be.false;
            expect(message.list[0].bodyValues[part.partId].value).to.include('Grüße aus München');
        });

        scenario('BLOB-005', async () => {
            const inner = Buffer.from(
                [
                    'From: Inner <inner@example.net>',
                    'To: Someone <someone@example.com>',
                    `Subject: Embedded ${tag()}`,
                    `Message-ID: <inner.${tag()}@scenario.example>`,
                    'MIME-Version: 1.0',
                    'Content-Type: text/plain; charset=us-ascii',
                    '',
                    'This is the embedded message body.',
                    'Second line.'
                ].join(CRLF)
            );
            const outer = multipart(`Forward ${tag()}`, [
                textPart('Forwarded message attached.'),
                ['Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="inner.eml"', '', inner.toString()].join(CRLF)
            ]);
            const id = await append(user, outer);
            const message = await emailOf(client, id, ['attachments']);
            const attachment = message.attachments.find(entry => entry.type === 'message/rfc822');
            expect(attachment, 'message/rfc822 attachment').to.exist;
            const res = await download.get(attachment.blobId, { name: 'inner.eml', type: 'message/rfc822' });
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.match(/^message\/rfc822/);
            expect(Number(res.headers.get('content-length') || res.body.length)).to.be.above(0);
            expect(res.body.equals(inner)).to.be.true;
        });

        scenario('BLOB-006', async () => {
            const bodies = [];
            for (const blobId of [email.blobId, textBlob]) {
                for (const type of ['application/octet-stream', 'text/plain']) {
                    const res = await download.get(blobId, { type });
                    expect(res.status).to.equal(200);
                    expect(res.headers.get('content-type').split(';')[0].trim()).to.equal(type);
                    bodies.push(res.body);
                }
            }
            expect(bodies[0].equals(bodies[1])).to.be.true;
            expect(bodies[2].equals(bodies[3])).to.be.true;
        });

        scenario('BLOB-007', async () => {
            const missing = await download.get(textBlob, { dropType: true, headers: { Accept: 'text/plain' } });
            expect(missing.status).to.equal(200);
            expect(missing.headers.get('content-type')).to.equal('application/octet-stream');
            const empty = await download.get(textBlob, { type: '', headers: { Accept: 'text/html' } });
            expect(empty.status).to.equal(200);
            expect(empty.headers.get('content-type')).to.equal('application/octet-stream');
        });

        scenario('BLOB-008', async () => {
            const injected = await download.get(email.blobId, { raw: { type: 'text/plain%0D%0AX-Injected:%20yes' } });
            expect(injected.headers.get('x-injected')).to.equal(null);
            if (injected.status === 400) {
                expect(injected.json.status).to.equal(400);
            } else {
                expect(injected.status).to.equal(200);
                expect(injected.headers.get('content-type')).to.equal('application/octet-stream');
                expect(injected.body.equals(raw)).to.be.true;
            }
            const garbage = await download.get(email.blobId, { type: 'garbage' });
            if (garbage.status === 400) {
                expect(garbage.json.status).to.equal(400);
            } else {
                expect(garbage.status).to.equal(200);
                expect(garbage.headers.get('content-type')).to.equal('application/octet-stream');
            }
        });

        scenario('BLOB-009', async () => {
            for (const blobId of [email.blobId, attachmentBlob]) {
                const res = await download.get(blobId, { name: 'myfile.txt' });
                expect(res.status).to.equal(200);
                const disposition = res.headers.get('content-disposition');
                expect(disposition).to.match(/^attachment\s*;/);
                expect(/filename="myfile\.txt"/.test(disposition) || /filename\*=UTF-8''myfile\.txt/.test(disposition)).to.be.true;
            }
        });

        scenario('BLOB-010', async () => {
            const cyrillic = 'Отчёт.pdf';
            const res = await download.get(email.blobId, { name: cyrillic });
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-disposition')).to.include(`filename*=UTF-8''${encodeURIComponent(cyrillic)}`);

            const tricky = await download.get(email.blobId, { name: 'a"b;c=d.txt' });
            expect(tricky.status).to.equal(200);
            const disposition = tricky.headers.get('content-disposition');
            // the quoted file name holds no unescaped quote, so the semicolon stays inside it
            const quoted = /filename="((?:[^"\\]|\\.)*)"/.exec(disposition);
            expect(quoted, 'quoted filename').to.exist;
            expect(quoted[1]).to.include(';c=d.txt');
            expect(disposition).to.match(/filename\*=UTF-8''a%22b%3Bc%3Dd\.txt/);

            const crlf = await download.get(email.blobId, { raw: { name: 'evil%0D%0AX-Injected:%20yes.txt' } });
            expect(crlf.headers.get('x-injected')).to.equal(null);
            expect([200, 400]).to.include(crlf.status);
            if (crlf.status === 200) {
                expect(crlf.headers.get('content-disposition')).to.not.match(/[\r\n]/);
            }
        });

        scenario('BLOB-011', async () => {
            const res = await download.get(attachmentBlob, { name: '' });
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-disposition').trim()).to.equal('attachment');
        });

        scenario('BLOB-012', async () => {
            const id = await append(
                user,
                multipart(`Html ${tag()}`, [
                    textPart('See the page.'),
                    [
                        'Content-Type: text/html; charset=utf-8',
                        'Content-Disposition: attachment; filename="page.html"',
                        '',
                        '<html><script>alert(1)</script></html>'
                    ].join(CRLF)
                ])
            );
            const message = await emailOf(client, id, ['attachments']);
            const res = await download.get(message.attachments[0].blobId, { name: 'page.html', type: 'text/html' });
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type').split(';')[0]).to.equal('text/html');
            expect(res.headers.get('content-disposition')).to.match(/^attachment/);
            expect(res.headers.get('x-content-type-options')).to.equal('nosniff');
            expect(res.headers.get('content-security-policy')).to.match(/(^|;)\s*sandbox\b/);
        });

        scenario('BLOB-013', async () => {
            const res = await download.get(email.blobId);
            expect(res.status).to.equal(200);
            const cache = res.headers.get('cache-control');
            expect(cache).to.include('private');
            expect(cache).to.include('immutable');
            expect(Number(/max-age=(\d+)/.exec(cache)[1])).to.be.at.least(86400);
            expectNotFound(await download.get(`Bm${new seed.ObjectId()}`));
        });

        scenario('BLOB-014', async () => {
            for (const blobId of [`Bm${new seed.ObjectId()}`, `Bp${new seed.ObjectId()}_1`, `Bu${new seed.ObjectId()}`]) {
                expectNotFound(await download.get(blobId));
            }
        });

        scenario('BLOB-015', async () => {
            const hex = email.blobId.slice(2);
            const longId = 'B' + 'x'.repeat(299);
            const cases = [
                { blobId: 'banana' },
                { blobId: `Bz${hex}` },
                { blobId: `Bm${hex.slice(0, 20)}` },
                { blobId: `Bp${hex}_1-1-1-1-1-1` },
                { blobId: longId },
                { raw: { blobId: '..%2F..%2F..%2Fetc%2Fpasswd' } },
                { raw: { blobId: `${email.blobId}%2F..%2F.` } }
            ];
            for (const entry of cases) {
                const res = await download.get(entry.blobId, entry.raw ? { raw: entry.raw } : {});
                expect(res.status, JSON.stringify(entry)).to.equal(404);
                expect(res.json.status).to.equal(404);
            }
            // five extra path segments after the blob id
            const res = await download.client.raw(download.url(email.blobId).replace(email.blobId, `${email.blobId}/a/b/c/d/e`));
            expect(res.status).to.equal(404);
            expect(res.json.status).to.equal(404);
        });

        scenario('BLOB-016', async () => {
            const boundary = `alt-${tag()}`;
            const nested = multipart(`Nested ${tag()}`, [
                [
                    `Content-Type: multipart/alternative; boundary="${boundary}"`,
                    '',
                    `--${boundary}`,
                    textPart('plain version'),
                    `--${boundary}`,
                    ['Content-Type: text/html; charset=utf-8', '', '<p>html version</p>'].join(CRLF),
                    `--${boundary}--`
                ].join(CRLF)
            ]);
            const id = await append(user, nested);
            const message = await emailOf(client, id, ['bodyStructure']);
            const container = message.bodyStructure.subParts[0];
            expect(container.type).to.equal('multipart/alternative');
            expect(container.blobId).to.equal(null);
            expect(container.subParts.every(part => typeof part.blobId === 'string')).to.be.true;
            const root = id.slice(1);
            expectNotFound(await download.get(`Bp${root}_1`));
            expectNotFound(await download.get(`Bp${root}_7`));
            expectNotFound(await download.get(`Bp${root}_1-5`));
            expect((await download.get(container.subParts[0].blobId)).status).to.equal(200);
        });

        scenario('BLOB-017', async () => {
            const { user: other, client: otherClient } = await setupUser();
            const otherId = await append(other, messageWithAttachment());
            const otherEmail = await emailOf(otherClient, otherId);
            const unknown = await download.get(`Bm${new seed.ObjectId()}`);
            for (const blobId of [otherEmail.blobId, otherEmail.attachments[0].blobId]) {
                const res = await download.get(blobId);
                expectNotFound(res);
                expect(res.json).to.deep.equal(unknown.json);
            }
        });

        scenario('BLOB-018', async () => {
            const { user: other, client: otherClient } = await setupUser();
            const otherId = await append(other, messageWithAttachment());
            const otherEmail = await emailOf(otherClient, otherId);
            const unknown = await download.get(`Bm${new seed.ObjectId()}`);
            for (const accountId of [otherClient.accountId, `u${new seed.ObjectId()}`]) {
                const res = await download.get(otherEmail.blobId, { accountId });
                expectNotFound(res);
                expect(res.json).to.deep.equal(unknown.json);
            }
        });
    });

    describe('Download and message lifecycle', () => {
        scenario('BLOB-019', async () => {
            const { user, client, download } = await setupUser();
            const raw = messageWithAttachment();
            const id = await append(user, raw);
            const email = await emailOf(client, id);
            const partBlob = email.attachments[0].blobId;

            await imapFlags(user, id, 'add', ['\\Deleted']);
            expectNotFound(await download.get(email.blobId));
            expectNotFound(await download.get(partBlob));

            await imapFlags(user, id, 'remove', ['\\Deleted']);
            const message = await download.get(email.blobId);
            expect(message.status).to.equal(200);
            expect(message.body.equals(raw)).to.be.true;
            const part = await download.get(partBlob);
            expect(part.status).to.equal(200);
            expect(part.body.equals(BINARY)).to.be.true;
        });

        scenario('BLOB-020', async () => {
            const { user, client, download } = await setupUser();
            await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
            const raw = messageWithAttachment();
            const id = await append(user, raw);
            const email = await emailOf(client, id);
            await seed.withImap(user, async imapClient => {
                await imapClient.mailboxOpen('INBOX');
                await imapClient.messageMove('1:*', 'Archive');
            });
            const message = await download.get(email.blobId);
            expect(message.status).to.equal(200);
            expect(message.body.equals(raw)).to.be.true;
            const part = await download.get(email.attachments[0].blobId);
            expect(part.status).to.equal(200);
            expect(part.body.equals(BINARY)).to.be.true;
            const after = await emailOf(client, id);
            expect(after.blobId).to.equal(email.blobId);
            expect(after.attachments[0].blobId).to.equal(email.attachments[0].blobId);
        });

        scenario('BLOB-021', async () => {
            const { user, client, download } = await setupUser();
            const raw = messageWithAttachment();
            const id = await append(user, raw);
            const email = await emailOf(client, id);
            await imapFlags(user, id, 'expunge');
            expectNotFound(await download.get(email.blobId));
            expectNotFound(await download.get(email.attachments[0].blobId));

            const archived = await storedDoc(user, messageIdOf(raw), 'archived');
            await api('POST', `/users/${user.id}/archived/messages/${archived._id}/restore`, {});
            const restored = await storedDoc(user, messageIdOf(raw));
            const restoredEmail = await emailOf(client, `M${restored.root}`);
            const message = await download.get(restoredEmail.blobId);
            expect(message.status).to.equal(200);
            expect(message.body.equals(raw)).to.be.true;
            const part = await download.get(restoredEmail.attachments[0].blobId);
            expect(part.status).to.equal(200);
            expect(part.body.equals(BINARY)).to.be.true;
        });

        scenario('BLOB-022', async () => {
            const { publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: 'Sealed', email: 'sealed@example.com' }] });
            const { user, client, download } = await setupUser({ pubKey: publicKey, encryptMessages: true });
            const raw = await fixtures.buildMessage({ subject: `Sealed ${tag()}`, text: 'secret words inside' });
            await seed.deliver(user.address, raw);
            const doc = await storedDoc(user, messageIdOf(raw));
            const email = await emailOf(client, `M${doc.root}`, ['blobId', 'bodyStructure']);
            expect(email.bodyStructure.type).to.equal('multipart/encrypted');

            const message = await download.get(email.blobId);
            expect(message.status).to.equal(200);
            const text = message.body.toString();
            expect(text).to.match(/Content-Type: multipart\/encrypted/i);
            expect(text).to.include('-----BEGIN PGP MESSAGE-----');
            expect(text).to.not.include('secret words inside');

            const leaves = [];
            const walk = part => (part.subParts && part.subParts.length ? part.subParts.forEach(walk) : leaves.push(part));
            walk(email.bodyStructure);
            expect(leaves.length).to.be.at.least(2);
            const bodies = [];
            for (const part of leaves) {
                const res = await download.get(part.blobId);
                expect(res.status).to.equal(200);
                expect(res.body.toString()).to.not.include('secret words inside');
                bodies.push(res.body.toString());
            }
            expect(bodies.some(body => body.includes('-----BEGIN PGP MESSAGE-----'))).to.be.true;
        });

        scenario('BLOB-023', async () => {
            const { user, client, download } = await setupUser();
            const raw = messageWithAttachment();
            const id = await append(user, raw);
            const email = await emailOf(client, id);
            for (const method of ['POST', 'PUT', 'DELETE']) {
                const res = await download.get(email.blobId, { method });
                expect(res.status, method).to.equal(405);
                expect(res.headers.get('allow')).to.include('GET');
            }
            const after = await download.get(email.blobId);
            expect(after.status).to.equal(200);
            expect(after.body.equals(raw)).to.be.true;
            expect((await emailOf(client, id)).blobId).to.equal(email.blobId);
        });
    });

    describe('Upload', () => {
        scenario('BLOB-002', async () => {});
    });

    describe('Blob/copy', () => {
        let a;
        let b;

        before(async () => {
            a = await setupUser();
            b = await setupUser();
        });

        const blobCopy = (client, args, using) => client.call([['Blob/copy', args, 'c']], using).then(([[name, res]]) => ({ name, res }));

        scenario('BLOB-045', async () => {
            const { name, res } = await blobCopy(a.client, { fromAccountId: `u${new seed.ObjectId()}`, accountId: a.client.accountId, blobIds: [] }, [
                jmap.URN.core
            ]);
            expect(name).to.equal('error');
            expect(res.type).to.equal('fromAccountNotFound');
        });

        scenario('BLOB-046', async () => {
            const otherId = await append(b.user, messageWithAttachment());
            const blobId = (await emailOf(b.client, otherId, ['blobId'])).blobId;
            const foreign = await blobCopy(a.client, { fromAccountId: b.client.accountId, accountId: a.client.accountId, blobIds: [blobId] });
            const random = await blobCopy(a.client, { fromAccountId: `u${new seed.ObjectId()}`, accountId: a.client.accountId, blobIds: [blobId] });
            expect(foreign.name).to.equal('error');
            expect(foreign.res.type).to.equal('fromAccountNotFound');
            expect(random.res).to.deep.equal(foreign.res);
            expectNotFound(await a.download.get(blobId));
        });

        scenario('BLOB-047', async () => {
            const ownId = await append(a.user, messageWithAttachment());
            const blobId = (await emailOf(a.client, ownId, ['blobId'])).blobId;
            for (const accountId of [b.client.accountId, `u${new seed.ObjectId()}`]) {
                const { name, res } = await blobCopy(a.client, { fromAccountId: a.client.accountId, accountId, blobIds: [blobId] });
                expect(name).to.equal('error');
                expect(res.type).to.equal('accountNotFound');
            }
            expectNotFound(await b.download.get(blobId));
        });

        scenario('BLOB-048', async () => {
            const { name, res } = await blobCopy(a.client, {
                fromAccountId: a.client.accountId,
                accountId: a.client.accountId,
                blobIds: [`Bm${new seed.ObjectId()}`]
            });
            expect(name).to.equal('error');
            expect(res.type).to.equal('invalidArguments');
            await expectError(a.client.method('Blob/copy', { fromAccountId: a.client.accountId, blobIds: [] }), 'invalidArguments');
        });
    });

    describe('Request', () => {
        scenario('BLOB-049', async () => {});
    });
});
