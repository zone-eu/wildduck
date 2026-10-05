/* eslint no-invalid-this: 0, no-unused-expressions: 0 */
/* global before, after */
'use strict';

const { expect } = require('chai');
const { simpleParser } = require('mailparser');
const { ObjectId } = require('mongodb');
const { HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { S3TestEnvironment, collect, binaryParser, ageChunks } = require('./attachment-s3-helpers');

const endpoint = process.env.S3_TEST_ENDPOINT;
const binary = Buffer.from(Array.from({ length: 4097 }, (value, index) => index % 256));

function fixture(name, encoding = 'base64', body = binary, width = 76) {
    let encoded;
    if (encoding === 'base64') {
        encoded = Buffer.from(
            body
                .toString('base64')
                .match(new RegExp(`.{1,${width}}`, 'g'))
                .join('\r\n')
        );
    } else if (encoding === 'quoted-printable') {
        encoded = Buffer.from('hello=20world=0D=0Awith=20soft=\r\nbreak=20and=20=3D');
        body = Buffer.from('hello world\r\nwith softbreak and =');
    } else {
        encoded = body;
    }
    const source = Buffer.concat([
        Buffer.from(
            [
                'From: sender@example.test',
                'To: recipient@example.test',
                `Subject: ${name}`,
                `Message-ID: <${name}@example.test>`,
                'Date: Tue, 01 Sep 2026 12:00:00 +0000',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="attachment-test"',
                '',
                '--attachment-test',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'Message body',
                '--attachment-test',
                'Content-Type: application/octet-stream',
                `Content-Transfer-Encoding: ${encoding}`,
                'Content-Disposition: attachment; filename="payload.bin"',
                '',
                ''
            ].join('\r\n')
        ),
        encoded,
        Buffer.from('\r\n--attachment-test--\r\n')
    ]);
    return { name, source, attachments: [{ filename: 'payload.bin', body, encoded, part: '2' }] };
}

const fixtures = [
    fixture('wrapped-base64'),
    fixture('short-base64-lines', 'base64', binary, 64),
    fixture('unwrapped-base64', 'base64', binary, 10000),
    fixture('base64-padding-one', 'base64', Buffer.alloc(1024, 97)),
    fixture('base64-padding-two', 'base64', Buffer.alloc(1025, 98)),
    fixture('quoted-printable', 'quoted-printable'),
    // WildDuck's MIME parser canonicalizes bare CR/LF, so use a binary part without bare line breaks.
    fixture('binary', 'binary', Buffer.from(binary.map(value => (value === 10 || value === 13 ? 0 : value)))),
    fixture('eight-bit', '8bit', Buffer.from('UTF-8 attachment: café\r\n'.repeat(100))),
    fixture('large-multiple-gridfs-chunks', 'base64', Buffer.alloc(600 * 1024, 173))
];

(endpoint ? describe : describe.skip)('S3 and GridFS message protocol parity (Moto)', function () {
    this.timeout(60000);
    let environment;
    const servers = {};

    before(async () => {
        environment = new S3TestEnvironment(endpoint);
        await environment.start();
        for (const type of ['gridstore', 's3']) {
            servers[type] = await environment.createServer(type);
        }
    });

    after(async () => {
        await environment?.close();
    });

    function messagePath(account, uid, mailbox = account.inbox) {
        return `/users/${account.user}/mailboxes/${mailbox}/messages/${uid}`;
    }

    async function bytes(server, path) {
        const response = await server.api.get(path).buffer(true).parse(binaryParser).expect(200);
        return response.body;
    }

    async function upload(server, account, source) {
        const response = await server.api
            .post(`/users/${account.user}/mailboxes/${account.inbox}/messages`)
            .set('Content-Type', 'message/rfc822')
            .send(source)
            .expect(200);
        expect(response.body.success).to.equal(true);
        return response.body.message.id;
    }

    async function verify(server, account, client, uid, sample) {
        await client.mailboxOpen('INBOX');
        const path = messagePath(account, uid);
        const info = (await server.api.get(path).expect(200)).body;
        expect(info.attachments).to.have.length(sample.attachments.length);
        const raw = await bytes(server, `${path}/message.eml`);
        expect(raw.equals(sample.source), 'API reconstructed RFC822 bytes').to.equal(true);
        const fetched = await client.fetchOne(uid, { source: true, size: true, bodyStructure: true, flags: true }, { uid: true });
        expect(fetched.source.equals(raw), 'IMAP and API RFC822 bytes').to.equal(true);
        expect(fetched.size).to.equal(raw.length);
        const parsed = await simpleParser(raw);
        expect(parsed.attachments).to.have.length(sample.attachments.length);
        for (const [index, attachment] of sample.attachments.entries()) {
            const metadata = info.attachments.find(entry => entry.filename === attachment.filename);
            expect(metadata, attachment.filename).to.exist;
            expect((await bytes(server, `${path}/attachments/${metadata.id}`)).equals(attachment.body), 'API decoded attachment').to.equal(true);
            expect(parsed.attachments[index].content.equals(attachment.body), 'mailparser decoded attachment').to.equal(true);
            const part = await client.fetchOne(uid, { bodyParts: [attachment.part] }, { uid: true });
            expect(part.bodyParts.get(attachment.part).equals(attachment.encoded), 'IMAP encoded BODY part').to.equal(true);
            const downloaded = await client.download(uid, attachment.part, { uid: true, chunkSize: 8192 });
            expect((await collect(downloaded.content)).equals(attachment.body), 'IMAP streamed decoded attachment').to.equal(true);
        }
        return {
            raw,
            structure: fetched.bodyStructure,
            sizes: info.attachments.map(attachment => attachment.sizeKb),
            hashes: info.attachments.map(attachment => attachment.hash)
        };
    }

    for (const type of ['gridstore', 's3']) {
        describe(type, () => {
            let server;
            let account;
            let client;

            beforeEach(async () => {
                server = servers[type];
                account = await server.createUser();
                client = await server.connectImap(account);
            });

            afterEach(async () => {
                await server?.disconnectImap();
            });

            for (const sample of fixtures) {
                for (const transport of ['API', 'IMAP APPEND']) {
                    it(`${transport} ${sample.name}: API download, RFC822, IMAP FETCH and streamed BODY`, async () => {
                        const uid = transport === 'API' ? await upload(server, account, sample.source) : (await client.append('INBOX', sample.source)).uid;
                        const result = await verify(server, account, client, uid, sample);
                        const files = await server.database
                            .collection('attachments.files')
                            .find({ _id: { $in: result.hashes.map(hash => Buffer.from(hash, 'hex')) } })
                            .toArray();
                        expect(files).to.have.length(sample.attachments.length);
                        for (const file of files) {
                            if (type === 's3') {
                                expect(file.metadata.storage.backend).to.equal('s3');
                                const location = file.metadata.storage;
                                const object = await environment.client.send(new HeadObjectCommand({ Bucket: location.bucket, Key: location.key }));
                                expect(object.ContentLength).to.equal(file.length);
                                expect(await server.database.collection('attachments.chunks').countDocuments({ files_id: file._id })).to.equal(0);
                            } else {
                                expect(file.metadata.storage).to.not.exist;
                                expect(await server.database.collection('attachments.chunks').countDocuments({ files_id: file._id })).to.be.above(0);
                            }
                        }
                    });
                }
            }

            it('returns byte-exact partial BODY ranges across base64 line endings and EOF', async () => {
                const sample = fixtures[0];
                const uid = await upload(server, account, sample.source);
                await client.mailboxOpen('INBOX');
                for (const [start, maxLength] of [
                    [0, 1],
                    [1, 3],
                    [74, 7],
                    [75, 2],
                    [76, 5],
                    [77, 91],
                    [sample.attachments[0].encoded.length - 3, 100]
                ]) {
                    const part = await client.fetchOne(uid, { bodyParts: [{ key: '2', start, maxLength }] }, { uid: true });
                    expect(part.bodyParts).to.exist;
                    expect(
                        part.bodyParts.get('2').equals(sample.attachments[0].encoded.subarray(start, start + maxLength)),
                        `BODY[2]<${start}.${maxLength}>`
                    ).to.equal(true);
                }
                const attachmentStart = sample.source.indexOf(sample.attachments[0].encoded);
                for (const start of [0, attachmentStart - 10, attachmentStart + 74, sample.source.length - 7]) {
                    const fetched = await client.fetchOne(uid, { source: { start, maxLength: 101 } }, { uid: true });
                    expect(fetched.source.equals(sample.source.subarray(start, start + 101)), `BODY[]<${start}.101>`).to.equal(true);
                }
            });

            it('composes multiple attachments and a CID image through the API', async () => {
                const response = await server.api
                    .post(`/users/${account.user}/mailboxes/${account.inbox}/messages`)
                    .send({
                        from: { address: 'sender@example.test' },
                        to: [{ address: 'recipient@example.test' }],
                        subject: 'Structured attachments',
                        text: 'Plain body',
                        html: '<p>HTML body<img src="cid:logo@example.test"></p>',
                        attachments: [
                            { filename: 'first.bin', contentType: 'application/octet-stream', content: binary.toString('base64') },
                            { filename: 'second.bin', contentType: 'application/octet-stream', content: Buffer.alloc(1234, 42).toString('base64') },
                            {
                                filename: 'logo.png',
                                contentType: 'image/png',
                                content: binary.toString('base64'),
                                cid: 'logo@example.test',
                                contentDisposition: 'inline'
                            }
                        ]
                    })
                    .expect(200);
                const uid = response.body.message.id;
                const path = messagePath(account, uid);
                const info = (await server.api.get(path).expect(200)).body;
                expect(info.attachments).to.have.length(3);
                const raw = await bytes(server, `${path}/message.eml`);
                const parsed = await simpleParser(raw);
                for (const attachment of parsed.attachments) {
                    const expected = attachment.filename === 'second.bin' ? Buffer.alloc(1234, 42) : binary;
                    expect(attachment.content.equals(expected), `${attachment.filename}: ${attachment.content.length}/${expected.length}`).to.equal(true);
                }
                expect(parsed.attachments.find(attachment => attachment.filename === 'logo.png').contentId).to.equal('<logo@example.test>');
                for (const attachment of info.attachments) {
                    const expected = attachment.filename === 'second.bin' ? Buffer.alloc(1234, 42) : binary;
                    expect((await bytes(server, `${path}/attachments/${attachment.id}`)).equals(expected)).to.equal(true);
                }
                await client.mailboxOpen('INBOX');
                expect((await client.fetchOne(uid, { source: true }, { uid: true })).source.equals(raw)).to.equal(true);
            });

            it('deduplicates simultaneous API and IMAP uploads and preserves every message', async () => {
                const sample = fixture(`concurrent-${type}`, 'base64', Buffer.from(`concurrent-${type}`.repeat(350)));
                const uids = await Promise.all([
                    ...Array.from({ length: 5 }, () => upload(server, account, sample.source)),
                    client.append('INBOX', sample.source).then(result => result.uid)
                ]);
                const messages = await server.database
                    .collection('messages')
                    .find({ user: new ObjectId(account.user) })
                    .toArray();
                expect(messages).to.have.length(6);
                const ids = messages.map(message => message.mimeTree.attachmentMap.ATT00001.toString('hex'));
                expect(new Set(ids).size).to.equal(1);
                const file = await server.database.collection('attachments.files').findOne({ _id: Buffer.from(ids[0], 'hex') });
                expect(file.metadata.c).to.equal(6);
                expect(file.metadata.m).to.equal(messages.reduce((sum, message) => sum + message.magic, 0));
                for (const uid of uids) {
                    expect((await bytes(server, `${messagePath(account, uid)}/message.eml`)).equals(sample.source)).to.equal(true);
                }
            });

            it('keeps attachment bytes and reference counts across IMAP COPY, MOVE and deleting the original', async () => {
                const sample = fixture(`copy-${type}`, 'base64', Buffer.alloc(2049, 33));
                const uid = await upload(server, account, sample.source);
                await client.mailboxOpen('INBOX');
                await client.mailboxCreate('Attachment copies');
                await client.mailboxCreate('Attachment moved');
                const copied = await client.messageCopy(uid, 'Attachment copies', { uid: true });
                const moved = await client.messageMove(uid, 'Attachment moved', { uid: true });
                expect(copied).to.be.ok;
                expect(moved).to.be.ok;
                await client.mailboxOpen('Attachment copies');
                const copiedUid = (await client.fetchOne('*', { uid: true })).uid;
                expect((await client.fetchOne(copiedUid, { source: true }, { uid: true })).source.equals(sample.source)).to.equal(true);
                await client.messageDelete(copiedUid, { uid: true });
                await client.mailboxOpen('Attachment moved');
                const movedUid = (await client.fetchOne('*', { uid: true })).uid;
                expect((await client.fetchOne(movedUid, { source: true }, { uid: true })).source.equals(sample.source)).to.equal(true);
                const mailboxes = (await server.api.get(`/users/${account.user}/mailboxes`).expect(200)).body.results;
                const mailbox = mailboxes.find(entry => entry.path === 'Attachment moved').id;
                expect((await bytes(server, `${messagePath(account, movedUid, mailbox)}/message.eml`)).equals(sample.source)).to.equal(true);
                const info = (await server.api.get(messagePath(account, movedUid, mailbox)).expect(200)).body;
                const file = await server.database.collection('attachments.files').findOne({ _id: Buffer.from(info.attachments[0].hash, 'hex') });
                // An expunged copy may be archived; all live and archived references must remain accounted for.
                const references = await server.database.collection('messages').find({ 'mimeTree.attachmentMap.ATT00001': file._id }).toArray();
                references.push(...(await server.database.collection('archived').find({ 'mimeTree.attachmentMap.ATT00001': file._id }).toArray()));
                expect(file.metadata.c).to.equal(references.length);
                expect(file.metadata.m).to.equal(references.reduce((sum, message) => sum + message.magic, 0));
            });

            it('returns 404 for missing attachments without damaging a valid download', async () => {
                const uid = await upload(server, account, fixtures[0].source);
                await server.api.get(`${messagePath(account, uid)}/attachments/ATT99999`).expect(404);
                await server.api.get(`${messagePath(account, uid + 100)}/attachments/ATT00001`).expect(404);
                await verify(server, account, client, uid, fixtures[0]);
            });

            it('replaces and deletes drafts, then collects only their unreferenced payload', async () => {
                const payload = Buffer.from(`draft-lifecycle-${type}`.repeat(100));
                const createDraft = replacePrevious =>
                    server.api
                        .post(`/users/${account.user}/mailboxes/${account.inbox}/messages`)
                        .send({
                            draft: true,
                            subject: 'Draft attachment lifecycle',
                            text: 'Draft body',
                            attachments: [{ filename: 'draft.bin', content: payload.toString('base64'), contentType: 'application/octet-stream' }],
                            ...(replacePrevious ? { replacePrevious } : {})
                        })
                        .expect(200);
                const first = (await createDraft()).body.message.id;
                const info = (await server.api.get(messagePath(account, first)).expect(200)).body;
                const id = Buffer.from(info.attachments[0].hash, 'hex');
                const before = await server.database.collection('attachments.files').findOne({ _id: id });
                expect(before.metadata.c).to.equal(1);
                const second = (await createDraft({ mailbox: account.inbox, id: first })).body.message.id;
                await server.api.get(messagePath(account, first)).expect(404);
                expect((await bytes(server, `${messagePath(account, second)}/attachments/ATT00001`)).equals(payload)).to.equal(true);
                const replaced = await server.database.collection('attachments.files').findOne({ _id: id });
                expect(replaced.metadata.c).to.equal(1);
                await server.api.delete(messagePath(account, second)).expect(200);
                const orphan = await server.database.collection('attachments.files').findOne({ _id: id });
                expect(orphan.metadata.c).to.equal(0);
                expect(orphan.metadata.m).to.equal(0);
                expect(await server.storage.deleteOrphanedAsync()).to.equal(0);
                await server.database.collection('attachments.files').updateOne({ _id: id }, { $set: { 'metadata.cu': new Date(0) } });
                await ageChunks(server.database.collection('attachments.chunks'), id);
                expect(await server.storage.deleteOrphanedAsync()).to.equal(1);
                expect(await server.database.collection('attachments.files').findOne({ _id: id })).to.equal(null);
                expect(await server.database.collection('attachments.chunks').countDocuments({ files_id: id })).to.equal(0);
                if (type === 's3') {
                    let error;
                    try {
                        await environment.client.send(new HeadObjectCommand({ Bucket: before.metadata.storage.bucket, Key: before.metadata.storage.key }));
                    } catch (err) {
                        error = err;
                    }
                    expect(error?.$metadata.httpStatusCode).to.equal(404);
                }
            });

            it('forwards attachments by API reference and keeps them readable after archiving the source', async () => {
                const sample = fixture(`forward-${type}`, 'base64', Buffer.from(`forward-${type}`.repeat(100)));
                const uid = await upload(server, account, sample.source);
                const response = await server.api
                    .post(`/users/${account.user}/mailboxes/${account.inbox}/messages`)
                    .send({
                        draft: true,
                        to: [{ address: 'forward@example.test' }],
                        text: 'Forward body',
                        reference: { mailbox: account.inbox, id: uid, action: 'forward', attachments: true }
                    })
                    .expect(200);
                const forwarded = response.body.message.id;
                await server.api.delete(messagePath(account, uid)).expect(200);
                expect((await bytes(server, `${messagePath(account, forwarded)}/attachments/ATT00001`)).equals(sample.attachments[0].body)).to.equal(true);
                await client.mailboxOpen('INBOX');
                const parsed = await simpleParser((await client.fetchOne(forwarded, { source: true }, { uid: true })).source);
                expect(parsed.attachments[0].content.equals(sample.attachments[0].body)).to.equal(true);
                const info = (await server.api.get(messagePath(account, forwarded)).expect(200)).body;
                const file = await server.database.collection('attachments.files').findOne({ _id: Buffer.from(info.attachments[0].hash, 'hex') });
                expect(file.metadata.c).to.equal(2);
                expect(await server.storage.deleteOrphanedAsync()).to.equal(0);
            });

            it('uploads a plain message without allocating an attachment payload', async () => {
                const source = Buffer.from('From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: No attachment\r\n\r\nPlain body\r\n');
                const count = await server.database.collection('attachments.files').countDocuments();
                const uid = await upload(server, account, source);
                await verify(server, account, client, uid, { source, attachments: [] });
                expect(await server.database.collection('attachments.files').countDocuments()).to.equal(count);
            });
        });
    }

    for (const sample of fixtures) {
        it(`compares S3 and GridFS RFC822, BODYSTRUCTURE and attachment sizes: ${sample.name}`, async () => {
            const results = [];
            try {
                for (const type of ['gridstore', 's3']) {
                    const server = servers[type];
                    const account = await server.createUser();
                    const uid = await upload(server, account, sample.source);
                    results.push(await verify(server, account, await server.connectImap(account), uid, sample));
                }
                expect(results[1]).to.deep.equal(results[0]);
            } finally {
                for (const server of Object.values(servers)) {
                    await server.disconnectImap();
                }
            }
        });
    }

    it('stores actual binary payloads in Moto as exactly one object per catalog record', async () => {
        const server = servers.s3;
        const files = await server.database.collection('attachments.files').find({ 'metadata.storage.backend': 's3' }).toArray();
        expect(files.length).to.be.above(0);
        for (const file of files) {
            const location = file.metadata.storage;
            const object = await environment.client.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }));
            const payload = await collect(object.Body);
            expect(payload.length).to.equal(file.length);
            if (file.metadata.decoded && file.length === binary.length) {
                expect(payload.equals(binary)).to.equal(true);
            }
        }
        const objects = await environment.client.send(new ListObjectsV2Command({ Bucket: environment.bucket, Prefix: server.databaseName }));
        expect(objects.Contents.map(object => object.Key).sort()).to.deep.equal(files.map(file => file.metadata.storage.key).sort());
    });

    it('reads both backends through API and IMAP after switching write preference and restarting', async () => {
        const server = servers.s3;
        const account = await server.createUser();
        const legacy = fixture('legacy-gridfs', 'base64', Buffer.from('legacy GridFS payload'.repeat(100)));
        const modern = fixture('modern-s3', 'base64', Buffer.from('modern S3 payload'.repeat(100)));
        try {
            await server.restart('gridstore');
            const oldUid = await upload(server, account, legacy.source);
            const oldInfo = (await server.api.get(messagePath(account, oldUid)).expect(200)).body;
            const oldId = Buffer.from(oldInfo.attachments[0].hash, 'hex');
            expect((await server.database.collection('attachments.files').findOne({ _id: oldId })).metadata.storage).to.not.exist;
            await server.restart('s3');
            const newUid = await upload(server, account, modern.source);
            const duplicateUid = await upload(server, account, legacy.source);
            const duplicateInfo = (await server.api.get(messagePath(account, duplicateUid)).expect(200)).body;
            expect(duplicateInfo.attachments[0].hash).to.equal(oldInfo.attachments[0].hash);
            const reused = await server.database.collection('attachments.files').findOne({ _id: oldId });
            expect(reused.metadata.storage).to.not.exist;
            expect(reused.metadata.c).to.equal(2);
            for (const preference of ['s3', 'gridstore']) {
                await server.restart(preference);
                const client = await server.connectImap(account);
                await verify(server, account, client, oldUid, legacy);
                await verify(server, account, client, duplicateUid, legacy);
                await verify(server, account, client, newUid, modern);
            }
        } finally {
            await server.restart('s3');
        }
    });
});
