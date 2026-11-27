/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Email/set seen from elsewhere: email-changes.yaml (ECHG-023, 033, 036, 107, 108), thread.yaml
// (THR-029), wildduck.yaml (WDX-007, 008, 009), blob.yaml (BLOB-033, 039, 040) and push.yaml
// (ESRC-039, 040).

const http = require('http');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');
const sse = require('../harness/sse');
const StorageHandler = require('../../../lib/storage-handler');
const { createRoleToken, deleteRoleToken } = require('../../api/_helpers');
const { imapFor, download } = require('./email-get-helpers');
const { account, set, update, create, expectCreated, expectNotCreated, seedEmail, emailOf, state, storageUsed, draft, upload } = require('./email-set-helpers');

/** A second JMAP session of the same user, with an application specific password */
async function secondSession(ctx) {
    const password = await accounts.createAsp(ctx.user, ['*']);
    const client = new jmap.JmapClient(jmap.basic(ctx.user.username, password));
    await client.session();
    return client;
}

/** Runs one call, answers [name, arguments] */
async function callOne(client, name, args) {
    const [[responseName, responseArgs]] = await client.call(
        [[name, Object.assign({ accountId: client.accountId }, args), 'c0']],
        [jmap.URN.core, jmap.URN.mail, jmap.URN.submission]
    );
    return [responseName, responseArgs];
}

const unknownMethod = ([name, args]) => name === 'error' && args.type === 'unknownMethod';

describe('Email/set seen from elsewhere', function () {
    this.timeout(120000);

    // ---- email-changes.yaml

    scenario('ECHG-023', async function () {
        const ctx = await account();
        const s0 = await state(ctx.client);
        const other = await secondSession(ctx);
        const created = expectCreated(await create(other, draft(ctx, { subject: 'From session 2' })));
        const blob = await upload(Object.assign({}, ctx, { client: other }), await fixtures.buildMessage({ subject: 'Imported' }), 'message/rfc822');
        const imported = await callOne(other, 'Email/import', { emails: { i1: { blobId: blob.blobId, mailboxIds: { [ctx.mb.INBOX]: true } } } });
        if (unknownMethod(imported)) {
            // Email/import (work package 2.7) is not in this tree yet
            return this.skip();
        }
        const changes = await ctx.client.method('Email/changes', { sinceState: s0 });
        expect([...changes.created].sort()).to.deep.equal([created.id, imported[1].created.i1.id].sort());
    });

    scenario('ECHG-033', async () => {
        const ctx = await account();
        const { id } = await seedEmail(ctx);
        const s0 = await state(ctx.client);
        const other = await secondSession(ctx);
        const res = await update(other, id, { 'keywords/$flagged': true });
        expect(res.updated).to.have.property(id);
        const changes = await ctx.client.method('Email/changes', { sinceState: s0 });
        expect(changes.updated).to.deep.equal([id]);
        expect(changes.newState).to.equal(res.newState);
    });

    scenario('ECHG-036', async () => {
        const ctx = await account();
        const { id } = await seedEmail(ctx);
        const s0 = await state(ctx.client);
        const other = await secondSession(ctx);
        expect((await update(other, id, { mailboxIds: { [ctx.mb.Archive]: true } })).updated).to.have.property(id);
        const changes = await ctx.client.method('Email/changes', { sinceState: s0 });
        expect(changes.updated).to.deep.equal([id]);
        expect(changes.created).to.deep.equal([]);
        expect(changes.destroyed).to.deep.equal([]);
    });

    scenario('ECHG-107', async () => {
        const ctx = await account();
        const { id } = await seedEmail(ctx);
        const s0 = (await ctx.client.method('Email/get', { ids: [id], properties: ['id'] })).state;
        const res = await update(ctx.client, id, { 'keywords/$seen': true });
        expect(res.oldState).to.equal(s0);
        const since = await ctx.client.method('Email/changes', { sinceState: res.oldState });
        expect(since.updated).to.deep.equal([id]);
        expect(since.newState).to.equal(res.newState);
        const after = await ctx.client.method('Email/changes', { sinceState: res.newState });
        expect([...after.created, ...after.updated, ...after.destroyed]).to.deep.equal([]);
        expect(after.newState).to.equal(res.newState);
    });

    scenario('ECHG-108', async () => {
        const ctx = await account();
        const s0 = await state(ctx.client);
        const empty = await set(ctx.client, {});
        const failed = await update(ctx.client, 'M000000000000000000000000', { 'keywords/$seen': true });
        expect(failed.notUpdated.M000000000000000000000000.type).to.equal('notFound');
        for (const res of [empty, failed]) {
            expect(res.oldState).to.equal(s0);
            expect(res.newState).to.equal(s0);
        }
        expect(await state(ctx.client)).to.equal(s0);
    });

    // ---- thread.yaml

    scenario('THR-029', async () => {
        const ctx = await account();
        const messageId = `thr029.${Date.now()}@example.com`;
        await seed.deliver(ctx.user.address, await fixtures.buildMessage({ subject: 'Lunch plans', to: ctx.user.address, messageId: `<${messageId}>` }));
        const original = (await ctx.client.method('Email/query', { filter: { inMailbox: ctx.mb.INBOX } })).ids[0];
        const { threadId } = await emailOf(ctx, original, ['threadId']);
        const reply = expectCreated(
            await create(
                ctx.client,
                draft(ctx, {
                    keywords: { $draft: true },
                    inReplyTo: [messageId],
                    references: [messageId],
                    subject: 'Re: Lunch plans',
                    textBody: [{ partId: 't' }],
                    bodyValues: { t: { value: 'Sounds good' } }
                })
            )
        );
        expect(reply.threadId).to.equal(threadId);
        // as onSuccessUpdateEmail does after a submission
        expect((await update(ctx.client, reply.id, { mailboxIds: { [ctx.mb.Sent]: true }, 'keywords/$draft': null })).updated).to.have.property(reply.id);
        const moved = await emailOf(ctx, reply.id, ['threadId', 'mailboxIds']);
        expect(moved.threadId).to.equal(threadId);
        const thread = await ctx.client.method('Thread/get', { ids: [threadId] });
        expect([...thread.list[0].emailIds].sort()).to.deep.equal([original, reply.id].sort());
        const { list } = await ctx.client.method('Email/get', { ids: thread.list[0].emailIds, properties: ['mailboxIds'] });
        expect(list.find(email => email.id === original).mailboxIds).to.deep.equal({ [ctx.mb.INBOX]: true });
        expect(list.find(email => email.id === reply.id).mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
    });

    // ---- wildduck.yaml

    scenario('WDX-007', async function () {
        const ctx = await account();
        await seedEmail(ctx);
        const used = await storageUsed(ctx);
        // past the quota: IMAP APPEND and the REST upload refuse once storageUsed is over it
        await api('PUT', `/users/${ctx.user.id}`, { quota: used - 1 });
        expectNotCreated(await create(ctx.client, draft(ctx)), 'overQuota');
        const session = await imapFor(ctx.user);
        let appendError = null;
        await session.append('INBOX', Buffer.from('Subject: over quota\r\n\r\nbody\r\n')).catch(err => {
            appendError = err;
        });
        expect(appendError, 'IMAP APPEND is refused').to.exist;
        expect(`${appendError.serverResponseCode || ''} ${appendError.response || ''} ${appendError.responseText || ''}`).to.match(/OVERQUOTA/i);
        expect(await storageUsed(ctx)).to.equal(used);

        const blob = await upload(ctx, await fixtures.buildMessage({ subject: 'Import over quota' }), 'message/rfc822');
        const imported = await callOne(ctx.client, 'Email/import', { emails: { i1: { blobId: blob.blobId, mailboxIds: { [ctx.mb.INBOX]: true } } } });
        if (unknownMethod(imported)) {
            // Email/import (work package 2.7) is not in this tree yet
            return this.skip();
        }
        expect(imported[1].notCreated.i1.type).to.equal('overQuota');
        expect(await storageUsed(ctx)).to.equal(used);
    });

    scenario('WDX-008', async () => {
        const ctx = await account();
        const original = await storageUsed(ctx);
        const blob = await upload(ctx, Buffer.alloc(4096, 9), 'application/octet-stream');
        const created = expectCreated(
            await create(ctx.client, {
                mailboxIds: { [ctx.mb.INBOX]: true },
                subject: 'Counted',
                attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', name: 'a.bin' }]
            })
        );
        expect(await storageUsed(ctx)).to.equal(original + created.size);

        // an IMAP APPEND of the same bytes is counted the same way
        const raw = await download(ctx.client, created.blobId);
        await (await imapFor(ctx.user)).append('Archive', raw);
        expect(await storageUsed(ctx)).to.equal(original + 2 * created.size);

        expect((await set(ctx.client, { destroy: [created.id] })).destroyed).to.deep.equal([created.id]);
        const db = await seed.db();
        const archived = await db.collection('archived').findOne({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(created.id.slice(1)) });
        expect(archived, 'the archived copy').to.exist;
        // the archived copy is not counted while it waits for the end of the archive period, nor after it
        expect(await storageUsed(ctx)).to.equal(original + created.size);
        await db.collection('archived').deleteOne({ _id: archived._id });
        expect(await storageUsed(ctx)).to.equal(original + created.size);
    });

    describe('webhooks and audit', () => {
        let server;
        let received;

        before(async () => {
            received = [];
            server = http.createServer((req, res) => {
                let body = '';
                req.on('data', chunk => (body += chunk));
                req.on('end', () => {
                    try {
                        received.push(JSON.parse(body));
                    } catch {
                        // ignore
                    }
                    res.end('ok');
                });
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        });

        after(() => new Promise(resolve => server.close(resolve)));

        scenario('WDX-009', async () => {
            const url = `http://127.0.0.1:${server.address().port}/hook`;
            const setup = async () => {
                const ctx = await account();
                await api('POST', '/webhooks', { type: ['*'], user: ctx.user.id, url });
                // audits are created with a token of the audit role
                const token = await createRoleToken('audit');
                const audit = await api(
                    'POST',
                    '/audit',
                    {
                        user: ctx.user.id,
                        start: new Date(Date.now() - 60000).toISOString(),
                        expires: new Date(Date.now() + 3600000).toISOString()
                    },
                    { headers: { 'X-Access-Token': token.accessToken } }
                );
                await deleteRoleToken(token.tokenHash);
                // the audit task copies the messages the account already has; it must be done before the actions
                // below, or whether it sees a message, and in which mailbox, depends on when it runs
                const db = await seed.db();
                await clock.waitFor(
                    async () => {
                        const auditData = await db.collection('audits').findOne({ _id: new seed.ObjectId(audit.id) });
                        return auditData && auditData.import && auditData.import.status === 'imported';
                    },
                    { timeout: 90000, message: 'the audit import did not finish' }
                );
                return Object.assign(ctx, { audit: audit.id });
            };
            const viaJmap = await setup();
            const viaImap = await setup();

            // JMAP: create, flag, move to Junk, destroy
            const created = expectCreated(
                await create(viaJmap.client, { mailboxIds: { [viaJmap.mb.INBOX]: true }, subject: 'Audited', from: [{ email: 'a@example.com' }] })
            );
            expect((await update(viaJmap.client, created.id, { 'keywords/$flagged': true })).updated).to.have.property(created.id);
            expect((await update(viaJmap.client, created.id, { mailboxIds: { [viaJmap.mb.Junk]: true } })).updated).to.have.property(created.id);
            // IMAP: the same actions
            const session = await imapFor(viaImap.user);
            const appended = await session.append('INBOX', await download(viaJmap.client, created.blobId));
            await session.mailboxOpen('INBOX');
            await session.messageFlagsAdd(String(appended.uid), ['\\Flagged'], { uid: true });
            const junkPath = (await (await seed.db()).collection('mailboxes').findOne({ user: new seed.ObjectId(viaImap.user.id), specialUse: '\\Junk' })).path;
            await session.messageMove(String(appended.uid), junkPath, { uid: true });

            const eventsOf = ctx => received.filter(event => event.user === ctx.user.id).map(event => event.ev);
            await clock.waitFor(() => eventsOf(viaJmap).includes('marked.spam') && eventsOf(viaImap).includes('marked.spam'), {
                timeout: 20000,
                message: 'marked.spam for both users'
            });

            // destroy
            expect((await set(viaJmap.client, { destroy: [created.id] })).destroyed).to.deep.equal([created.id]);
            await session.mailboxOpen(junkPath);
            await session.messageDelete('1:*');
            await clock.delay(2000);

            expect(eventsOf(viaJmap).sort()).to.deep.equal(eventsOf(viaImap).sort());
            const db = await seed.db();
            // an audit copy where a message is stored (a move is not audited again)
            const audits = async ctx =>
                (
                    await db
                        .collection('audit.files')
                        .find({ 'metadata.audit': new seed.ObjectId(ctx.audit) })
                        .sort({ _id: 1 })
                        .toArray()
                ).map(file => file.metadata.mailboxPath);
            expect(await audits(viaJmap)).to.deep.equal(['INBOX']);
            expect(await audits(viaImap)).to.deep.equal(['INBOX']);
        });
    });

    // ---- blob.yaml

    scenario('BLOB-033', async () => {
        const a = await account();
        const b = await account();
        const content = Buffer.from('only for B');
        const blob = await upload(b, content);
        expect((await a.client.raw(`/jmap/download/${a.client.accountId}/${blob.blobId}/x.bin`)).status).to.equal(404);
        const res = await create(a.client, draft(a, { attachments: [{ blobId: blob.blobId, type: 'application/octet-stream' }] }));
        const error = res.notCreated.c1;
        expect(res.created).to.equal(null);
        if (error.type === 'blobNotFound') {
            expect(error.notFound).to.deep.equal([blob.blobId]);
        } else {
            expect(error).to.deep.include({ type: 'invalidProperties', properties: ['attachments'] });
        }
        expect((await download(b.client, blob.blobId)).equals(content)).to.be.true;
    });

    scenario('BLOB-039', async () => {
        const ctx = await account();
        const content = Buffer.from('consumed into an Email');
        const blob = await upload(ctx, content);
        const created = expectCreated(
            await create(ctx.client, draft(ctx, { attachments: [{ blobId: blob.blobId, type: 'application/octet-stream', name: 'c.bin' }] }))
        );
        const db = await seed.db();
        await db
            .collection('storage.files')
            .updateOne({ _id: new seed.ObjectId(blob.blobId.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() - 1000) } });
        await new StorageHandler({ database: db, gridfs: db, users: db }).removeExpiredUploads();
        const { attachments } = await emailOf(ctx, created.id, ['attachments']);
        expect((await download(ctx.client, attachments[0].blobId)).equals(content)).to.be.true;
        expect((await emailOf(ctx, created.id, ['size'])).size).to.equal(created.size);
    });

    scenario('BLOB-040', async () => {
        const ctx = await account();
        const content = Buffer.from('%PDF-1.4 last reference');
        const e1 = await seedEmail(ctx, {
            content: await fixtures.buildMessage({ attachments: [{ filename: 'p.pdf', content, contentType: 'application/pdf' }] })
        });
        const part = (await emailOf(ctx, e1.id, ['attachments'])).attachments[0].blobId;
        const res = await set(ctx.client, {
            destroy: [e1.id],
            create: { c1: draft(ctx, { attachments: [{ blobId: part, type: 'application/pdf', name: 'p.pdf' }] }) }
        });
        expect(res.destroyed).to.deep.equal([e1.id]);
        const created = expectCreated(res);
        const { attachments } = await emailOf(ctx, created.id, ['attachments']);
        expect((await download(ctx.client, attachments[0].blobId)).equals(content)).to.be.true;
    });

    // ---- push.yaml

    scenario('ESRC-039', async () => {
        const ctx = await account();
        const { id } = await seedEmail(ctx);
        const es = await sse.open('/jmap/eventsource/?types=*&closeafter=no&ping=0', { authorization: jmap.basic(ctx.user.username, ctx.user.password) });
        expect(es.status).to.equal(200);
        await es.settle();
        const res = await update(ctx.client, id, { 'keywords/$seen': true });
        await es.next();
        await es.settle();
        const values = es.states().map(event => event.json.changed[ctx.client.accountId].Email);
        expect(values).to.include(res.newState);
        es.close();
    });

    scenario('ESRC-040', async () => {
        const ctx = await account();
        const es = await sse.open('/jmap/eventsource/?types=*&closeafter=no&ping=0', { authorization: jmap.basic(ctx.user.username, ctx.user.password) });
        expect(es.status).to.equal(200);
        await es.settle();
        const using = [jmap.URN.core, jmap.URN.mail, jmap.URN.submission];
        const { list } = await ctx.client.method('Identity/get', {}, using);
        const res = await ctx.client.method('Identity/set', { update: { [list[0].id]: { name: 'Renamed' } } }, using);
        expect(res.updated).to.have.property(list[0].id);
        const event = await es.next();
        const changed = event.json.changed[ctx.client.accountId];
        expect(Object.keys(changed)).to.deep.equal(['Identity']);
        expect(changed.Identity).to.equal((await ctx.client.method('Identity/get', { ids: [] }, using)).state);
        es.close();
    });
});
