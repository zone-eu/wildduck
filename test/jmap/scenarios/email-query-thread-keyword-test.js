/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue file email-query.yaml: thread keyword filters and sorts (phase 4, work package 4.4).

const { expect } = require('chai');
const { scenario, api } = require('../harness');
const { setup, append, imapIn, idsOf, query, errorOf, ids, day, threadMessages, inProcess } = require('./email-query-helpers');

const sortedBy = async (ctx, sort) => (await query(ctx, { sort })).ids;

/**
 * Runs the same filters on a service whose memory limit is far below the number of candidates, so the
 * conditions are decided by the threads having or lacking the keyword across the account, and answers
 * the result ids per filter.
 */
async function withoutCandidates(ctx, filters, memoryLimit = 2) {
    const service = await inProcess(ctx, { query: { memoryLimit } });
    try {
        const results = [];
        for (const filter of filters) {
            results.push((await service.method('Email/query', { filter })).ids);
        }
        return results;
    } finally {
        await service.close();
    }
}

describe('Email/query thread keyword filters and sorts (email-query.yaml)', () => {
    scenario('EQRY-038', async () => {
        const ctx = await setup();
        const [a1raw, a2raw] = threadMessages('a038', 2);
        const [b1raw, b2raw] = threadMessages('b038', 2);
        const [a1, a2, b1, b2] = await append(ctx, [
            { raw: a1raw, flags: ['\\Flagged'], date: day(1) },
            { raw: a2raw, date: day(2) },
            { raw: b1raw, date: day(3) },
            { raw: b2raw, date: day(4) }
        ]);
        const filter = { someInThreadHaveKeyword: '$flagged' };
        const found = await idsOf(ctx, filter);
        expect(found).to.have.members(ids([a1, a2]));
        expect(found).to.not.include.members(ids([b1, b2]));
        // the same through the account wide threads, when the candidates are too many
        const [fallback] = await withoutCandidates(ctx, [filter]);
        expect(fallback).to.have.members(ids([a1, a2]));
    });

    scenario('EQRY-039', async () => {
        const ctx = await setup();
        const [a1raw, a2raw] = threadMessages('a039', 2);
        const [b1raw, b2raw] = threadMessages('b039', 2);
        const [c1raw] = threadMessages('c039', 1);
        const [a1, a2, b1, b2, c1] = await append(ctx, [
            { raw: a1raw, flags: ['\\Seen'], date: day(1) },
            { raw: a2raw, flags: ['\\Seen'], date: day(2) },
            { raw: b1raw, flags: ['\\Seen'], date: day(3) },
            { raw: b2raw, date: day(4) },
            { raw: c1raw, date: day(5) }
        ]);
        const all = { allInThreadHaveKeyword: '$seen' };
        const negated = { operator: 'NOT', conditions: [all] };
        expect(await idsOf(ctx, all)).to.have.members(ids([a1, a2]));
        expect(await idsOf(ctx, negated)).to.have.members(ids([b1, b2, c1]));
        const [fallbackAll, fallbackNot] = await withoutCandidates(ctx, [all, negated]);
        expect(fallbackAll).to.have.members(ids([a1, a2]));
        expect(fallbackNot).to.have.members(ids([b1, b2, c1]));
        // two unseen emails decide the condition: with room for one, the filter is refused instead of read unbounded
        const err = await withoutCandidates(ctx, [all], 1).catch(error => error);
        expect(err.type).to.equal('unsupportedFilter');
    });

    scenario('EQRY-040', async () => {
        const ctx = await setup();
        const [a1raw, a2raw] = threadMessages('a040', 2);
        const [b1raw, b2raw] = threadMessages('b040', 2);
        const [, , b1, b2] = await append(ctx, [
            { raw: a1raw, flags: ['\\Flagged'], date: day(1) },
            { raw: a2raw, date: day(2) },
            { raw: b1raw, date: day(3) },
            { raw: b2raw, date: day(4) }
        ]);
        const filter = { noneInThreadHaveKeyword: '$flagged' };
        expect(await idsOf(ctx, filter))
            .to.have.members(ids([b1, b2]))
            .and.have.lengthOf(2);
        const [fallback] = await withoutCandidates(ctx, [filter]);
        expect(fallback)
            .to.have.members(ids([b1, b2]))
            .and.have.lengthOf(2);
    });

    scenario('EQRY-041', async () => {
        const ctx = await setup();
        const [a1raw, a2raw, a3raw] = threadMessages('a041', 3);
        const [a1, a2, a3] = await append(ctx, [
            { raw: a1raw, date: day(1) },
            { raw: a2raw, box: '\\Trash', flags: ['\\Seen', '\\Flagged'], date: day(2) },
            { raw: a3raw, flags: ['\\Flagged'], date: day(3) }
        ]);
        await imapIn(ctx, 'INBOX', client => client.messageFlagsAdd(String(a3.uid), ['\\Deleted'], { uid: true }));
        const inbox = ctx.mailbox('INBOX');

        expect(await idsOf(ctx, { inMailbox: inbox, someInThreadHaveKeyword: '$flagged' })).to.deep.equal([a1.id]);
        await imapIn(ctx, '\\Trash', client => client.messageFlagsRemove(String(a2.uid), ['\\Flagged'], { uid: true }));
        // the \Deleted A3 is not part of the thread any more
        expect(await idsOf(ctx, { inMailbox: inbox, someInThreadHaveKeyword: '$flagged' })).to.deep.equal([]);
        expect(await idsOf(ctx, { inMailbox: inbox, allInThreadHaveKeyword: '$seen' })).to.deep.equal([]);
    });

    scenario('EQRY-042', async () => {
        const ctx = await setup();
        const [a1raw, a2raw] = threadMessages('a042', 2);
        const [b1raw, b2raw] = threadMessages('b042', 2);
        const [a1, a2, b1, b2] = await append(ctx, [
            { raw: a1raw, date: day(1) },
            { raw: a2raw, flags: ['todo'], date: day(2) },
            { raw: b1raw, date: day(3) },
            { raw: b2raw, date: day(4) }
        ]);
        const label = await api('POST', `/users/${ctx.user.id}/labels`, { name: 'Thread label 042' });
        await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${a1.uid}`, { addLabels: ['Thread label 042'] });

        expect(await idsOf(ctx, { someInThreadHaveKeyword: `$wdlabel$${label.id}` }))
            .to.have.members(ids([a1, a2]))
            .and.have.lengthOf(2);
        expect(await idsOf(ctx, { noneInThreadHaveKeyword: 'todo' }))
            .to.have.members(ids([b1, b2]))
            .and.have.lengthOf(2);
    });

    scenario('EQRY-114', async () => {
        const ctx = await setup();
        const [a1raw, a2raw] = threadMessages('a114', 2);
        const [b1raw] = threadMessages('b114', 1);
        const [c1raw] = threadMessages('c114', 1);
        const [a1, b1, a2, c1] = await append(ctx, [
            { raw: a1raw, flags: ['\\Flagged'], date: day(1) },
            { raw: b1raw, date: day(2) },
            { raw: a2raw, date: day(3) },
            { raw: c1raw, flags: ['\\Flagged'], date: day(4) }
        ]);
        const sortOn = property => [
            { property, keyword: '$flagged', isAscending: false },
            { property: 'receivedAt', isAscending: false }
        ];
        expect(await sortedBy(ctx, sortOn('someInThreadHaveKeyword'))).to.deep.equal(ids([c1, a2, a1, b1]));
        expect(await sortedBy(ctx, sortOn('allInThreadHaveKeyword'))).to.deep.equal(ids([c1, a2, b1, a1]));
    });

    scenario('EQRY-115', async () => {
        const ctx = await setup();
        expect(await errorOf(ctx, { sort: [{ property: 'someInThreadHaveKeyword' }] })).to.equal('invalidArguments');
        expect(await errorOf(ctx, { sort: [{ property: 'allInThreadHaveKeyword', keyword: '' }] })).to.equal('invalidArguments');
    });
});
