/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue file email-query.yaml: Email/queryChanges and canCalculateChanges (phase 4, work package 4.3).

const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const { scenario, api, seed } = require('../harness');
const redisUrl = require('../../../lib/redis-url');
const { setup, rawMessage, append, imapIn, query, errorOf, ids, day, threadMessages, deliverTo, applyChanges, inProcess } = require('./email-query-helpers');

const ASC = [{ property: 'receivedAt', isAscending: true }];
const DESC = [{ property: 'receivedAt', isAscending: false }];
const RESPONSE_KEYS = ['accountId', 'oldQueryState', 'newQueryState', 'removed', 'added'];

const changes = (ctx, args) => ctx.client.method('Email/queryChanges', args);
const changesError = (ctx, args) => errorOf(ctx, args, 'Email/queryChanges');

/** Email/query and queryChanges with the same arguments */
function tracked(ctx, args) {
    return {
        query: extra => query(ctx, Object.assign({}, args, extra)),
        since: (sinceQueryState, extra) => changes(ctx, Object.assign({ sinceQueryState }, args, extra)),
        error: (sinceQueryState, extra) => changesError(ctx, Object.assign({ sinceQueryState }, args, extra))
    };
}

/** Where a message with this Email id is stored now */
async function locate(ctx, id) {
    const db = await seed.db();
    const doc = await db
        .collection('messages')
        .find({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(id.slice(1)) }, { projection: { mailbox: true, uid: true } })
        .sort({ _id: -1 })
        .limit(1)
        .next();
    expect(doc, id).to.exist;
    const path = Object.keys(ctx.boxes).find(name => ctx.boxes[name].id === doc.mailbox.toString() && !name.startsWith('\\'));
    return { mailbox: doc.mailbox.toString(), uid: doc.uid, path };
}

/** Runs an IMAP command on the message with this Email id, in its current mailbox */
async function onMessage(ctx, id, fn) {
    const { path, uid } = await locate(ctx, id);
    return imapIn(ctx, path, client => fn(client, String(uid)));
}

const flag = (ctx, id, flags) => onMessage(ctx, id, (client, uid) => client.messageFlagsAdd(uid, flags, { uid: true }));
const unflag = (ctx, id, flags) => onMessage(ctx, id, (client, uid) => client.messageFlagsRemove(uid, flags, { uid: true }));
const moveTo = (ctx, id, path) => onMessage(ctx, id, (client, uid) => client.messageMove(uid, ctx.boxes[path].path, { uid: true }));
const expunge = (ctx, id) => onMessage(ctx, id, (client, uid) => client.messageDelete(uid, { uid: true }));
const destroy = (ctx, id) => ctx.client.method('Email/set', { destroy: [id] });

/** A message whose Message-ID is unique to this run */
let counter = 0;
const unique = (subject, extra = {}) => rawMessage(Object.assign({ subject, messageId: `<qc.${Date.now()}.${++counter}@test.example>` }, extra));

describe('Email/queryChanges (email-query.yaml)', () => {
    describe('canCalculateChanges and arguments', () => {
        scenario('EQRY-158', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(1) }, { date: day(2), flags: ['\\Flagged'] }]);
            const inbox = ctx.mailbox('INBOX');
            const variants = [
                { filter: { inMailbox: inbox }, sort: ASC },
                { filter: { inMailbox: inbox }, sort: ASC, collapseThreads: true },
                { filter: null },
                { filter: { inMailbox: inbox, hasKeyword: '$flagged' } },
                { filter: { text: 'foo' } }
            ];
            for (const args of variants) {
                const res = await query(ctx, args);
                expect(res.canCalculateChanges, JSON.stringify(args)).to.be.true;
                const next = await changes(ctx, Object.assign({ sinceQueryState: res.queryState }, args));
                expect(next.oldQueryState).to.equal(res.queryState);
                expect(next.removed).to.deep.equal([]);
                expect(next.added).to.deep.equal([]);
            }
        });

        scenario('EQRY-166', async () => {
            const ctx = await setup();
            const state = (await query(ctx, {})).queryState;
            expect(await changesError(ctx, {})).to.equal('invalidArguments');
            expect(await changesError(ctx, { sinceQueryState: 5 })).to.equal('invalidArguments');
            expect(await changesError(ctx, { sinceQueryState: state, maxChanges: -1 })).to.equal('invalidArguments');
            expect(await changesError(ctx, { sinceQueryState: state, filter: { bogus: 1 } })).to.equal('invalidArguments');
            const [[name, response]] = await ctx.client.call([
                ['Email/queryChanges', { accountId: `u${crypto.randomBytes(12).toString('hex')}`, sinceQueryState: state }, 'c']
            ]);
            expect([name, response.type]).to.deep.equal(['error', 'accountNotFound']);
            expect(await changesError(ctx, { sinceQueryState: `q${crypto.randomBytes(20).toString('hex')}` })).to.equal('cannotCalculateChanges');
            expect(await changesError(ctx, { sinceQueryState: 'unknown' })).to.equal('cannotCalculateChanges');
        });

        scenario('EQRY-184', async () => {
            const ctx = await setup();
            const state = (await query(ctx, {})).queryState;
            for (const maxChanges of [-1, 0, 'x']) {
                expect(await changesError(ctx, { sinceQueryState: state, maxChanges }), String(maxChanges)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-193', async () => {
            const ctx = await setup();
            const state = (await query(ctx, {})).queryState;
            expect(await changesError(ctx, { sinceQueryState: state, filter: { bogus: 1 } })).to.equal('invalidArguments');
            expect(await changesError(ctx, { sinceQueryState: state, sort: [{ property: 'hasKeyword' }] })).to.equal('invalidArguments');
            expect(await changesError(ctx, { sinceQueryState: state, sort: [{ property: 'nonexistent' }] })).to.equal('unsupportedSort');
            expect(await changesError(ctx, {})).to.equal('invalidArguments');
        });

        scenario('EQRY-188', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(1) }]);
            const q1 = (await query(ctx, { collapseThreads: true })).queryState;
            expect(await changesError(ctx, { sinceQueryState: q1, collapseThreads: false })).to.equal('cannotCalculateChanges');
            expect(await changesError(ctx, { sinceQueryState: q1 })).to.equal('cannotCalculateChanges');
            expect((await changes(ctx, { sinceQueryState: q1, collapseThreads: true })).added).to.deep.equal([]);
        });

        scenario('EQRY-189', async () => {
            const ctx = await setup(['Work']);
            await append(ctx, [{ date: day(1) }]);
            const filter = { inMailbox: ctx.mailbox('INBOX'), after: '2020-01-01T00:00:00Z' };
            const q1 = (await query(ctx, { filter, sort: DESC })).queryState;
            expect(await changesError(ctx, { sinceQueryState: q1, filter: { inMailbox: ctx.mailbox('Work') }, sort: DESC })).to.equal('cannotCalculateChanges');
            expect(await changesError(ctx, { sinceQueryState: q1, filter, sort: [{ property: 'size' }] })).to.equal('cannotCalculateChanges');
            expect(await changesError(ctx, { sinceQueryState: q1, filter: null, sort: DESC })).to.equal('cannotCalculateChanges');
            // the same filter with its keys in another order is the same query
            const reordered = { after: filter.after, inMailbox: filter.inMailbox };
            expect((await changes(ctx, { sinceQueryState: q1, filter: reordered, sort: DESC })).removed).to.deep.equal([]);
        });

        scenario('EQRY-190', async () => {
            const ctx = await setup();
            const other = await setup();
            await append(ctx, [{ date: day(1) }]);
            await append(other, [{ date: day(1) }]);
            const q1 = (await query(ctx, { sort: DESC })).queryState;
            const foreign = (await query(other, { sort: DESC })).queryState;
            for (const sinceQueryState of ['garbage', '0', foreign]) {
                expect(await changesError(ctx, { sinceQueryState, sort: DESC }), sinceQueryState).to.equal('cannotCalculateChanges');
            }
            // the cached result of a state is kept for a limited time; once it is gone (as after the
            // journal retention, which is far longer) the state can not be followed any more
            const redis = new Redis(typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis);
            try {
                expect(await redis.hdel(`jmap:qc:${ctx.user.id}`, q1)).to.equal(1);
            } finally {
                redis.disconnect();
            }
            expect(await changesError(ctx, { sinceQueryState: q1, sort: DESC })).to.equal('cannotCalculateChanges');
        });

        scenario('EQRY-191', async () => {
            const ctx = await setup();
            await append(
                ctx,
                Array.from({ length: 6 }, (item, i) => ({ date: day(i + 1) }))
            );
            // a service that caches at most four ids: a window past them can not be followed
            const service = await inProcess(ctx, { queryCache: { maxIds: 4 } });
            try {
                const res = await service.method('Email/query', { sort: DESC, position: 3, limit: 3 });
                expect(res.canCalculateChanges).to.be.false;
                const err = await service.method('Email/queryChanges', { sort: DESC, sinceQueryState: res.queryState }).catch(error => error);
                expect(err.type).to.equal('cannotCalculateChanges');
            } finally {
                await service.close();
            }
        });
    });

    describe('reported changes', () => {
        scenario('EQRY-167', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(1) }, { date: day(2) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC });
            const q1 = (await q.query()).queryState;
            const res = await q.since(q1);
            expect(res).to.have.all.keys(RESPONSE_KEYS);
            expect(res).to.deep.equal({ accountId: ctx.client.accountId, oldQueryState: q1, newQueryState: q1, removed: [], added: [] });
        });

        scenario('EQRY-168', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(1) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC });
            const q1 = (await q.query()).queryState;
            const added = await deliverTo(ctx, unique('New 168'));
            const plain = await q.since(q1);
            expect(plain).to.have.all.keys(RESPONSE_KEYS);
            expect(plain.removed).to.be.an('array');
            expect(plain.added).to.deep.equal([{ id: added, index: 0 }]);
            for (const item of plain.added) {
                expect(item).to.have.all.keys('id', 'index');
            }
            const withTotal = await q.since(q1, { calculateTotal: true });
            expect(withTotal).to.have.all.keys([...RESPONSE_KEYS, 'total']);
            expect(withTotal.total).to.equal(2);
            const indexes = withTotal.added.map(item => item.index);
            expect([...indexes].sort((a, b) => a - b)).to.deep.equal(indexes);
        });

        scenario('EQRY-169', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [{ date: day(1) }, { date: day(2) }]);
            const inbox = { inMailbox: ctx.mailbox('INBOX') };
            const desc = tracked(ctx, { filter: inbox, sort: DESC });
            const asc = tracked(ctx, { filter: inbox, sort: ASC });
            const first = await desc.query();
            expect(first.ids).to.deep.equal(ids([e2, e1]));
            const firstAsc = await asc.query();
            const e3 = await deliverTo(ctx, unique('New 169'));

            const down = await desc.since(first.queryState);
            expect(down.removed).to.deep.equal([]);
            expect(down.added).to.deep.equal([{ id: e3, index: 0 }]);
            expect(down.newQueryState).to.equal((await desc.query()).queryState);
            const up = await asc.since(firstAsc.queryState);
            expect(up.removed).to.deep.equal([]);
            expect(up.added).to.deep.equal([{ id: e3, index: 2 }]);
            expect(up.newQueryState).to.equal((await asc.query()).queryState);
        });

        scenario('EQRY-170', async () => {
            const ctx = await setup(['Work']);
            await append(ctx, [{ box: 'Work', date: day(1) }]);
            const work = tracked(ctx, { filter: { inMailbox: ctx.mailbox('Work') } });
            const q1 = (await work.query()).queryState;
            await deliverTo(ctx, unique('Inbox 170'));
            const res = await work.since(q1);
            expect(res.removed).to.deep.equal([]);
            expect(res.added).to.deep.equal([]);
            if (res.newQueryState !== q1) {
                const again = await work.since(res.newQueryState);
                expect(again.removed).to.deep.equal([]);
                expect(again.added).to.deep.equal([]);
            }
        });

        scenario('EQRY-171', async () => {
            const ctx = await setup();
            const [, e2] = await append(ctx, [{ date: day(1) }, { date: day(2) }, { date: day(3) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') } });
            const q1 = (await q.query()).queryState;
            await destroy(ctx, e2.id);
            const res = await q.since(q1, { calculateTotal: true });
            expect(res.removed).to.include(e2.id);
            expect(res.added).to.deep.equal([]);
            expect(res.total).to.equal(2);
        });

        scenario('EQRY-172', async () => {
            const ctx = await setup(['Work']);
            const [, e9] = await append(ctx, [{ box: 'Work', date: day(1) }, { date: day(2) }]);
            const work = tracked(ctx, { filter: { inMailbox: ctx.mailbox('Work') } });
            const q1 = (await work.query()).queryState;
            await destroy(ctx, e9.id);
            const res = await work.since(q1);
            expect(res.added).to.deep.equal([]);
            expect(res.removed).to.deep.equal([]);
        });

        scenario('EQRY-173', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [{ date: day(1) }, { date: day(2) }, { date: day(3) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: ASC });
            const q1 = (await q.query()).queryState;

            await flag(ctx, e2.id, ['\\Deleted']);
            const r1 = await q.since(q1);
            expect(r1.removed).to.deep.equal([e2.id]);
            expect(r1.added).to.deep.equal([]);
            const q2 = r1.newQueryState;

            await unflag(ctx, e2.id, ['\\Deleted']);
            const r2 = await q.since(q2);
            expect(r2.removed).to.deep.equal([]);
            expect(r2.added).to.deep.equal([{ id: e2.id, index: 1 }]);
            const q3 = r2.newQueryState;

            await flag(ctx, e2.id, ['\\Deleted']);
            await expunge(ctx, e2.id);
            const r3 = await q.since(q3);
            expect(r3.removed).to.deep.equal([e2.id]);
            expect(r3.added).to.deep.equal([]);
            const r4 = await q.since(q1);
            expect(r4.removed).to.include(e2.id);
            expect(r4.added.map(item => item.id)).to.not.include(e2.id);
            expect(applyChanges(ids([e1, e2, e3]), r4)).to.deep.equal(ids([e1, e3]));
        });

        scenario('EQRY-174', async () => {
            const ctx = await setup(['Work']);
            const [e1, e2, e3] = await append(ctx, [{ date: day(1) }, { date: day(2) }, { box: 'Work', date: day(3) }]);
            const inbox = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: ASC });
            const work = tracked(ctx, { filter: { inMailbox: ctx.mailbox('Work') }, sort: ASC });
            const qi = (await inbox.query()).queryState;
            const qw = (await work.query()).queryState;

            await moveTo(ctx, e1.id, 'Work');
            const i1 = await inbox.since(qi);
            expect(i1.removed).to.deep.equal([e1.id]);
            expect(i1.added).to.deep.equal([]);
            const w1 = await work.since(qw);
            expect(w1.removed).to.deep.equal([]);
            expect(w1.added).to.deep.equal([{ id: e1.id, index: 0 }]);

            await ctx.client.method('Email/set', { update: { [e3.id]: { mailboxIds: { [ctx.mailbox('INBOX')]: true } } } });
            const e2place = await locate(ctx, e2.id);
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${e2place.mailbox}/messages/${e2place.uid}`, { moveTo: ctx.boxes.Work.id });

            const i2 = await inbox.since(qi);
            expect(i2.removed).to.have.members(ids([e1, e2]));
            expect(i2.added).to.deep.equal([{ id: e3.id, index: 0 }]);
            const w2 = await work.since(qw);
            expect(w2.removed).to.deep.equal([e3.id]);
            expect(w2.added).to.deep.equal([
                { id: e1.id, index: 0 },
                { id: e2.id, index: 1 }
            ]);
            expect((await inbox.query()).ids).to.deep.equal([e3.id]);
            expect((await work.query()).ids).to.deep.equal(ids([e1, e2]));
        });

        scenario('EQRY-175', async () => {
            const ctx = await setup(['Work']);
            const entries = await append(ctx, [{ date: day(1) }, { date: day(2) }, { date: day(3) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: ASC });
            const before = await q.query();
            await imapIn(ctx, 'INBOX', client => client.messageMove('1:*', ctx.boxes.Work.path));
            await imapIn(ctx, 'Work', client => client.messageMove('1:*', ctx.boxes.INBOX.path));
            await flag(ctx, entries[1].id, ['\\Flagged']);

            const res = await q.since(before.queryState);
            const known = new Set(before.ids);
            for (const id of res.removed) {
                expect(
                    res.added.map(item => item.id),
                    `${id} removed without being added`
                ).to.include(id);
            }
            for (const item of res.added) {
                expect(known.has(item.id), `${item.id} is not one of the original ids`).to.be.true;
            }
            expect(applyChanges(before.ids, res)).to.deep.equal(before.ids);
            expect((await q.query()).ids).to.deep.equal(before.ids);
        });

        scenario('EQRY-176', async () => {
            const ctx = await setup(['Work']);
            const [e1] = await append(ctx, [{ date: day(1) }]);
            const work = tracked(ctx, { filter: { inMailbox: ctx.mailbox('Work') } });
            const inbox = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') } });
            const qw = (await work.query()).queryState;
            const qi = (await inbox.query()).queryState;
            await onMessage(ctx, e1.id, (client, uid) => client.messageCopy(uid, ctx.boxes.Work.path, { uid: true }));

            const w = await work.since(qw);
            expect(w.removed).to.deep.equal([]);
            expect(w.added).to.have.lengthOf(1);
            expect(w.added[0].index).to.equal(0);
            expect(w.added[0].id)
                .to.match(/^M[0-9a-f]{24}$/)
                .and.not.equal(e1.id);
            const i = await inbox.since(qi);
            expect(i.removed).to.deep.equal([]);
            expect(i.added).to.deep.equal([]);
        });

        scenario('EQRY-177', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [{ date: day(1) }, { date: day(2) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: ASC });
            const q1 = (await q.query()).queryState;
            await flag(ctx, e1.id, ['\\Seen', '\\Flagged']);
            await flag(ctx, e2.id, ['custom177']);
            const res = await q.since(q1);
            expect(res.removed).to.deep.equal([]);
            expect(res.added).to.deep.equal([]);
        });

        scenario('EQRY-178', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [{ date: day(1), flags: ['\\Flagged'] }, { date: day(2) }, { date: day(3), flags: ['\\Flagged'] }]);
            const q = tracked(ctx, { filter: { hasKeyword: '$flagged' }, sort: ASC });
            const before = await q.query();
            expect(before.ids).to.deep.equal(ids([e1, e3]));
            await unflag(ctx, e1.id, ['\\Flagged']);
            await flag(ctx, e2.id, ['\\Flagged']);
            const res = await q.since(before.queryState);
            expect(res.removed).to.include(e1.id);
            expect(res.added).to.deep.include({ id: e2.id, index: 0 });
            if (res.removed.includes(e3.id)) {
                expect(res.added).to.deep.include({ id: e3.id, index: 1 });
            }
            expect(applyChanges(before.ids, res)).to.deep.equal(ids([e2, e3]));
        });

        scenario('EQRY-179', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [{ date: day(1) }, { date: day(2) }, { date: day(3) }]);
            const q = tracked(ctx, { sort: [{ property: 'hasKeyword', keyword: '$flagged', isAscending: false }, ...ASC] });
            const before = await q.query();
            expect(before.ids).to.deep.equal(ids([e1, e2, e3]));
            await flag(ctx, e3.id, ['\\Flagged']);
            const res = await q.since(before.queryState);
            expect(res.removed).to.include(e3.id);
            expect(res.added).to.deep.include({ id: e3.id, index: 0 });
            for (const id of res.removed) {
                expect(res.added.map(item => item.id)).to.include(id);
            }
            expect(applyChanges(before.ids, res)).to.deep.equal(ids([e3, e1, e2]));
        });

        scenario('EQRY-181', async () => {
            const ctx = await setup();
            const entries = await append(
                ctx,
                Array.from({ length: 10 }, (item, i) => ({ date: day(i + 1) }))
            );
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC });
            const before = await q.query({ limit: 3 });
            const cached = ids([entries[9], entries[8], entries[7]]);
            expect(before.ids).to.deep.equal(cached);
            const e11 = await deliverTo(ctx, unique('New 181'));
            await expunge(ctx, entries[1].id);

            const res = await q.since(before.queryState, { upToId: entries[7].id });
            expect(res.added).to.deep.equal([{ id: e11, index: 0 }]);
            expect(res.removed).to.not.include(entries[1].id);
            const patched = applyChanges(cached, res);
            const current = (await q.query()).ids;
            expect(patched).to.deep.equal(current.slice(0, patched.length));
            expect(patched.slice(0, 4)).to.deep.equal([e11, ...cached]);
        });

        scenario('EQRY-182', async () => {
            const ctx = await setup();
            const entries = await append(
                ctx,
                Array.from({ length: 6 }, (item, i) => ({ date: day(i + 1), flags: ['\\Flagged'] }))
            );
            const flagged = tracked(ctx, { filter: { hasKeyword: '$flagged' }, sort: DESC });
            const before = await flagged.query();
            const all = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC });
            const allBefore = await all.query();
            await unflag(ctx, entries[0].id, ['\\Flagged']);

            const res = await flagged.since(before.queryState, { upToId: before.ids[1] });
            expect(res.removed).to.include(entries[0].id);
            expect(applyChanges(before.ids, res)).to.deep.equal(before.ids.slice(0, 5));

            const e7 = await deliverTo(ctx, unique('New 182'));
            const full = await all.since(allBefore.queryState, { upToId: `M${'0'.repeat(24)}` });
            expect(full.added).to.deep.equal([{ id: e7, index: 0 }]);
            expect(full.removed).to.deep.equal([]);
        });

        scenario('EQRY-183', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(1) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC });
            const collapsed = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC, collapseThreads: true });
            const q1 = (await q.query()).queryState;
            const c1 = (await collapsed.query()).queryState;
            const added = [];
            for (let i = 0; i < 3; i++) {
                added.push(await deliverTo(ctx, unique(`New 183 ${i}`)));
            }
            expect(await q.error(q1, { maxChanges: 1 })).to.equal('tooManyChanges');
            expect(await q.error(q1, { maxChanges: 2 })).to.equal('tooManyChanges');
            expect(await collapsed.error(c1, { maxChanges: 1 })).to.equal('tooManyChanges');
            for (const maxChanges of [3, null]) {
                const res = await q.since(q1, { maxChanges });
                expect(res.removed).to.deep.equal([]);
                expect(res.added.map(item => item.id)).to.have.members(added);
            }
        });

        scenario('EQRY-185', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [{ date: day(1) }, { date: day(2) }, { date: day(3) }, { date: day(4) }]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') } });
            const q1 = (await q.query()).queryState;
            expect((await q.since(q1, { calculateTotal: true })).total).to.equal(4);
            await deliverTo(ctx, unique('New 185 a'));
            await deliverTo(ctx, unique('New 185 b'));
            await expunge(ctx, entries[0].id);
            const res = await q.since(q1, { calculateTotal: true });
            expect(res.total).to.equal(5);
            expect((await q.since(res.newQueryState, { calculateTotal: true })).total).to.equal(5);
            expect(await q.since(q1, { calculateTotal: false })).to.not.have.property('total');
            expect(await q.since(q1)).to.not.have.property('total');
        });

        scenario('EQRY-186', async () => {
            const ctx = await setup();
            const [a1raw, a2raw] = threadMessages('a186', 2);
            const [b1raw] = threadMessages('b186', 1);
            const [a1, b1] = await append(ctx, [
                { raw: a1raw, date: day(1) },
                { raw: b1raw, date: day(2) }
            ]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC, collapseThreads: true });
            const before = await q.query();
            expect(before.ids).to.deep.equal(ids([b1, a1]));
            const a2 = await deliverTo(ctx, a2raw);
            const c1 = await deliverTo(ctx, unique('Single 186'));

            const res = await q.since(before.queryState, { calculateTotal: true });
            expect(res.removed).to.include(a1.id);
            expect(res.added).to.deep.equal([
                { id: c1, index: 0 },
                { id: a2, index: 1 }
            ]);
            expect(res.total).to.equal(3);
            expect(applyChanges(before.ids, res)).to.deep.equal((await q.query()).ids);
        });

        scenario('EQRY-187', async () => {
            const ctx = await setup();
            const [a1raw, a2raw, a3raw] = threadMessages('a187', 3);
            const [b1raw] = threadMessages('b187', 1);
            const [a1, a2, b1, a3] = await append(ctx, [
                { raw: a1raw, date: day(1) },
                { raw: a2raw, date: day(2) },
                { raw: b1raw, date: day(3) },
                { raw: a3raw, date: day(4) }
            ]);
            const q = tracked(ctx, { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC, collapseThreads: true });
            const before = await q.query();
            expect(before.ids).to.deep.equal(ids([a3, b1]));
            await flag(ctx, a3.id, ['\\Deleted']);
            await expunge(ctx, a3.id);
            const first = await q.since(before.queryState, { calculateTotal: true });
            expect(first.removed).to.include(a3.id);
            expect(first.added).to.deep.include({ id: a2.id, index: 1 });
            expect(first.total).to.equal(2);

            await expunge(ctx, a1.id);
            const second = await q.since(first.newQueryState, { calculateTotal: true });
            expect(applyChanges(ids([b1, a2]), second)).to.deep.equal(ids([b1, a2]));
            expect(second.total).to.equal(2);
        });

        scenario('EQRY-192', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(1) }]);
            const before = await query(ctx, { filter: null, sort: null });
            const [junk] = await append(ctx, [{ box: '\\Junk', raw: unique('Junk 192') }]);
            const inbox = await deliverTo(ctx, unique('Inbox 192'));
            const fresh = await query(ctx, {});
            for (const args of [{ filter: null, sort: null }, {}]) {
                const res = await changes(ctx, Object.assign({ sinceQueryState: before.queryState }, args));
                expect(res.added.map(item => item.id)).to.have.members([junk.id, inbox]);
                for (const item of res.added) {
                    expect(fresh.ids.indexOf(item.id)).to.equal(item.index);
                }
                expect(applyChanges(before.ids, res)).to.deep.equal(fresh.ids);
            }
        });

        scenario('EQRY-194', async () => {
            const ctx = await setup();
            const [a1raw, a2raw] = threadMessages('a194', 2);
            const [b1raw] = threadMessages('b194', 1);
            const [gone] = await append(ctx, [{ date: day(1) }]);
            const [a1, a2, b1] = await append(ctx, [
                { raw: a1raw, date: day(2) },
                { raw: a2raw, date: day(3) },
                { raw: b1raw, date: day(4) }
            ]);
            await flag(ctx, gone.id, ['\\Deleted']);
            await expunge(ctx, gone.id);
            const sorted = tracked(ctx, {
                filter: { inMailbox: ctx.mailbox('INBOX') },
                sort: [{ property: 'someInThreadHaveKeyword', keyword: '$flagged', isAscending: false }, ...DESC]
            });
            const filtered = tracked(ctx, { filter: { someInThreadHaveKeyword: '$flagged' } });
            const sortedBefore = await sorted.query();
            expect(sortedBefore.ids).to.deep.equal(ids([b1, a2, a1]));
            const filteredBefore = await filtered.query();
            expect(filteredBefore.ids).to.deep.equal([]);

            await flag(ctx, a1.id, ['\\Flagged']);
            const bySort = await sorted.since(sortedBefore.queryState);
            const now = (await sorted.query()).ids;
            expect(now).to.deep.equal(ids([a2, a1, b1]));
            expect(applyChanges(sortedBefore.ids, bySort)).to.deep.equal(now);
            // the thread moved ahead of B1, or B1 moved behind it: either way the new order is reported
            const moved = new Set([...bySort.removed, ...bySort.added.map(item => item.id)]);
            expect(moved.has(b1.id) || (moved.has(a1.id) && moved.has(a2.id))).to.be.true;
            expect(bySort.removed).to.not.include(gone.id);

            const byFilter = await filtered.since(filteredBefore.queryState);
            expect(byFilter.added.map(item => item.id)).to.have.members(ids([a1, a2]));
            expect(byFilter.removed).to.not.include(gone.id);
        });

        scenario('EQRY-195', async () => {
            const ctx = await setup();
            await append(ctx, [
                { date: day(1), raw: rawMessage({ subject: 'b' }) },
                { date: day(2), raw: rawMessage({ subject: 'd' }) }
            ]);
            const up = tracked(ctx, { sort: [{ property: 'subject' }] });
            const down = tracked(ctx, { sort: [{ property: 'subject', isAscending: false }] });
            const q1 = (await up.query()).queryState;
            const q2 = (await down.query()).queryState;
            const [a, c, e] = await append(ctx, [
                { date: day(3), raw: rawMessage({ subject: 'a' }) },
                { date: day(4), raw: rawMessage({ subject: 'c' }) },
                { date: day(5), raw: rawMessage({ subject: 'e' }) }
            ]);
            const ascending = await up.since(q1);
            expect(ascending.removed).to.deep.equal([]);
            expect(ascending.added).to.deep.equal([
                { id: a.id, index: 0 },
                { id: c.id, index: 2 },
                { id: e.id, index: 4 }
            ]);
            const descending = await down.since(q2);
            expect(descending.removed).to.deep.equal([]);
            expect(descending.added).to.deep.equal([
                { id: e.id, index: 0 },
                { id: c.id, index: 2 },
                { id: a.id, index: 4 }
            ]);
        });

        scenario('EQRY-196', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(1) }]);
            const args = { filter: { inMailbox: ctx.mailbox('INBOX') }, sort: DESC };
            const q1 = (await query(ctx, args)).queryState;
            const added = await deliverTo(ctx, unique('New 196'));
            const accountId = ctx.client.accountId;
            const [[, changed], [, queried], [, got]] = await ctx.client.call([
                ['Email/queryChanges', Object.assign({ accountId, sinceQueryState: q1 }, args), 'c'],
                ['Email/query', Object.assign({ accountId }, args), 'q'],
                ['Email/get', { accountId, '#ids': { resultOf: 'c', name: 'Email/queryChanges', path: '/added/*/id' }, properties: ['id'] }, 'g']
            ]);
            expect(changed.newQueryState).to.equal(queried.queryState);
            for (const item of changed.added) {
                expect(queried.ids.indexOf(item.id)).to.equal(item.index);
            }
            expect(got.list.map(email => email.id)).to.deep.equal([added]);
        });
    });
});
