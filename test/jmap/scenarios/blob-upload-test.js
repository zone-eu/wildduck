/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file blob.yaml, phase 2: the upload endpoint (BLOB). Scenarios that consume uploads in
// Email/set or Email/import live with those methods.

const http = require('http');
const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, api, accounts, seed, jmap } = require('../harness');
const { startInstance, stopInstance, connect } = require('../harness/instance');
const StorageHandler = require('../../../lib/storage-handler');

const BLOB_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** Uploads a body; answers {status, json, body} */
async function upload(client, body, headers = {}, accountId = client.accountId, base = jmap.JMAP_URL) {
    return client.raw(`${base}/jmap/upload/${accountId}/`, { method: 'POST', body, headers });
}

async function download(client, blobId, base = jmap.JMAP_URL) {
    return client.raw(`${base}/jmap/download/${client.accountId}/${blobId}/file.bin?type=application/octet-stream`);
}

async function session(user) {
    const client = jmap.forUser(user);
    await client.session();
    return client;
}

const temporaryFiles = async user => {
    const db = await seed.db();
    return db
        .collection('storage.files')
        .find({ 'metadata.user': new seed.ObjectId(user.id), 'metadata.expires': { $exists: true } })
        .toArray();
};

/** A request whose body stays open until `finish` is called */
function heldUpload(url, user) {
    const target = new URL(url);
    const req = http.request({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { Authorization: jmap.basic(user.username, user.password), 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' }
    });
    const response = new Promise((resolve, reject) => {
        req.on('response', res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
    });
    req.write('first chunk');
    return { response, finish: () => req.end('last chunk') };
}

describe('Upload', function () {
    this.timeout(60000);
    let user;
    let client;

    before(async () => {
        user = await accounts.createUser();
        client = await session(user);
    });

    scenario('BLOB-024', async () => {
        const res = await upload(client, 'twenty four octets here!', { 'Content-Type': 'text/plain' });
        expect(res.status).to.equal(200);
        expect(res.headers.get('content-type')).to.match(/^application\/json/);
        expect(res.json.accountId).to.equal(client.accountId);
        expect(res.json.blobId).to.be.a('string');
        expect(res.json.type).to.match(/^text\/plain/);
        expect(res.json.size).to.equal(24);
    });

    scenario('BLOB-025', async () => {
        const res = await upload(client, 'x', { 'Content-Type': 'text/plain' });
        expect(res.json.blobId).to.match(BLOB_ID);
        expect(res.json.blobId.startsWith('Bu')).to.be.true;
    });

    scenario('BLOB-026', async () => {
        const buffer = crypto.randomBytes(102400);
        buffer[10] = 0x0d;
        buffer[11] = 0x0a;
        buffer[20] = 0x0a;
        const res = await upload(client, buffer, { 'Content-Type': 'application/octet-stream' });
        expect(res.json.size).to.equal(102400);
        const downloaded = await download(client, res.json.blobId);
        expect(downloaded.status).to.equal(200);
        expect(Buffer.compare(downloaded.body, buffer)).to.equal(0);
    });

    scenario('BLOB-027', async () => {
        const html = '<!doctype html><html><body>hello</body></html>';
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
        expect((await upload(client, html, { 'Content-Type': 'text/html' })).json.type).to.equal('text/html');
        expect((await upload(client, html, { 'Content-Type': 'text/plain' })).json.type).to.equal('text/plain');
        expect((await upload(client, png, { 'Content-Type': 'text/plain;charset=latin1' })).json.type).to.match(/^text\/plain/);
    });

    scenario('BLOB-028', async () => {
        // fetch adds a Content-Type for a string body, a Uint8Array body has none
        const none = await upload(client, new Uint8Array(Buffer.from('no type')));
        expect(none.status).to.equal(200);
        expect(none.json.type).to.equal('application/octet-stream');
        const empty = await upload(client, 'empty type', { 'Content-Type': '' });
        expect(empty.status).to.equal(200);
        expect(empty.json.type).to.equal('application/octet-stream');
    });

    scenario('BLOB-029', async () => {
        const res = await upload(client, '', { 'Content-Type': 'text/plain' });
        expect(res.status).to.equal(200);
        expect(res.json.size).to.equal(0);
        const downloaded = await download(client, res.json.blobId);
        expect(downloaded.status).to.equal(200);
        expect(downloaded.body.length).to.equal(0);
    });

    scenario('BLOB-030', async () => {
        const form = '--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n--xyz--\r\n';
        const multipart = await upload(client, form, { 'Content-Type': 'multipart/form-data; boundary=xyz' });
        expect(multipart.json.size).to.equal(Buffer.byteLength(form));
        expect(multipart.json.type).to.equal('multipart/form-data; boundary=xyz');
        expect((await download(client, multipart.json.blobId)).body.toString()).to.equal(form);
        const json = '{"methodCalls": []}';
        const posted = await upload(client, json, { 'Content-Type': 'application/json' });
        expect(posted.json.size).to.equal(json.length);
        expect((await download(client, posted.json.blobId)).body.toString()).to.equal(json);
    });

    scenario('BLOB-032', async () => {
        const other = await accounts.createUser();
        for (const accountId of [`u${other.id}`, 'u0123456789abcdef01234567']) {
            const res = await upload(client, 'foreign', { 'Content-Type': 'text/plain' }, accountId);
            expect(res.status).to.equal(404);
            expect(res.headers.get('content-type')).to.match(/problem\+json/);
        }
        expect(await temporaryFiles(other)).to.have.length(0);
    });

    scenario('BLOB-035', async () => {
        const body = crypto.randomBytes(500);
        const first = await upload(client, body, { 'Content-Type': 'application/octet-stream' });
        const second = await upload(client, body, { 'Content-Type': 'application/octet-stream' });
        expect(first.json.size).to.equal(second.json.size);
        expect(first.json.blobId).to.not.equal(second.json.blobId);
        for (const blobId of [first.json.blobId, second.json.blobId]) {
            expect(Buffer.compare((await download(client, blobId)).body, body)).to.equal(0);
        }
        const files = await temporaryFiles(user);
        const ids = [first.json.blobId.slice(2), second.json.blobId.slice(2)];
        expect(files.filter(file => ids.includes(file._id.toString())).every(file => file.metadata.expires instanceof Date)).to.be.true;
    });

    scenario('BLOB-036', async () => {
        const before = await client.call([
            ['Email/get', { accountId: client.accountId, ids: [] }, 'e'],
            ['Mailbox/get', { accountId: client.accountId }, 'm'],
            ['Email/query', { accountId: client.accountId }, 'q']
        ]);
        await upload(client, 'From: a@example.com\r\nSubject: not mail\r\n\r\nbody\r\n', { 'Content-Type': 'message/rfc822' });
        const after = await client.call([
            ['Email/get', { accountId: client.accountId, ids: [] }, 'e'],
            ['Mailbox/get', { accountId: client.accountId }, 'm'],
            ['Email/query', { accountId: client.accountId }, 'q']
        ]);
        expect(after[0][1].state).to.equal(before[0][1].state);
        expect(after[1][1].state).to.equal(before[1][1].state);
        expect(after[1][1].list.map(mailbox => mailbox.totalEmails)).to.deep.equal(before[1][1].list.map(mailbox => mailbox.totalEmails));
        expect(after[2][1].ids).to.deep.equal(before[2][1].ids);
        const status = await seed.withImap(user, imap => imap.status('INBOX', { messages: true }));
        expect(status.messages).to.equal(0);
    });

    scenario('BLOB-041', async () => {
        const fresh = await accounts.createUser();
        const c = await session(fresh);
        const before = (await api('GET', `/users/${fresh.id}`)).limits.quota.used;
        const res = await upload(c, crypto.randomBytes(1024 * 1024), { 'Content-Type': 'application/octet-stream' });
        expect(res.status).to.equal(200);
        expect((await api('GET', `/users/${fresh.id}`)).limits.quota.used).to.equal(before);
    });

    scenario('BLOB-043', async () => {
        const fresh = await accounts.createUser();
        const c = await session(fresh);
        const s = await c.session();
        const max = s.accounts[c.accountId].accountCapabilities[jmap.URN.mail].maxSizeAttachmentsPerEmail;
        const quota = (config.jmap.limits && config.jmap.limits.uploadQuota) || 200 * 1024 * 1024;
        expect(quota).to.be.at.least(max);
        // uploads totalling M octets, in pieces no larger than maxSizeUpload
        const piece = Math.min(s.capabilities[jmap.URN.core].maxSizeUpload, 16 * 1024 * 1024);
        const blobIds = [];
        for (let total = 0; total < max; total += piece) {
            const res = await upload(c, Buffer.alloc(Math.min(piece, max - total), 1), { 'Content-Type': 'application/octet-stream' });
            expect(res.status).to.equal(200);
            blobIds.push(res.json.blobId);
        }
        for (const blobId of blobIds) {
            const res = await c.raw(`/jmap/download/${c.accountId}/${blobId}/x?type=application/octet-stream`, { method: 'HEAD' });
            expect(res.status, blobId).to.equal(200);
        }
    });

    scenario('BLOB-086', async () => {
        // what aerc (go-jmap) sends when it saves a draft or sends a message: the raw message labelled as JSON
        const raw = 'From: a@example.com\r\nTo: b@example.com\r\nSubject: BLOB-086\r\nMessage-ID: <blob-086@example.com>\r\n\r\nHello\r\n';
        const res = await upload(client, raw, { 'Content-Type': 'application/json' });
        expect(res.status).to.equal(200);
        expect(res.json).to.include({ accountId: client.accountId, type: 'application/json', size: raw.length });

        const drafts = `F${(await accounts.mailboxes(user))['\\Drafts'].id}`;
        const imported = await client.method('Email/import', {
            emails: { draft: { blobId: res.json.blobId, mailboxIds: { [drafts]: true }, keywords: { $draft: true } } }
        });
        expect(imported.notCreated, JSON.stringify(imported.notCreated)).to.equal(null);
        const [email] = (await client.method('Email/get', { ids: [imported.created.draft.id], properties: ['subject', 'mailboxIds'] })).list;
        expect(email).to.deep.include({ subject: 'BLOB-086', mailboxIds: { [drafts]: true } });
    });

    describe('expiry', () => {
        let storage;
        before(async () => {
            const db = await connect();
            storage = new StorageHandler({ database: db.database, users: db.users, gridfs: db.gridfs });
        });

        // moves the clock of an upload by setting its expiry relative to now
        const expireIn = async (blobId, ms) => {
            const db = await seed.db();
            await db
                .collection('storage.files')
                .updateOne({ _id: new seed.ObjectId(blobId.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() + ms) } });
        };

        scenario('BLOB-037', async () => {
            const res = await upload(client, 'keep me', { 'Content-Type': 'text/plain' });
            // a one hour lifetime, 59 minutes later: one minute left
            await expireIn(res.json.blobId, 60 * 1000);
            await storage.removeExpiredUploads();
            const downloaded = await download(client, res.json.blobId);
            expect(downloaded.status).to.equal(200);
            expect(downloaded.body.toString()).to.equal('keep me');
        });

        scenario('BLOB-038', async () => {
            const fresh = await accounts.createUser();
            const c = await session(fresh);
            const res = await upload(c, crypto.randomBytes(3000), { 'Content-Type': 'application/octet-stream' });
            const db = await seed.db();
            const [file] = await temporaryFiles(fresh);
            expect(file.metadata.expires.getTime() - Date.now()).to.be.closeTo(24 * 3600 * 1000, 60 * 1000);
            await expireIn(res.json.blobId, -1000);
            await storage.removeExpiredUploads();
            expect((await download(c, res.json.blobId)).status).to.equal(404);
            expect(await temporaryFiles(fresh)).to.have.length(0);
            expect(await db.collection('storage.chunks').countDocuments({ files_id: file._id })).to.equal(0);
        });

        scenario('BLOB-087', async () => {
            const fresh = await accounts.createUser();
            const c = await session(fresh);
            for (let i = 0; i < 2; i++) {
                const res = await upload(c, crypto.randomBytes(3000), { 'Content-Type': 'application/octet-stream' });
                await expireIn(res.json.blobId, -1000);
            }
            const ids = (await temporaryFiles(fresh)).map(file => file._id);
            expect(ids).to.have.length(2);

            // a handler whose first deletion of chunks fails
            const db = await connect();
            const failing = new StorageHandler({ database: db.database, users: db.users, gridfs: db.gridfs });
            let failures = 1;
            failing.gridfs = {
                collection: name => {
                    const collection = db.gridfs.collection(name);
                    if (name !== 'storage.chunks') {
                        return collection;
                    }
                    return new Proxy(collection, {
                        get: (target, key) =>
                            key === 'deleteMany' && failures-- > 0
                                ? () => Promise.reject(new Error('injected failure'))
                                : typeof target[key] === 'function'
                                  ? target[key].bind(target)
                                  : target[key]
                    });
                }
            };
            const err = await failing.removeExpiredUploads().catch(error => error);
            expect(err).to.be.an('error');
            await failing.removeExpiredUploads();

            const tdb = await seed.db();
            expect(await tdb.collection('storage.files').countDocuments({ _id: { $in: ids } })).to.equal(0);
            expect(await tdb.collection('storage.chunks').countDocuments({ files_id: { $in: ids } })).to.equal(0);
        });
    });

    describe('limits', () => {
        let instance;
        const LIMIT = 4096;
        before(async () => {
            instance = await startInstance({
                limits: Object.assign({}, config.jmap.limits, { maxSizeUpload: LIMIT, maxConcurrentUpload: 2, uploadQuota: 10000 })
            });
        });
        after(() => stopInstance(instance.app));

        scenario('BLOB-031', async () => {
            const fresh = await accounts.createUser();
            const c = await session(fresh);
            const exact = await upload(c, Buffer.alloc(LIMIT, 1), { 'Content-Type': 'application/octet-stream' }, c.accountId, instance.url);
            expect(exact.status).to.equal(200);
            expect(exact.json.size).to.equal(LIMIT);
            const before = await temporaryFiles(fresh);
            const db = await seed.db();
            const chunksBefore = await db.collection('storage.chunks').countDocuments({});

            const over = await upload(c, Buffer.alloc(LIMIT + 1, 1), { 'Content-Type': 'application/octet-stream' }, c.accountId, instance.url);
            expect(over.status).to.equal(413);
            expect(over.json).to.include({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxSizeUpload' });

            // chunked, without Content-Length
            const chunked = await new Promise((resolve, reject) => {
                const target = new URL(instance.url);
                const req = http.request(
                    {
                        host: target.hostname,
                        port: target.port,
                        path: `/jmap/upload/${c.accountId}/`,
                        method: 'POST',
                        headers: {
                            Authorization: jmap.basic(fresh.username, fresh.password),
                            'Content-Type': 'application/octet-stream',
                            'Transfer-Encoding': 'chunked'
                        }
                    },
                    res => {
                        const chunks = [];
                        res.on('data', chunk => chunks.push(chunk));
                        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
                    }
                );
                req.on('error', reject);
                req.write(Buffer.alloc(LIMIT, 1));
                req.end(Buffer.alloc(1, 1));
            });
            expect(chunked.status).to.equal(413);
            expect(chunked.json).to.include({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxSizeUpload' });

            const after = await temporaryFiles(fresh);
            expect(after.map(file => file._id.toString())).to.deep.equal(before.map(file => file._id.toString()));
            // the refused uploads left no chunks behind
            expect(await db.collection('storage.chunks').countDocuments({})).to.equal(chunksBefore);
        });

        scenario('BLOB-042', async () => {
            const fresh = await accounts.createUser();
            const c = await session(fresh);
            const sent = [];
            for (let i = 0; i < 3; i++) {
                const body = crypto.randomBytes(3000);
                const res = await upload(c, body, { 'Content-Type': 'application/octet-stream' }, c.accountId, instance.url);
                sent.push({ blobId: res.json.blobId, body });
            }
            // fits only once U1 and U2 are gone
            const fourth = crypto.randomBytes(4090);
            const res = await upload(c, fourth, { 'Content-Type': 'application/octet-stream' }, c.accountId, instance.url);
            expect(res.status).to.equal(200);
            expect((await download(c, sent[0].blobId, instance.url)).status).to.equal(404);
            expect((await download(c, sent[1].blobId, instance.url)).status).to.equal(404);
            expect(Buffer.compare((await download(c, sent[2].blobId, instance.url)).body, sent[2].body)).to.equal(0);
            expect(Buffer.compare((await download(c, res.json.blobId, instance.url)).body, fourth)).to.equal(0);
        });

        scenario('BLOB-044', async () => {
            const fresh = await accounts.createUser();
            const other = await accounts.createUser();
            const c = await session(fresh);
            const oc = await session(other);
            const url = `${instance.url}/jmap/upload/${c.accountId}/`;
            const held = [heldUpload(url, fresh), heldUpload(url, fresh)];
            // let both reach the handler and take their slots
            await new Promise(resolve => setTimeout(resolve, 300));
            const third = await upload(c, 'one too many', { 'Content-Type': 'text/plain' }, c.accountId, instance.url);
            expect(third.status).to.equal(429);
            expect(third.json).to.include({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxConcurrentUpload' });
            expect((await upload(oc, 'other user', { 'Content-Type': 'text/plain' }, oc.accountId, instance.url)).status).to.equal(200);
            held[0].finish();
            expect((await held[0].response).status).to.equal(200);
            expect((await upload(c, 'room again', { 'Content-Type': 'text/plain' }, c.accountId, instance.url)).status).to.equal(200);
            held[1].finish();
            expect((await held[1].response).status).to.equal(200);
        });
    });

    describe('upload count', () => {
        let instance;
        const COUNT = 3;
        before(async () => {
            instance = await startInstance({ limits: Object.assign({}, config.jmap.limits, { maxUploads: COUNT }) });
        });
        after(() => stopInstance(instance.app));

        scenario('BLOB-088', async () => {
            const fresh = await accounts.createUser();
            const c = await session(fresh);
            const sent = [];
            for (let i = 0; i < COUNT; i++) {
                const res = await upload(c, '', { 'Content-Type': 'text/plain' }, c.accountId, instance.url);
                expect(res.status).to.equal(200);
                sent.push(res.json.blobId);
            }
            // Blob/upload without data sources makes an empty upload as well
            const blobs = new jmap.JmapClient(jmap.basic(fresh.username, fresh.password));
            blobs.raw = (
                raw => (path, init) =>
                    raw.call(blobs, path.startsWith('http') ? path : instance.url + path, init)
            )(blobs.raw);
            await blobs.session();
            const created = await blobs.method('Blob/upload', { create: { e: { data: [] } } }, [jmap.URN.core, jmap.URN.blob]);
            expect(created.created, JSON.stringify(created.notCreated)).to.have.property('e');

            expect(await temporaryFiles(fresh)).to.have.length(COUNT);
            expect((await download(c, sent[0], instance.url)).status).to.equal(404);
            expect((await download(c, sent[1], instance.url)).status).to.equal(200);

            // pinned uploads are never deleted: with only those left, the next upload is refused
            const db = await seed.db();
            await db
                .collection('storage.files')
                .updateMany(
                    { 'metadata.user': new seed.ObjectId(fresh.id), 'metadata.expires': { $exists: true } },
                    { $set: { 'metadata.expires': new Date('9999-01-01T00:00:00Z') } }
                );
            const refused = await upload(c, 'one too many', { 'Content-Type': 'text/plain' }, c.accountId, instance.url);
            expect(refused.status).to.equal(413);
            expect(refused.json).to.include({ type: 'urn:ietf:params:jmap:error:limit', limit: 'uploadQuota' });
            expect(await temporaryFiles(fresh)).to.have.length(COUNT);
        });
    });
});
