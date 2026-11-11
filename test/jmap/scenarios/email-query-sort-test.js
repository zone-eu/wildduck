/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-query.yaml: sort comparators of Email/query.

const { expect } = require('chai');
const { scenario, api } = require('../harness');
const { setup, rawMessage, sizedMessage, append, imapIn, query, idsOf, errorOf, emails, ids, day } = require('./email-query-helpers');

const asc = property => [{ property, isAscending: true }];
const desc = property => [{ property, isAscending: false }];
const sorted = async (ctx, sort, args = {}) => (await query(ctx, Object.assign({ sort }, args))).ids;

describe('Email/query sorting (email-query.yaml)', () => {
    describe('receivedAt and sentAt', () => {
        scenario('EQRY-092', async () => {
            const ctx = await setup();
            // arrival order differs from the date order
            const [e2, e3, e1] = await append(ctx, [{ date: day(2) }, { date: day(3) }, { date: day(1) }]);
            const ascending = await sorted(ctx, asc('receivedAt'));
            expect(ascending).to.deep.equal(ids([e1, e2, e3]));
            expect(await sorted(ctx, desc('receivedAt'))).to.deep.equal(ids([e3, e2, e1]));

            const got = await emails(ctx, ascending, ['receivedAt']);
            const received = ascending.map(id => Date.parse(got[id].receivedAt));
            expect([...received].sort((a, b) => a - b)).to.deep.equal(received);
            const internal = await imapIn(ctx, 'INBOX', async client => {
                const result = {};
                for await (const message of client.fetch('1:*', { uid: true, internalDate: true })) {
                    result[message.uid] = message.internalDate.getTime();
                }
                return result;
            });
            expect([e1, e2, e3].map(entry => internal[entry.uid])).to.deep.equal(received);
        });

        scenario('EQRY-093', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [
                { date: day(1), raw: rawMessage({ date: 'Wed, 03 Jan 2024 10:00:00 +0000' }) },
                { date: day(2), raw: rawMessage({ date: 'Tue, 02 Jan 2024 10:00:00 +0000' }) },
                { date: day(3), raw: rawMessage({ date: 'Mon, 01 Jan 2024 10:00:00 +0000' }) }
            ]);
            expect(await sorted(ctx, [{ property: 'receivedAt' }])).to.deep.equal(ids(entries));
            expect(await sorted(ctx, [{ property: 'sentAt' }])).to.deep.equal(ids(entries).reverse());
        });

        scenario('EQRY-094', async () => {
            const ctx = await setup(['Work', 'Other']);
            // pairs share a receivedAt, so the order also depends on the tie breaker, and arrival is
            // in reverse date order, so an order by arrival would differ from the default order
            await append(
                ctx,
                Array.from({ length: 20 }, (item, i) => ({ box: ['INBOX', 'Work', 'Other'][i % 3], date: day(20 - Math.floor(i / 2)) }))
            );
            const results = [];
            for (let i = 0; i < 3; i++) {
                for (const args of [{}, { sort: null }, { sort: [] }]) {
                    results.push(await query(ctx, args));
                }
            }
            expect(results[0].ids).to.have.lengthOf(20);
            expect(results[0].ids).to.deep.equal((await query(ctx, { sort: [{ property: 'receivedAt', isAscending: false }] })).ids);
            for (const res of results) {
                expect(res.ids).to.deep.equal(results[0].ids);
                expect(res.queryState).to.equal(results[0].queryState);
            }
        });

        scenario('EQRY-095', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [{ date: day(2) }, { date: day(1) }, { date: day(3) }]);
            const newestFirst = ids([entries[2], entries[0], entries[1]]);
            expect(await idsOf(ctx, null)).to.deep.equal(newestFirst);
            expect(await idsOf(ctx, { inMailbox: ctx.mailbox('INBOX') })).to.deep.equal(newestFirst);
            expect(await sorted(ctx, desc('receivedAt'))).to.deep.equal(newestFirst);
        });

        scenario('EQRY-096', async () => {
            const ctx = await setup();
            // D1 10:00Z < D2 10:30Z < D3 11:00Z, written in different zones
            const d1 = 'Mon, 01 Jan 2024 10:00:00 +0000';
            const d2 = 'Mon, 01 Jan 2024 12:30:00 +0200';
            const d3 = 'Mon, 01 Jan 2024 06:00:00 -0500';
            const [e1, e2, e3] = await append(ctx, [
                { date: day(3), raw: rawMessage({ date: d2 }) },
                { date: day(1), raw: rawMessage({ date: d3 }) },
                { date: day(2), raw: rawMessage({ date: d1 }) }
            ]);
            expect(await sorted(ctx, asc('sentAt'))).to.deep.equal(ids([e3, e1, e2]));
            expect(await sorted(ctx, desc('sentAt'))).to.deep.equal(ids([e2, e1, e3]));
            expect(await sorted(ctx, desc('sentAt'), { filter: { inMailbox: ctx.mailbox('INBOX') } })).to.deep.equal(ids([e2, e1, e3]));
        });

        scenario('EQRY-097', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [
                { date: day(2), raw: rawMessage({ date: false }) },
                { date: day(3), raw: rawMessage({ date: 'Mon, 01 Jan 2024 10:00:00 +0000' }) },
                { date: day(4), raw: rawMessage({ date: 'not a date at all' }) }
            ]);
            expect(await sorted(ctx, asc('sentAt'))).to.deep.equal(ids([e2, e1, e3]));
        });
    });

    describe('size and keywords', () => {
        scenario('EQRY-098', async () => {
            const ctx = await setup();
            const [s2, s3, s1] = await append(ctx, [{ raw: sizedMessage(1500) }, { raw: sizedMessage(2500) }, { raw: sizedMessage(800) }]);
            const ascending = await sorted(ctx, asc('size'));
            expect(ascending).to.deep.equal(ids([s1, s2, s3]));
            expect(await sorted(ctx, desc('size'))).to.deep.equal(ids([s3, s2, s1]));
            const got = await emails(ctx, ascending, ['size']);
            expect(ascending.map(id => got[id].size)).to.deep.equal([800, 1500, 2500]);
        });

        scenario('EQRY-099', async () => {
            const ctx = await setup();
            const [e1, e2, e3, e4] = await append(ctx, [
                { date: day(1), flags: ['\\Flagged'] },
                { date: day(2) },
                { date: day(3), flags: ['\\Flagged'] },
                { date: day(4) }
            ]);
            expect(await sorted(ctx, [{ property: 'hasKeyword', keyword: '$flagged' }, { property: 'receivedAt' }])).to.deep.equal(ids([e2, e4, e1, e3]));
            expect(await sorted(ctx, [{ property: 'hasKeyword', keyword: '$flagged', isAscending: false }, { property: 'receivedAt' }])).to.deep.equal(
                ids([e1, e3, e2, e4])
            );
        });

        scenario('EQRY-100', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [{ date: day(1), flags: ['\\Seen'] }, { date: day(2), flags: ['todo'] }, { date: day(3) }]);
            const label = await api('POST', `/users/${ctx.user.id}/labels`, { name: 'Sorted label' });
            await api('PUT', `/users/${ctx.user.id}/mailboxes/${ctx.boxes.INBOX.id}/messages/${e3.uid}`, { addLabels: ['Sorted label'] });

            const cases = [
                ['$seen', [e1, e2, e3]],
                ['todo', [e2, e1, e3]],
                ['TODO', [e2, e1, e3]],
                [`$wdlabel$${label.id}`, [e3, e1, e2]]
            ];
            for (const [keyword, expected] of cases) {
                const sort = [{ property: 'hasKeyword', keyword, isAscending: false }, { property: 'receivedAt' }];
                expect(await sorted(ctx, sort), keyword).to.deep.equal(ids(expected));
            }
        });

        scenario('EQRY-107', async () => {
            const ctx = await setup();
            const [a, b, c, d] = await append(ctx, [
                { date: day(1), raw: sizedMessage(2000) },
                { date: day(2), raw: sizedMessage(1000) },
                { date: day(3), raw: sizedMessage(2000) },
                { date: day(4), raw: sizedMessage(1000) }
            ]);
            expect(await sorted(ctx, [{ property: 'size' }, { property: 'receivedAt', isAscending: false }])).to.deep.equal(ids([d, b, c, a]));
            expect(await sorted(ctx, [{ property: 'size', isAscending: false }, { property: 'receivedAt' }])).to.deep.equal(ids([a, c, b, d]));
        });

        scenario('EQRY-108', async () => {
            const ctx = await setup();
            const date = day(5);
            const entries = await append(
                ctx,
                Array.from({ length: 30 }, (item, i) => ({ date, raw: sizedMessage(1200, { subject: `Equal message ${String(i).padStart(2, '0')}` }) }))
            );
            const full = await sorted(ctx, asc('receivedAt'));
            expect(full).to.have.members(ids(entries));
            for (let i = 0; i < 4; i++) {
                expect(await sorted(ctx, asc('receivedAt'))).to.deep.equal(full);
            }
            const pages = [];
            for (let position = 0; position < 30; position += 7) {
                pages.push(...(await sorted(ctx, asc('receivedAt'), { position, limit: 7 })));
            }
            expect(pages).to.deep.equal(full);
            const descending = await sorted(ctx, desc('receivedAt'));
            expect(descending).to.have.members(full);
            expect(await sorted(ctx, desc('receivedAt'))).to.deep.equal(descending);
        });

        scenario('EQRY-109', async () => {
            const ctx = await setup();
            await append(ctx, [{ date: day(2) }, { date: day(1) }, { date: day(3) }]);
            const plain = await sorted(ctx, asc('receivedAt'));
            expect(await sorted(ctx, [{ property: 'receivedAt', collation: 'i;ascii-casemap' }])).to.deep.equal(plain);
            expect(await sorted(ctx, [{ property: 'receivedAt', collation: 'i;nonexistent' }])).to.deep.equal(plain);
        });
    });

    describe('invalid comparators', () => {
        let ctx;
        before(async () => {
            ctx = await setup();
        });

        scenario('EQRY-101', async () => {
            const sorts = [
                [{ property: 'receivedAt' }, { property: 'hasKeyword' }],
                [{ property: 'hasKeyword', keyword: '' }],
                [{ property: 'hasKeyword', keyword: 'bad keyword' }],
                [{ property: 'hasKeyword', keyword: true }]
            ];
            for (const sort of sorts) {
                expect(await errorOf(ctx, { sort }), JSON.stringify(sort)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-102', async () => {
            const sorts = [
                [{ isAscending: true }],
                ['receivedAt'],
                { property: 'receivedAt' },
                [{ property: 'receivedAt', isAscending: 'yes' }],
                [{ property: 5 }]
            ];
            for (const sort of sorts) {
                expect(await errorOf(ctx, { sort }), JSON.stringify(sort)).to.equal('invalidArguments');
            }
        });

        scenario('EQRY-103', async () => {
            const sorts = [
                [{ property: 'unknownProperty' }],
                [{ property: 'id' }],
                [{ property: 'ReceivedAt' }],
                [{ property: 'receivedAt' }, { property: 'preview' }]
            ];
            for (const sort of sorts) {
                expect(await errorOf(ctx, { sort }), JSON.stringify(sort)).to.equal('unsupportedSort');
            }
        });

        scenario('EQRY-104', () => {});
    });
});
