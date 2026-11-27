/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-query.yaml: response shape, mailbox, date, size, keyword and attachment filters,
// filter operators and filter validation of Email/query.

const crypto = require('crypto');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures } = require('../harness');
const { MAX_DEPTH, MAX_CONDITIONS } = require('../../../lib/jmap/email-search');
const { setup, rawMessage, withHeaders, append, imapIn, query, idsOf, errorOf, emails, ids, day, utc } = require('./email-query-helpers');

const EMAIL_ID = /^M[0-9a-f]{24}$/;
const unknownMailbox = () => `F${new seed.ObjectId().toString()}`;

describe('Email/query filters (email-query.yaml)', () => {
    describe('response shape and account scope', () => {
        scenario('EQRY-001', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [{}, {}, {}]);

            const res = await query(ctx);
            expect(res.accountId).to.equal(ctx.client.accountId);
            expect(res.queryState).to.be.a('string').that.is.not.empty;
            expect(res.canCalculateChanges).to.be.a('boolean');
            expect(res.position).to.equal(0);
            expect(res.ids).to.have.lengthOf(3);
            expect(new Set(res.ids).size).to.equal(3);
            res.ids.forEach(id => expect(id).to.match(EMAIL_ID));
            expect(res.ids).to.have.members(ids(entries));
            expect(res).to.not.have.property('total');
            // limit is only there because the server applied its maximum when the client gave none
            expect(Object.keys(res)).to.have.members(['accountId', 'queryState', 'canCalculateChanges', 'position', 'ids', 'limit']);
        });

        scenario('EQRY-002', async () => {
            const ctx = await setup();
            const first = await query(ctx, { filter: null });
            expect(first.ids).to.deep.equal([]);
            expect(first.position).to.equal(0);

            const second = await query(ctx, { filter: { text: 'foo' }, calculateTotal: true });
            expect(second.ids).to.deep.equal([]);
            expect(second.position).to.equal(0);
            expect(second.total).to.equal(0);
        });

        scenario('EQRY-003', async () => {
            const ctx = await setup(['Projects']);
            const entries = await append(
                ctx,
                ['INBOX', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', 'Projects'].map(box => ({ box }))
            );

            for (const args of [{ filter: null }, {}, { filter: {} }]) {
                const res = await query(ctx, Object.assign({ calculateTotal: true }, args));
                expect(res.ids).to.have.members(ids(entries));
                expect(res.total).to.equal(6);
            }
        });

        scenario('EQRY-004', async () => {
            const a = await setup();
            const b = await setup();
            const message = { subject: 'Same subject for both' };
            const [mine] = await append(a, [{ message }]);
            await append(b, [{ message }]);

            expect(await idsOf(a, null)).to.deep.equal([mine.id]);
            expect(await errorOf(a, { filter: { inMailbox: b.mailbox('INBOX') } })).to.equal('invalidArguments');
        });

        scenario('EQRY-005', async () => {
            const ctx = await setup();
            const other = await accounts.createUser();
            for (const accountId of [`u${other.id}`, `u${crypto.randomBytes(12).toString('hex')}`]) {
                const responses = await ctx.client.call([
                    ['Email/query', { accountId }, 'q'],
                    ['Email/queryChanges', { accountId, sinceQueryState: 'anything' }, 'c']
                ]);
                expect(responses.map(([name, args]) => [name, args.type])).to.deep.equal([
                    ['error', 'accountNotFound'],
                    ['error', 'accountNotFound']
                ]);
            }
        });

        scenario('EQRY-006', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [{ date: day(1) }, { date: day(2) }, { date: day(3) }]);
            const accountId = ctx.client.accountId;
            const [[, queried], [, got]] = await ctx.client.call([
                ['Email/query', { accountId, filter: { inMailbox: ctx.mailbox('INBOX') }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q'],
                ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id'] }, 'g']
            ]);
            expect(queried.ids).to.have.members(ids(entries));
            expect(got.list.map(email => email.id)).to.have.members(queried.ids);
            expect(got.notFound).to.deep.equal([]);
        });

        scenario('EQRY-007', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [{}, {}, {}]);
            const queries = [
                { filter: null },
                { filter: { inMailbox: ctx.mailbox('INBOX') }, calculateTotal: true },
                { collapseThreads: true, calculateTotal: true }
            ];

            await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(e2.uid), ['\\Deleted'], { uid: true }));
            for (const args of queries) {
                const res = await query(ctx, args);
                expect(res.ids).to.have.members([e1.id, e3.id]);
                if (args.calculateTotal) {
                    expect(res.total).to.equal(2);
                }
            }

            await imapIn(ctx, 'INBOX', client => client.messageFlagsRemove(String(e2.uid), ['\\Deleted'], { uid: true }));
            for (const args of queries) {
                const res = await query(ctx, args);
                expect(res.ids).to.have.members([e1.id, e2.id, e3.id]);
                if (args.calculateTotal) {
                    expect(res.total).to.equal(3);
                }
            }
        });

        scenario('EQRY-008', async () => {
            const ctx = await setup();
            await append(ctx, [{}]);
            for (const filter of [{ hasKeyword: '\\Deleted' }, { hasKeyword: '\\Recent' }, { notKeyword: '\\Deleted' }]) {
                expect(await errorOf(ctx, { filter }), JSON.stringify(filter)).to.equal('invalidArguments');
            }
        });
    });

    describe('mailbox filters', () => {
        scenario('EQRY-009', async () => {
            const ctx = await setup(['Work']);
            const [e1, e2, e3] = await append(ctx, [{}, {}, { box: 'Work' }, { box: '\\Trash' }]);
            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('Work') })).to.deep.equal([e3.id]);
            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('INBOX') })).to.have.members([e1.id, e2.id]);
        });

        scenario('EQRY-010', async () => {
            const ctx = await setup(['Empty']);
            await append(ctx, [{}, {}]);
            const res = await query(ctx, { filter: { inMailbox: ctx.mailbox('Empty') }, calculateTotal: true });
            expect(res.ids).to.deep.equal([]);
            expect(res.total).to.equal(0);
            expect(res.position).to.equal(0);
        });

        scenario('EQRY-011', async () => {
            const ctx = await setup(['Parent', 'Parent/Child']);
            const [e1, e2] = await append(ctx, [{ box: 'Parent' }, { box: 'Parent/Child' }]);
            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('Parent') })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('Parent/Child') })).to.deep.equal([e2.id]);
        });

        scenario('EQRY-012', async () => {
            const ctx = await setup();
            for (const inMailbox of ['foo', unknownMailbox(), null, 42]) {
                expect(await errorOf(ctx, { filter: { inMailbox } }), String(inMailbox)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-013', async () => {
            const ctx = await setup(['Secret']);
            const [visible] = await append(ctx, [{}, { box: 'Secret' }]);
            const db = await seed.db();
            await db.collection('mailboxes').updateOne({ _id: new seed.ObjectId(ctx.boxes.Secret.id) }, { $set: { hidden: true } });

            expect(await idsOf(ctx, null)).to.deep.equal([visible.id]);
            expect(await errorOf(ctx, { filter: { inMailbox: ctx.mailbox('Secret') } })).to.equal('invalidArguments');
        });

        scenario('EQRY-014', async () => {
            const ctx = await setup(['Work']);
            const [e1, e2, , e4] = await append(ctx, [{}, { box: 'Work' }, { box: '\\Trash' }, { box: '\\Junk' }]);
            expect(await idsOf(ctx, { inMailboxOtherThan: [ctx.mailbox('\\Trash')] })).to.have.members([e1.id, e2.id, e4.id]);
            expect(await idsOf(ctx, { inMailboxOtherThan: [ctx.mailbox('\\Trash'), ctx.mailbox('\\Junk')] })).to.have.members([e1.id, e2.id]);
        });

        scenario('EQRY-015', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [{}, { box: '\\Trash' }]);
            expect(await idsOf(ctx, { inMailboxOtherThan: [] })).to.have.members(ids(entries));
        });

        scenario('EQRY-016', async () => {
            const ctx = await setup();
            expect(await errorOf(ctx, { filter: { inMailboxOtherThan: ['foo'] } })).to.equal('invalidArguments');
            expect(await errorOf(ctx, { filter: { inMailboxOtherThan: ctx.mailbox('INBOX') } })).to.equal('invalidArguments');
        });

        scenario('EQRY-017', async () => {
            const ctx = await setup(['Work']);
            const [e1] = await append(ctx, [{}, { box: 'Work' }]);
            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('INBOX'), inMailboxOtherThan: [ctx.mailbox('Work')] })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('INBOX'), inMailboxOtherThan: [ctx.mailbox('INBOX')] })).to.deep.equal([]);
        });

        scenario('EQRY-018', async () => {
            const ctx = await setup(['Work', 'Archive']);
            const [e1, e2, e3] = await append(ctx, [{}, { box: 'Work' }, { box: 'Archive' }]);
            const inbox = { inMailbox: ctx.mailbox('INBOX') };
            const work = { inMailbox: ctx.mailbox('Work') };
            expect(await idsOf(ctx, { operator: 'OR', conditions: [inbox, work] })).to.have.members([e1.id, e2.id]);
            expect(await idsOf(ctx, { operator: 'AND', conditions: [inbox, work] })).to.deep.equal([]);
            expect(await idsOf(ctx, { operator: 'NOT', conditions: [inbox] })).to.have.members([e2.id, e3.id]);
            expect(
                await idsOf(ctx, {
                    operator: 'AND',
                    conditions: [{ inMailboxOtherThan: [ctx.mailbox('INBOX')] }, { inMailboxOtherThan: [ctx.mailbox('Work')] }]
                })
            ).to.deep.equal([e3.id]);
        });

        scenario('EQRY-019', async () => {
            const ctx = await setup(['A', 'B']);
            const [e1, e2] = await append(ctx, [{ box: 'A' }, { box: 'A' }]);
            const onA = { filter: { inMailbox: ctx.mailbox('A') } };
            const onB = { filter: { inMailbox: ctx.mailbox('B') } };
            let states = [(await query(ctx, onA)).queryState, (await query(ctx, onB)).queryState];
            const check = async (expectedA, expectedB) => {
                const [a, b] = [await query(ctx, onA), await query(ctx, onB)];
                expect(a.ids).to.have.members(expectedA);
                expect(b.ids).to.have.members(expectedB);
                expect(a.queryState).to.not.equal(states[0]);
                expect(b.queryState).to.not.equal(states[1]);
                states = [a.queryState, b.queryState];
            };

            await imapIn(ctx, 'A', client => client.messageMove(String(e1.uid), 'B', { uid: true }));
            await check([e2.id], [e1.id]);

            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.A.id}/messages/${e2.uid}`, { moveTo: ctx.boxes.B.id });
            await check([], [e1.id, e2.id]);
        });

        scenario('EQRY-020', async () => {
            const ctx = await setup(['Work']);
            const [e1] = await append(ctx, [{}]);
            await imapIn(ctx, 'INBOX', client => client.messageCopy(String(e1.uid), 'Work', { uid: true }));

            const all = await query(ctx, { filter: null, calculateTotal: true });
            expect(all.total).to.equal(2);
            expect(new Set(all.ids).size).to.equal(2);
            expect(all.ids).to.include(e1.id);
            const work = await idsOf(ctx, { inMailbox: ctx.mailbox('Work') });
            expect(work).to.have.lengthOf(1);
            expect(work[0]).to.not.equal(e1.id);
        });
    });

    describe('date and size filters', () => {
        let ctx;
        let e1, e2, e3;
        before(async () => {
            ctx = await setup();
            // appended out of order, so the results do not follow arrival
            [e2, e3, e1] = await append(ctx, [{ date: day(2) }, { date: day(3) }, { date: day(1) }]);
        });

        scenario('EQRY-021', async () => {
            expect(await idsOf(ctx, { before: '2024-01-02T10:00:00Z' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { before: '2024-01-02T10:00:01Z' })).to.have.members([e1.id, e2.id]);
        });

        scenario('EQRY-022', async () => {
            expect(await idsOf(ctx, { after: '2024-01-02T10:00:00Z' })).to.have.members([e2.id, e3.id]);
            expect(await idsOf(ctx, { after: '2024-01-02T10:00:01Z' })).to.deep.equal([e3.id]);
        });

        scenario('EQRY-023', async () => {
            expect(await idsOf(ctx, { after: utc(day(2)), before: utc(day(3)) })).to.deep.equal([e2.id]);
            expect(await idsOf(ctx, { after: utc(day(3)), before: utc(day(1)) })).to.deep.equal([]);
        });

        scenario('EQRY-024', async () => {
            const own = await setup();
            const [m1] = await append(own, [
                { date: new Date('2024-03-01T10:00:00Z'), raw: rawMessage({ date: 'Wed, 01 Jan 2020 10:00:00 +0000' }) },
                { date: new Date('2020-01-01T10:00:00Z'), raw: rawMessage({ date: 'Fri, 01 Mar 2024 10:00:00 +0000' }) }
            ]);
            expect(await idsOf(own, { after: '2023-01-01T00:00:00Z' })).to.deep.equal([m1.id]);
        });

        scenario('EQRY-025', async () => {
            const own = await setup(['Work']);
            const inbox = await append(
                own,
                [1, 2, 3, 4, 5].map(n => ({ date: day(n) }))
            );
            await append(own, [{ box: 'Work', date: day(3, 12) }]);
            const desc = [{ property: 'receivedAt', isAscending: false }];
            expect(await idsOf(own, { inMailbox: own.mailbox('INBOX'), after: utc(day(3)) }, { sort: desc, limit: 2 })).to.deep.equal([
                inbox[4].id,
                inbox[3].id
            ]);
            expect(await idsOf(own, { inMailbox: own.mailbox('INBOX'), before: utc(day(3)) }, { sort: desc, limit: 1 })).to.deep.equal([inbox[1].id]);
        });

        scenario('EQRY-026', async () => {
            for (const filter of [{ before: 'yesterday' }, { after: 1700000000 }, { before: '2024-01-02T10:00:00+02:00' }, { after: '2024-01-02' }]) {
                expect(await errorOf(ctx, { filter }), JSON.stringify(filter)).to.equal('invalidArguments');
            }
        });
    });

    describe('size filters', () => {
        let ctx;
        let small, medium, large;
        before(async () => {
            ctx = await setup();
            [medium, large, small] = await append(ctx, [
                { raw: rawMessage({ body: 'm'.repeat(2000) }) },
                { raw: rawMessage({ body: 'l'.repeat(3000) }) },
                { raw: rawMessage({ body: 's'.repeat(1000) }) }
            ]);
            const sizes = await emails(ctx, ids([small, medium, large]), ['size']);
            const imapSizes = await imapIn(ctx, 'INBOX', async client => {
                const result = {};
                for await (const message of client.fetch('1:*', { uid: true, size: true })) {
                    result[message.uid] = message.size;
                }
                return result;
            });
            for (const entry of [small, medium, large]) {
                entry.size = sizes[entry.id].size;
                expect(entry.size).to.equal(imapSizes[entry.uid]);
            }
            expect(small.size).to.be.below(medium.size);
            expect(medium.size).to.be.below(large.size);
        });

        scenario('EQRY-027', async () => {
            expect(await idsOf(ctx, { minSize: medium.size })).to.have.members([medium.id, large.id]);
            expect(await idsOf(ctx, { minSize: medium.size + 1 })).to.deep.equal([large.id]);
        });

        scenario('EQRY-028', async () => {
            expect(await idsOf(ctx, { maxSize: medium.size })).to.deep.equal([small.id]);
            expect(await idsOf(ctx, { maxSize: medium.size + 1 })).to.have.members([small.id, medium.id]);
            expect(await idsOf(ctx, { minSize: medium.size, maxSize: large.size })).to.deep.equal([medium.id]);
        });

        scenario('EQRY-029', async () => {
            for (const filter of [{ minSize: -1 }, { maxSize: -1 }, { minSize: 1.5 }, { maxSize: '100' }]) {
                expect(await errorOf(ctx, { filter }), JSON.stringify(filter)).to.equal('invalidArguments');
            }
            expect(await idsOf(ctx, { minSize: 0 })).to.have.members(ids([small, medium, large]));
            expect(await idsOf(ctx, { maxSize: 0 })).to.deep.equal([]);
        });
    });

    describe('keyword filters', () => {
        scenario('EQRY-030', async () => {
            const ctx = await setup();
            const flags = ['\\Seen', '\\Flagged', '\\Draft', '\\Answered', '$Forwarded'];
            const entries = await append(ctx, flags.map(flag => ({ flags: [flag] })).concat([{}]));
            const keywords = ['$seen', '$flagged', '$draft', '$answered', '$forwarded'];
            for (const [index, keyword] of keywords.entries()) {
                expect(await idsOf(ctx, { hasKeyword: keyword }), keyword).to.deep.equal([entries[index].id]);
            }
        });

        scenario('EQRY-031', async () => {
            const ctx = await setup();
            const [e1, , e3] = await append(ctx, [{ flags: ['\\Seen'] }, { flags: ['\\Seen', '\\Flagged'] }, {}]);
            expect(await idsOf(ctx, { notKeyword: '$seen' })).to.deep.equal([e3.id]);
            expect(await idsOf(ctx, { notKeyword: '$flagged' })).to.have.members([e1.id, e3.id]);
            expect(await idsOf(ctx, { hasKeyword: '$seen', notKeyword: '$flagged' })).to.deep.equal([e1.id]);
        });

        scenario('EQRY-032', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [{ flags: ['custom'] }, { flags: ['$MDNSent'] }, {}]);
            expect(await idsOf(ctx, { hasKeyword: 'custom' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { hasKeyword: '$mdnsent' })).to.deep.equal([e2.id]);
            expect(await idsOf(ctx, { notKeyword: 'custom' })).to.have.members([e2.id, e3.id]);
        });

        scenario('EQRY-033', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [{ flags: ['Important'] }, { flags: ['\\Seen'] }]);
            expect(await idsOf(ctx, { hasKeyword: 'important' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { hasKeyword: 'IMPORTANT' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { hasKeyword: '$Seen' })).to.deep.equal([e2.id]);
            expect(await idsOf(ctx, { notKeyword: 'ImPortant' })).to.deep.equal([e2.id]);
        });

        scenario('EQRY-034', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [{}, {}]);
            const label = await api('POST', `/users/${ctx.user.id}/labels`, { name: 'Scenario label' });
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${e1.uid}`, { addLabels: ['Scenario label'] });
            const keyword = `$wdlabel$${label.id}`;

            const got = await emails(ctx, [e1.id], ['keywords']);
            expect(got[e1.id].keywords).to.have.property(keyword, true);
            expect(await idsOf(ctx, { hasKeyword: keyword })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { notKeyword: keyword })).to.deep.equal([e2.id]);
            expect(await idsOf(ctx, { hasKeyword: `$wdlabel$${new seed.ObjectId().toString()}` })).to.deep.equal([]);
        });

        scenario('EQRY-035', async () => {
            const ctx = await setup();
            const values = ['', 'k'.repeat(256), 'two words', ...['(', ')', '{', ']', '%', '*', '"'].map(char => `bad${char}word`), true];
            for (const property of ['hasKeyword', 'notKeyword']) {
                for (const value of values) {
                    expect(await errorOf(ctx, { filter: { [property]: value } }), `${property} ${value}`).to.equal('invalidArguments');
                }
            }
        });

        scenario('EQRY-036', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [{}, {}]);
            const flagged = { filter: { hasKeyword: '$flagged' } };
            let previous = await query(ctx, flagged);
            expect(previous.ids).to.deep.equal([]);
            const check = async expected => {
                const res = await query(ctx, flagged);
                expect(res.ids).to.have.members(expected);
                expect(res.queryState).to.not.equal(previous.queryState);
                previous = res;
            };

            await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(e1.uid), ['\\Flagged'], { uid: true }));
            await check([e1.id]);
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${e2.uid}`, { flagged: true });
            await check([e1.id, e2.id]);
            await imapIn(ctx, 'INBOX', client => client.messageFlagsRemove(String(e1.uid), ['\\Flagged'], { uid: true }));
            await check([e2.id]);
        });

        scenario('EQRY-037', () => {});
    });

    describe('attachment filter', () => {
        let ctx;
        let e1, e2, e3;
        before(async () => {
            ctx = await setup();
            [e1, e2, e3] = await append(ctx, [
                { message: { text: 'plain only' } },
                {
                    message: {
                        text: 'with a pdf',
                        attachments: [{ filename: 'report.pdf', content: Buffer.from('%PDF-1.4 scenario'), contentType: 'application/pdf' }]
                    }
                },
                { message: { text: 'text part', html: '<p>html part</p>' } }
            ]);
        });

        scenario('EQRY-043', async () => {
            expect(await idsOf(ctx, { hasAttachment: true })).to.deep.equal([e2.id]);
            const got = await emails(ctx, ids([e1, e2, e3]), ['hasAttachment']);
            expect([e1, e2, e3].map(entry => got[entry.id].hasAttachment)).to.deep.equal([false, true, false]);
        });

        scenario('EQRY-044', async () => {
            expect(await idsOf(ctx, { hasAttachment: false })).to.have.members([e1.id, e3.id]);
            expect(await errorOf(ctx, { filter: { hasAttachment: 'true' } })).to.equal('invalidArguments');
            expect(await errorOf(ctx, { filter: { hasAttachment: null } })).to.equal('invalidArguments');
        });

        scenario('EQRY-045', async () => {
            const own = await setup();
            const image = { filename: 'pixel.png', content: Buffer.from('89504e470d0a1a0a', 'hex'), contentType: 'image/png', cid: 'pixel@scenario' };
            const html = '<p>Look <img src="cid:pixel@scenario"></p>';
            const [m1, m2] = await append(own, [
                { message: { html, attachments: [image] } },
                { message: { html, attachments: [image, { filename: 'doc.pdf', content: Buffer.from('%PDF-1.4 x'), contentType: 'application/pdf' }] } }
            ]);
            const withAttachment = await idsOf(own, { hasAttachment: true });
            const without = await idsOf(own, { hasAttachment: false });
            const got = await emails(own, ids([m1, m2]), ['hasAttachment']);
            for (const entry of [m1, m2]) {
                expect(withAttachment.includes(entry.id), entry.id).to.not.equal(without.includes(entry.id));
                expect(withAttachment.includes(entry.id)).to.equal(got[entry.id].hasAttachment);
            }
            expect(withAttachment).to.include(m2.id);
        });
    });

    describe('operators', () => {
        let ctx;
        let both, flaggedOnly, seenOnly, neither;
        before(async () => {
            ctx = await setup();
            [both, flaggedOnly, seenOnly, neither] = await append(ctx, [
                { flags: ['\\Flagged', '\\Seen'] },
                { flags: ['\\Flagged'] },
                { flags: ['\\Seen'] },
                {}
            ]);
        });
        const flagged = { hasKeyword: '$flagged' };
        const seen = { hasKeyword: '$seen' };

        scenario('EQRY-080', async () => {
            const own = await setup(['Work']);
            const [m1] = await append(own, [
                { flags: ['\\Flagged'], raw: rawMessage({ from: 'Alice <alice@example.com>' }) },
                { raw: rawMessage({ from: 'Alice <alice@example.com>' }) },
                { flags: ['\\Flagged'], raw: rawMessage({ from: 'Bob <bob@example.com>' }) },
                { box: 'Work', flags: ['\\Flagged'], raw: rawMessage({ from: 'Alice <alice@example.com>' }) }
            ]);
            const single = await idsOf(own, { inMailbox: own.mailbox('INBOX'), hasKeyword: '$flagged', from: 'alice' });
            const combined = await idsOf(own, {
                operator: 'AND',
                conditions: [{ inMailbox: own.mailbox('INBOX') }, { hasKeyword: '$flagged' }, { from: 'alice' }]
            });
            expect(single).to.deep.equal([m1.id]);
            expect(combined).to.deep.equal(single);
        });

        scenario('EQRY-081', async () => {
            const own = await setup(['Work']);
            const attachment = [{ filename: 'plan.pdf', content: Buffer.from('%PDF-1.4 plan'), contentType: 'application/pdf' }];
            const build = async (overrides = {}) =>
                withHeaders(
                    await fixtures.buildMessage(
                        Object.assign(
                            {
                                from: 'Walter Match <walter@match.example>',
                                to: 'Tina Target <tina@target.example>',
                                cc: 'Carl Copy <carl@copy.example>',
                                subject: 'Expedition quokka report',
                                text: 'The wombat expedition went well',
                                headers: { 'X-Expedition': 'southern' },
                                attachments: attachment
                            },
                            overrides
                        )
                    ),
                    ['Bcc: Bea Blind <bea@blind.example>']
                );
            const inRange = day(2);
            const flags = ['\\Flagged'];
            const [match] = await append(own, [
                { raw: await build(), flags, date: inRange },
                { box: 'Work', raw: await build(), flags, date: inRange },
                { raw: await build(), flags, date: day(9) },
                { raw: await build(), date: inRange },
                { raw: await build(), flags: ['\\Flagged', '\\Seen'], date: inRange },
                { raw: await build({ attachments: [] }), flags, date: inRange },
                { raw: await build({ subject: 'Expedition report' }), flags, date: inRange }
            ]);
            const filter = {
                inMailbox: own.mailbox('INBOX'),
                inMailboxOtherThan: [own.mailbox('\\Trash')],
                after: utc(day(1)),
                before: utc(day(3)),
                minSize: 100,
                maxSize: 1000000,
                hasKeyword: '$flagged',
                notKeyword: '$seen',
                hasAttachment: true,
                text: 'wombat',
                from: 'walter',
                to: 'tina',
                cc: 'carl',
                bcc: 'bea',
                subject: 'quokka',
                body: 'expedition',
                header: ['X-Expedition', 'southern']
            };
            expect(await idsOf(own, filter)).to.deep.equal([match.id]);
        });

        scenario('EQRY-082', async () => {
            expect(await idsOf(ctx, { operator: 'AND', conditions: [flagged, seen] })).to.deep.equal([both.id]);
        });

        scenario('EQRY-083', async () => {
            const res = await idsOf(ctx, { operator: 'OR', conditions: [flagged, seen] });
            expect(res).to.have.members([both.id, flaggedOnly.id, seenOnly.id]);
            expect(res).to.have.lengthOf(3);
            expect(await idsOf(ctx, { operator: 'OR', conditions: [flagged, flagged] })).to.have.members(await idsOf(ctx, flagged));
        });

        scenario('EQRY-084', async () => {
            expect(await idsOf(ctx, { operator: 'NOT', conditions: [flagged] })).to.have.members([seenOnly.id, neither.id]);
            expect(await idsOf(ctx, { operator: 'NOT', conditions: [flagged, seen] })).to.deep.equal([neither.id]);
        });

        scenario('EQRY-085', async () => {
            const own = await setup();
            const from = name => rawMessage({ from: `${name} <${name}@example.com>` });
            const pdf = [{ filename: 'x.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }];
            const [a1, a2, , b2, c1] = await append(own, [
                { raw: from('alice'), flags: ['\\Flagged'] },
                { raw: from('alice') },
                { raw: from('bob'), flags: ['\\Flagged'] },
                { message: { from: 'bob <bob@example.com>', attachments: pdf } },
                { raw: from('carol') }
            ]);
            const alice = { from: 'alice' };
            const bob = { from: 'bob' };
            const queryA = {
                operator: 'AND',
                conditions: [
                    { operator: 'OR', conditions: [alice, bob] },
                    { operator: 'NOT', conditions: [flagged] }
                ]
            };
            const queryB = {
                operator: 'OR',
                conditions: [
                    { operator: 'AND', conditions: [alice, flagged] },
                    { operator: 'AND', conditions: [bob, { hasAttachment: true }] }
                ]
            };
            const queryC = { operator: 'NOT', conditions: [{ operator: 'OR', conditions: [alice, { operator: 'AND', conditions: [bob, flagged] }] }] };
            expect(await idsOf(own, queryA)).to.have.members([a2.id, b2.id]);
            expect(await idsOf(own, queryB)).to.have.members([a1.id, b2.id]);
            expect(await idsOf(own, queryC)).to.have.members([b2.id, c1.id]);
        });

        scenario('EQRY-086', async () => {
            const own = await setup();
            const [alpha, beta, alphaBeta, gamma] = await append(
                own,
                ['alpha', 'beta', 'alpha beta', 'gamma'].map(subject => ({ raw: rawMessage({ subject, body: 'neutral content' }) }))
            );
            expect(await idsOf(own, { operator: 'OR', conditions: [{ text: 'alpha' }, { text: 'beta' }] })).to.have.members([alpha.id, beta.id, alphaBeta.id]);
            expect(await idsOf(own, { operator: 'NOT', conditions: [{ text: 'alpha' }] })).to.have.members([beta.id, gamma.id]);
            expect(await idsOf(own, { operator: 'AND', conditions: [{ text: 'alpha' }, { operator: 'NOT', conditions: [{ text: 'beta' }] }] })).to.deep.equal([
                alpha.id
            ]);
            expect(await idsOf(own, { operator: 'OR', conditions: [{ text: 'gamma' }, { hasKeyword: '$flagged' }] })).to.deep.equal([gamma.id]);
        });

        scenario('EQRY-087', async () => {
            const own = await setup(['Work']);
            const entries = await append(own, [{}, { box: 'Work' }, { box: '\\Trash' }]);
            expect(await idsOf(own, {})).to.have.members(ids(entries));
            expect(await idsOf(own, { operator: 'AND', conditions: [{}] })).to.have.members(ids(entries));
            expect(await idsOf(own, { operator: 'OR', conditions: [{}, { hasKeyword: 'nonexistent' }] })).to.have.members(ids(entries));
            expect(await idsOf(own, { operator: 'NOT', conditions: [{}] })).to.deep.equal([]);
        });

        scenario('EQRY-088', async () => {
            const own = await setup();
            const entries = await append(own, [{}, {}, {}]);
            expect(await idsOf(own, { operator: 'AND', conditions: [] })).to.have.members(ids(entries));
            expect(await idsOf(own, { operator: 'OR', conditions: [] })).to.deep.equal([]);
            expect(await idsOf(own, { operator: 'NOT', conditions: [] })).to.have.members(ids(entries));
        });
    });

    describe('filter validation', () => {
        let ctx;
        before(async () => {
            ctx = await setup();
        });

        scenario('EQRY-089', async () => {
            const filters = [
                { unknownProperty: 'x' },
                { inmailbox: ctx.mailbox('INBOX') },
                { hasKeyword: '$seen', bogus: 1 },
                { operator: 'OR', conditions: [{ hasKeyword: '$seen' }, { unknownProperty: 'x' }] }
            ];
            for (const filter of filters) {
                expect(await errorOf(ctx, { filter }), JSON.stringify(filter)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-090', async () => {
            const filters = [
                { operator: 'XOR', conditions: [] },
                { operator: 'and', conditions: [{}] },
                { operator: 'AND' },
                { operator: 'AND', conditions: {} },
                { operator: 'AND', conditions: [{}], hasKeyword: '$seen' },
                { operator: 'AND', conditions: ['x'] },
                'filter',
                [{ hasKeyword: '$seen' }]
            ];
            for (const filter of filters) {
                expect(await errorOf(ctx, { filter }), JSON.stringify(filter)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-091', async () => {
            const nested = levels => {
                let filter = { hasKeyword: '$seen' };
                for (let i = 0; i < levels; i++) {
                    filter = { operator: 'AND', conditions: [filter] };
                }
                return filter;
            };
            const wide = count => ({ operator: 'OR', conditions: Array.from({ length: count }, (item, i) => ({ hasKeyword: `k${i}` })) });

            for (const filter of [nested(MAX_DEPTH + 1), wide(MAX_CONDITIONS + 1)]) {
                const started = Date.now();
                expect(await errorOf(ctx, { filter })).to.equal('unsupportedFilter');
                expect(Date.now() - started).to.be.below(2000);
            }
            expect(await errorOf(ctx, { filter: nested(MAX_DEPTH) })).to.equal(null);
            expect(await errorOf(ctx, { filter: wide(MAX_CONDITIONS) })).to.equal(null);
        });
    });
});
