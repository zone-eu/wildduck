/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before */
'use strict';

// Catalogue file email-set.yaml, Email/set destroy (ESET-069 to ESET-086), with THR-034 (thread.yaml)
// and ECHG-055, ECHG-059 (email-changes.yaml).

const { expect } = require('chai');
const { scenario, api, seed, fixtures, clock, jmap } = require('../harness');
const { imapFor, mailboxId, message } = require('./email-get-helpers');
const {
    account,
    set,
    create,
    expectNotCreated,
    seedEmail,
    emailOf,
    state,
    imapFlags,
    docOf,
    restListing,
    storageUsed,
    counts,
    draft
} = require('./email-set-helpers');

const destroy = (client, ids) => set(client, { destroy: [].concat(ids) });

async function archivedCount(ctx, id) {
    const db = await seed.db();
    return db.collection('archived').countDocuments({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(id.slice(1)) });
}

const notFound = async (ctx, ids) => (await ctx.client.method('Email/get', { ids: [].concat(ids), properties: ['id'] })).notFound;

/** Waits until a NOOP brings the expected untagged response */
const afterNoop = (session, event) =>
    clock.waitFor(async () => {
        await session.noop();
        return Promise.race([event, clock.delay(100).then(() => null)]);
    });

describe('Email/set destroy (email-set.yaml)', function () {
    this.timeout(60000);
    let ctx;

    before(async () => {
        ctx = await account();
    });

    scenario('ESET-069', async () => {
        const { id } = await seedEmail(ctx);
        const res = await destroy(ctx.client, id);
        expect(res.destroyed).to.deep.equal([id]);
        expect(res.notDestroyed).to.equal(null);
        expect(res.created).to.equal(null);
        expect(res.updated).to.equal(null);
        expect(await notFound(ctx, id)).to.deep.equal([id]);
        expect((await ctx.client.method('Email/query', { filter: { inMailbox: ctx.mb.INBOX } })).ids).to.not.include(id);
    });

    scenario('ESET-070', async () => {
        const ids = [(await seedEmail(ctx)).id, (await seedEmail(ctx, { mailbox: 'Archive' })).id, (await seedEmail(ctx)).id];
        const res = await destroy(ctx.client, ids);
        expect([...res.destroyed].sort()).to.deep.equal([...ids].sort());
        expect([...(await notFound(ctx, ids))].sort()).to.deep.equal([...ids].sort());
    });

    scenario('ESET-071', async () => {
        const own = await account();
        await seedEmail(own);
        const { id, uid } = await seedEmail(own);
        const session = await seed.imap(own.user);
        const opened = await session.mailboxOpen('INBOX');
        const exists = opened.exists;
        const expunged = new Promise(resolve => session.on('expunge', resolve));
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        expect(await afterNoop(session, expunged), 'untagged EXPUNGE').to.exist;
        await session.mailboxClose();
        const reopened = await session.mailboxOpen('INBOX');
        expect(reopened.exists).to.equal(exists - 1);
        expect(await session.search({ uid: String(uid) }, { uid: true })).to.deep.equal([]);
        await session.logout().catch(() => false);
    });

    scenario('ESET-072', async () => {
        const own = await account();
        const { id } = await seedEmail(own, { subject: 'To the archive' });
        const used = await storageUsed(own);
        const size = (await emailOf(own, id, ['size'])).size;
        const doc = await docOf(own, id);
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        expect(await restListing(own, 'INBOX')).to.deep.equal([]);
        const archived = (await api('GET', `/users/${own.user.id}/archived/messages`)).results;
        expect(archived).to.have.length(1);
        expect(archived[0].subject).to.equal('To the archive');
        expect(archived[0].mailbox).to.equal(doc.mailbox.toString());
        expect(await storageUsed(own)).to.equal(used - size);
    });

    scenario('ESET-073', async () => {
        const own = await account();
        const { id } = await seedEmail(own, { flags: ['\\Flagged'] });
        const before = await emailOf(own, id, ['receivedAt', 'keywords', 'subject', 'size', 'blobId']);
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        const s1 = await state(own.client);
        const archived = (await api('GET', `/users/${own.user.id}/archived/messages`)).results;
        await api('POST', `/users/${own.user.id}/archived/messages/${archived[0].id}/restore`, {});
        const changes = await own.client.method('Email/changes', { sinceState: s1 });
        expect(changes.created).to.have.length(1);
        expect(changes.updated).to.deep.equal([]);
        expect(changes.destroyed).to.deep.equal([]);
        const restored = await emailOf(own, changes.created[0], ['receivedAt', 'keywords', 'subject', 'size', 'blobId']);
        expect(restored.receivedAt).to.equal(before.receivedAt);
        expect(restored.keywords).to.deep.equal(before.keywords);
        expect(restored.subject).to.equal(before.subject);
        expect(restored.size).to.equal(before.size);
    });

    scenario('ESET-074', async () => {
        const own = await account();
        await seedEmail(own, { subject: 'Other thread', flags: ['\\Seen'] });
        const { id } = await seedEmail(own, { subject: 'Lonely unread' });
        const before = (await counts(own, [own.mb.INBOX]))[own.mb.INBOX];
        const s0 = await state(own.client);
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        const after = await own.client.method('Mailbox/get', {
            ids: [own.mb.INBOX],
            properties: ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']
        });
        for (const key of ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']) {
            expect(after.list[0][key], key).to.equal(before[key] - 1);
        }
        expect(after.state).to.not.equal(s0);
    });

    scenario('ESET-075', async () => {
        const own = await account();
        const first = await seedEmail(own, {
            content: message(['Subject: Thread plan', 'From: a@example.com', 'Message-ID: <t1@example.com>'], 'first')
        });
        const second = await seedEmail(own, {
            content: message(
                [
                    'Subject: Re: Thread plan',
                    'From: b@example.com',
                    'Message-ID: <t2@example.com>',
                    'In-Reply-To: <t1@example.com>',
                    'References: <t1@example.com>'
                ],
                'second'
            )
        });
        const { threadId } = await emailOf(own, first.id, ['threadId']);
        expect((await emailOf(own, second.id, ['threadId'])).threadId).to.equal(threadId);
        const s0 = await state(own.client);
        expect((await destroy(own.client, first.id)).destroyed).to.deep.equal([first.id]);
        const threads = await own.client.method('Thread/get', { ids: [threadId] });
        expect(threads.list).to.deep.equal([{ id: threadId, emailIds: [second.id] }]);
        expect((await own.client.method('Thread/changes', { sinceState: s0 })).updated).to.deep.equal([threadId]);
    });

    scenario('ESET-076', async () => {
        const own = await account();
        const { id } = await seedEmail(own, { subject: 'Only one here' });
        const { threadId } = await emailOf(own, id, ['threadId']);
        const s0 = await state(own.client);
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        expect((await own.client.method('Thread/get', { ids: [threadId] })).notFound).to.deep.equal([threadId]);
        const changes = await own.client.method('Thread/changes', { sinceState: s0 });
        expect(changes.destroyed).to.deep.equal([threadId]);
    });

    scenario('ESET-077', async () => {
        const { id } = await seedEmail(ctx);
        const s0 = await state(ctx.client);
        const res = await destroy(ctx.client, id);
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.not.equal(s0);
        const changes = await ctx.client.method('Email/changes', { sinceState: s0 });
        expect(changes.destroyed).to.deep.equal([id]);
        expect(changes.created).to.deep.equal([]);
        expect(changes.updated).to.deep.equal([]);
        expect(changes.newState).to.equal(res.newState);
    });

    scenario('ESET-078', async () => {
        const res = await destroy(ctx.client, 'M000000000000000000000000');
        expect(res.destroyed).to.equal(null);
        expect(res.notDestroyed.M000000000000000000000000.type).to.equal('notFound');
    });

    scenario('ESET-079', async () => {
        const res = await destroy(ctx.client, 'invalid id!');
        expect(res.notDestroyed['invalid id!'].type).to.equal('notFound');
    });

    scenario('ESET-080', async () => {
        const { id } = await seedEmail(ctx);
        expect((await destroy(ctx.client, id)).destroyed).to.deep.equal([id]);
        const res = await destroy(ctx.client, id);
        expect(res.notDestroyed[id].type).to.equal('notFound');
        expect(res.newState).to.equal(res.oldState);
        expect(await archivedCount(ctx, id)).to.equal(1);
    });

    scenario('ESET-081', async () => {
        const { id } = await seedEmail(ctx);
        const res = await destroy(ctx.client, [id, id]);
        expect(res.destroyed).to.deep.equal([id]);
        expect(res.notDestroyed).to.equal(null);
        expect(await archivedCount(ctx, id)).to.equal(1);
    });

    scenario('ESET-082', async () => {
        const { id } = await seedEmail(ctx);
        const res = await destroy(ctx.client, [id, 'M00000000000000000000000c']);
        expect(res.destroyed).to.deep.equal([id]);
        expect(res.notDestroyed.M00000000000000000000000c.type).to.equal('notFound');
    });

    scenario('ESET-083', async () => {
        const { id, uid } = await seedEmail(ctx, { flags: ['\\Deleted'] });
        const s0 = await state(ctx.client);
        const res = await destroy(ctx.client, id);
        expect(res.notDestroyed[id].type).to.equal('notFound');
        expect(res.newState).to.equal(s0);
        expect(await imapFlags(ctx, 'INBOX', uid)).to.include('\\Deleted');
    });

    scenario('ESET-084', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        expect((await set(own.client, { update: { [id]: { mailboxIds: { [own.mb.Archive]: true } } } })).updated).to.have.property(id);
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        const session = await imapFor(own.user);
        for (const path of ['INBOX', 'Archive']) {
            const opened = await session.mailboxOpen(path);
            expect(opened.exists, path).to.equal(0);
        }
    });

    scenario('ESET-085', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const session = await imapFor(own.user);
        await session.mailboxOpen('INBOX');
        await session.messageCopy(String(uid), 'Archive', { uid: true });
        const copy = (await own.client.method('Email/query', { filter: { inMailbox: own.mb.Archive } })).ids[0];
        expect(copy).to.not.equal(id);
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        const email = await emailOf(own, copy, ['mailboxIds', 'blobId']);
        expect(email.mailboxIds).to.deep.equal({ [own.mb.Archive]: true });
        const res = await own.client.raw(`/jmap/download/${own.client.accountId}/${email.blobId}/copy.eml`);
        expect(res.status).to.equal(200);
    });

    scenario('ESET-086', async () => {
        const own = await account();
        const content = await fixtures.buildMessage({ attachments: [{ filename: 'a.bin', content: Buffer.from('attachment content') }] });
        const { id } = await seedEmail(own, { content });
        const email = await emailOf(own, id, ['blobId', 'attachments']);
        const partBlob = email.attachments[0].blobId;
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        for (const blob of [email.blobId, partBlob]) {
            expect((await own.client.raw(`/jmap/download/${own.client.accountId}/${blob}/x`)).status, blob).to.equal(404);
        }
        const res = await create(own.client, draft(own, { attachments: [{ blobId: partBlob, type: 'application/octet-stream' }] }));
        expect(expectNotCreated(res, 'blobNotFound').notFound).to.deep.equal([partBlob]);
    });

    scenario('THR-034', async () => {
        const own = await account();
        await seed.deliver(own.user.address, await fixtures.buildMessage({ subject: 'Single thread member', to: own.user.address }));
        const id = (await own.client.method('Email/query', { filter: { inMailbox: own.mb.INBOX } })).ids[0];
        const { threadId } = await emailOf(own, id, ['threadId']);
        const s1 = await state(own.client);
        expect((await destroy(own.client, id)).destroyed).to.deep.equal([id]);
        expect((await own.client.method('Thread/changes', { sinceState: s1 })).destroyed).to.deep.equal([threadId]);
        expect((await own.client.method('Thread/get', { ids: [threadId] })).notFound).to.deep.equal([threadId]);
    });

    scenario('ECHG-055', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        const s0 = await state(own.client);
        const other = jmap.forUser(own.user);
        expect((await destroy(other, id)).destroyed).to.deep.equal([id]);
        const changes = await own.client.method('Email/changes', { sinceState: s0 });
        expect(changes.destroyed).to.deep.equal([id]);
        expect(changes.created).to.deep.equal([]);
        expect(changes.updated).to.deep.equal([]);
    });

    scenario('ECHG-059', async function () {
        const own = await account();
        await api('POST', `/users/${own.user.id}/mailboxes`, { path: 'Doomed' });
        const doomed = await mailboxId(own.user, 'Doomed');
        const ids = [(await seedEmail(own, { mailbox: 'Doomed' })).id, (await seedEmail(own, { mailbox: 'Doomed' })).id];
        const s0 = await state(own.client);
        const other = jmap.forUser(own.user);
        await other.session();
        const [[name, res]] = await other.call([['Mailbox/set', { accountId: other.accountId, destroy: [`F${doomed}`], onDestroyRemoveEmails: true }, 'm']]);
        if (name === 'error' && res.type === 'unknownMethod') {
            // Mailbox/set (work package 2.2) is not in this tree yet
            return this.skip();
        }
        expect(res.destroyed).to.deep.equal([`F${doomed}`]);
        const changes = await own.client.method('Email/changes', { sinceState: s0 });
        expect([...changes.destroyed].sort()).to.deep.equal([...ids].sort());
    });
});
