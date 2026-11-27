/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, BigInt */
'use strict';

// Catalogue file email-set.yaml, Email/set update (ESET-001 to ESET-068), the generic /set rules
// (ESET-088 to ESET-109) and concurrency (ESET-232 to ESET-239).

const { expect } = require('chai');
const { scenario, api, seed, clock, jmap } = require('../harness');
const { imapFor, mailboxId, getOne } = require('./email-get-helpers');
const {
    account,
    set,
    update,
    methodError,
    expectUpdated,
    expectNotUpdated,
    expectProperties,
    seedEmail,
    keywordsOf,
    emailOf,
    state,
    imapFlags,
    docOf,
    restMessage,
    restListing,
    restMailbox,
    counts,
    createLabel,
    draft
} = require('./email-set-helpers');
const { MAX_KEYWORDS } = require('../../../lib/jmap/types/email-set');

const without = (flags, ...removed) => flags.filter(flag => !removed.map(item => item.toLowerCase()).includes(flag.toLowerCase()));
const lower = flags => flags.map(flag => flag.toLowerCase()).sort();

async function mailboxModseq(ctx, path) {
    const db = await seed.db();
    return (await db.collection('mailboxes').findOne({ _id: await mailboxId(ctx.user, path) })).modifyIndex;
}

async function journalCount(ctx) {
    const db = await seed.db();
    return db.collection('journal').countDocuments({ user: new seed.ObjectId(ctx.user.id) });
}

async function labelCounter(ctx, label) {
    return api('GET', `/users/${ctx.user.id}/label-counters/${encodeURIComponent(label)}?searchable=false`);
}

describe('Email/set update (email-set.yaml)', function () {
    this.timeout(60000);
    let ctx;

    before(async () => {
        ctx = await account();
    });

    // ---- keywords

    scenario('ESET-001', async () => {
        const { id } = await seedEmail(ctx);
        const res = await update(ctx.client, id, { 'keywords/$flagged': true });
        expect(res.updated).to.have.property(id);
        expect(res.updated[id] === null || typeof res.updated[id] === 'object').to.be.true;
        expect(res.notUpdated).to.equal(null);
        expect(res.created).to.equal(null);
        expect(res.destroyed).to.equal(null);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $flagged: true });
    });

    scenario('ESET-002', async () => {
        const { id } = await seedEmail(ctx, { flags: ['\\Flagged', '\\Seen'] });
        expectUpdated(await update(ctx.client, id, { 'keywords/$flagged': null }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-003', async () => {
        const { id, uid } = await seedEmail(ctx);
        const before = await docOf(ctx, id);
        const res = await update(ctx.client, id, { 'keywords/$flagged': null });
        expectUpdated(res, id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
        const after = await docOf(ctx, id);
        expect(after.modseq).to.equal(before.modseq);
        expect(lower(without(await imapFlags(ctx, 'INBOX', uid), '\\Recent'))).to.deep.equal([]);
    });

    scenario('ESET-004', async () => {
        const { id } = await seedEmail(ctx, { flags: ['\\Seen', '\\Flagged'] });
        expectUpdated(await update(ctx.client, id, { keywords: { $answered: true, custom: true } }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $answered: true, custom: true });
    });

    scenario('ESET-005', async () => {
        const { id, uid } = await seedEmail(ctx, { flags: ['\\Seen', '\\Flagged', 'custom'] });
        expectUpdated(await update(ctx.client, id, { keywords: {} }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
        expect(without(await imapFlags(ctx, 'INBOX', uid), '\\Recent')).to.deep.equal([]);
    });

    scenario('ESET-006', async () => {
        const { id } = await seedEmail(ctx, { flags: ['\\Flagged'] });
        const before = await mailboxModseq(ctx, 'INBOX');
        expectUpdated(await update(ctx.client, id, { 'keywords/$seen': true, 'keywords/$flagged': null, 'keywords/work': true }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true, work: true });
        expect(await mailboxModseq(ctx, 'INBOX')).to.equal(before + 1);
        expect((await docOf(ctx, id)).modseq).to.equal(before + 1);
    });

    scenario('ESET-007', async () => {
        const { id } = await seedEmail(ctx, { flags: ['\\Seen'] });
        const entries = await journalCount(ctx);
        const res = await update(ctx.client, id, { 'keywords/$seen': true });
        expectUpdated(res, id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
        expect(res.newState).to.equal(res.oldState);
        expect(await journalCount(ctx)).to.equal(entries);
    });

    scenario('ESET-008', async () => {
        const own = await account();
        const ids = [];
        for (let i = 0; i < 10; i++) {
            ids.push((await seedEmail(own)).id);
        }
        const before = (await counts(own, [own.mb.INBOX]))[own.mb.INBOX];
        const res = await set(own.client, { update: Object.fromEntries(ids.map(id => [id, { 'keywords/$seen': true }])) });
        expect(Object.keys(res.updated).sort()).to.deep.equal([...ids].sort());
        expect(res.notUpdated).to.equal(null);
        const { list } = await own.client.method('Email/get', { ids, properties: ['keywords'] });
        expect(list.every(email => email.keywords.$seen === true)).to.be.true;
        expect((await counts(own, [own.mb.INBOX]))[own.mb.INBOX].unreadEmails).to.equal(before.unreadEmails - 10);
    });

    scenario('ESET-009', async () => {
        const { id } = await seedEmail(ctx);
        const res = await update(ctx.client, id, { 'keywords/$seen': true });
        expect(res.updated).to.be.an('object').that.has.all.keys(id);
        const value = res.updated[id];
        expect(value === null || (typeof value === 'object' && !('keywords' in value))).to.be.true;
    });

    async function systemFlag(keyword, imapFlag, restField) {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const client = await imapFor(own.user);
        await client.mailboxOpen('INBOX');
        const unread = async () => (await counts(own, [own.mb.INBOX]))[own.mb.INBOX].unreadEmails;
        const unreadBefore = await unread();
        const flagsBefore = await imapFlags(own, 'INBOX', uid);

        expectUpdated(await update(own.client, id, { [`keywords/${keyword}`]: true }), id);
        const set1 = await imapFlags(own, 'INBOX', uid);
        expect(lower(without(set1, ...flagsBefore))).to.deep.equal([imapFlag.toLowerCase()]);
        expect((await restMessage(own, id))[restField]).to.equal(true);
        const unreadSet = await unread();

        expectUpdated(await update(own.client, id, { [`keywords/${keyword}`]: null }), id);
        const set2 = await imapFlags(own, 'INBOX', uid);
        expect(lower(set2)).to.not.include(imapFlag.toLowerCase());
        expect((await restMessage(own, id))[restField]).to.equal(false);
        return { unreadBefore, unreadSet, unreadAfter: await unread() };
    }

    scenario('ESET-010', async () => {
        const result = await systemFlag('$seen', '\\Seen', 'seen');
        expect(result.unreadSet).to.equal(result.unreadBefore - 1);
        expect(result.unreadAfter).to.equal(result.unreadBefore);
    });

    scenario('ESET-011', async () => {
        await systemFlag('$flagged', '\\Flagged', 'flagged');
    });

    scenario('ESET-012', async () => {
        await systemFlag('$answered', '\\Answered', 'answered');
    });

    scenario('ESET-013', async () => {
        const result = await systemFlag('$draft', '\\Draft', 'draft');
        expect(result.unreadSet).to.equal(result.unreadBefore - 1);
        expect(result.unreadAfter).to.equal(result.unreadBefore);
    });

    scenario('ESET-014', async () => {
        await systemFlag('$forwarded', '$Forwarded', 'forwarded');
    });

    scenario('ESET-015', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        expectUpdated(await update(own.client, id, { 'keywords/project-x': true }), id);
        expect(lower(await imapFlags(own, 'INBOX', uid))).to.include('project-x');
        const client = await imapFor(own.user);
        await client.mailboxClose().catch(() => false);
        const opened = await client.mailboxOpen('INBOX');
        const listed = [...(opened.permanentFlags || []), ...(opened.flags || [])].map(flag => flag.toLowerCase());
        expect(listed).to.include('project-x');
        expect(await client.search({ keyword: 'project-x' }, { uid: true })).to.include(uid);
    });

    scenario('ESET-016', async () => {
        const { id, uid } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { 'keywords/$Flagged': true, 'keywords/MyTag': true }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $flagged: true, mytag: true });
        const flags = without(await imapFlags(ctx, 'INBOX', uid), '\\Recent');
        expect(lower(flags)).to.deep.equal(['\\flagged', 'mytag']);
    });

    scenario('ESET-017', async () => {
        const { id, uid } = await seedEmail(ctx, { flags: ['Important'] });
        expectUpdated(await update(ctx.client, id, { 'keywords/important': true }), id);
        const flags = without(await imapFlags(ctx, 'INBOX', uid), '\\Recent');
        expect(flags.filter(flag => flag.toLowerCase() === 'important')).to.deep.equal(['Important']);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ important: true });
        expectUpdated(await update(ctx.client, id, { 'keywords/IMPORTANT': null }), id);
        expect(lower(await imapFlags(ctx, 'INBOX', uid))).to.not.include('important');
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
    });

    scenario('ESET-018', async () => {
        const { id, uid } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { keywords: { Foo: true, foo: true } }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ foo: true });
        expect(lower(without(await imapFlags(ctx, 'INBOX', uid), '\\Recent'))).to.deep.equal(['foo']);
    });

    scenario('ESET-019', async () => {
        const { id } = await seedEmail(ctx, { flags: ['\\Flagged'] });
        const error = expectNotUpdated(await update(ctx.client, id, { 'keywords/$flagged': false }), id, 'invalidProperties');
        expect(error.properties).to.deep.equal(['keywords']);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $flagged: true });
    });

    scenario('ESET-020', async () => {
        const { id } = await seedEmail(ctx, { flags: ['\\Seen'] });
        expectProperties(expectNotUpdated(await update(ctx.client, id, { keywords: { $flagged: false } }), id, 'invalidProperties'), ['keywords']);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-021', async () => {
        const { id } = await seedEmail(ctx);
        for (const patch of [{ 'keywords/foo': 1 }, { 'keywords/foo': 'true' }, { keywords: { foo: null } }]) {
            expectProperties(expectNotUpdated(await update(ctx.client, id, patch), id, 'invalidProperties'), ['keywords']);
        }
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
    });

    scenario('ESET-022', async () => {
        const { id, uid } = await seedEmail(ctx);
        const before = await imapFlags(ctx, 'INBOX', uid);
        const bad = ['a b', 'a(b', 'a)b', 'a{b', 'a]b', 'a%b', 'a*b', 'a"b', 'a\\b', 'a\u0001b', 'café'];
        for (const keyword of bad) {
            const patch = { [`keywords/${keyword.replace(/~/g, '~0').replace(/\//g, '~1')}`]: true };
            expectProperties(expectNotUpdated(await update(ctx.client, id, patch), id, 'invalidProperties'), ['keywords']);
        }
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
        expect(await imapFlags(ctx, 'INBOX', uid)).to.deep.equal(before);
    });

    scenario('ESET-023', async () => {
        const { id } = await seedEmail(ctx);
        expectProperties(expectNotUpdated(await update(ctx.client, id, { keywords: { '': true } }), id, 'invalidProperties'), ['keywords']);
        expectProperties(expectNotUpdated(await update(ctx.client, id, { [`keywords/${'k'.repeat(256)}`]: true }), id, 'invalidProperties'), ['keywords']);
        const long = 'k'.repeat(255);
        expectUpdated(await update(ctx.client, id, { [`keywords/${long}`]: true }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ [long]: true });
    });

    scenario('ESET-024', async () => {
        const { id } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { 'keywords/a~1b': true }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ 'a/b': true });
        expectNotUpdated(await update(ctx.client, id, { 'keywords/a/b': true }), id, 'invalidPatch');
    });

    scenario('ESET-025', async () => {
        const { id, uid } = await seedEmail(ctx);
        for (const patch of [{ 'keywords/$deleted': true }, { 'keywords/$recent': true }, { keywords: { $deleted: true } }, { keywords: { $recent: true } }]) {
            expectProperties(expectNotUpdated(await update(ctx.client, id, patch), id, 'invalidProperties'), ['keywords']);
        }
        expect(lower(await imapFlags(ctx, 'INBOX', uid))).to.not.include('\\deleted');
        expect((await ctx.client.method('Email/get', { ids: [id], properties: ['id'] })).notFound).to.deep.equal([]);
    });

    scenario('ESET-026', async () => {
        const own = await account();
        const { id } = await seedEmail(own, { flags: ['\\Flagged'] });
        // a session that sees the message as \Recent
        const client = await imapFor(own.user);
        await client.mailboxOpen('INBOX');
        const before = await docOf(own, id);
        expectUpdated(await update(own.client, id, { keywords: { $seen: true } }), id);
        const after = await docOf(own, id);
        expect(after.flags).to.deep.equal(['\\Seen']);
        expect(after.undeleted).to.equal(true);
        expect(before.flags).to.deep.equal(['\\Flagged']);
    });

    scenario('ESET-027', async () => {
        const { id, uid } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { keywords: { $junk: true, $mdnsent: true } }), id);
        expect(await emailOf(ctx, id, ['keywords', 'mailboxIds'])).to.deep.include({
            keywords: { $junk: true, $mdnsent: true },
            mailboxIds: { [ctx.mb.INBOX]: true }
        });
        expect(lower(without(await imapFlags(ctx, 'INBOX', uid), '\\Recent'))).to.deep.equal(['$junk', '$mdnsent']);
    });

    scenario('ESET-028', async () => {
        const { id } = await seedEmail(ctx);
        const keywords = Object.fromEntries(Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => [`kw${i}`, true]));
        expectNotUpdated(await update(ctx.client, id, { keywords }), id, 'tooManyKeywords');
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
    });

    scenario('ESET-029', async () => {
        const own = await account();
        const label = await createLabel(own, 'Project');
        const { id, uid } = await seedEmail(own);
        const before = await labelCounter(own, 'Project');
        expectUpdated(await update(own.client, id, { [`keywords/$wdlabel$${label}`]: true }), id);
        expect(await keywordsOf(own, id)).to.deep.equal({ [`$wdlabel$${label}`]: true });
        expect((await restMessage(own, id)).labels).to.deep.equal(['Project']);
        expect((await labelCounter(own, 'Project')).total).to.equal(before.total + 1);
        expect(await imapFlags(own, 'INBOX', uid)).to.include(`$wdlabel$${label}`);
    });

    scenario('ESET-030', async () => {
        const own = await account();
        const label = await createLabel(own, 'Remove');
        const { id, uid } = await seedEmail(own, { flags: ['\\Seen'] });
        await api('PUT', `/users/${own.user.id}/mailboxes/${await mailboxId(own.user, 'INBOX')}/messages/${uid}`, { addLabels: ['Remove'] });
        const before = await labelCounter(own, 'Remove');
        expectUpdated(await update(own.client, id, { [`keywords/$wdlabel$${label}`]: null }), id);
        expect((await restMessage(own, id)).labels).to.deep.equal([]);
        expect((await labelCounter(own, 'Remove')).total).to.equal(before.total - 1);
        expect(await keywordsOf(own, id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-031', async () => {
        const own = await account();
        const l1 = await createLabel(own, 'L1');
        const l2 = await createLabel(own, 'L2');
        const { id, uid } = await seedEmail(own, { flags: ['\\Seen'] });
        await api('PUT', `/users/${own.user.id}/mailboxes/${await mailboxId(own.user, 'INBOX')}/messages/${uid}`, { addLabels: ['L1', 'L2'] });
        expectUpdated(await update(own.client, id, { keywords: { $seen: true, [`$wdlabel$${l2}`]: true } }), id);
        expect(await keywordsOf(own, id)).to.deep.equal({ $seen: true, [`$wdlabel$${l2}`]: true });
        expect((await restMessage(own, id)).labels).to.deep.equal(['L2']);
        expect((await labelCounter(own, 'L1')).total).to.equal(0);
        expect((await labelCounter(own, 'L2')).total).to.equal(1);
        expect(l1).to.be.a('string');
    });

    scenario('ESET-032', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        const db = await seed.db();
        const labelsBefore = await db.collection('labels').countDocuments({ user: new seed.ObjectId(own.user.id) });
        const before = await docOf(own, id);
        for (const keyword of ['$wdlabel$000000000000000000000000', '$wdlabel$xyz']) {
            expectProperties(expectNotUpdated(await update(own.client, id, { [`keywords/${keyword}`]: true }), id, 'invalidProperties'), ['keywords']);
        }
        expect(await db.collection('labels').countDocuments({ user: new seed.ObjectId(own.user.id) })).to.equal(labelsBefore);
        const after = await docOf(own, id);
        expect(after.flags).to.deep.equal(before.flags);
        expect(after.modseq).to.equal(before.modseq);
    });

    scenario('ESET-033', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const client = await imapFor(own.user);
        const opened = await client.mailboxOpen('INBOX');
        const highest = Number(opened.highestModseq);
        expectUpdated(await update(own.client, id, { 'keywords/$flagged': true }), id);
        const changed = [];
        for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true, changedSince: BigInt(highest) })) {
            changed.push(msg);
        }
        const entry = changed.find(msg => msg.uid === uid);
        expect(entry, 'reported by CHANGEDSINCE').to.exist;
        expect([...entry.flags]).to.include('\\Flagged');
        expect(Number(entry.modseq)).to.be.above(highest);
        await client.mailboxClose();
        const reopened = await client.mailboxOpen('INBOX');
        expect(Number(reopened.highestModseq)).to.be.above(highest);
    });

    scenario('ESET-034', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const client = await seed.imap(own.user);
        await client.mailboxOpen('INBOX');
        const seenFlags = new Promise(resolve =>
            client.on('flags', event => {
                if (event.flags && event.flags.has('\\Seen')) {
                    resolve(event);
                }
            })
        );
        const idling = client.idle();
        await clock.delay(200);
        expectUpdated(await update(own.client, id, { 'keywords/$seen': true }), id);
        const event = await Promise.race([seenFlags, clock.delay(8000).then(() => null)]);
        expect(event, 'untagged FETCH while idling').to.exist;
        expect(event.uid === undefined || event.uid === uid).to.be.true;
        expect(event.seq).to.equal(1);
        await client.logout().catch(() => false);
        await idling.catch(() => false);
    });

    scenario('ESET-035', async () => {
        const own = await account();
        const ids = [];
        for (let i = 0; i < 3; i++) {
            ids.push((await seedEmail(own)).id);
        }
        const stateBefore = await state(own.client);
        expectUpdated(await update(own.client, ids[0], { 'keywords/$seen': true }), ids[0]);
        expect((await restMailbox(own, 'INBOX')).unseen).to.equal(2);
        const listing = await restListing(own, 'INBOX');
        const doc = await docOf(own, ids[0]);
        expect(listing.find(entry => entry.id === doc.uid).seen).to.equal(true);
        const mailboxes = await own.client.method('Mailbox/get', { ids: [own.mb.INBOX], properties: ['unreadEmails'] });
        expect(mailboxes.list[0].unreadEmails).to.equal(2);
        expect(mailboxes.state).to.not.equal(stateBefore);
    });

    scenario('ESET-036', async () => {
        const { id, uid } = await seedEmail(ctx);
        const client = await imapFor(ctx.user);
        await client.mailboxOpen('INBOX');
        await client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true });
        expectUpdated(await update(ctx.client, id, { 'keywords/$flagged': true }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $answered: true, $flagged: true });
    });

    // ---- mailboxIds

    scenario('ESET-037', async () => {
        const { id } = await seedEmail(ctx, { flags: ['\\Seen'] });
        const properties = ['id', 'blobId', 'threadId', 'receivedAt', 'size', 'keywords', 'mailboxIds'];
        const before = await emailOf(ctx, id, properties);
        const res = await update(ctx.client, id, { mailboxIds: { [ctx.mb.Archive]: true } });
        expectUpdated(res, id);
        const after = await emailOf(ctx, id, properties);
        expect(after).to.deep.equal(Object.assign({}, before, { mailboxIds: { [ctx.mb.Archive]: true } }));
    });

    scenario('ESET-038', async () => {
        const { id } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { [`mailboxIds/${ctx.mb.INBOX}`]: null, [`mailboxIds/${ctx.mb.Archive}`]: true }), id);
        expect(await emailOf(ctx, id, ['mailboxIds'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.Archive]: true } });
    });

    scenario('ESET-039', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own, { flags: ['\\Seen', 'tagged'] });
        const inboxSession = await seed.imap(own.user);
        const archiveSession = await seed.imap(own.user);
        await inboxSession.mailboxOpen('INBOX');
        await archiveSession.mailboxOpen('Archive');
        const before = await inboxSession.fetchOne(String(uid), { uid: true, flags: true, internalDate: true, size: true, source: true }, { uid: true });
        const expunged = new Promise(resolve => inboxSession.on('expunge', resolve));
        const exists = new Promise(resolve => archiveSession.on('exists', resolve));

        expectUpdated(await update(own.client, id, { mailboxIds: { [own.mb.Archive]: true } }), id);
        // untagged updates arrive with the first NOOP after the session learned about the change
        const settled = async (session, event) =>
            clock.waitFor(async () => {
                await session.noop();
                return Promise.race([event, clock.delay(100).then(() => null)]);
            });
        expect(await settled(inboxSession, expunged), 'EXPUNGE in INBOX').to.exist;
        expect(await settled(archiveSession, exists), 'EXISTS in Archive').to.exist;

        const doc = await docOf(own, id);
        expect(doc.uid).to.be.a('number');
        const moved = await archiveSession.fetchOne(String(doc.uid), { uid: true, flags: true, internalDate: true, size: true, source: true }, { uid: true });
        expect(moved.internalDate.getTime()).to.equal(before.internalDate.getTime());
        expect([...moved.flags].sort()).to.deep.equal([...before.flags].sort());
        expect(moved.size).to.equal(before.size);
        expect(moved.source.equals(before.source)).to.be.true;
        await inboxSession.logout().catch(() => false);
        await archiveSession.logout().catch(() => false);
    });

    scenario('ESET-040', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        const before = await counts(own, [own.mb.INBOX, own.mb.Archive]);
        expectUpdated(await update(own.client, id, { mailboxIds: { [own.mb.Archive]: true } }), id);
        const after = await counts(own, [own.mb.INBOX, own.mb.Archive]);
        for (const key of ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']) {
            expect(after[own.mb.INBOX][key], key).to.equal(before[own.mb.INBOX][key] - 1);
            expect(after[own.mb.Archive][key], key).to.equal(before[own.mb.Archive][key] + 1);
        }
        expect((await restMailbox(own, 'INBOX')).total).to.equal(after[own.mb.INBOX].totalEmails);
        expect((await restMailbox(own, 'Archive')).total).to.equal(after[own.mb.Archive].totalEmails);
        expect((await restMailbox(own, 'Archive')).unseen).to.equal(after[own.mb.Archive].unreadEmails);
    });

    scenario('ESET-041', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        const s0 = await state(own.client);
        expectUpdated(await update(own.client, id, { mailboxIds: { [own.mb.Archive]: true } }), id);
        const emailChanges = await own.client.method('Email/changes', { sinceState: s0 });
        expect(emailChanges.updated).to.deep.equal([id]);
        expect(emailChanges.created).to.deep.equal([]);
        expect(emailChanges.destroyed).to.deep.equal([]);
        const mailboxChanges = await own.client.method('Mailbox/changes', { sinceState: s0 });
        expect([...mailboxChanges.updated].sort()).to.deep.equal([own.mb.INBOX, own.mb.Archive].sort());
        const counted = ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];
        expect(mailboxChanges.updatedProperties === null || mailboxChanges.updatedProperties.every(property => counted.includes(property))).to.be.true;
    });

    scenario('ESET-042', async () => {
        const own = await account();
        const ids = [];
        for (let i = 0; i < 5; i++) {
            ids.push((await seedEmail(own)).id);
        }
        const res = await set(own.client, { update: Object.fromEntries(ids.map(id => [id, { mailboxIds: { [own.mb.Archive]: true } }])) });
        expect(Object.keys(res.updated).sort()).to.deep.equal([...ids].sort());
        const archive = await own.client.method('Email/query', { filter: { inMailbox: own.mb.Archive } });
        expect([...archive.ids].sort()).to.deep.equal([...ids].sort());
        expect((await own.client.method('Email/query', { filter: { inMailbox: own.mb.INBOX } })).ids).to.deep.equal([]);
    });

    scenario('ESET-043', async () => {
        const { id } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { mailboxIds: { [ctx.mb.Archive]: true }, 'keywords/$seen': true }), id);
        expect(await emailOf(ctx, id, ['mailboxIds', 'keywords'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.Archive]: true }, keywords: { $seen: true } });
        const doc = await docOf(ctx, id);
        expect(await imapFlags(ctx, 'Archive', doc.uid)).to.include('\\Seen');
        // either part invalid: nothing applied
        const other = await seedEmail(ctx);
        expectNotUpdated(
            await update(ctx.client, other.id, { mailboxIds: { [ctx.mb.Archive]: true }, 'keywords/$seen': false }),
            other.id,
            'invalidProperties'
        );
        expect(await emailOf(ctx, other.id, ['mailboxIds', 'keywords'])).to.deep.equal({ id: other.id, mailboxIds: { [ctx.mb.INBOX]: true }, keywords: {} });
    });

    scenario('ESET-044', async () => {
        const { id } = await seedEmail(ctx);
        const error = expectNotUpdated(
            await update(ctx.client, id, { mailboxIds: { F000000000000000000000000: true }, 'keywords/$seen': true }),
            id,
            'invalidProperties'
        );
        expectProperties(error, ['mailboxIds']);
        expect(await emailOf(ctx, id, ['mailboxIds', 'keywords'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.INBOX]: true }, keywords: {} });
    });

    scenario('ESET-045', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        expectNotUpdated(await update(own.client, id, { [`mailboxIds/${own.mb.Archive}`]: true }), id, 'tooManyMailboxes');
        expectNotUpdated(await update(own.client, id, { mailboxIds: { [own.mb.INBOX]: true, [own.mb.Archive]: true } }), id, 'tooManyMailboxes');
        expect(await emailOf(own, id, ['mailboxIds'])).to.deep.equal({ id, mailboxIds: { [own.mb.INBOX]: true } });
        expect(await restListing(own, 'Archive')).to.deep.equal([]);
    });

    scenario('ESET-046', async () => {
        const { id } = await seedEmail(ctx);
        expectProperties(expectNotUpdated(await update(ctx.client, id, { [`mailboxIds/${ctx.mb.INBOX}`]: null }), id, 'invalidProperties'), ['mailboxIds']);
        expectProperties(expectNotUpdated(await update(ctx.client, id, { mailboxIds: {} }), id, 'invalidProperties'), ['mailboxIds']);
        expect(await emailOf(ctx, id, ['mailboxIds'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.INBOX]: true } });
    });

    scenario('ESET-047', async () => {
        const { id } = await seedEmail(ctx);
        for (const mailbox of ['F000000000000000000000000', 'invalid id!']) {
            expectProperties(expectNotUpdated(await update(ctx.client, id, { mailboxIds: { [mailbox]: true } }), id, 'invalidProperties'), ['mailboxIds']);
        }
        expect(await emailOf(ctx, id, ['mailboxIds'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.INBOX]: true } });
    });

    scenario('ESET-048', async () => {
        const { id } = await seedEmail(ctx);
        const patches = [
            { mailboxIds: { [ctx.mb.Archive]: false } },
            { [`mailboxIds/${ctx.mb.Archive}`]: false },
            { mailboxIds: { [ctx.mb.Archive]: 'yes' } },
            { mailboxIds: [ctx.mb.Archive] }
        ];
        for (const patch of patches) {
            expectProperties(expectNotUpdated(await update(ctx.client, id, patch), id, 'invalidProperties'), ['mailboxIds']);
        }
        expect(await emailOf(ctx, id, ['mailboxIds'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.INBOX]: true } });
    });

    scenario('ESET-049', async () => {
        const { id, uid } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { mailboxIds: { [ctx.mb.INBOX]: true }, 'keywords/$seen': true }), id);
        const doc = await docOf(ctx, id);
        expect(doc.uid).to.equal(uid);
        expect(await imapFlags(ctx, 'INBOX', uid)).to.include('\\Seen');
    });

    scenario('ESET-050', async () => {
        const { id } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { mailboxIds: { [ctx.mb.Trash]: true } }), id);
        expect(await emailOf(ctx, id, ['mailboxIds'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.Trash]: true } });
        const db = await seed.db();
        expect(await db.collection('archived').countDocuments({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(id.slice(1)) })).to.equal(0);
        const doc = await docOf(ctx, id);
        expect(await imapFlags(ctx, 'Trash', doc.uid)).to.not.include('\\Deleted');
    });

    scenario('ESET-051', async function () {
        const { id } = await seedEmail(ctx);
        const responses = await ctx.client.call(
            [
                ['Mailbox/set', { accountId: ctx.client.accountId, create: { mb: { name: `New ${Date.now()}` } } }, 'm'],
                ['Email/set', { accountId: ctx.client.accountId, update: { [id]: { mailboxIds: { '#mb': true } } } }, 'e']
            ],
            [jmap.URN.core, jmap.URN.mail]
        );
        if (responses[0][0] === 'error' && responses[0][1].type === 'unknownMethod') {
            // Mailbox/set (work package 2.2) is not in this tree yet
            return this.skip();
        }
        const created = responses[0][1].created.mb.id;
        expectUpdated(responses[1][1], id);
        expect(await emailOf(ctx, id, ['mailboxIds'])).to.deep.equal({ id, mailboxIds: { [created]: true } });
        const res = await update(ctx.client, id, { mailboxIds: { '#nope': true } });
        expectProperties(expectNotUpdated(res, id, 'invalidProperties'), ['mailboxIds']);
    });

    scenario('ESET-052', async () => {
        const { id } = await seedEmail(ctx, { mailbox: 'Drafts', flags: ['\\Draft'] });
        expectUpdated(await update(ctx.client, id, { mailboxIds: { [ctx.mb.INBOX]: true } }), id);
        expect(await emailOf(ctx, id, ['mailboxIds', 'keywords'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.INBOX]: true }, keywords: { $draft: true } });
    });

    scenario('ESET-053', async () => {
        const own = await account();
        const { id } = await seedEmail(own, { subject: 'Moved by JMAP', flags: ['\\Flagged'] });
        const before = await restMessage(own, id);
        expectUpdated(await update(own.client, id, { mailboxIds: { [own.mb.Archive]: true } }), id);
        expect(await restListing(own, 'INBOX')).to.deep.equal([]);
        const archive = await restListing(own, 'Archive');
        expect(archive).to.have.length(1);
        expect(archive[0].subject).to.equal('Moved by JMAP');
        expect(archive[0].flagged).to.equal(true);
        expect(archive[0].idate).to.equal(before.idate);
    });

    scenario('ESET-054', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const client = await imapFor(own.user);
        await client.mailboxOpen('INBOX');
        await client.messageMove(String(uid), 'Archive', { uid: true });
        expectUpdated(await update(own.client, id, { 'keywords/$seen': true }), id);
        expect(await emailOf(own, id, ['mailboxIds', 'keywords'])).to.deep.equal({ id, mailboxIds: { [own.mb.Archive]: true }, keywords: { $seen: true } });

        // a COPY is a second Email with an id of its own
        const doc = await docOf(own, id);
        await client.mailboxOpen('Archive');
        await client.messageCopy(String(doc.uid), 'INBOX', { uid: true });
        const { ids } = await own.client.method('Email/query', { filter: { inMailbox: own.mb.INBOX } });
        expect(ids).to.have.length(1);
        const copy = ids[0];
        expect(copy).to.not.equal(id);
        expectUpdated(await update(own.client, copy, { 'keywords/$flagged': true }), copy);
        expect(await keywordsOf(own, copy)).to.deep.equal({ $seen: true, $flagged: true });
        expect(await keywordsOf(own, id)).to.deep.equal({ $seen: true });
    });

    // ---- patch rules

    scenario('ESET-055', async () => {
        const { id } = await seedEmail(ctx);
        const before = await docOf(ctx, id);
        const error = (await update(ctx.client, id, { invalid: 'value' })).notUpdated[id];
        expect(['invalidProperties', 'invalidPatch']).to.include(error.type);
        if (error.type === 'invalidProperties') {
            expect(error.properties).to.deep.equal(['invalid']);
        }
        expect((await docOf(ctx, id)).modseq).to.equal(before.modseq);
    });

    scenario('ESET-056', async () => {
        const { id } = await seedEmail(ctx);
        expectNotUpdated(await update(ctx.client, id, { 'keywords/$absent/x': true }), id, 'invalidPatch');
        expectNotUpdated(await update(ctx.client, id, { 'mailboxIds/nosuchmailbox/x': true }), id, 'invalidPatch');
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
    });

    scenario('ESET-057', async () => {
        const { id } = await seedEmail(ctx);
        expectNotUpdated(await update(ctx.client, id, { keywords: { a: true }, 'keywords/$seen': true }), id, 'invalidPatch');
        expectNotUpdated(await update(ctx.client, id, { mailboxIds: { [ctx.mb.Archive]: true }, [`mailboxIds/${ctx.mb.INBOX}`]: null }), id, 'invalidPatch');
        expect(await emailOf(ctx, id, ['mailboxIds', 'keywords'])).to.deep.equal({ id, mailboxIds: { [ctx.mb.INBOX]: true }, keywords: {} });
    });

    scenario('ESET-058', async () => {
        const { id } = await seedEmail(ctx);
        const before = await docOf(ctx, id);
        for (const key of ['/keywords/$seen', '', 'keywords/', 'mailboxIds/invalid id!']) {
            const error = (await update(ctx.client, id, { [key]: true })).notUpdated[id];
            expect(['invalidPatch', 'invalidProperties'], key).to.include(error.type);
        }
        const after = await docOf(ctx, id);
        expect(after.flags).to.deep.equal(before.flags);
        expect(after.mailbox.toString()).to.equal(before.mailbox.toString());
    });

    scenario('ESET-059', async () => {
        const m1 = await seedEmail(ctx);
        const m2 = await seedEmail(ctx);
        const res = await set(ctx.client, { update: { [m1.id]: 'oops', [m2.id]: { 'keywords/$seen': true } } });
        expect(res.notUpdated[m1.id].type).to.equal('invalidPatch');
        expect(res.updated).to.have.property(m2.id);
        expect(await keywordsOf(ctx, m1.id)).to.deep.equal({});
        expect(await keywordsOf(ctx, m2.id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-060', async () => {
        const { id } = await seedEmail(ctx);
        const before = await docOf(ctx, id);
        const res = await update(ctx.client, id, {});
        expect(res.updated).to.deep.equal({ [id]: null });
        expect(res.newState).to.equal(res.oldState);
        expect((await docOf(ctx, id)).modseq).to.equal(before.modseq);
    });

    scenario('ESET-061', async () => {
        const { id } = await seedEmail(ctx);
        const properties = [
            'id',
            'blobId',
            'threadId',
            'size',
            'receivedAt',
            'subject',
            'from',
            'header:Subject',
            'bodyValues',
            'textBody',
            'bodyStructure',
            'preview',
            'hasAttachment'
        ];
        const original = await emailOf(ctx, id, properties);
        const values = {
            id: 'M000000000000000000000001',
            blobId: 'Bm000000000000000000000001',
            threadId: 'T000000000000000000000001',
            size: 1,
            receivedAt: '2001-01-01T00:00:00Z',
            subject: 'changed',
            from: [{ name: null, email: 'x@example.com' }],
            'header:Subject': ' changed',
            bodyValues: { 1: { value: 'x', isEncodingProblem: false, isTruncated: false } },
            textBody: [],
            bodyStructure: { type: 'text/plain', partId: '9' },
            preview: 'changed',
            hasAttachment: true
        };
        for (const [property, value] of Object.entries(values)) {
            expectProperties(expectNotUpdated(await update(ctx.client, id, { [property]: value }), id, 'invalidProperties'), [property]);
        }
        expect(await emailOf(ctx, id, properties)).to.deep.equal(original);
    });

    scenario('ESET-062', async () => {
        const { id } = await seedEmail(ctx);
        const email = await getOne(ctx.client, id);
        const patch = Object.assign({}, email, { keywords: { $seen: true } });
        expectUpdated(await update(ctx.client, id, patch), id);
        const after = await getOne(ctx.client, id);
        expect(after).to.deep.equal(Object.assign({}, email, { keywords: { $seen: true } }));
    });

    scenario('ESET-063', async () => {
        const { id } = await seedEmail(ctx);
        const error = expectNotUpdated(await update(ctx.client, id, { 'keywords/$seen': true, subject: 'new', size: 1 }), id, 'invalidProperties');
        expect(error.properties).to.include.members(['subject', 'size']);
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
    });

    scenario('ESET-064', async () => {
        const res = await update(ctx.client, 'M000000000000000000000000', { 'keywords/$seen': true });
        expect(res.updated).to.equal(null);
        expect(res.notUpdated).to.deep.equal({
            M000000000000000000000000: { type: 'notFound', description: res.notUpdated.M000000000000000000000000.description }
        });
    });

    scenario('ESET-065', async () => {
        const res = await update(ctx.client, 'not-an-id!', { 'keywords/$seen': true });
        expect(res.notUpdated['not-an-id!'].type).to.equal('notFound');
    });

    scenario('ESET-066', async () => {
        const { id } = await seedEmail(ctx);
        const res = await set(ctx.client, { update: { M00000000000000000000000f: { 'keywords/$seen': true }, [id]: { 'keywords/$seen': true } } });
        expect(res.updated).to.have.all.keys(id);
        expect(res.notUpdated.M00000000000000000000000f.type).to.equal('notFound');
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-067', async () => {
        const { id, uid } = await seedEmail(ctx, { flags: ['\\Deleted'] });
        const before = await imapFlags(ctx, 'INBOX', uid);
        expectNotUpdated(await update(ctx.client, id, { 'keywords/$seen': true }), id, 'notFound');
        expect(await imapFlags(ctx, 'INBOX', uid)).to.deep.equal(before);
    });

    scenario('ESET-068', async () => {
        const other = await account();
        const { id, uid } = await seedEmail(other);
        const res = await update(ctx.client, id, { 'keywords/$seen': true });
        expect(res.notUpdated[id].type).to.equal('notFound');
        const destroyed = await set(ctx.client, { destroy: [id] });
        expect(destroyed.notDestroyed[id].type).to.equal('notFound');
        expect(await imapFlags(other, 'INBOX', uid)).to.not.include('\\Seen');
        expect((await other.client.method('Email/get', { ids: [id], properties: ['id'] })).notFound).to.deep.equal([]);
        const error = await methodError(ctx.client, 'Email/set', { accountId: other.client.accountId, update: { [id]: { 'keywords/$seen': true } } });
        expect(error.type).to.equal('accountNotFound');
    });

    // ---- the generic /set rules

    scenario('ESET-088', async () => {
        const { id } = await seedEmail(ctx);
        const s0 = (await ctx.client.method('Email/get', { ids: [id], properties: ['id'] })).state;
        const res = await update(ctx.client, id, { 'keywords/$seen': true });
        expect(res.accountId).to.equal(ctx.client.accountId);
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.not.equal(s0);
        expect((await ctx.client.method('Email/get', { ids: [id], properties: ['id'] })).state).to.equal(res.newState);
    });

    scenario('ESET-089', async () => {
        const s0 = await state(ctx.client);
        const res = await set(ctx.client, { update: { M000000000000000000000000: { 'keywords/$seen': true } }, destroy: ['M000000000000000000000001'] });
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.equal(s0);
    });

    scenario('ESET-090', async () => {
        const s0 = await state(ctx.client);
        for (const args of [{}, { create: null, update: null, destroy: null }]) {
            const res = await set(ctx.client, args);
            expect(res.oldState).to.equal(s0);
            expect(res.newState).to.equal(s0);
            for (const key of ['created', 'updated', 'destroyed', 'notCreated', 'notUpdated', 'notDestroyed']) {
                expect(res[key], key).to.equal(null);
            }
        }
    });

    scenario('ESET-091', async () => {
        const { id } = await seedEmail(ctx);
        const res = await update(ctx.client, id, { mailboxIds: { [ctx.mb.Archive]: true } });
        expectUpdated(res, id);
        const mailboxState = (await ctx.client.method('Mailbox/get', { ids: [], properties: ['id'] })).state;
        const threadState = (await ctx.client.method('Thread/get', { ids: [] })).state;
        expect(mailboxState).to.equal(res.newState);
        expect(threadState).to.equal(res.newState);
        expect(await state(ctx.client)).to.equal(res.newState);
    });

    scenario('ESET-092', async () => {
        const { id } = await seedEmail(ctx);
        const s0 = await state(ctx.client);
        const res = await update(ctx.client, id, { 'keywords/$seen': true }, { ifInState: s0 });
        expectUpdated(res, id);
        expect(res.oldState).to.equal(s0);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-093', async () => {
        const own = await account();
        const m1 = await seedEmail(own);
        const m2 = await seedEmail(own);
        const s0 = await state(own.client);
        const client = await imapFor(own.user);
        await client.mailboxOpen('INBOX');
        await client.messageFlagsAdd(String(m1.uid), ['\\Answered'], { uid: true });
        const responses = await own.client.call([
            [
                'Email/set',
                {
                    accountId: own.client.accountId,
                    ifInState: s0,
                    create: { c1: draft(own) },
                    update: { [m1.id]: { 'keywords/$seen': true } },
                    destroy: [m2.id]
                },
                'call-1'
            ]
        ]);
        expect(responses).to.deep.equal([['error', { type: 'stateMismatch' }, 'call-1']]);
        expect(await keywordsOf(own, m1.id)).to.deep.equal({ $answered: true });
        expect((await own.client.method('Email/get', { ids: [m2.id], properties: ['id'] })).notFound).to.deep.equal([]);
        expect((await own.client.method('Email/query', { filter: { inMailbox: own.mb.Drafts } })).ids).to.deep.equal([]);
    });

    scenario('ESET-094', async () => {
        const { id } = await seedEmail(ctx);
        expectUpdated(await update(ctx.client, id, { 'keywords/$seen': true }, { ifInState: null }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-095', async () => {
        const { id } = await seedEmail(ctx);
        expect((await methodError(ctx.client, 'Email/set', { ifInState: 'garbage', update: { [id]: { 'keywords/$seen': true } } })).type).to.equal(
            'stateMismatch'
        );
        expect((await methodError(ctx.client, 'Email/set', { ifInState: 5, update: { [id]: { 'keywords/$seen': true } } })).type).to.equal('invalidArguments');
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
    });

    scenario('ESET-096', async () => {
        const { id } = await seedEmail(ctx);
        const s0 = await state(ctx.client);
        const accountId = ctx.client.accountId;
        const responses = await ctx.client.call([
            ['Email/set', { accountId, update: { [id]: { 'keywords/$seen': true } } }, 'a'],
            ['Email/get', { accountId, ids: [id], properties: ['keywords'] }, 'b'],
            ['Email/set', { accountId, ifInState: s0, update: { [id]: { 'keywords/$flagged': true } } }, 'c']
        ]);
        expectUpdated(responses[0][1], id);
        expect(responses[1][1].list[0].keywords).to.deep.equal({ $seen: true });
        expect(responses[1][1].state).to.equal(responses[0][1].newState);
        expect(responses[2]).to.deep.equal(['error', { type: 'stateMismatch' }, 'c']);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-097', async () => {
        const { id } = await seedEmail(ctx);
        const session = await ctx.client.session();
        const max = session.capabilities[jmap.URN.core].maxObjectsInSet;
        const unknown = Array.from({ length: max }, (_, i) => `M${i.toString(16).padStart(24, '0')}`);
        const error = await methodError(ctx.client, 'Email/set', { destroy: unknown, update: { [id]: { 'keywords/$seen': true } } });
        expect(error.type).to.equal('requestTooLarge');
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
        const res = await set(ctx.client, { destroy: unknown.slice(1), update: { [id]: { 'keywords/$seen': true } } });
        expectUpdated(res, id);
        expect(Object.keys(res.notDestroyed)).to.have.length(max - 1);
    });

    scenario('ESET-098', async () => {
        const call = async args => {
            const res = await ctx.client.request({ using: [jmap.URN.core, jmap.URN.mail], methodCalls: [['Email/set', args, 'c0']] });
            expect(res.status).to.equal(200);
            return res.json.methodResponses[0];
        };
        expect(await call({})).to.deep.include.members(['error']);
        expect((await call({}))[1].type).to.equal('invalidArguments');
        expect((await call({ accountId: 'unknown' }))[1].type).to.equal('accountNotFound');
        expect((await call({ accountId: 42 }))[1].type).to.equal('invalidArguments');
    });

    scenario('ESET-099', async () => {
        const { id } = await seedEmail(ctx);
        for (const args of [{ create: [] }, { update: 'x' }, { destroy: { [id]: true } }, { bogus: true, update: { [id]: { 'keywords/$seen': true } } }]) {
            expect((await methodError(ctx.client, 'Email/set', args)).type, JSON.stringify(args)).to.equal('invalidArguments');
        }
        expect(await keywordsOf(ctx, id)).to.deep.equal({});
    });

    scenario('ESET-100', async () => {
        const res = await ctx.client.request({ using: [jmap.URN.core], methodCalls: [['Email/set', { accountId: ctx.client.accountId }, 'c0']] });
        expect(res.json.methodResponses[0][0]).to.equal('error');
        expect(res.json.methodResponses[0][1].type).to.equal('unknownMethod');
    });

    scenario('ESET-101', async () => {
        const own = await account();
        const m1 = await seedEmail(own);
        const m2 = await seedEmail(own);
        const s0 = await state(own.client);
        const res = await set(own.client, { create: { c1: draft(own) }, update: { [m1.id]: { 'keywords/$seen': true } }, destroy: [m2.id] });
        expect(res.created).to.have.all.keys('c1');
        expect(res.updated).to.have.all.keys(m1.id);
        expect(res.destroyed).to.deep.equal([m2.id]);
        expect(res.notCreated).to.equal(null);
        expect(res.notUpdated).to.equal(null);
        expect(res.notDestroyed).to.equal(null);
        expect(res.oldState).to.equal(s0);
        expect(res.newState).to.equal(await state(own.client));
        const changes = await own.client.method('Email/changes', { sinceState: s0 });
        expect(changes.newState).to.equal(res.newState);
    });

    scenario('ESET-102', async () => {
        const { id } = await seedEmail(ctx);
        const res = await set(ctx.client, {
            create: { bad: { subject: 'no mailbox', textBody: [{ partId: 't' }], bodyValues: { t: { value: 'x' } } }, ok: draft(ctx) },
            update: { [id]: { 'keywords/$seen': true }, M00000000000000000000000a: { 'keywords/$seen': true } },
            destroy: ['M00000000000000000000000b']
        });
        expect(res.created).to.have.all.keys('ok');
        expect(res.notCreated.bad.type).to.equal('invalidProperties');
        expect(res.updated).to.have.all.keys(id);
        expect(res.notUpdated.M00000000000000000000000a.type).to.equal('notFound');
        expect(res.notDestroyed.M00000000000000000000000b.type).to.equal('notFound');
    });

    scenario('ESET-103', async () => {
        const { id } = await seedEmail(ctx);
        const res = await set(ctx.client, { update: { [id]: { 'keywords/$seen': true } }, destroy: [id] });
        expect(res.destroyed).to.deep.equal([id]);
        expect(res.notUpdated[id].type).to.equal('willDestroy');
        expect((await ctx.client.method('Email/get', { ids: [id], properties: ['id'] })).notFound).to.deep.equal([id]);
    });

    scenario('ESET-104', async () => {
        const res = await set(ctx.client, { create: { c1: draft(ctx) }, update: { '#c1': { 'keywords/$flagged': true } } });
        const real = res.created.c1.id;
        expect(res.updated).to.have.all.keys(real);
        expect(await keywordsOf(ctx, real)).to.deep.equal({ $flagged: true });
    });

    scenario('ESET-105', async () => {
        const accountId = ctx.client.accountId;
        const calls = [
            ['Email/set', { accountId, create: { c1: draft(ctx, { subject: 'ref' }) } }, 'a'],
            ['Email/get', { accountId, ids: ['#c1'], properties: ['subject'] }, 'b'],
            ['Email/set', { accountId, destroy: ['#c1'] }, 'c']
        ];
        const withIds = await ctx.client.request({ using: [jmap.URN.core, jmap.URN.mail], methodCalls: calls, createdIds: {} });
        const responses = withIds.json.methodResponses;
        const real = responses[0][1].created.c1.id;
        expect(responses[1][1].list).to.deep.equal([{ id: real, subject: 'ref' }]);
        expect(responses[2][1].destroyed).to.deep.equal([real]);
        expect(withIds.json.createdIds).to.deep.equal({ c1: real });

        const plain = await ctx.client.request({ using: [jmap.URN.core, jmap.URN.mail], methodCalls: calls });
        expect(plain.json).to.not.have.property('createdIds');
        expect(plain.json.methodResponses[2][1].destroyed).to.deep.equal([plain.json.methodResponses[0][1].created.c1.id]);
    });

    scenario('ESET-106', async () => {
        const { id } = await seedEmail(ctx);
        const res = await set(ctx.client, { update: { '#nope': { 'keywords/$seen': true }, [id]: { 'keywords/$seen': true } }, destroy: ['#nope2'] });
        expect(res.updated).to.have.all.keys(id);
        expect(res.notUpdated['#nope'].type).to.equal('notFound');
        expect(res.notDestroyed['#nope2'].type).to.equal('notFound');
    });

    scenario('ESET-107', async () => {
        const accountId = ctx.client.accountId;
        const responses = await ctx.client.call([
            ['Email/set', { accountId, create: { c1: draft(ctx, { subject: 'first' }) } }, 'a'],
            ['Email/set', { accountId, create: { c1: draft(ctx, { subject: 'second' }) } }, 'b'],
            ['Email/get', { accountId, ids: ['#c1'], properties: ['subject'] }, 'c']
        ]);
        expect(responses[2][1].list).to.deep.equal([{ id: responses[1][1].created.c1.id, subject: 'second' }]);
    });

    scenario('ESET-108', async () => {
        const [m1, m2, m3] = [await seedEmail(ctx), await seedEmail(ctx), await seedEmail(ctx)];
        const res = await set(ctx.client, {
            update: {
                [m1.id]: { 'keywords/$seen': true },
                [m2.id]: { 'keywords/$seen': true, subject: 'nope' },
                [m3.id]: { 'keywords/$seen': true }
            }
        });
        expect(res.updated).to.have.all.keys(m1.id, m3.id);
        expect(res.notUpdated[m2.id].type).to.equal('invalidProperties');
        expect(await keywordsOf(ctx, m2.id)).to.deep.equal({});
        expect(await keywordsOf(ctx, m1.id)).to.deep.equal({ $seen: true });
    });

    scenario('ESET-109', async () => {
        const { id } = await seedEmail(ctx);
        const res = await set(ctx.client, {
            create: { a: { subject: 'x' }, b: draft(ctx, { unknown: 1 }) },
            update: { [id]: { subject: 'y' }, M000000000000000000000000: {} },
            destroy: ['M000000000000000000000000']
        });
        const known = [
            'forbidden',
            'overQuota',
            'tooLarge',
            'rateLimit',
            'notFound',
            'invalidPatch',
            'willDestroy',
            'invalidProperties',
            'singleton',
            'blobNotFound',
            'tooManyKeywords',
            'tooManyMailboxes'
        ];
        const errors = [...Object.values(res.notCreated), ...Object.values(res.notUpdated), ...Object.values(res.notDestroyed)];
        expect(errors).to.have.length(5);
        for (const error of errors) {
            expect(known).to.include(error.type);
            if ('description' in error) {
                expect(error.description).to.be.a('string');
            }
            if (error.type === 'invalidProperties') {
                expect(error.properties).to.be.an('array');
                expect(error.properties.every(property => typeof property === 'string')).to.be.true;
            }
        }
    });

    // ---- concurrency

    scenario('ESET-232', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        const second = jmap.forUser(own.user);
        await second.session();
        for (let round = 0; round < 50; round++) {
            const [a, b] = await Promise.all([update(own.client, id, { 'keywords/$seen': true }), update(second, id, { 'keywords/$flagged': true })]);
            expectUpdated(a, id);
            expectUpdated(b, id);
            expect(await keywordsOf(own, id), `round ${round}`).to.deep.equal({ $seen: true, $flagged: true });
            expectUpdated(await update(own.client, id, { keywords: {} }), id);
        }
    });

    scenario('ESET-233', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const second = jmap.forUser(own.user);
        await second.session();
        for (let round = 0; round < 10; round++) {
            const [a, b] = await Promise.all([update(own.client, id, { keywords: { a: true } }), update(second, id, { keywords: { b: true } })]);
            expectUpdated(a, id);
            expectUpdated(b, id);
            const keywords = await keywordsOf(own, id);
            expect([JSON.stringify({ a: true }), JSON.stringify({ b: true })], `round ${round}`).to.include(JSON.stringify(keywords));
            expect(lower(without(await imapFlags(own, 'INBOX', uid), '\\Recent'))).to.deep.equal(Object.keys(keywords));
        }
    });

    scenario('ESET-234', async () => {
        const { id } = await seedEmail(ctx);
        const second = jmap.forUser(ctx.user);
        await second.session();
        const s0 = await state(ctx.client);
        expectUpdated(await update(ctx.client, id, { 'keywords/$seen': true }, { ifInState: s0 }), id);
        expect((await methodError(second, 'Email/set', { ifInState: s0, update: { [id]: { 'keywords/$flagged': true } } })).type).to.equal('stateMismatch');
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true });
        expectUpdated(await update(second, id, { 'keywords/$flagged': true }, { ifInState: await state(second) }), id);
        expect(await keywordsOf(ctx, id)).to.deep.equal({ $seen: true, $flagged: true });
    });

    scenario('ESET-235', async () => {
        const own = await account();
        await api('POST', `/users/${own.user.id}/mailboxes`, { path: 'A' });
        await api('POST', `/users/${own.user.id}/mailboxes`, { path: 'B' });
        const { list } = await own.client.method('Mailbox/get', { properties: ['name'] });
        const box = name => list.find(entry => entry.name === name).id;
        const { id } = await seedEmail(own);
        const second = jmap.forUser(own.user);
        await second.session();
        const [a, b] = await Promise.all([
            update(own.client, id, { mailboxIds: { [box('A')]: true } }),
            update(second, id, { mailboxIds: { [box('B')]: true } })
        ]);
        for (const res of [a, b]) {
            expect(res.updated !== null ? Object.keys(res.updated) : [], JSON.stringify(res)).to.satisfy(
                keys => keys.includes(id) || (res.notUpdated && res.notUpdated[id].type === 'notFound')
            );
        }
        const email = await emailOf(own, id, ['mailboxIds']);
        const where = Object.keys(email.mailboxIds);
        expect(where).to.have.length(1);
        expect([box('A'), box('B')]).to.include(where[0]);
        const listings = { INBOX: await restListing(own, 'INBOX'), A: await restListing(own, 'A'), B: await restListing(own, 'B') };
        expect(listings.INBOX).to.have.length(0);
        expect(listings.A.length + listings.B.length).to.equal(1);
        const all = await counts(own, [own.mb.INBOX, box('A'), box('B')]);
        expect(all[own.mb.INBOX].totalEmails).to.equal(0);
        expect(all[box('A')].totalEmails).to.equal(listings.A.length);
        expect(all[box('B')].totalEmails).to.equal(listings.B.length);
    });

    scenario('ESET-236', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        const second = jmap.forUser(own.user);
        await second.session();
        const [destroyed, updated] = await Promise.all([set(own.client, { destroy: [id] }), update(second, id, { 'keywords/$seen': true })]);
        expect(destroyed.destroyed).to.deep.equal([id]);
        expect(updated.updated ? Object.keys(updated.updated) : [updated.notUpdated[id].type]).to.satisfy(
            list => list.includes(id) || list.includes('notFound')
        );
        expect((await own.client.method('Email/get', { ids: [id], properties: ['id'] })).notFound).to.deep.equal([id]);
        expect(await restListing(own, 'INBOX')).to.deep.equal([]);
        const db = await seed.db();
        expect(await db.collection('archived').countDocuments({ user: new seed.ObjectId(own.user.id), root: new seed.ObjectId(id.slice(1)) })).to.equal(1);
    });

    scenario('ESET-237', async () => {
        const own = await account();
        const { id } = await seedEmail(own);
        await seedEmail(own);
        const second = jmap.forUser(own.user);
        await second.session();
        const before = await counts(own, [own.mb.INBOX]);
        const usedBefore = (await api('GET', `/users/${own.user.id}`)).limits.quota.used;
        const size = (await emailOf(own, id, ['size'])).size;
        const [a, b] = await Promise.all([set(own.client, { destroy: [id] }), set(second, { destroy: [id] })]);
        const outcomes = [a, b].map(res => (res.destroyed && res.destroyed.includes(id) ? 'destroyed' : res.notDestroyed[id].type));
        expect(outcomes).to.include('destroyed');
        expect(outcomes.every(outcome => ['destroyed', 'notFound'].includes(outcome))).to.be.true;
        expect((await counts(own, [own.mb.INBOX]))[own.mb.INBOX].totalEmails).to.equal(before[own.mb.INBOX].totalEmails - 1);
        expect((await api('GET', `/users/${own.user.id}`)).limits.quota.used).to.equal(usedBefore - size);
        const db = await seed.db();
        expect(await db.collection('archived').countDocuments({ user: new seed.ObjectId(own.user.id), root: new seed.ObjectId(id.slice(1)) })).to.equal(1);
    });

    scenario('ESET-238', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const client = await imapFor(own.user);
        await client.mailboxOpen('INBOX');
        const [, res] = await Promise.all([client.messageMove(String(uid), 'Archive', { uid: true }), update(own.client, id, { 'keywords/$flagged': true })]);
        expectUpdated(res, id);
        const doc = await docOf(own, id);
        expect((await pathOf(own, doc.mailbox)).toString()).to.equal('Archive');
        await clock.waitFor(async () => (await imapFlags(own, 'Archive', (await docOf(own, id)).uid)).includes('\\Flagged'), {
            timeout: 3000,
            message: 'the moved message has \\Flagged'
        });
    });

    scenario('ESET-239', async () => {
        const own = await account();
        const { id, uid } = await seedEmail(own);
        const s0 = await state(own.client);
        const client = await imapFor(own.user);
        await client.mailboxOpen('INBOX');
        const [, res] = await Promise.all([
            client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }),
            update(own.client, id, { 'keywords/$flagged': true })
        ]);
        expectUpdated(res, id);
        expect(await keywordsOf(own, id)).to.deep.equal({ $answered: true, $flagged: true });
        expect(lower(without(await imapFlags(own, 'INBOX', uid), '\\Recent'))).to.deep.equal(['\\answered', '\\flagged']);
        expect((await own.client.method('Email/changes', { sinceState: s0 })).updated).to.deep.equal([id]);
    });
});

async function pathOf(ctx, mailbox) {
    const db = await seed.db();
    return (await db.collection('mailboxes').findOne({ _id: mailbox })).path;
}
