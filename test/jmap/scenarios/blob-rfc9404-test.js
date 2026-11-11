/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file blob.yaml, phase 4: RFC 9404 blob management, Blob/upload, Blob/get and Blob/lookup
// (BLOB-050 to BLOB-085).

const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, accounts, seed, clock, jmap } = require('../harness');
const { startInstance, stopInstance, connect } = require('../harness/instance');
const StorageHandler = require('../../../lib/storage-handler');

const USING = [jmap.URN.core, jmap.URN.mail, jmap.URN.blob];
const UPLOAD_ID = /^Bu[0-9a-f]{24}$/;
const PANGRAM = 'The quick brown fox jumped over the lazy dog.';
const CRLF = '\r\n';
const tag = () => crypto.randomBytes(4).toString('hex');

// a 95 octet image/png body: the PNG signature and binary data that is not UTF-8
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(87)]);

async function setupUser(options) {
    const user = await accounts.createUser(options);
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

/** Runs method calls with the blob capability; answers the method responses */
const call = (client, calls, using = USING) => client.call(calls, using);

/** One method with the blob capability; answers its arguments, throws with the type of an error */
const method = (client, name, args, using = USING) => client.method(name, args, using);

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
    return err.response;
}

/** Creates blobs with Blob/upload: {creationId: object}; answers the response */
const uploadBlobs = (client, create) => method(client, 'Blob/upload', { create });

/** Creates one blob from text; answers its id */
async function textBlob(client, text, type = 'text/plain') {
    const res = await uploadBlobs(client, { t: { data: [{ 'data:asText': text }], type } });
    expect(res.created, JSON.stringify(res.notCreated)).to.have.property('t');
    return res.created.t.id;
}

async function rawBlob(client, buffer) {
    const res = await uploadBlobs(client, { t: { data: [{ 'data:asBase64': buffer.toString('base64') }] } });
    expect(res.created, JSON.stringify(res.notCreated)).to.have.property('t');
    return res.created.t.id;
}

const download = (client, blobId) => client.raw(`/jmap/download/${client.accountId}/${blobId}/file.bin?type=application/octet-stream`);

/** The stored document of a message by its Message-ID, once it exists */
async function storedDoc(user, messageId) {
    const db = await seed.db();
    return clock.waitFor(
        () =>
            db
                .collection('messages')
                .find({ user: new seed.ObjectId(user.id), msgid: messageId })
                .sort({ _id: -1 })
                .limit(1)
                .next(),
        { message: `message ${messageId} not stored` }
    );
}

const messageIdOf = raw => /^Message-ID: (.*)$/im.exec(raw.toString())[1].trim();

/** Appends a raw message over IMAP and answers its Email id */
async function append(user, raw, mailbox = 'INBOX') {
    await seed.withImap(user, imap => imap.append(mailbox, raw));
    const doc = await storedDoc(user, messageIdOf(raw));
    return `M${doc.root}`;
}

function plainMessage(subject = `Plain ${tag()}`, body = 'Hello there.\r\nSecond line.\r\n') {
    return Buffer.from(
        [
            'From: Sender <sender@example.net>',
            'To: Recipient <recipient@example.com>',
            `Subject: ${subject}`,
            `Message-ID: <${tag()}.${Date.now()}@scenario.example>`,
            `Date: ${new Date().toUTCString()}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=us-ascii',
            'Content-Transfer-Encoding: 7bit',
            '',
            body
        ].join(CRLF)
    );
}

const BINARY = crypto.randomBytes(3000);

function messageWithAttachment(subject = `Attachment ${tag()}`) {
    const boundary = `b-${tag()}`;
    const head = [
        'From: Sender <sender@example.net>',
        'To: Recipient <recipient@example.com>',
        `Subject: ${subject}`,
        `Message-ID: <${tag()}.${Date.now()}@scenario.example>`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`
    ].join(CRLF);
    const parts = [
        ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', 'See the attachment.'].join(CRLF),
        [
            'Content-Type: application/octet-stream; name="data.bin"',
            'Content-Disposition: attachment; filename="data.bin"',
            'Content-Transfer-Encoding: base64',
            '',
            BINARY.toString('base64').replace(/.{76}/g, `$&${CRLF}`)
        ].join(CRLF)
    ];
    const body = parts.map(part => `--${boundary}${CRLF}${part}${CRLF}`).join('') + `--${boundary}--${CRLF}`;
    return Buffer.from(`${head}${CRLF}${CRLF}${body}`);
}

async function emailOf(client, emailId, properties = ['blobId', 'size', 'threadId', 'mailboxIds', 'attachments', 'textBody']) {
    const res = await client.method('Email/get', { ids: [emailId], properties, bodyProperties: ['partId', 'blobId', 'size', 'type'] });
    expect(res.notFound).to.deep.equal([]);
    return res.list[0];
}

/** Uploads a body through the upload endpoint as another user; answers the blob id */
async function foreignUpload() {
    const { client } = await setupUser();
    const res = await client.raw(`/jmap/upload/${client.accountId}/`, { method: 'POST', body: 'foreign data', headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).to.equal(201);
    return res.json.blobId;
}

describe('JMAP blob management (blob.yaml, RFC 9404)', () => {
    let user;
    let client;

    before(async () => {
        ({ user, client } = await setupUser());
    });

    describe('Capability', () => {
        scenario('BLOB-050', async () => {
            const session = await client.session();
            expect(session.capabilities[jmap.URN.blob]).to.deep.equal({});
            const capability = session.accounts[client.accountId].accountCapabilities[jmap.URN.blob];
            expect(capability).to.be.an('object');
            expect(capability.maxSizeBlobSet === null || (Number.isInteger(capability.maxSizeBlobSet) && capability.maxSizeBlobSet >= 0)).to.be.true;
            expect(capability.maxDataSources).to.be.a('number').and.at.least(64);
            expect([...capability.supportedTypeNames].sort()).to.deep.equal(['CalendarEvent', 'ContactCard', 'Email', 'Mailbox', 'Thread']);
            expect(capability.supportedDigestAlgorithms).to.be.an('array').that.includes.members(['sha', 'sha-256']);
            for (const name of capability.supportedDigestAlgorithms) {
                expect(name).to.equal(name.toLowerCase());
            }
            expect(session.primaryAccounts[jmap.URN.blob]).to.equal(client.accountId);
        });

        scenario('BLOB-051', async () => {
            const emailId = await append(user, plainMessage());
            const { blobId } = await emailOf(client, emailId, ['blobId']);
            const calls = [
                ['Blob/get', { accountId: client.accountId, ids: [blobId], properties: ['size'] }, 'g'],
                ['Blob/upload', { accountId: client.accountId, create: { u: { data: [{ 'data:asText': 'x' }] } } }, 'u'],
                ['Blob/lookup', { accountId: client.accountId, typeNames: ['Email'], ids: [blobId] }, 'l']
            ];
            const without = await call(client, calls, [jmap.URN.core, jmap.URN.mail]);
            expect(without.map(([name, args]) => [name, args.type])).to.deep.equal([
                ['error', 'unknownMethod'],
                ['error', 'unknownMethod'],
                ['error', 'unknownMethod']
            ]);
            const withBlob = await call(client, calls);
            expect(withBlob.map(([name]) => name)).to.deep.equal(['Blob/get', 'Blob/upload', 'Blob/lookup']);
        });
    });

    describe('Blob/upload', () => {
        scenario('BLOB-052', async () => {
            const unicode = 'é€😀';
            const res = await uploadBlobs(client, {
                t: { data: [{ 'data:asText': 'Hello, world!' }], type: 'text/plain' },
                u: { data: [{ 'data:asText': unicode }], type: 'text/plain' }
            });
            expect(res.accountId).to.equal(client.accountId);
            expect(res.notCreated === null || res.notCreated === undefined).to.be.true;
            expect(res.created.t.id).to.match(UPLOAD_ID);
            expect(res.created.t.type).to.equal('text/plain');
            expect(res.created.t.size).to.equal(13);
            expect(res.created.u.size).to.equal(Buffer.byteLength(unicode));
            expect(res.created.u.size).to.not.equal(unicode.length);
        });

        scenario('BLOB-053', async () => {
            const res = await uploadBlobs(client, { p: { data: [{ 'data:asBase64': PNG.toString('base64') }], type: 'image/png' } });
            expect(res.created.p.size).to.equal(95);
            expect(res.created.p.type).to.equal('image/png');
            const downloaded = await download(client, res.created.p.id);
            expect(downloaded.status).to.equal(200);
            expect(downloaded.body.equals(PNG)).to.be.true;
        });

        scenario('BLOB-054', async () => {
            const res = await uploadBlobs(client, {
                a: { data: [{ 'data:asText': '<html><body>hi</body></html>' }] },
                b: { data: [{ 'data:asText': '<html><body>hi</body></html>' }], type: null }
            });
            expect(res.created.a.type).to.equal('application/octet-stream');
            expect(res.created.b.type).to.equal('application/octet-stream');
        });

        scenario('BLOB-055', async () => {
            const [[, uploaded], [, got]] = await call(client, [
                ['Blob/upload', { accountId: client.accountId, create: { e: { data: [] } } }, 'u'],
                ['Blob/get', { accountId: client.accountId, ids: ['#e'], properties: ['data:asText', 'size'] }, 'g']
            ]);
            expect(uploaded.created.e.id).to.match(UPLOAD_ID);
            expect(uploaded.created.e.size).to.equal(0);
            expect(got.list[0]['data:asText']).to.equal('');
            expect(got.list[0].size).to.equal(0);
        });

        scenario('BLOB-056', async () => {
            const responses = await call(client, [
                ['Blob/upload', { accountId: client.accountId, create: { b4: { data: [{ 'data:asText': PANGRAM }] } } }, 'S4'],
                [
                    'Blob/upload',
                    {
                        accountId: client.accountId,
                        create: {
                            cat: {
                                data: [
                                    { 'data:asText': 'How' },
                                    { blobId: '#b4', offset: 3, length: 7 },
                                    { 'data:asText': 'was t' },
                                    { blobId: '#b4', offset: 1, length: 1 },
                                    { 'data:asBase64': 'YXQ/' }
                                ]
                            }
                        }
                    },
                    'CAT'
                ],
                ['Blob/get', { accountId: client.accountId, ids: ['#cat'], properties: ['data:asText', 'size'] }, 'G4']
            ]);
            expect(responses[0][1].created.b4.size).to.equal(45);
            expect(responses[1][1].created.cat.size).to.equal(19);
            expect(responses[2][1].list[0]['data:asText']).to.equal('How quick was that?');
            expect(responses[2][1].list[0].size).to.equal(19);
            expect(responses[2][1].list[0].id).to.equal(responses[1][1].created.cat.id);
        });

        scenario('BLOB-057', async () => {
            const raw = messageWithAttachment();
            const emailId = await append(user, raw);
            const email = await emailOf(client, emailId);
            const partBlob = email.attachments[0].blobId;
            const res = await uploadBlobs(client, {
                whole: { data: [{ blobId: email.blobId }] },
                part: { data: [{ blobId: partBlob, offset: null, length: null }] },
                tail: { data: [{ blobId: partBlob, offset: 2 }] }
            });
            expect(res.created.whole.size).to.equal(email.size);
            expect(res.created.part.size).to.equal(BINARY.length);
            expect(res.created.tail.size).to.equal(BINARY.length - 2);
            expect((await download(client, res.created.whole.id)).body.equals(raw)).to.be.true;
            expect((await download(client, res.created.part.id)).body.equals(BINARY)).to.be.true;
            expect((await download(client, res.created.tail.id)).body.equals(BINARY.subarray(2))).to.be.true;
        });

        scenario('BLOB-058', async () => {
            const res = await client.request({
                using: USING,
                createdIds: {},
                methodCalls: [
                    [
                        'Blob/upload',
                        { accountId: client.accountId, create: { t: { data: [{ 'data:asText': 't' }] }, b: { data: [{ 'data:asText': 'b' }] } } },
                        'u'
                    ]
                ]
            });
            expect(res.status).to.equal(200);
            const created = res.json.methodResponses[0][1].created;
            expect(res.json.createdIds).to.deep.equal({ t: created.t.id, b: created.b.id });
        });

        scenario('BLOB-059', async () => {
            const { mailboxes } = await accountsMailboxes();
            const raw = plainMessage(`Imported ${tag()}`).toString();
            const res = await client.request({
                using: USING,
                methodCalls: [
                    ['Blob/upload', { accountId: client.accountId, create: { msg: { data: [{ 'data:asText': raw }], type: 'message/rfc822' } } }, 'u'],
                    ['Email/import', { accountId: client.accountId, emails: { e: { blobId: '#msg', mailboxIds: { [mailboxes.inbox]: true } } } }, 'i']
                ]
            });
            expect(res.status).to.equal(200);
            expect(res.json).to.not.have.property('createdIds');
            const [, imported] = res.json.methodResponses[1];
            expect(imported.notCreated || {}).to.deep.equal({});
            expect(imported.created.e.id).to.match(/^M[0-9a-f]{24}$/);
            expect(imported.created.e.blobId).to.not.equal(res.json.methodResponses[0][1].created.msg.id);
        });

        // Inbox id of the shared user
        async function accountsMailboxes() {
            const res = await client.method('Mailbox/get', { ids: null, properties: ['role'] });
            return { mailboxes: { inbox: res.list.find(mailbox => mailbox.role === 'inbox').id } };
        }

        scenario('BLOB-060', async () => {
            const foreign = await foreignUpload();
            const own = await textBlob(client, 'own data');
            const res = await uploadBlobs(client, {
                unknown: { data: [{ blobId: `Bu${crypto.randomBytes(12).toString('hex')}` }] },
                foreign: { data: [{ blobId: foreign }] },
                missing: { data: [{ blobId: '#nosuch' }] },
                valid: { data: [{ blobId: own }] }
            });
            for (const creationId of ['unknown', 'foreign', 'missing']) {
                expect(res.notCreated[creationId].type, creationId).to.equal('invalidProperties');
            }
            expect(res.notCreated.foreign).to.deep.equal(res.notCreated.unknown);
            expect(res.created).to.have.all.keys('valid');
            expect(res.created.valid.size).to.equal(8);
        });

        scenario('BLOB-061', async () => {
            const source = await textBlob(client, 'abcde');
            const res = await uploadBlobs(client, {
                long: { data: [{ blobId: source, offset: 3, length: 10 }] },
                past: { data: [{ blobId: source, offset: 6 }] },
                empty: { data: [{ blobId: source, offset: 5, length: 0 }] },
                whole: { data: [{ blobId: source, offset: 0, length: 5 }] }
            });
            expect(res.notCreated).to.have.all.keys('long', 'past');
            expect(res.created.empty.size).to.equal(0);
            expect(res.created.whole.size).to.equal(5);
        });

        scenario('BLOB-062', async () => {
            const res = await uploadBlobs(client, {
                bad: { data: [{ 'data:asBase64': 'not*base64!' }] },
                middle: { data: [{ 'data:asBase64': 'aGVsbG8=YQ==' }] },
                good: { data: [{ 'data:asBase64': 'aGVsbG8=' }] }
            });
            expect(res.notCreated.bad.type).to.equal('invalidProperties');
            expect(res.notCreated.middle.type).to.equal('invalidProperties');
            expect(res.created.good.size).to.equal(5);
        });

        scenario('BLOB-063', async () => {
            const source = await textBlob(client, 'source');
            const res = await uploadBlobs(client, {
                both: { data: [{ 'data:asText': 'a', 'data:asBase64': 'YQ==' }] },
                textBlob: { data: [{ 'data:asText': 'a', blobId: source }] },
                none: { data: [{}] },
                hex: { data: [{ 'data:asHex': '61' }] },
                offset: { data: [{ 'data:asText': 'abc', offset: 1 }] }
            });
            expect(res.created === null || res.created === undefined).to.be.true;
            for (const creationId of ['both', 'textBlob', 'none', 'hex', 'offset']) {
                expect(res.notCreated[creationId].type, creationId).to.equal('invalidProperties');
            }
        });

        scenario('BLOB-065', async () => {
            const fresh = await setupUser();
            const session = await fresh.client.session();
            const max = session.accounts[fresh.client.accountId].accountCapabilities[jmap.URN.blob].maxDataSources;
            expect(max).to.be.at.least(64);
            const db = await seed.db();
            const files = () => db.collection('storage.files').countDocuments({ 'metadata.user': new seed.ObjectId(fresh.user.id) });
            const res = await uploadBlobs(fresh.client, {
                full: { data: Array.from({ length: max }, () => ({ 'data:asText': 'x' })) },
                over: { data: Array.from({ length: max + 1 }, () => ({ 'data:asText': 'x' })) }
            });
            expect(res.created.full.size).to.equal(max);
            expect(['invalidProperties', 'tooLarge']).to.include(res.notCreated.over.type);
            expect(await files()).to.equal(1);
        });

        scenario('BLOB-066', async () => {
            const res = await uploadBlobs(client, {
                ok: { data: [{ 'data:asText': 'fine' }] },
                broken: { data: [{ 'data:asBase64': '***' }] }
            });
            expect(res.created).to.have.all.keys('ok');
            expect(res.notCreated).to.have.all.keys('broken');
            await expectError(method(client, 'Blob/upload', { create: {}, update: { x: {} } }), 'invalidArguments');
            await expectError(method(client, 'Blob/upload', { create: {}, destroy: [res.created.ok.id] }), 'invalidArguments');
            // nothing was destroyed
            expect((await download(client, res.created.ok.id)).status).to.equal(200);
        });

        scenario('BLOB-067', async () => {
            const fresh = await setupUser();
            const res = await uploadBlobs(fresh.client, { png: { data: [{ 'data:asText': 'this is not a PNG image' }], type: 'image/png' } });
            expect(res.created.png.type).to.equal('image/png');
            const blobId = res.created.png.id;
            const downloaded = await download(fresh.client, blobId);
            expect(downloaded.status).to.equal(200);
            expect(downloaded.body.toString()).to.equal('this is not a PNG image');

            // stored as a temporary upload: counted in the upload quota, never in the mail quota
            const db = await seed.db();
            const file = await db.collection('storage.files').findOne({ _id: new seed.ObjectId(blobId.slice(2)) });
            expect(file.metadata.user.toString()).to.equal(fresh.user.id);
            expect(file.length).to.equal(23);
            const ttl = ((config.jmap.limits && config.jmap.limits.uploadTtl) || 24 * 3600) * 1000;
            expect(ttl).to.be.at.least(3600 * 1000);
            expect(file.metadata.expires.getTime() - Date.now()).to.be.closeTo(ttl, 60 * 1000);

            const connected = await connect();
            const storage = new StorageHandler({ database: connected.database, users: connected.users, gridfs: connected.gridfs });
            const err = await storage.makeRoom(new seed.ObjectId(fresh.user.id), 0, 22).catch(error => error);
            // the only upload was evicted to make room: it counted against the upload quota
            expect(err).to.not.be.an('error');
            expect((await download(fresh.client, blobId)).status).to.equal(404);

            // and one that expires is removed like an endpoint upload
            const second = await textBlob(fresh.client, 'short lived');
            await db
                .collection('storage.files')
                .updateOne({ _id: new seed.ObjectId(second.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() - 1000) } });
            expect((await download(fresh.client, second)).status).to.equal(404);
            await storage.removeExpiredUploads();
            expect(await db.collection('storage.files').countDocuments({ _id: new seed.ObjectId(second.slice(2)) })).to.equal(0);
        });

        describe('size limits', () => {
            let instance;
            let small;
            const LIMIT = 200000;

            before(async () => {
                instance = await startInstance({
                    limits: Object.assign({}, config.jmap.limits, { maxSizeBlobSet: LIMIT, maxDataSources: 128 })
                });
                small = new jmap.JmapClient(jmap.basic(user.username, user.password));
                small.raw = (
                    (raw, base) => (path, init) =>
                        raw.call(small, path.startsWith('http') ? path : base + path, init)
                )(small.raw, instance.url);
                await small.session();
            });

            after(async () => {
                await stopInstance(instance && instance.app);
            });

            scenario('BLOB-064', async () => {
                const session = await small.session();
                expect(session.accounts[small.accountId].accountCapabilities[jmap.URN.blob].maxSizeBlobSet).to.equal(LIMIT);
                const references = (id, count) => Array.from({ length: count }, () => ({ blobId: id }));
                const responses = await small.call(
                    [
                        ['Blob/upload', { accountId: small.accountId, create: { seed: { data: [{ 'data:asText': 'x'.repeat(600) }] } } }, 's'],
                        ['Blob/upload', { accountId: small.accountId, create: { level1: { data: references('#seed', 100) } } }, '1'],
                        [
                            'Blob/upload',
                            {
                                accountId: small.accountId,
                                create: {
                                    level2: { data: references('#level1', Math.ceil(LIMIT / 60000) + 1) },
                                    literal: { data: [{ 'data:asText': 'y'.repeat(LIMIT + 1) }] }
                                }
                            },
                            '2'
                        ]
                    ],
                    USING
                );
                expect(responses[0][1].created.seed.size).to.equal(600);
                expect(responses[1][1].created.level1.size).to.equal(60000);
                expect(responses[2][1].notCreated.level2.type).to.equal('tooLarge');
                expect(responses[2][1].notCreated.literal.type).to.equal('tooLarge');
                expect(responses[2][1].created === null || responses[2][1].created === undefined).to.be.true;
            });
        });
    });

    describe('Blob/get', () => {
        let pangram;

        before(async () => {
            pangram = await textBlob(client, PANGRAM);
        });

        scenario('BLOB-068', async () => {
            const text = 'Grüße, world';
            const id = await textBlob(client, text);
            const res = await method(client, 'Blob/get', { ids: [id] });
            expect(res.list).to.have.length(1);
            const [blob] = res.list;
            expect(blob.id).to.equal(id);
            expect(blob['data:asText']).to.equal(text);
            expect(blob.size).to.equal(Buffer.byteLength(text));
            expect(blob.isTruncated || false).to.be.false;
            expect(blob.isEncodingProblem || false).to.be.false;
            expect(res.notFound).to.deep.equal([]);
        });

        scenario('BLOB-069', async () => {
            const body = 'Plain ASCII body.\r\nWith two lines.\r\n';
            const raw = plainMessage(`ASCII ${tag()}`, body);
            const emailId = await append(user, raw);
            const email = await emailOf(client, emailId);
            const textPart = email.textBody[0].blobId;
            const res = await method(client, 'Blob/get', { ids: [email.blobId, textPart], properties: ['data:asText', 'data:asBase64', 'size'] });
            const byId = Object.fromEntries(res.list.map(blob => [blob.id, blob]));
            const expected = { [email.blobId]: raw, [textPart]: Buffer.from(body) };
            for (const [id, content] of Object.entries(expected)) {
                expect(byId[id]['data:asText'], id).to.equal(content.toString());
                expect(byId[id]['data:asBase64'], id).to.equal(content.toString('base64'));
                expect(byId[id]['data:asBase64']).to.not.match(/\s/);
                expect(byId[id].size, id).to.equal(content.length);
            }
        });

        scenario('BLOB-070', async () => {
            let res = await method(client, 'Blob/get', { ids: [pangram], offset: 4, length: 5, properties: ['data:asText', 'data:asBase64', 'size'] });
            expect(res.list[0]['data:asText']).to.equal('quick');
            expect(res.list[0]['data:asBase64']).to.equal(Buffer.from('quick').toString('base64'));
            expect(res.list[0].size).to.equal(45);
            expect(res.list[0].isTruncated || false).to.be.false;
            res = await method(client, 'Blob/get', { ids: [pangram], offset: 40, length: null, properties: ['data:asText', 'size'] });
            expect(res.list[0]['data:asText']).to.equal(PANGRAM.slice(40));
            expect(res.list[0]['data:asText']).to.have.length(5);
            expect(res.list[0].isTruncated || false).to.be.false;
        });

        scenario('BLOB-071', async () => {
            const get = args =>
                method(client, 'Blob/get', Object.assign({ ids: [pangram], properties: ['data:asText', 'size'] }, args)).then(res => res.list[0]);
            const past = await get({ offset: 40, length: 100 });
            expect(past['data:asText']).to.equal(PANGRAM.slice(40));
            expect(past.isTruncated).to.equal(true);
            const beyond = await get({ offset: 1000 });
            expect(beyond['data:asText']).to.equal('');
            expect(beyond.isTruncated).to.equal(true);
            const end = await get({ offset: 45, length: 0 });
            expect(end['data:asText']).to.equal('');
            expect(end.isTruncated || false).to.be.false;
        });

        scenario('BLOB-072', async () => {
            const bytes = Buffer.concat([Buffer.from('abc'), Buffer.from([0x81, 0x81]), Buffer.from('def')]);
            const id = await rawBlob(client, bytes);
            const [byDefault] = (await method(client, 'Blob/get', { ids: [id] })).list;
            expect(byDefault.isEncodingProblem).to.equal(true);
            expect(byDefault['data:asBase64']).to.equal(bytes.toString('base64'));
            expect(byDefault['data:asText'] === null || byDefault['data:asText'] === undefined).to.be.true;
            const [text] = (await method(client, 'Blob/get', { ids: [id], properties: ['data:asText'] })).list;
            expect(text.isEncodingProblem).to.equal(true);
            expect(text['data:asText']).to.equal(null);
            expect(text).to.not.have.property('data:asBase64');
            const [base64] = (await method(client, 'Blob/get', { ids: [id], properties: ['data:asBase64'] })).list;
            expect(base64['data:asBase64']).to.equal(bytes.toString('base64'));
            expect(base64.isEncodingProblem || false).to.be.false;
        });

        scenario('BLOB-073', async () => {
            // the fourth and fifth octets are one character
            const id = await textBlob(client, 'abcé');
            const [cut] = (await method(client, 'Blob/get', { ids: [id], offset: 0, length: 4, properties: ['data:asText'] })).list;
            expect(cut.isEncodingProblem).to.equal(true);
            expect(cut['data:asText']).to.equal(null);
            const [whole] = (await method(client, 'Blob/get', { ids: [id], offset: 0, length: 5, properties: ['data:asText'] })).list;
            expect(whole['data:asText']).to.equal('abcé');
            expect(whole.isEncodingProblem || false).to.be.false;
        });

        scenario('BLOB-074', async () => {
            const digest = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('base64');
            const properties = ['digest:sha', 'digest:sha-256'];
            const ranges = [
                [{}, Buffer.from(PANGRAM)],
                [{ offset: 4, length: 5 }, Buffer.from('quick')],
                [{ offset: 40, length: 100 }, Buffer.from(PANGRAM.slice(40))]
            ];
            for (const [range, octets] of ranges) {
                const [blob] = (await method(client, 'Blob/get', Object.assign({ ids: [pangram], properties }, range))).list;
                expect(blob['digest:sha'], JSON.stringify(range)).to.equal(digest('sha1', octets));
                expect(blob['digest:sha-256'], JSON.stringify(range)).to.equal(digest('sha256', octets));
                expect(blob['digest:sha']).to.not.match(/^[0-9a-f]{40}$/);
                const keys = Object.keys(blob).filter(key => key !== 'isTruncated');
                expect(keys.sort()).to.deep.equal(['digest:sha', 'digest:sha-256', 'id']);
            }
        });

        scenario('BLOB-075', async () => {
            const session = await client.session();
            expect(session.accounts[client.accountId].accountCapabilities[jmap.URN.blob].supportedDigestAlgorithms).to.not.include('nosuch');
            for (const properties of [['digest:nosuch'], ['digest:SHA-256'], ['data:asHex']]) {
                await expectError(method(client, 'Blob/get', { ids: [pangram], properties }), 'invalidArguments');
            }
        });

        scenario('BLOB-076', async function () {
            this.timeout(180000);
            const fresh = await setupUser();
            const line = 'x'.repeat(76) + CRLF;
            const body = line.repeat(Math.ceil((20 * 1024 * 1024) / line.length));
            const raw = plainMessage(`Large ${tag()}`, body);
            const emailId = await append(fresh.user, raw);
            const email = await emailOf(fresh.client, emailId, ['blobId', 'size']);
            expect(email.size).to.be.above(20 * 1024 * 1024);
            const started = Date.now();
            const res = await fresh.client.request({
                using: USING,
                methodCalls: [['Blob/get', { accountId: fresh.client.accountId, ids: [email.blobId], properties: ['size'] }, 'g']]
            });
            const elapsed = Date.now() - started;
            const [blob] = res.json.methodResponses[0][1].list;
            expect(blob).to.deep.equal({ id: email.blobId, size: email.size });
            expect(res.body.length).to.be.below(1024);
            expect(elapsed).to.be.below(2000);
        });

        scenario('BLOB-077', async () => {
            const foreign = await foreignUpload();
            const res = await method(client, 'Blob/get', { ids: [pangram, foreign, 'not-a-blob'], properties: ['size'] });
            expect(res.list.map(blob => blob.id)).to.deep.equal([pangram]);
            expect(res.notFound).to.have.members([foreign, 'not-a-blob']);
        });

        scenario('BLOB-078', async () => {
            await expectError(method(client, 'Blob/get', { ids: null }), 'invalidArguments');
            await expectError(method(client, 'Blob/get', {}), 'invalidArguments');
        });
    });

    describe('Blob/lookup', () => {
        let inbox;
        let archive;

        before(async () => {
            const res = await client.method('Mailbox/get', { ids: null, properties: ['role', 'name'] });
            inbox = res.list.find(mailbox => mailbox.role === 'inbox').id;
            archive = res.list.find(mailbox => mailbox.role === 'archive');
            if (!archive) {
                const created = await client.method('Mailbox/set', { create: { a: { name: `Archive ${tag()}` } } });
                archive = created.created.a.id;
            } else {
                archive = archive.id;
            }
        });

        const lookup = (ids, typeNames = ['Mailbox', 'Thread', 'Email'], using) => method(client, 'Blob/lookup', { typeNames, ids }, using);

        scenario('BLOB-079', async () => {
            const emailId = await append(user, plainMessage());
            const email = await emailOf(client, emailId);
            const res = await lookup([email.blobId]);
            expect(res.list).to.deep.equal([{ id: email.blobId, matchedIds: { Mailbox: [inbox], Thread: [email.threadId], Email: [emailId] } }]);
        });

        scenario('BLOB-080', async () => {
            const emailId = await append(user, messageWithAttachment());
            const email = await emailOf(client, emailId);
            const res = await lookup([email.attachments[0].blobId], ['Email', 'Mailbox']);
            expect(res.list).to.have.length(1);
            expect(res.list[0].matchedIds).to.deep.equal({ Email: [emailId], Mailbox: [inbox] });
        });

        scenario('BLOB-081', async () => {
            const other = await setupUser();
            const otherEmail = await append(other.user, plainMessage());
            const foreign = (await emailOf(other.client, otherEmail, ['blobId'])).blobId;
            const random = `Bm${crypto.randomBytes(12).toString('hex')}`;
            const unreferenced = await textBlob(client, 'not in any message');
            const res = await lookup([random, foreign, unreferenced]);
            const empty = { Mailbox: [], Thread: [], Email: [] };
            expect(res.list).to.deep.equal([
                { id: random, matchedIds: empty },
                { id: foreign, matchedIds: empty },
                { id: unreferenced, matchedIds: empty }
            ]);
        });

        scenario('BLOB-082', async () => {
            const emailId = await append(user, plainMessage());
            const { blobId } = await emailOf(client, emailId, ['blobId']);
            await expectError(lookup([blobId], ['Email', 'NoSuchType']), 'unknownDataType');
            await expectError(lookup([blobId], ['Email'], [jmap.URN.core, jmap.URN.blob]), 'unknownDataType');
            await expectError(lookup([blobId], ['SearchSnippet']), 'unknownDataType');
        });

        scenario('BLOB-083', async () => {
            const res = await lookup([]);
            expect(res.list).to.deep.equal([]);
        });

        scenario('BLOB-084', async () => {
            const raw = plainMessage();
            const emailId = await append(user, raw);
            const email = await emailOf(client, emailId);
            let res = await lookup([email.blobId]);
            expect(res.list[0].matchedIds.Mailbox).to.deep.equal([inbox]);

            const archivePath = (await client.method('Mailbox/get', { ids: [archive], properties: ['name'] })).list[0].name;
            const doc = await storedDoc(user, messageIdOf(raw));
            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('INBOX');
                await imap.messageMove(String(doc.uid), archivePath, { uid: true });
            });
            await clock.waitFor(async () => (await lookup([email.blobId])).list[0].matchedIds.Mailbox[0] === archive, { message: 'not moved' });
            res = await lookup([email.blobId]);
            expect(res.list[0].matchedIds).to.deep.equal({ Mailbox: [archive], Thread: [email.threadId], Email: [emailId] });

            const moved = await storedDoc(user, messageIdOf(raw));
            await seed.withImap(user, async imap => {
                await imap.mailboxOpen(archivePath);
                await imap.messageFlagsAdd(String(moved.uid), ['\\Deleted'], { uid: true });
            });
            res = await lookup([email.blobId]);
            expect(res.list[0].matchedIds).to.deep.equal({ Mailbox: [], Thread: [], Email: [] });
        });

        scenario('BLOB-085', async () => {
            const raw = plainMessage();
            const originalId = await append(user, raw);
            const doc = await storedDoc(user, messageIdOf(raw));
            const archivePath = (await client.method('Mailbox/get', { ids: [archive], properties: ['name'] })).list[0].name;
            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('INBOX');
                await imap.messageCopy(String(doc.uid), archivePath, { uid: true });
            });
            const db = await seed.db();
            const copy = await clock.waitFor(
                () =>
                    db
                        .collection('messages')
                        .findOne({ user: new seed.ObjectId(user.id), msgid: messageIdOf(raw), mailbox: new seed.ObjectId(archive.slice(1)) }),
                {
                    message: 'copy not stored'
                }
            );
            const copyId = `M${copy.root}`;
            expect(copyId).to.not.equal(originalId);
            const original = await emailOf(client, originalId, ['blobId']);
            const copied = await emailOf(client, copyId, ['blobId']);
            expect(copied.blobId).to.not.equal(original.blobId);
            const res = await lookup([original.blobId, copied.blobId], ['Email', 'Mailbox']);
            expect(res.list).to.deep.equal([
                { id: original.blobId, matchedIds: { Email: [originalId], Mailbox: [inbox] } },
                { id: copied.blobId, matchedIds: { Email: [copyId], Mailbox: [archive] } }
            ]);
        });
    });
});
