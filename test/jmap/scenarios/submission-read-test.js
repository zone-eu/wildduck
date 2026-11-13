/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Catalogue file submission.yaml: EmailSubmission/get, /changes, /query and /queryChanges (RFC 8621
// 7.1 to 7.4), record expiry, and the EmailSubmission state on the event stream.

const { expect } = require('chai');
const { scenario, seed, jmap, outbound } = require('../harness');
const sse = require('../harness/sse');
const h = require('./submission-helpers');

const held = (ctx, seconds) => ({ mailFrom: { email: ctx.user.address, parameters: { HOLDFOR: String(seconds) } }, rcptTo: [{ email: 'r@example.net' }] });

/** Submits a new draft (or the given Email); answers the submission id */
async function submission(ctx, options = {}) {
    const emailId = options.emailId || (await h.createDraft(ctx, options.draft)).id;
    const extra = Object.assign(
        {},
        options.identityId ? { identityId: options.identityId } : {},
        options.hold !== undefined ? { envelope: held(ctx, options.hold) } : {}
    );
    return h.expectCreated(await h.submitEmail(ctx, emailId, extra)).id;
}

/** Moves a submission to final: the MTA took the message */
async function finalize(ctx, id) {
    await outbound.remove(await h.queueIdOf(id));
    expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('final');
}

const query = (ctx, args = {}) => h.call(ctx, 'EmailSubmission/query', args);

async function queryError(ctx, args) {
    const error = await h.methodError(ctx, 'EmailSubmission/query', args);
    return error.type;
}

async function changesError(ctx, sinceState) {
    return (await h.methodError(ctx, 'EmailSubmission/changes', { sinceState })).type;
}

describe('EmailSubmission read side', function () {
    this.timeout(60000);

    after(() => sse.closeAll());

    describe('get', () => {
        scenario('SUB-118', async () => {
            const ctx = await h.sender();
            const other = await h.sender();
            const x1 = await submission(ctx);
            await submission(ctx);
            const y = await submission(other);
            const random = 'S0123456789abcdef01234567';
            const res = await h.call(ctx, 'EmailSubmission/get', { ids: [x1, random, y] });
            expect(res.list.map(entry => entry.id)).to.deep.equal([x1]);
            expect(res.notFound).to.deep.equal([random, y]);
            expect(res.state).to.be.a('string').and.not.empty;
            expect(res.accountId).to.equal(ctx.client.accountId);
        });

        scenario('SUB-119', async () => {
            const ctx = await h.sender();
            for (const ids of [null, []]) {
                expect(await h.call(ctx, 'EmailSubmission/get', { ids })).to.deep.include({ list: [], notFound: [] });
            }
            const ids = [await submission(ctx), await submission(ctx)];
            expect((await h.call(ctx, 'EmailSubmission/get', { ids: null })).list.map(entry => entry.id).sort()).to.deep.equal(ids.sort());
            expect(await h.call(ctx, 'EmailSubmission/get', { ids: [] })).to.deep.include({ list: [], notFound: [] });
        });

        scenario('SUB-120', async () => {
            const ctx = await h.sender();
            const x = await submission(ctx);
            const some = await h.call(ctx, 'EmailSubmission/get', { ids: [x], properties: ['undoStatus', 'sendAt'] });
            expect(Object.keys(some.list[0]).sort()).to.deep.equal(['id', 'sendAt', 'undoStatus']);
            const none = await h.call(ctx, 'EmailSubmission/get', { ids: [x], properties: [] });
            expect(Object.keys(none.list[0])).to.deep.equal(['id']);
            const error = await h.methodError(ctx, 'EmailSubmission/get', { ids: [x], properties: ['undoStatus', 'bogus'] });
            expect(error.type).to.equal('invalidArguments');
        });

        scenario('SUB-121', async () => {
            const ctx = await h.sender();
            const extra = await h.call(ctx, 'Identity/set', { create: { i: { email: ctx.user.address, name: 'Extra identity' } } });
            const identityId = extra.created.i.id;
            const draft = await h.createDraft(ctx, { subject: 'Alone in its thread' });
            const { threadId } = await h.emailOf(ctx, draft.id, ['threadId']);
            const x = await submission(ctx, { emailId: draft.id, identityId });
            await finalize(ctx, x);
            await ctx.client.method('Email/set', { destroy: [draft.id] });
            await h.call(ctx, 'Identity/set', { destroy: [identityId] });
            const object = await h.getSubmission(ctx, x);
            expect(object).to.include({ identityId, emailId: draft.id, threadId });
            expect((await ctx.client.method('Email/get', { ids: [draft.id] })).notFound).to.deep.equal([draft.id]);
            expect((await ctx.client.method('Thread/get', { ids: [threadId] })).notFound).to.deep.equal([threadId]);
            expect((await h.call(ctx, 'Identity/get', { ids: [identityId] })).notFound).to.deep.equal([identityId]);
        });
    });

    describe('changes', () => {
        scenario('SUB-122', async () => {
            const ctx = await h.sender();
            const x = await submission(ctx, { hold: 0 });
            await finalize(ctx, x);
            const p = await submission(ctx, { hold: 3600 });
            const s1 = await h.submissionState(ctx);
            // both were released longer ago than the retention (7 days in the test configuration)
            const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
            const db = await seed.db();
            await db.collection('jmap.submissions').updateMany({ _id: { $in: [x, p].map(id => new seed.ObjectId(id.slice(1))) } }, { $set: { sendAt: old } });
            expect((await h.call(ctx, 'EmailSubmission/get', { ids: [x, p] })).notFound).to.deep.equal([x]);
            const changes = await h.call(ctx, 'EmailSubmission/changes', { sinceState: s1 });
            expect(changes.destroyed).to.deep.equal([x]);
            expect((await h.getSubmission(ctx, p)).undoStatus).to.equal('pending');
        });

        scenario('SUB-123', async () => {
            const fresh = await h.sender();
            const busy = await h.sender();
            await submission(busy);
            for (const ctx of [fresh, busy]) {
                const state = await h.submissionState(ctx);
                const changes = await h.call(ctx, 'EmailSubmission/changes', { sinceState: state });
                expect(changes).to.deep.include({ oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [] });
            }
        });

        scenario('SUB-124', async () => {
            const ctx = await h.sender();
            const x0 = await submission(ctx);
            await finalize(ctx, x0);
            const s1 = await h.submissionState(ctx);
            const x1 = await submission(ctx, { hold: 3600 });
            const x2 = await submission(ctx, { hold: 3600 });
            const s2 = await h.submissionState(ctx);
            await h.submissionSet(ctx, { update: { [x2]: { undoStatus: 'canceled' } } });
            await h.submissionSet(ctx, { destroy: [x0] });
            const since1 = await h.call(ctx, 'EmailSubmission/changes', { sinceState: s1 });
            expect(since1.created.sort()).to.deep.equal([x1, x2].sort());
            expect(since1.updated).to.deep.equal([]);
            expect(since1.destroyed).to.deep.equal([x0]);
            const since2 = await h.call(ctx, 'EmailSubmission/changes', { sinceState: s2 });
            expect(since2.created).to.deep.equal([]);
            expect(since2.updated).to.deep.equal([x2]);
            expect(since2.destroyed).to.deep.equal([x0]);
            expect(since2.newState).to.equal(await h.submissionState(ctx));
        });

        scenario('SUB-125', async () => {
            const ctx = await h.sender();
            const x = await submission(ctx);
            const s1 = await h.submissionState(ctx);
            expect(Object.values((await h.getSubmission(ctx, x)).deliveryStatus)[0].delivered).to.equal('queued');
            const stream = await sse.open('/jmap/eventsource/?types=EmailSubmission&closeafter=no&ping=0', {
                authorization: jmap.basic(ctx.user.username, ctx.user.password)
            });
            await stream.until(() => stream.comments.length || stream.events.length, 5000, 'the stream did not start');
            await stream.settle(300);
            await outbound.lock(await h.queueIdOf(x));
            // nothing is read over JMAP until the event arrives: the server observes the queue by itself
            const event = await stream.next('state', 10000);
            expect(event.json.changed[ctx.client.accountId]).to.have.property('EmailSubmission');
            const changes = await h.call(ctx, 'EmailSubmission/changes', { sinceState: s1 });
            expect(changes.updated).to.deep.equal([x]);
            const object = await h.getSubmission(ctx, x);
            expect(object.undoStatus).to.equal('final');
            expect(Object.values(object.deliveryStatus)[0].delivered).to.equal('unknown');
            expect(event.json.changed[ctx.client.accountId].EmailSubmission).to.equal(await h.submissionState(ctx));
            stream.close();
        });

        scenario('SUB-126', async () => {
            const ctx = await h.sender();
            const emailState = (await ctx.client.method('Email/get', { ids: [] })).state;
            await submission(ctx);
            // a state whose last change is older than the change log retention (30 days)
            const db = await seed.db();
            await db
                .collection('jmap.state')
                .updateOne({ _id: new seed.ObjectId(ctx.user.id) }, { $set: { 'seqTime.EmailSubmission': new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
            const expired = await h.submissionState(ctx);
            await submission(ctx);
            const s1 = await h.submissionState(ctx);
            const ids = [];
            for (let i = 0; i < 5; i++) {
                ids.push(await submission(ctx));
            }
            expect(await changesError(ctx, 'o9z.0.deadbeef')).to.equal('cannotCalculateChanges');
            expect(await changesError(ctx, emailState)).to.equal('cannotCalculateChanges');
            expect(await changesError(ctx, expired)).to.equal('cannotCalculateChanges');
            let since = s1;
            const seen = [];
            for (let page = 0; page < 10; page++) {
                const changes = await h.call(ctx, 'EmailSubmission/changes', { sinceState: since, maxChanges: 2 });
                const pageIds = changes.created.concat(changes.updated, changes.destroyed);
                expect(pageIds.length).to.be.at.most(2);
                seen.push(...pageIds);
                since = changes.newState;
                if (!changes.hasMoreChanges) {
                    break;
                }
                expect(pageIds.length).to.equal(2);
            }
            expect(seen.sort()).to.deep.equal(ids.sort());
        });
    });

    describe('query', () => {
        scenario('SUB-127', async () => {
            const ctx = await h.sender();
            const empty = await query(ctx, { calculateTotal: true });
            expect(empty).to.deep.include({ ids: [], position: 0, total: 0, accountId: ctx.client.accountId });
            expect(empty.queryState).to.be.a('string');
            expect(empty.canCalculateChanges).to.be.a('boolean');
            const ids = [await submission(ctx), await submission(ctx), await submission(ctx)];
            const full = await query(ctx, { calculateTotal: true });
            expect(full.ids.sort()).to.deep.equal(ids.sort());
            expect(full).to.deep.include({ total: 3, position: 0 });
            expect(full.canCalculateChanges).to.be.a('boolean');
            expect(await query(ctx)).to.not.have.property('total');
        });

        scenario('SUB-128', async () => {
            const ctx = await h.sender();
            const ids = [await submission(ctx), await submission(ctx), await submission(ctx)];
            for (const filter of [null, {}]) {
                expect((await query(ctx, { filter })).ids.sort()).to.deep.equal([...ids].sort());
            }
            for (const filter of [1, { bogus: true }, { identityIds: ctx.identity.id }]) {
                expect(await queryError(ctx, { filter })).to.equal('invalidArguments');
            }
        });

        scenario('SUB-129', async () => {
            const ctx = await h.sender();
            const second = `${h.unique('i2')}@example.com`;
            await h.addAddress(ctx, second);
            const i2 = await h.identityOf(ctx, second);
            const x1 = await submission(ctx);
            const x2 = await submission(ctx);
            const x3 = await submission(ctx, { identityId: i2.id, draft: { from: second } });
            const run = async identityIds => (await query(ctx, { filter: { identityIds } })).ids.sort();
            expect(await run([ctx.identity.id])).to.deep.equal([x1, x2].sort());
            expect(await run([ctx.identity.id, i2.id])).to.deep.equal([x1, x2, x3].sort());
            expect(await run(['I0123456789abcdef01234567'])).to.deep.equal([]);
            expect(await run([])).to.deep.equal([]);
        });

        scenario('SUB-130', async () => {
            const ctx = await h.sender();
            const d1 = await h.createDraft(ctx);
            const d2 = await h.createDraft(ctx);
            const x1 = await submission(ctx, { emailId: d1.id });
            const x2 = await submission(ctx, { emailId: d1.id });
            const x3 = await submission(ctx, { emailId: d2.id });
            await ctx.client.method('Email/set', { destroy: [d2.id] });
            expect((await query(ctx, { filter: { emailIds: [d1.id] } })).ids.sort()).to.deep.equal([x1, x2].sort());
            expect((await query(ctx, { filter: { emailIds: [d2.id] } })).ids).to.deep.equal([x3]);
        });

        scenario('SUB-131', async () => {
            const ctx = await h.sender();
            const messageId = `${h.unique('t1')}@example.com`;
            const first = await h.createDraft(ctx, { subject: 'Thread one', extra: { messageId: [messageId] } });
            const reply = await h.createDraft(ctx, { subject: 'Re: Thread one', extra: { inReplyTo: [messageId], references: [messageId] } });
            const separate = await h.createDraft(ctx, { subject: 'Thread two' });
            const [t1, t1b, t2] = await Promise.all([first, reply, separate].map(async draft => (await h.emailOf(ctx, draft.id, ['threadId'])).threadId));
            expect(t1b).to.equal(t1);
            expect(t2).to.not.equal(t1);
            const x1 = await submission(ctx, { emailId: first.id });
            const x2 = await submission(ctx, { emailId: reply.id });
            const x3 = await submission(ctx, { emailId: separate.id });
            expect((await query(ctx, { filter: { threadIds: [t1] } })).ids.sort()).to.deep.equal([x1, x2].sort());
            expect((await query(ctx, { filter: { threadIds: [t2, t1] } })).ids.sort()).to.deep.equal([x1, x2, x3].sort());
        });

        scenario('SUB-132', async () => {
            const ctx = await h.sender();
            const pending = await submission(ctx, { hold: 3600 });
            const final = await submission(ctx);
            await finalize(ctx, final);
            const canceled = await submission(ctx, { hold: 3600 });
            await h.submissionSet(ctx, { update: { [canceled]: { undoStatus: 'canceled' } } });
            for (const [undoStatus, id] of [
                ['pending', pending],
                ['final', final],
                ['canceled', canceled]
            ]) {
                expect((await query(ctx, { filter: { undoStatus } })).ids).to.deep.equal([id]);
                expect((await h.getSubmission(ctx, id)).undoStatus).to.equal(undoStatus);
            }
            expect((await query(ctx, { filter: { undoStatus: 'sent' } })).ids).to.deep.equal([]);
        });

        scenario('SUB-133', async () => {
            const ctx = await h.sender();
            const x1 = await submission(ctx);
            const x2 = await submission(ctx, { hold: 3600 });
            const x3 = await submission(ctx, { hold: 86400 });
            const t2 = (await h.getSubmission(ctx, x2)).sendAt;
            const t3 = (await h.getSubmission(ctx, x3)).sendAt;
            expect((await query(ctx, { filter: { before: t2 } })).ids).to.deep.equal([x1]);
            expect((await query(ctx, { filter: { after: t2 } })).ids.sort()).to.deep.equal([x2, x3].sort());
            expect((await query(ctx, { filter: { after: t2, before: t3 } })).ids).to.deep.equal([x2]);
        });

        scenario('SUB-134', async () => {
            const ctx = await h.sender();
            const second = `${h.unique('i2')}@example.com`;
            await h.addAddress(ctx, second);
            const i2 = await h.identityOf(ctx, second);
            const ids = [];
            ids.push(await submission(ctx, { hold: 3600 }));
            ids.push(await submission(ctx));
            ids.push(await submission(ctx, { identityId: i2.id, draft: { from: second }, hold: 7200 }));
            ids.push(await submission(ctx, { identityId: i2.id, draft: { from: second } }));
            await finalize(ctx, ids[1]);
            await finalize(ctx, ids[3]);
            const { list } = await h.call(ctx, 'EmailSubmission/get', { ids });
            const matching = test =>
                list
                    .filter(test)
                    .map(entry => entry.id)
                    .sort();
            const run = async filter => (await query(ctx, { filter })).ids.sort();
            expect(await run({ identityIds: [i2.id], undoStatus: 'pending' })).to.deep.equal(
                matching(entry => entry.identityId === i2.id && entry.undoStatus === 'pending')
            );
            expect(await run({ operator: 'OR', conditions: [{ undoStatus: 'pending' }, { undoStatus: 'final' }] })).to.deep.equal(matching(() => true));
            expect(await run({ operator: 'NOT', conditions: [{ identityIds: [i2.id] }] })).to.deep.equal(matching(entry => entry.identityId !== i2.id));
            expect(await run({ identityIds: [i2.id], undoStatus: 'pending' })).to.have.length(1);
        });

        scenario('SUB-135', async () => {
            const ctx = await h.sender();
            const messageId = `${h.unique('t')}@example.com`;
            const e1 = await h.createDraft(ctx, { subject: 'Sort one', extra: { messageId: [messageId] } });
            const e2 = await h.createDraft(ctx, { subject: 'Re: Sort one', extra: { inReplyTo: [messageId], references: [messageId] } });
            const e3 = await h.createDraft(ctx, { subject: 'Sort two' });
            const plan = [
                [e1, 300],
                [e2, 100],
                [e3, 500],
                [e1, 200],
                [e3, 400]
            ];
            for (const [email, hold] of plan) {
                await submission(ctx, { emailId: email.id, hold });
            }
            const { list } = await h.call(ctx, 'EmailSubmission/get', {});
            expect(list).to.have.length(5);
            const keyOf = { emailId: entry => entry.emailId, threadId: entry => entry.threadId, sentAt: entry => entry.sendAt };
            const expected = (keys, ascending) =>
                [...list]
                    .sort((a, b) => {
                        for (const key of keys) {
                            const [x, y] = [keyOf[key](a), keyOf[key](b)];
                            if (x !== y) {
                                return (x < y ? -1 : 1) * (ascending ? 1 : -1);
                            }
                        }
                        return a.id < b.id ? -1 : 1;
                    })
                    .map(entry => entry.id);
            for (const property of ['emailId', 'threadId', 'sentAt']) {
                for (const isAscending of [true, false]) {
                    const sort = [{ property, isAscending }];
                    const first = (await query(ctx, { sort })).ids;
                    expect(first, `${property} ${isAscending}`).to.deep.equal(expected([property], isAscending));
                    expect((await query(ctx, { sort })).ids).to.deep.equal(first);
                }
            }
            const sentAtAsc = (await query(ctx, { sort: [{ property: 'sentAt' }] })).ids;
            const sentAtDesc = (await query(ctx, { sort: [{ property: 'sentAt', isAscending: false }] })).ids;
            expect(sentAtDesc).to.deep.equal([...sentAtAsc].reverse());
            const combined = (await query(ctx, { sort: [{ property: 'threadId' }, { property: 'sentAt' }] })).ids;
            expect(combined).to.deep.equal(expected(['threadId', 'sentAt'], true));
        });

        scenario('SUB-136', async () => {
            const ctx = await h.sender();
            await submission(ctx);
            expect(await queryError(ctx, { sort: [{ property: 'undoStatus' }] })).to.equal('unsupportedSort');
            expect(await queryError(ctx, { sort: [{ property: 'bogus' }] })).to.equal('unsupportedSort');
            expect(await queryError(ctx, { sort: [{ isAscending: true }] })).to.equal('invalidArguments');
        });

        describe('ten submissions', () => {
            let ctx;
            let ordered;
            before(async () => {
                ctx = await h.sender();
                ordered = [];
                for (let i = 0; i < 10; i++) {
                    ordered.push(await submission(ctx, { hold: 60 * (i + 1) }));
                }
            });

            scenario('SUB-137', async () => {
                const first = (await query(ctx)).ids;
                expect((await query(ctx)).ids).to.deep.equal(first);
                const paged = [];
                for (let position = 0; position < 10; position += 3) {
                    paged.push(...(await query(ctx, { position, limit: 3 })).ids);
                }
                expect(paged).to.deep.equal(first);
                expect(new Set(paged).size).to.equal(10);
            });

            scenario('SUB-138', async () => {
                const sort = [{ property: 'sentAt', isAscending: true }];
                expect((await query(ctx, { sort })).ids).to.deep.equal(ordered);
                expect(await query(ctx, { sort, position: 3, limit: 4 })).to.deep.include({ ids: ordered.slice(3, 7), position: 3 });
                expect(await query(ctx, { sort, position: -2 })).to.deep.include({ ids: ordered.slice(8), position: 8 });
                expect((await query(ctx, { sort, position: 50 })).ids).to.deep.equal([]);
                expect(await query(ctx, { sort, limit: 0, calculateTotal: true })).to.deep.include({ ids: [], total: 10 });
                expect(await query(ctx, { sort, anchor: ordered[5], anchorOffset: -2, limit: 3 })).to.deep.include({ ids: ordered.slice(3, 6), position: 3 });
                expect(await queryError(ctx, { sort, anchor: 'S0123456789abcdef01234567' })).to.equal('anchorNotFound');
                expect(await queryError(ctx, { sort, limit: -1 })).to.equal('invalidArguments');
            });
        });

        scenario('SUB-139', async () => {
            const ctx = await h.sender();
            await submission(ctx);
            const q1 = (await query(ctx)).queryState;
            expect((await query(ctx)).queryState).to.equal(q1);
            const id = await submission(ctx);
            const after = await query(ctx);
            expect(after.queryState).to.not.equal(q1);
            expect(after.ids).to.include(id);
        });

        scenario('SUB-140', async () => {
            const ctx = await h.sender();
            await submission(ctx);
            const sort = [{ property: 'sentAt' }];
            const first = await query(ctx, { sort });
            expect(first.canCalculateChanges).to.equal(false);
            const run = args => h.methodError(ctx, 'EmailSubmission/queryChanges', Object.assign({ sort }, args));
            expect((await run({ sinceQueryState: first.queryState })).type).to.equal('cannotCalculateChanges');
            await submission(ctx);
            expect((await run({ sinceQueryState: first.queryState })).type).to.equal('cannotCalculateChanges');
            expect((await run({})).type).to.equal('invalidArguments');
        });
    });

    scenario('SUB-141', async () => {
        const ctx = await h.sender();
        const draft = await h.createDraft(ctx);
        const initial = {
            EmailSubmission: await h.submissionState(ctx),
            Email: (await ctx.client.method('Email/get', { ids: [] })).state
        };
        const stream = await sse.open('/jmap/eventsource/?types=*&closeafter=no&ping=0', { authorization: jmap.basic(ctx.user.username, ctx.user.password) });
        await stream.until(() => stream.comments.length || stream.events.length, 5000, 'the stream did not start');
        await stream.settle(300);
        const deliveryBefore = stream.states().length ? stream.states().pop().json.changed[ctx.client.accountId].EmailDelivery : undefined;
        const toSent = { [`mailboxIds/${ctx.mb.Drafts}`]: null, [`mailboxIds/${ctx.mb.Sent}`]: true, 'keywords/$draft': null };
        const responses = await h.calls(ctx, [
            [
                'EmailSubmission/set',
                { create: { s1: { identityId: ctx.identity.id, emailId: draft.id, envelope: held(ctx, 3600) } }, onSuccessUpdateEmail: { '#s1': toSent } },
                'c1'
            ]
        ]);
        const id = h.expectCreated(responses[0][1]).id;
        const changed = {};
        while (!(changed.EmailSubmission && changed.Email && changed.Mailbox)) {
            const event = await stream.next('state', 8000);
            Object.assign(changed, event.json.changed[ctx.client.accountId]);
        }
        expect(changed.EmailSubmission).to.not.equal(initial.EmailSubmission);
        expect(changed.Email).to.not.equal(initial.Email);
        expect(changed).to.not.have.property('EmailDelivery');
        await stream.settle(300);
        await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'canceled' } } });
        const canceled = await stream.next('state', 8000);
        expect(canceled.json.changed[ctx.client.accountId]).to.have.property('EmailSubmission');
        expect(canceled.json.changed[ctx.client.accountId].EmailSubmission).to.equal(await h.submissionState(ctx));
        expect(deliveryBefore).to.equal(undefined);
        stream.close();
    });
});
