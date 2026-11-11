/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue file email-query.yaml: header field, header, text and body filters of Email/query.

const { expect } = require('chai');
const { scenario, seed, fixtures, clock } = require('../harness');
const { setup, rawMessage, append, query, idsOf, errorOf, emails, ids } = require('./email-query-helpers');

// a message with only the given subject and a neutral body
const subjectOnly = subject => ({ raw: rawMessage({ subject, body: 'neutral content' }) });
const bodyOnly = body => ({ raw: rawMessage({ subject: 'neutral subject', body }) });

describe('Email/query text filters (email-query.yaml)', () => {
    describe('header field filters', () => {
        scenario('EQRY-046', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [
                { raw: rawMessage({ from: 'Alice Liddell <alice@wonder.example>', to: 'carol@example.com' }) },
                { raw: rawMessage({ from: 'Bob Stone <bob@quarry.example>', to: 'carol@example.com' }) }
            ]);
            for (const from of ['alice@wonder.example', 'Liddell', 'wonder.example', 'alice']) {
                expect(await idsOf(ctx, { from }), from).to.deep.equal([e1.id]);
            }
            expect(await idsOf(ctx, { from: 'carol' })).to.deep.equal([]);
        });

        scenario('EQRY-047', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [
                { raw: rawMessage({ to: 'Carol King <carol@example.com>, dave@example.org' }) },
                { raw: rawMessage({ to: 'erin@example.net', cc: 'carol@example.com' }) }
            ]);
            for (const to of ['carol@example.com', 'King', 'dave@example.org']) {
                expect(await idsOf(ctx, { to }), to).to.deep.equal([e1.id]);
            }
            expect(await idsOf(ctx, { to: 'erin' })).to.deep.equal([e2.id]);
        });

        scenario('EQRY-048', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [{ raw: rawMessage({ cc: 'Frank Moon <frank@example.com>' }) }, { raw: rawMessage({ to: 'frank@example.com' }) }]);
            expect(await idsOf(ctx, { cc: 'frank@example.com' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { cc: 'Moon' })).to.deep.equal([e1.id]);
        });

        scenario('EQRY-049', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [
                { box: '\\Drafts', raw: rawMessage({ bcc: 'Grace Hill <grace@example.com>' }) },
                { raw: rawMessage({ to: 'grace@example.com' }) }
            ]);
            expect(await idsOf(ctx, { bcc: 'grace@example.com' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { bcc: 'Hill' })).to.deep.equal([e1.id]);
        });

        scenario('EQRY-050', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [
                { raw: rawMessage({ subject: 'Quarterly Budget Review', body: 'see attached' }) },
                { raw: rawMessage({ subject: 'Lunch plans', body: 'no budget for lunch' }) }
            ]);
            expect(await idsOf(ctx, { subject: 'budget' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { subject: 'BUDGET' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { subject: 'lunch' })).to.deep.equal([e2.id]);
        });

        scenario('EQRY-051', async () => {
            const ctx = await setup();
            const subject = `=?UTF-8?B?${Buffer.from('Tere hommikust').toString('base64')}?=`;
            const [e1] = await append(ctx, [{ raw: rawMessage({ subject, from: '=?ISO-8859-1?Q?J=F5gi?= <jogi@example.ee>' }) }, subjectOnly('Hello')]);
            expect(await idsOf(ctx, { subject: 'hommikust' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { from: 'Jõgi' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'hommikust' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { subject: '=?UTF-8?B?' })).to.deep.equal([]);
        });

        scenario('EQRY-052', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [
                { message: { subject: "Côte d'Azur itinerary", from: 'Jörg Müller <jorg@example.de>', text: 'Travel plan' } },
                subjectOnly('Something else')
            ]);
            for (const filter of [{ subject: 'cote' }, { subject: 'CÔTE' }, { from: 'muller' }, { text: 'côte' }, { text: 'COTE' }]) {
                expect(await idsOf(ctx, filter), JSON.stringify(filter)).to.deep.equal([e1.id]);
            }
        });

        scenario('EQRY-053', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [subjectOnly('red green blue'), subjectOnly('red blue'), subjectOnly('green')]);
            expect(await idsOf(ctx, { subject: 'blue red' })).to.have.members([e1.id, e2.id]);
            expect(await idsOf(ctx, { subject: 'red green' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { subject: 'red yellow' })).to.deep.equal([]);
        });

        scenario('EQRY-054', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [subjectOnly('cats and dogs'), subjectOnly('dogs and cats'), subjectOnly('cats or dogs and birds')]);
            expect(await idsOf(ctx, { subject: '"cats and dogs"' })).to.deep.equal([entries[0].id]);
            expect(await idsOf(ctx, { subject: "'cats and dogs'" })).to.deep.equal([entries[0].id]);
            expect(await idsOf(ctx, { subject: 'cats dogs' })).to.have.members(ids(entries));
        });

        scenario('EQRY-055', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [subjectOnly('say "hi" now'), subjectOnly('say hi now'), subjectOnly("don't panic")]);
            expect(await errorOf(ctx, { filter: { subject: '"say \\"hi\\""' } })).to.equal(null);
            expect(await idsOf(ctx, { subject: '"say \\"hi\\""' })).to.include(e1.id);
            expect(await errorOf(ctx, { filter: { subject: "don't" } })).to.equal(null);
        });

        scenario('EQRY-056', async () => {
            const ctx = await setup();
            const [e1, , e3] = await append(ctx, [subjectOnly('something - otherthing'), subjectOnly('something'), subjectOnly('otherthing')]);
            const first = await idsOf(ctx, { text: 'something -otherthing' });
            expect(first).to.include(e1.id);
            expect([[e1.id], [e1.id, e3.id].sort()].map(list => JSON.stringify(list))).to.include(JSON.stringify([...first].sort()));
            expect(await idsOf(ctx, { subject: 'something - otherthing' })).to.deep.equal([e1.id]);
            expect(await errorOf(ctx, { filter: { text: 'some*' } })).to.equal(null);
            expect(await errorOf(ctx, { filter: { subject: 'a.c(d' } })).to.equal(null);
        });

        scenario('EQRY-057', async () => {
            const ctx = await setup();
            const [e1, e2, e3, e4] = await append(ctx, [
                { raw: rawMessage({ to: 'foo.bar@xxx.example.com' }) },
                { raw: rawMessage({ to: 'foo.baz+tag@yyy.example.com' }) },
                { raw: rawMessage({ to: 'Tu X <tux@example.com>' }) },
                { raw: rawMessage({ to: 'Team: m1@example.com, m2@example.com;' }) }
            ]);
            const cases = [
                ['foo.bar@xxx.example.com', e1],
                ['foo.baz+tag@yyy.example.com', e2],
                ['yyy.example.com', e2],
                ['m2@example.com', e4],
                ['Tu X', e3]
            ];
            for (const [to, entry] of cases) {
                expect(await idsOf(ctx, { to }), to).to.deep.equal([entry.id]);
            }
        });
    });

    describe('header filter', () => {
        scenario('EQRY-058', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [
                { raw: rawMessage({ headers: ['X-Project: apollo'] }) },
                { raw: rawMessage({ headers: ['List-Id: <dev.example.com>'] }) },
                { raw: rawMessage() }
            ]);
            expect(await idsOf(ctx, { header: ['X-Project'] })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { header: ['x-project'] })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { header: ['LIST-ID'] })).to.deep.equal([e2.id]);
            expect(await idsOf(ctx, { header: ['X-Missing'] })).to.deep.equal([]);
        });

        scenario('EQRY-059', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [
                { raw: rawMessage({ headers: ['X-Project: Apollo Mission'] }) },
                { raw: rawMessage({ headers: ['X-Project: Gemini'] }) },
                { raw: rawMessage({ headers: ['X-Project: one', 'X-Project: two'] }) }
            ]);
            expect(await idsOf(ctx, { header: ['X-Project', 'apollo'] })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { header: ['x-project', 'GEMINI'] })).to.deep.equal([e2.id]);
            expect(await idsOf(ctx, { header: ['X-Project', 'two'] })).to.deep.equal([e3.id]);
            expect(await idsOf(ctx, { header: ['X-Project', 'saturn'] })).to.deep.equal([]);
        });

        scenario('EQRY-060', async () => {
            const ctx = await setup();
            const [e1, e3] = await append(ctx, [
                { raw: rawMessage({ messageId: '<foo@example.com>', headers: ['In-Reply-To: <bar@example.com>'] }) },
                { raw: rawMessage({ headers: ['X-Arbitrary-Thing: zebra'] }) }
            ]);
            await seed.deliver(ctx.user.address, rawMessage({ subject: 'delivered' }));
            const db = await seed.db();
            const delivered = await clock.waitFor(() =>
                db.collection('messages').findOne({ user: new seed.ObjectId(ctx.user.id), subject: 'delivered' }, { projection: { root: true } })
            );
            const e2 = { id: `M${delivered.root}` };

            const cases = [
                [['Message-ID', 'foo@example.com'], e1],
                [['In-Reply-To', 'bar@example.com'], e1],
                [['Delivered-To'], e2],
                [['X-Arbitrary-Thing', 'zebra'], e3]
            ];
            for (const [header, entry] of cases) {
                expect(await idsOf(ctx, { header }), header.join(':')).to.deep.equal([entry.id]);
                expect(await idsOf(ctx, { header, inMailbox: ctx.mailbox('INBOX') }), header.join(':')).to.deep.equal([entry.id]);
            }
        });

        scenario('EQRY-061', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [
                { raw: rawMessage({ headers: ['X-Note:   säge   '] }) },
                { raw: rawMessage({ headers: [`X-Note: =?UTF-8?Q?s=C3=A4ge?=`] }) },
                { raw: rawMessage({ headers: ['X-Note: something else'] }) }
            ]);
            expect(await idsOf(ctx, { header: ['X-Note', 'säge'] })).to.have.members(ids(entries.slice(0, 2)));
        });

        scenario('EQRY-062', async () => {
            const ctx = await setup();
            for (const header of [[], ['X-A', 'b', 'c'], 'X-A', [1], [''], ['Bad Name:']]) {
                expect(await errorOf(ctx, { filter: { header } }), JSON.stringify(header)).to.equal('invalidArguments');
            }
        });
    });

    describe('text and body filters', () => {
        scenario('EQRY-063', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [
                { raw: rawMessage({ from: 'Zanzibar Traveller <traveller@example.com>', body: 'neutral' }) },
                { raw: rawMessage({ to: 'zanzibar@example.com', body: 'neutral' }) },
                { raw: rawMessage({ cc: 'Zanzibar Office <office@example.com>', body: 'neutral' }) },
                { raw: rawMessage({ bcc: 'zanzibar@example.org', body: 'neutral' }) },
                { raw: rawMessage({ subject: 'Trip to Zanzibar', body: 'neutral' }) },
                { raw: rawMessage({ body: 'neutral' }) }
            ]);
            expect(await idsOf(ctx, { text: 'zanzibar' })).to.have.members(ids(entries.slice(0, 5)));
        });

        scenario('EQRY-064', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [bodyOnly('kumquat is the first word'), bodyOnly(`${'filler text '.repeat(350)}\npersimmon`)]);
            expect(await idsOf(ctx, { text: 'kumquat' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'persimmon' })).to.deep.equal([]);
            expect(await idsOf(ctx, { body: 'persimmon' })).to.deep.equal([]);
        });

        scenario('EQRY-066', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [
                { raw: rawMessage({ subject: 'mango', body: 'nothing here' }) },
                { raw: rawMessage({ subject: 'weekly', body: 'ripe mango season' }) }
            ]);
            expect(await idsOf(ctx, { body: 'mango' })).to.deep.equal([e2.id]);
            expect(await idsOf(ctx, { subject: 'mango' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'mango' })).to.have.members([e1.id, e2.id]);
        });

        scenario('EQRY-067', async () => {
            const ctx = await setup();
            const html =
                '<html><head><title>Page title</title><style>.stylesheetword { color: red }</style><script>var scriptword = 1;</script></head>' +
                '<body><div class="markupclass">Fresh papaya today</div><img src="https://example.com/x.png" alt="guavaalt"></body></html>';
            const [e1] = await append(ctx, [{ raw: rawMessage({ subject: 'html only', contentType: 'text/html; charset=utf-8', body: html }) }]);
            expect(await idsOf(ctx, { text: 'papaya' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { body: 'papaya' })).to.deep.equal([e1.id]);
            for (const text of ['div', 'markupclass', 'stylesheetword', 'scriptword']) {
                expect(await idsOf(ctx, { text }), text).to.deep.equal([]);
            }
            // matching alt text is optional, either answer is conformant
            expect(await errorOf(ctx, { filter: { text: 'guavaalt' } })).to.equal(null);
        });

        scenario('EQRY-068', async () => {
            const ctx = await setup();
            const [e1, e2] = await append(ctx, [
                { message: { subject: 'alternative', text: 'plainonly tangerine', html: '<p>htmlonly tangerine</p>' } },
                {
                    message: {
                        subject: 'mixed',
                        text: 'nectarine',
                        attachments: [{ filename: 'fruit.pdf', content: Buffer.from('%PDF-1.4 fruit'), contentType: 'application/pdf' }]
                    }
                }
            ]);
            expect(await idsOf(ctx, { text: 'tangerine' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'plainonly' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'nectarine' })).to.deep.equal([e2.id]);
        });

        scenario('EQRY-069', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [
                {
                    message: {
                        subject: 'link',
                        text: 'see <https://needle.example.com/page>',
                        html: '<p>see <a href="https://needle.example.com/page">this page</a></p>'
                    }
                }
            ]);
            expect(await idsOf(ctx, { body: 'needle.example.com' })).to.deep.equal([e1.id]);
        });

        scenario('EQRY-070', async () => {
            const ctx = await setup();
            await append(ctx, [
                {
                    message: {
                        subject: 'binary',
                        text: 'see attached',
                        attachments: [{ filename: 'blob.bin', content: Buffer.from('xx durian xx'), contentType: 'application/octet-stream' }]
                    }
                },
                {
                    message: {
                        subject: 'text attachment',
                        text: 'see attached',
                        attachments: [{ filename: 'notes.txt', content: 'durian notes', contentType: 'text/plain', contentDisposition: 'attachment' }]
                    }
                }
            ]);
            const base64 = Buffer.from('xx durian xx').toString('base64');
            expect(await idsOf(ctx, { text: 'durian' })).to.deep.equal([]);
            expect(await idsOf(ctx, { body: 'durian' })).to.deep.equal([]);
            expect(await idsOf(ctx, { text: base64 })).to.deep.equal([]);
        });

        scenario('EQRY-071', async () => {
            const ctx = await setup();
            await append(ctx, [
                {
                    message: {
                        subject: 'report',
                        text: 'see attached',
                        attachments: [{ filename: 'rambutan-report.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }]
                    }
                }
            ]);
            expect(await idsOf(ctx, { text: 'rambutan' })).to.deep.equal([]);
        });

        scenario('EQRY-072', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [
                { raw: rawMessage({ subject: 'invoice', body: 'for october' }) },
                { raw: rawMessage({ subject: 'invoice', body: 'for november' }) },
                { raw: rawMessage({ subject: 'october news', body: 'neutral' }) }
            ]);
            expect(await idsOf(ctx, { text: 'invoice october' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'october   invoice' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'invoice december' })).to.deep.equal([]);
        });

        scenario('EQRY-073', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [bodyOnly('your country needs you'), bodyOnly('the country is your home')]);
            expect(await idsOf(ctx, { text: '"your country"' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: "'your country'" })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: '"your country" home' })).to.deep.equal([]);
        });

        scenario('EQRY-074', async () => {
            const ctx = await setup();
            const [e1, e2, e3] = await append(ctx, [bodyOnly('the bus is late'), bodyOnly('two buses arrived'), bodyOnly('good business')]);
            const res = await idsOf(ctx, { body: 'bus' });
            expect(res).to.include(e1.id);
            expect(res).to.not.include(e3.id);
            // pinned: MongoDB phrase matching does not stem a plural here
            expect(res).to.not.include(e2.id);
        });

        scenario('EQRY-075', async () => {
            const ctx = await setup();
            const japanese = '日本語の件名';
            // the subject above in ISO-2022-JP
            const iso2022 = '=?ISO-2022-JP?B?GyRCRnxLXDhsJE43b0w+GyhC?=';
            const [e1, e2] = await append(ctx, [
                { message: { subject: '孫子兵法 notes', text: 'привет мир' } },
                { raw: rawMessage({ subject: iso2022, body: 'neutral' }) }
            ]);
            const got = await emails(ctx, [e2.id], ['subject']);
            expect(got[e2.id].subject).to.equal(japanese);
            expect(await idsOf(ctx, { subject: '孫子兵法' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'привет' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { text: 'ПРИВЕТ' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { subject: japanese })).to.deep.equal([e2.id]);
        });

        scenario('EQRY-076', async () => {
            const ctx = await setup();
            const [e1] = await append(ctx, [bodyOnly('total 1,234.56 EUR'), bodyOnly('total 999 EUR')]);
            expect(await idsOf(ctx, { body: '1,234.56' })).to.deep.equal([e1.id]);
            expect(await idsOf(ctx, { body: ' 1,234.56 ' })).to.deep.equal([e1.id]);
        });

        scenario('EQRY-077', async () => {
            const ctx = await setup();
            const entries = await append(ctx, [{}, {}]);
            for (const filter of [{ text: '' }, { subject: '   ' }, { from: '' }]) {
                expect(await idsOf(ctx, filter), JSON.stringify(filter)).to.have.members(ids(entries));
            }
            expect(await errorOf(ctx, { filter: { text: 5 } })).to.equal('invalidArguments');
        });

        scenario('EQRY-078', async () => {
            const ctx = await setup();
            const before = await query(ctx, { filter: { text: 'pomelo' } });
            expect(before.ids).to.deep.equal([]);
            await seed.deliver(ctx.user.address, rawMessage({ subject: 'pomelo harvest' }));
            const after = await query(ctx, { filter: { text: 'pomelo' } });
            expect(after.ids).to.have.lengthOf(1);
            expect(after.queryState).to.not.equal(before.queryState);
        });

        scenario('EQRY-079', async () => {
            // the fixture holds the private key first, then the public key
            const keys = fixtures.readFixture('User 2 (F8BFEF95).asc').toString();
            const pubKey = keys.slice(keys.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----'));
            const ctx = await setup([], { pubKey, encryptMessages: true });
            await seed.deliver(ctx.user.address, rawMessage({ subject: 'sealed envelope', body: 'the starfruit is ripe' }));
            const db = await seed.db();
            const doc = await clock.waitFor(() =>
                db.collection('messages').findOne({ user: new seed.ObjectId(ctx.user.id) }, { projection: { root: true, text: true } })
            );
            // stored encrypted, the plain body is not readable in the database
            expect(doc.text || '').to.not.include('starfruit');
            const id = `M${doc.root}`;
            expect(await idsOf(ctx, { subject: 'sealed' })).to.deep.equal([id]);
            expect(await idsOf(ctx, { text: 'sealed' })).to.deep.equal([id]);
            expect(await idsOf(ctx, { body: 'starfruit' })).to.deep.equal([]);
        });
    });
});
