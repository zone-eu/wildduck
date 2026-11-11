/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue files email-query.yaml and core.yaml: the from, to and subject sorts and the advertised sort
// options (phase 4, work package 4.5).

const { expect } = require('chai');
const { scenario } = require('../harness');
const { setup, rawMessage, append, query, errorOf, ids, day, inProcess } = require('./email-query-helpers');

const NINE = ['receivedAt', 'sentAt', 'size', 'from', 'to', 'subject', 'hasKeyword', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword'];
const PHASE_4 = ['from', 'to', 'subject', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword'];
const KEYWORD_SORTS = ['hasKeyword', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword'];

const sorted = async (ctx, sort) => (await query(ctx, { sort })).ids;
const sortOptions = session => session.accounts[Object.keys(session.accounts)[0]].accountCapabilities['urn:ietf:params:jmap:mail'].emailQuerySortOptions;

/** Calls Email/query once per sort property; answers the error type (or null) per property */
async function tryEach(ctx, properties) {
    const result = {};
    for (const property of properties) {
        const comparator = KEYWORD_SORTS.includes(property) ? { property, keyword: '$flagged' } : { property };
        result[property] = await errorOf(ctx, { sort: [comparator] });
    }
    return result;
}

/** One email per subject, appended in this order one day apart */
const withSubjects = (ctx, subjects) =>
    append(
        ctx,
        subjects.map((subject, i) => ({ date: day(i + 1), raw: rawMessage({ subject }) }))
    );

describe('Email/query string sorts and sort options (email-query.yaml, core.yaml)', () => {
    scenario('EQRY-105', async () => {
        const ctx = await setup();
        await append(ctx, [{ date: day(1) }, { date: day(2) }]);
        const options = sortOptions(await ctx.client.session());
        expect(options).to.have.members(NINE).and.have.lengthOf(NINE.length);
        const errors = await tryEach(ctx, options);
        expect(errors).to.deep.equal(Object.fromEntries(options.map(property => [property, null])));
        // every RFC 8621 4.4.2 property is listed, anything else is unsupportedSort
        expect(await tryEach(ctx, ['id', 'threadId', 'preview'])).to.deep.equal({
            id: 'unsupportedSort',
            threadId: 'unsupportedSort',
            preview: 'unsupportedSort'
        });
    });

    scenario('EQRY-106', async () => {
        const ctx = await setup();
        await append(ctx, [{ date: day(1), flags: ['\\Flagged'] }, { date: day(2) }]);
        const options = sortOptions(await ctx.client.session());
        expect(options).to.include.members(PHASE_4);
        expect(options).to.have.lengthOf(9);
        const errors = await tryEach(ctx, options);
        expect(
            Object.values(errors).every(type => type === null),
            JSON.stringify(errors)
        ).to.be.true;
    });

    scenario('CORE-012', async () => {
        const ctx = await setup();
        expect(sortOptions(await ctx.client.session())).to.include.members(PHASE_4);
    });

    scenario('EQRY-110', async () => {
        const ctx = await setup();
        const [banana, apple, cherry, pie, reApple] = await withSubjects(ctx, [
            'Re: banana',
            'apple',
            'Fwd: Re: cherry',
            '[list] Apple pie (fwd)',
            'RE: apple'
        ]);
        const order = ids([apple, reApple, pie, banana, cherry]);
        expect(await sorted(ctx, [{ property: 'subject' }, { property: 'receivedAt' }])).to.deep.equal(order);
        expect(
            await sorted(ctx, [
                { property: 'subject', isAscending: false },
                { property: 'receivedAt', isAscending: false }
            ])
        ).to.deep.equal([...order].reverse());
        // pages of the sorted list come from the list cached under the query state
        const pages = [];
        for (let position = 0; position < 5; position += 2) {
            pages.push(...(await query(ctx, { sort: [{ property: 'subject' }, { property: 'receivedAt' }], position, limit: 2 })).ids);
        }
        expect(pages).to.deep.equal(order);

        // an in memory sort is bounded: a result larger than the memory limit is refused, not sorted
        const service = await inProcess(ctx, { query: { memoryLimit: 4 } });
        try {
            // a sort the shared server has no cached list for; the shorter 'apple' still comes first
            const bySubject = [{ property: 'subject' }, { property: 'size' }, { property: 'receivedAt' }];
            const err = await service.method('Email/query', { sort: bySubject }).catch(error => error);
            expect(err.type).to.equal('unsupportedSort');
            const narrow = await service.method('Email/query', {
                filter: {
                    after: day(2)
                        .toISOString()
                        .replace(/\.000Z$/, 'Z')
                },
                sort: bySubject
            });
            expect(narrow.ids).to.deep.equal(ids([apple, reApple, pie, cherry]));
        } finally {
            await service.close();
        }
    });

    scenario('EQRY-111', async () => {
        const ctx = await setup();
        const [e1, e2, e3, e4] = await append(ctx, [
            { date: day(1), raw: rawMessage({ from: 'Zed <aaa@example.com>' }) },
            { date: day(2), raw: rawMessage({ from: 'bbb@example.com' }) },
            { date: day(3), raw: rawMessage({ from: 'Carl <zzz@example.com>, Aaron <a@example.com>' }) },
            { date: day(4), raw: rawMessage({ from: false }) }
        ]);
        expect(await sorted(ctx, [{ property: 'from' }])).to.deep.equal(ids([e4, e2, e3, e1]));
    });

    scenario('EQRY-112', async () => {
        const ctx = await setup();
        const [e1, e2, e3, e4] = await append(ctx, [
            { date: day(1), raw: rawMessage({ to: 'Yvonne <a@example.com>' }) },
            { date: day(2), raw: rawMessage({ to: 'm@example.com' }) },
            { date: day(3), raw: rawMessage({ to: false, cc: 'Cecil <c@example.com>' }) },
            { date: day(4), raw: rawMessage({ to: 'bob <z@example.com>' }) }
        ]);
        expect(await sorted(ctx, [{ property: 'to' }])).to.deep.equal(ids([e3, e4, e2, e1]));
        expect(await sorted(ctx, [{ property: 'to', isAscending: false }])).to.deep.equal(ids([e1, e2, e4, e3]));
    });

    scenario('EQRY-113', async () => {
        const ctx = await setup();
        const [apple, banana, cherry, apfel] = await withSubjects(ctx, ['apple', 'Banana', 'cherry', 'Äpfel']);
        const byDefault = await sorted(ctx, [{ property: 'subject' }]);
        expect(byDefault).to.deep.equal(ids([apple, apfel, banana, cherry]));

        const session = await ctx.client.session();
        const collations = session.capabilities['urn:ietf:params:jmap:core'].collationAlgorithms;
        expect(collations).to.be.an('array').that.is.not.empty;
        for (const collation of collations) {
            expect(await errorOf(ctx, { sort: [{ property: 'subject', collation }] }), collation).to.equal(null);
        }
        if (collations.includes('i;ascii-casemap')) {
            const ascii = await sorted(ctx, [{ property: 'subject', collation: 'i;ascii-casemap' }]);
            const positions = ids([apple, banana, cherry]).map(id => ascii.indexOf(id));
            expect([...positions].sort((a, b) => a - b)).to.deep.equal(positions);
        }
        if (!collations.includes('i;octet')) {
            expect(await errorOf(ctx, { sort: [{ property: 'subject', collation: 'i;octet' }] })).to.equal('unsupportedSort');
        }
        expect(await errorOf(ctx, { sort: [{ property: 'subject', collation: 'i;nonexistent' }] })).to.equal('unsupportedSort');
    });
});
