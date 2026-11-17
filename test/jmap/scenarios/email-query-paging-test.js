/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-query.yaml: paging, anchors, totals, collapseThreads and queryState of
// Email/query, and results across the other protocols.

const { expect } = require('chai');
const { scenario, api, seed, clock } = require('../harness');
const { setup, rawMessage, sizedMessage, append, imapIn, query, idsOf, errorOf, emails, ids, day } = require('./email-query-helpers');

const ASC = [{ property: 'receivedAt', isAscending: true }];
const DESC = [{ property: 'receivedAt', isAscending: false }];

/** Messages of one thread: the first starts it, the others reply to it */
function thread(name, count, options = {}) {
    const root = `<${name}.${Date.now()}@thread.example>`;
    return Array.from({ length: count }, (item, i) =>
        rawMessage(
            Object.assign(
                {
                    subject: i ? `Re: Thread ${name}` : `Thread ${name}`,
                    messageId: i ? `<${name}.${i}.${Date.now()}@thread.example>` : root,
                    headers: i ? [`In-Reply-To: ${root}`, `References: ${root}`] : []
                },
                options
            )
        )
    );
}

/** A user with `count` Inbox messages one day apart (E1 oldest); the given indexes (1 based) are flagged */
async function series(count, flagged = []) {
    const ctx = await setup();
    const entries = await append(
        ctx,
        Array.from({ length: count }, (item, i) => ({ date: day(i + 1), flags: flagged.includes(i + 1) ? ['\\Flagged'] : [] }))
    );
    return { ctx, e: [null, ...entries] };
}

const range = (e, from, to) => e.slice(from, to + 1).map(entry => entry.id);

describe('Email/query paging and threads (email-query.yaml)', () => {
    describe('position and limit', () => {
        let ctx, e;
        before(async () => {
            ({ ctx, e } = await series(10, [2, 4, 6, 8]));
        });
        const page = (args = {}) => query(ctx, Object.assign({ sort: ASC }, args));

        scenario('EQRY-116', async () => {
            for (const args of [{ position: 0 }, {}]) {
                const res = await page(args);
                expect(res.ids).to.deep.equal(range(e, 1, 10));
                expect(res.position).to.equal(0);
            }
        });

        scenario('EQRY-117', async () => {
            const third = await page({ position: 3 });
            expect(third.ids).to.deep.equal(range(e, 4, 10));
            expect(third.position).to.equal(3);
            const last = await page({ position: 9 });
            expect(last.ids).to.deep.equal([e[10].id]);
            expect(last.position).to.equal(9);
        });

        scenario('EQRY-118', async () => {
            for (const [limit, expected] of [
                [3, range(e, 1, 3)],
                [10, range(e, 1, 10)],
                [50, range(e, 1, 10)]
            ]) {
                const res = await page({ limit });
                expect(res.ids).to.deep.equal(expected);
                expect(res).to.not.have.property('limit');
            }
        });

        scenario('EQRY-119', async () => {
            const pages = [await page({ position: 0, limit: 4 }), await page({ position: 4, limit: 4 }), await page({ position: 8, limit: 4 })];
            expect(pages.map(res => res.ids)).to.deep.equal([range(e, 1, 4), range(e, 5, 8), range(e, 9, 10)]);
            expect(pages.map(res => res.position)).to.deep.equal([0, 4, 8]);
            expect(new Set(pages.map(res => res.queryState)).size).to.equal(1);
        });

        scenario('EQRY-120', async () => {
            expect((await page({ position: 10 })).ids).to.deep.equal([]);
            expect((await page({ position: 11, limit: 5 })).ids).to.deep.equal([]);
            const far = await page({ position: 1000000, calculateTotal: true });
            expect(far.ids).to.deep.equal([]);
            expect(far.total).to.equal(10);
            expect(Number.isInteger(far.position)).to.be.true;
            expect(far.position).to.be.at.least(far.total);
        });

        scenario('EQRY-123', async () => {
            const own = await setup();
            await append(own, [{}, {}, {}, {}, {}]);
            const unlimited = await query(own);
            const res = await query(own, { limit: 0, calculateTotal: true });
            expect(res.ids).to.deep.equal([]);
            expect(res.position).to.equal(0);
            expect(res.total).to.equal(5);
            expect(res.queryState).to.equal(unlimited.queryState);
            expect(res).to.not.have.property('limit');
        });

        scenario('EQRY-124', async () => {
            for (const limit of [-1, 'ten', 2.5]) {
                expect(await errorOf(ctx, { limit }), String(limit)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-127', async () => {
            const cases = [{ position: 'first' }, { position: 1.5 }, { anchor: e[3].id, anchorOffset: 'x' }, { calculateTotal: 'yes' }, { collapseThreads: 1 }];
            for (const args of cases) {
                expect(await errorOf(ctx, args), JSON.stringify(args)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-128', async () => {
            expect(await errorOf(ctx, { bogusArgument: true })).to.equal('invalidArguments');
            expect(await errorOf(ctx, { disableGuidSearch: true })).to.equal('invalidArguments');
        });

        scenario('EQRY-140', async () => {
            const own = await setup();
            await append(own, [{}, {}, {}, {}, {}]);
            expect(await query(own)).to.not.have.property('total');
            expect(await query(own, { calculateTotal: false })).to.not.have.property('total');
            expect((await query(own, { calculateTotal: true })).total).to.equal(5);
        });

        scenario('EQRY-141', async () => {
            const cases = [
                [{ limit: 2 }, 10],
                [{ position: 8 }, 10],
                [{ filter: { hasKeyword: '$flagged' }, limit: 1 }, 4],
                [{ anchor: e[3].id, limit: 1 }, 10]
            ];
            for (const [args, total] of cases) {
                expect((await page(Object.assign({ calculateTotal: true }, args))).total, JSON.stringify(args)).to.equal(total);
            }
        });
    });

    describe('negative position', () => {
        let ctx, e;
        before(async () => {
            ({ ctx, e } = await series(9, [3, 5]));
        });
        const page = (args = {}) => query(ctx, Object.assign({ sort: ASC }, args));

        scenario('EQRY-121', async () => {
            const cases = [
                [{ position: -3, limit: 2 }, range(e, 7, 8), 6],
                [{ position: -1 }, [e[9].id], 8],
                [{ position: -9 }, range(e, 1, 9), 0]
            ];
            for (const [args, expected, position] of cases) {
                const res = await page(args);
                expect(res.ids).to.deep.equal(expected);
                expect(res.position).to.equal(position);
            }
        });

        scenario('EQRY-122', async () => {
            const all = await page({ position: -20, limit: 3 });
            expect(all.ids).to.deep.equal(range(e, 1, 3));
            expect(all.position).to.equal(0);
            const filtered = await page({ position: -5, filter: { hasKeyword: '$flagged' } });
            expect(filtered.ids).to.deep.equal([e[3].id, e[5].id]);
            expect(filtered.position).to.equal(0);
        });
    });

    describe('anchors', () => {
        let ctx, e;
        before(async () => {
            ({ ctx, e } = await series(10));
        });
        const page = (args = {}) => query(ctx, Object.assign({ sort: ASC }, args));
        const expectPage = async (args, expected, position) => {
            const res = await page(args);
            expect(res.ids, JSON.stringify(args)).to.deep.equal(expected);
            expect(res.position, JSON.stringify(args)).to.equal(position);
        };

        scenario('EQRY-129', async () => {
            await expectPage({ anchor: e[4].id }, range(e, 4, 10), 3);
            await expectPage({ anchor: e[4].id, anchorOffset: 0, limit: 2 }, range(e, 4, 5), 3);
        });

        scenario('EQRY-130', async () => {
            await expectPage({ anchor: e[2].id, anchorOffset: 1 }, range(e, 3, 10), 2);
            await expectPage({ anchor: e[1].id, anchorOffset: 1, limit: 2 }, range(e, 2, 3), 1);
        });

        scenario('EQRY-131', async () => {
            const res = await page({ anchor: e[5].id, anchorOffset: -2, limit: 5 });
            expect(res.ids).to.deep.equal(range(e, 3, 7));
            expect(res.position).to.equal(2);
            expect(res.ids.indexOf(e[5].id)).to.equal(2);
        });

        scenario('EQRY-132', async () => {
            await expectPage({ anchor: e[2].id, anchorOffset: -5, limit: 3 }, range(e, 1, 3), 0);
        });

        scenario('EQRY-133', async () => {
            const { ctx: own, e: three } = await series(3);
            const res = await query(own, { sort: ASC, anchor: three[2].id, anchorOffset: 10, limit: 5, calculateTotal: true });
            expect(res.ids).to.deep.equal([]);
            expect(res.total).to.equal(3);
            expect(res.position).to.equal(3);
        });

        scenario('EQRY-134', async () => {
            await expectPage({ anchor: e[6].id, position: 2, limit: 2 }, range(e, 6, 7), 5);
            await expectPage({ anchor: e[6].id, position: -1 }, range(e, 6, 10), 5);
        });

        scenario('EQRY-135', async () => {
            await expectPage({ anchorOffset: 4 }, range(e, 1, 10), 0);
            await expectPage({ anchor: null, anchorOffset: 4, position: 1 }, range(e, 2, 10), 1);
        });

        scenario('EQRY-136', async () => {
            const own = await setup(['Work']);
            const [e1, e2, e3] = await append(own, [{}, { box: 'Work' }, {}]);
            await imapIn(own, 'INBOX', client => client.messageFlagsAdd(String(e3.uid), ['\\Deleted'], { uid: true }));
            const cases = [
                { anchor: `M${new seed.ObjectId().toString()}` },
                { filter: { inMailbox: own.mailbox('INBOX') }, anchor: e2.id },
                { filter: { hasKeyword: '$flagged' }, anchor: e1.id },
                { anchor: e3.id },
                { anchor: 'not-an-id' }
            ];
            for (const args of cases) {
                expect(await errorOf(own, args), JSON.stringify(args)).to.equal('anchorNotFound');
            }
        });

        scenario('EQRY-138', async () => {
            const own = await setup();
            // sizes do not follow the dates
            const sizes = [1700, 900, 2300, 1100, 2900, 1300, 600, 2500, 1900, 800];
            const entries = await append(
                own,
                sizes.map((size, i) => ({ date: day(i + 1), flags: i % 2 === 0 ? ['\\Flagged'] : [], raw: sizedMessage(size) }))
            );
            const x = [null, ...entries];

            const first = await query(own, { filter: { hasKeyword: '$flagged' }, sort: DESC, anchor: x[5].id, anchorOffset: -1, limit: 3 });
            expect(first.ids).to.deep.equal([x[7].id, x[5].id, x[3].id]);
            expect(first.position).to.equal(1);

            for (const [sort, anchor] of [
                [[{ property: 'size' }], x[5]],
                [[{ property: 'hasKeyword', keyword: '$flagged' }, { property: 'receivedAt' }], x[2]]
            ]) {
                const full = (await query(own, { sort })).ids;
                const res = await query(own, Object.assign({ sort, anchor: anchor.id }, sort.length === 1 ? { limit: 1 } : {}));
                expect(res.ids[0]).to.equal(anchor.id);
                expect(res.position).to.equal(full.indexOf(anchor.id));
            }
        });

        scenario('EQRY-139', async () => {
            const own = await setup();
            const date = day(7);
            await append(
                own,
                Array.from({ length: 12 }, (item, i) => ({ date, raw: sizedMessage(1000, { subject: `Twin ${String(i).padStart(2, '0')}` }) }))
            );
            const sort = [{ property: 'receivedAt' }];
            const list = (await query(own, { sort })).ids;
            expect(list).to.have.lengthOf(12);
            for (const [index, id] of list.entries()) {
                const res = await query(own, { sort, anchor: id, limit: 1 });
                expect(res.position).to.equal(index);
                expect(res.ids).to.deep.equal([id]);
            }
        });
    });

    describe('collapseThreads', () => {
        scenario('EQRY-137', async () => {
            const ctx = await setup();
            const [a1raw, a2raw] = thread('a137', 2);
            const [a1, b1, a2] = await append(ctx, [
                { date: day(1), raw: a1raw },
                { date: day(2), raw: rawMessage({ subject: 'Single 137' }) },
                { date: day(3), raw: a2raw }
            ]);
            expect(await idsOf(ctx, null, { sort: DESC, collapseThreads: true })).to.deep.equal([a2.id, b1.id]);
            expect(await errorOf(ctx, { sort: DESC, collapseThreads: true, anchor: a1.id })).to.equal('anchorNotFound');
            const res = await query(ctx, { sort: DESC, collapseThreads: true, anchor: b1.id, anchorOffset: -1 });
            expect(res.ids).to.deep.equal([a2.id, b1.id]);
            expect(res.position).to.equal(0);
        });

        scenario('EQRY-142', async () => {
            const ctx = await setup();
            const items = [...thread('t1', 3), ...thread('t2', 2), ...thread('t3', 1), ...thread('t4', 1)].map((raw, i) => ({ raw, date: day(i + 1) }));
            const entries = await append(ctx, items);
            await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(entries[1].uid), ['\\Deleted'], { uid: true }));

            const accountId = ctx.client.accountId;
            const inbox = ctx.boxes.INBOX.id;
            const filter = { inMailbox: `F${inbox}` };
            const [[, mailboxes], [, plain], [, collapsed]] = await ctx.client.call([
                ['Mailbox/get', { accountId, ids: [`F${inbox}`], properties: ['totalEmails', 'totalThreads'] }, 'm'],
                ['Email/query', { accountId, filter, calculateTotal: true }, 'q'],
                ['Email/query', { accountId, filter, calculateTotal: true, collapseThreads: true }, 'c']
            ]);
            expect(plain.total).to.equal(6);
            expect(collapsed.total).to.equal(4);
            expect(plain.total).to.equal(mailboxes.list[0].totalEmails);
            expect(collapsed.total).to.equal(mailboxes.list[0].totalThreads);
        });

        scenario('EQRY-143', async () => {
            const ctx = await setup();
            const entries = await append(
                ctx,
                [...thread('a143', 3), ...thread('b143', 2), rawMessage({ subject: 'Single 143' })].map(raw => ({ raw }))
            );
            const collapsed = await idsOf(ctx, null, { collapseThreads: true });
            expect(collapsed).to.have.lengthOf(3);
            const got = await emails(ctx, collapsed, ['threadId']);
            expect(new Set(collapsed.map(id => got[id].threadId)).size).to.equal(3);
            expect(await idsOf(ctx, null, { collapseThreads: false })).to.have.members(ids(entries));
            expect(await idsOf(ctx, null)).to.have.members(ids(entries));
        });

        scenario('EQRY-144', async () => {
            const ctx = await setup();
            const [a1raw, a2raw] = thread('a144', 2);
            const [b1raw, b2raw] = thread('b144', 2);
            const resize = (raw, size) => {
                const text = raw.toString();
                return Buffer.from(text.replace(/\r\n\r\nHello\r\n$/, '\r\n\r\n' + 'z'.repeat(size - raw.length + 5) + '\r\n'));
            };
            const [a1, b1, b2, a2] = await append(ctx, [
                { date: day(1), raw: resize(a1raw, 4000) },
                { date: day(2), raw: resize(b1raw, 3000) },
                { date: day(3), raw: resize(b2raw, 1000) },
                { date: day(4), raw: resize(a2raw, 2000) }
            ]);
            expect(await idsOf(ctx, null, { collapseThreads: true, sort: DESC })).to.deep.equal([a2.id, b2.id]);
            expect(await idsOf(ctx, null, { collapseThreads: true, sort: ASC })).to.deep.equal([a1.id, b1.id]);
            expect(await idsOf(ctx, null, { collapseThreads: true, sort: [{ property: 'size', isAscending: false }] })).to.deep.equal([a1.id, b1.id]);
        });

        scenario('EQRY-145', async () => {
            const ctx = await setup();
            const [a1raw, a2raw] = thread('a145', 2);
            const [a1, b1, a2] = await append(ctx, [
                { date: day(1), flags: ['\\Flagged'], raw: Buffer.from(a1raw.toString().replace(/Hello\r\n$/, 'loganberry only here\r\n')) },
                { date: day(2), raw: rawMessage({ subject: 'Single 145' }) },
                { date: day(3), raw: a2raw }
            ]);
            const collapsed = filter => idsOf(ctx, filter, { collapseThreads: true, sort: DESC });
            expect(await collapsed({ hasKeyword: '$flagged' })).to.deep.equal([a1.id]);
            expect(await collapsed({ after: '2024-01-02T10:00:00Z' })).to.deep.equal([a2.id, b1.id]);
            expect(await collapsed({ text: 'loganberry' })).to.deep.equal([a1.id]);
        });

        scenario('EQRY-146', async () => {
            const ctx = await setup();
            const [a1raw, a2raw, a3raw] = thread('a146', 3);
            const [, a2, a3, b1] = await append(ctx, [
                { date: day(1), raw: a1raw },
                { date: day(2), raw: a2raw, box: '\\Sent' },
                { date: day(3), raw: a3raw },
                { date: day(4), raw: rawMessage({ subject: 'Single 146' }), box: '\\Sent' }
            ]);
            const collapsed = filter => idsOf(ctx, filter, { collapseThreads: true, sort: DESC });
            expect(await collapsed(null)).to.deep.equal([b1.id, a3.id]);
            expect(await collapsed({ inMailbox: ctx.mailbox('INBOX') })).to.deep.equal([a3.id]);
            expect(await collapsed({ inMailbox: ctx.mailbox('\\Sent') })).to.deep.equal([b1.id, a2.id]);
            expect(await collapsed({ inMailboxOtherThan: [ctx.mailbox('INBOX')] })).to.deep.equal([b1.id, a2.id]);
        });

        scenario('EQRY-147', async () => {
            const ctx = await setup();
            const raws = [...thread('a147', 3), ...thread('b147', 2), rawMessage({ subject: 'Single 147' })];
            await append(
                ctx,
                raws.map((raw, i) => ({ raw, flags: i < 2 ? ['\\Flagged'] : [] }))
            );
            const total = async args => (await query(ctx, Object.assign({ calculateTotal: true, collapseThreads: true }, args))).total;
            expect(await total({})).to.equal(3);
            expect(await total({ limit: 1 })).to.equal(3);
            expect(await total({ filter: { hasKeyword: '$flagged' } })).to.equal(1);
            expect(await total({ collapseThreads: false })).to.equal(6);
        });

        scenario('EQRY-148', async () => {
            const ctx = await setup();
            const items = [];
            for (let t = 0; t < 8; t++) {
                thread(`t148x${t}`, 3).forEach((raw, i) => items.push({ raw, date: day(1 + t, i * 3) }));
            }
            await append(ctx, items);
            const collapsedPage = args => query(ctx, Object.assign({ collapseThreads: true, sort: DESC }, args));
            const c = (await collapsedPage({})).ids;
            expect(c).to.have.lengthOf(8);
            const cases = [
                [{ position: 2, limit: 3 }, c.slice(2, 5), 2],
                [{ position: -2 }, c.slice(6, 8), 6],
                [{ anchor: c[5], anchorOffset: -1, limit: 2 }, c.slice(4, 6), 4]
            ];
            for (const [args, expected, position] of cases) {
                const res = await collapsedPage(args);
                expect(res.ids, JSON.stringify(args)).to.deep.equal(expected);
                expect(res.position, JSON.stringify(args)).to.equal(position);
            }
            expect((await collapsedPage({ position: 8 })).ids).to.deep.equal([]);
        });

        scenario('EQRY-149', async () => {
            const ctx = await setup();
            const [a1raw, a2raw] = thread('a149', 2);
            const [a1, a2] = await append(ctx, [
                { date: day(1), raw: a1raw },
                { date: day(2), raw: a2raw }
            ]);
            await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(a2.uid), ['\\Deleted'], { uid: true }));
            const res = await query(ctx, { collapseThreads: true, sort: DESC, calculateTotal: true });
            expect(res.ids).to.deep.equal([a1.id]);
            expect(res.total).to.equal(1);
        });

        scenario('EQRY-150', async () => {
            const ctx = await setup();
            const [a1raw, a2raw] = thread('a150', 2);
            const collapsed = () => query(ctx, { collapseThreads: true, sort: DESC, calculateTotal: true });
            await seed.deliver(ctx.user.address, a1raw);
            const first = await clock.waitFor(async () => {
                const res = await collapsed();
                return res.ids.length === 1 && res;
            });
            await seed.deliver(ctx.user.address, a2raw);
            const db = await seed.db();
            const reply = await clock.waitFor(() =>
                db.collection('messages').findOne({ user: new seed.ObjectId(ctx.user.id), subject: /^re:/i }, { projection: { root: true } })
            );
            const res = await collapsed();
            expect(res.ids).to.deep.equal([`M${reply.root}`]);
            expect(res.total).to.equal(1);
            expect(res.queryState).to.not.equal(first.queryState);
        });
    });

    describe('queryState', () => {
        scenario('EQRY-151', async () => {
            const ctx = await setup();
            await append(ctx, [{}, {}, {}]);
            const filter = { hasKeyword: '$seen' };
            const states = [];
            for (let i = 0; i < 3; i++) {
                states.push((await query(ctx, { filter })).queryState);
            }
            states.push((await query(ctx, { filter, position: 1, limit: 1 })).queryState);
            states.push((await query(ctx, { filter, limit: 0 })).queryState);
            expect(new Set(states).size).to.equal(1);
        });

        scenario('EQRY-152', async () => {
            const ctx = await setup();
            await append(ctx, [{}, {}]);
            const before = await query(ctx, { sort: DESC });
            // what the TTL index does once the retention passes: every journal entry of the account is gone
            const db = await seed.db();
            await db.collection('journal').deleteMany({ user: new seed.ObjectId(ctx.user.id) });
            const after = await query(ctx, { sort: DESC });
            expect(after.queryState).to.equal(before.queryState);
            expect(after.ids).to.deep.equal(before.ids);
        });

        scenario('EQRY-153', async () => {
            const ctx = await setup();
            await append(ctx, [{}]);
            const inbox = { filter: { inMailbox: ctx.mailbox('INBOX') } };
            const before = await query(ctx, inbox);
            await seed.deliver(ctx.user.address, rawMessage({ subject: 'Delivered 153' }));
            const after = await query(ctx, inbox);
            expect(after.ids).to.have.lengthOf(2);
            expect(after.ids).to.include.members(before.ids);
            expect(after.queryState).to.not.equal(before.queryState);
        });

        scenario('EQRY-154', async () => {
            const ctx = await setup();
            const [e1, e2, e3, e4] = await append(ctx, [{}, {}, {}, {}]);
            const inbox = { filter: { inMailbox: ctx.mailbox('INBOX') } };
            let previous = await query(ctx, inbox);
            const step = async (expected, stateChanges) => {
                const res = await query(ctx, inbox);
                expect(res.ids).to.have.members(expected);
                if (stateChanges) {
                    expect(res.queryState).to.not.equal(previous.queryState);
                }
                previous = res;
            };

            await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(e1.uid), ['\\Deleted'], { uid: true }));
            await step([e2.id, e3.id, e4.id], true);
            await imapIn(ctx, 'INBOX', client => client.messageDelete(String(e1.uid), { uid: true }));
            await step([e2.id, e3.id, e4.id], false);
            await api('DELETE', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${e2.uid}`);
            await step([e3.id, e4.id], true);
            await imapIn(ctx, 'INBOX', client => client.messageMove(String(e3.uid), ctx.boxes['\\Trash'].path, { uid: true }));
            await step([e4.id], true);
        });

        scenario('EQRY-155', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [{ date: day(1) }, { date: day(2) }]);
            const queryA = { filter: { notKeyword: '$seen' } };
            const queryB = { sort: [{ property: 'hasKeyword', keyword: '$flagged', isAscending: false }, { property: 'receivedAt' }] };
            const [a0, b0] = [await query(ctx, queryA), await query(ctx, queryB)];
            expect(b0.ids).to.deep.equal([e1.id, e2.id]);

            await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(e1.uid), ['\\Seen'], { uid: true }));
            const a1 = await query(ctx, queryA);
            expect(a1.ids).to.not.include(e1.id);
            expect(a1.queryState).to.not.equal(a0.queryState);

            await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(e2.uid), ['\\Flagged'], { uid: true }));
            const b1 = await query(ctx, queryB);
            expect(b1.ids[0]).to.equal(e2.id);
            expect(b1.queryState).to.not.equal(b0.queryState);
        });

        scenario('EQRY-156', async () => {
            const ctx = await setup(['Work']);
            const [w1] = await append(ctx, [
                { box: 'Work', date: day(1) },
                { box: 'Work', date: day(2) }
            ]);
            const work = { filter: { inMailbox: ctx.mailbox('Work') }, sort: [{ property: 'receivedAt' }] };
            const before = await query(ctx, work);
            await seed.deliver(ctx.user.address, rawMessage({ subject: 'Unrelated 156' }));
            await imapIn(ctx, 'Work', client => client.messageFlagsAdd(String(w1.uid), ['\\Flagged'], { uid: true }));
            const after = await query(ctx, work);
            // the state may change (it follows the account journal), the ids may not
            expect(after.ids).to.deep.equal(before.ids);
        });

        scenario('EQRY-157', () => {});
        scenario('EQRY-165', () => {});
    });

    describe('across protocols', () => {
        scenario('EQRY-159', async () => {
            const ctx = await setup();
            const appendDate = new Date('2020-05-04T03:02:01Z');
            const [e1] = await append(ctx, [{ flags: ['\\Flagged'], date: appendDate, raw: rawMessage({ subject: 'Appended 159' }) }]);
            await api('POST', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages`, {
                // the JSON raw property is the message source itself
                raw: rawMessage({ subject: 'Uploaded 159' }).toString()
            });
            await seed.deliver(ctx.user.address, rawMessage({ subject: 'Delivered 159' }));

            const db = await seed.db();
            const docs = await clock.waitFor(async () => {
                const list = await db
                    .collection('messages')
                    .find({ user: new seed.ObjectId(ctx.user.id) }, { projection: { root: true, subject: true, idate: true } })
                    .sort({ idate: 1, _id: 1 })
                    .toArray();
                return list.length === 3 && list;
            });
            expect(docs.map(doc => doc.subject)).to.deep.equal(['Appended 159', 'Uploaded 159', 'Delivered 159']);

            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('INBOX') }, { sort: ASC })).to.deep.equal(docs.map(doc => `M${doc.root}`));
            expect(await idsOf(ctx, { hasKeyword: '$flagged' })).to.deep.equal([e1.id]);
            const got = await emails(ctx, [e1.id], ['receivedAt']);
            expect(got[e1.id].receivedAt).to.equal('2020-05-04T03:02:01Z');
        });

        scenario('EQRY-160', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [{}]);
            const inbox = { filter: { inMailbox: ctx.mailbox('INBOX') } };
            await api('DELETE', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${e1.uid}`);
            const before = await query(ctx, inbox);
            expect(before.ids).to.deep.equal([]);

            const archived = await clock.waitFor(async () => {
                const res = await api('GET', `/users/${ctx.user.id}/archived/messages`);
                return res.results.length && res.results;
            });
            await api('POST', `/users/${ctx.user.id}/archived/messages/${archived[0].id}/restore`, {});
            const after = await clock.waitFor(async () => {
                const res = await query(ctx, inbox);
                return res.ids.length && res;
            });
            expect(after.ids).to.have.lengthOf(1);
            expect(after.queryState).to.not.equal(before.queryState);
        });

        scenario('EQRY-161', async () => {
            const ctx = await setup(['Projects']);
            const entries = await append(ctx, [{ box: 'Projects' }, { box: 'Projects' }]);
            const pid = ctx.mailbox('Projects');

            await seed.withImap(ctx.user, client => client.mailboxRename('Projects', 'Archive/Projects'));
            expect(await idsOf(ctx, { inMailbox: pid })).to.have.members(ids(entries));

            await seed.withImap(ctx.user, client => client.mailboxDelete('Archive/Projects'));
            expect(await errorOf(ctx, { filter: { inMailbox: pid } })).to.equal('invalidArguments');
            const all = await idsOf(ctx, null);
            expect(all).to.not.include(entries[0].id);
            expect(all).to.not.include(entries[1].id);
        });
    });
});
