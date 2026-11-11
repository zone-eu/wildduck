/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-get.yaml: the headers property, header:{name} forms and the convenience
// properties (EGET-043 to EGET-103).

const punycode = require('punycode.js');
const { expect } = require('chai');
const { scenario, seed, clock } = require('../harness');
const { newUser, append, get, getOne, expectInvalid, imapFor, message, raw } = require('./email-get-helpers');

const BASE = ['From: Sender <sender@example.net>', 'To: Recipient <recipient@example.com>'];

describe('Email/get header forms (email-get.yaml)', () => {
    let ctx;
    // one message carrying most headers the form validation scenarios ask for
    let fullId;

    // appends a message with the given header lines and answers the Email for the properties
    const headersOf = async (headers, properties, body = 'Body text') => {
        const { id } = await append(ctx.user, message(headers, body));
        return getOne(ctx.client, id, { properties });
    };

    before(async () => {
        ctx = await newUser();
        fullId = (
            await append(
                ctx.user,
                message([
                    'Return-Path: <bounce@example.net>',
                    'Received: from mx.example.net by mx.example.com; Thu, 22 Aug 2019 23:12:06 -0600',
                    'From: Sender <sender@example.net>',
                    'Sender: sender@example.net',
                    'Reply-To: reply@example.net',
                    'To: Recipient <recipient@example.com>',
                    'Cc: cc@example.com',
                    'Bcc: bcc@example.com',
                    'Resent-From: resent@example.net',
                    'Resent-To: resent-to@example.com',
                    'Resent-Date: Fri, 23 Aug 2019 10:00:00 +0000',
                    'Resent-Message-ID: <resent@example.net>',
                    'Subject: Full header set',
                    'Comments: a comment',
                    'Keywords: one, two',
                    'Date: Thu, 22 Aug 2019 23:12:06 -0600',
                    'Message-ID: <full@example.net>',
                    'In-Reply-To: <parent@example.net>',
                    'References: <root@example.net> <parent@example.net>',
                    'List-Id: Example list <list.example.net>',
                    'List-Help: <https://example.net/help>',
                    'List-Unsubscribe: <https://example.net/unsub>',
                    'List-Subscribe: <https://example.net/sub>',
                    'List-Post: <mailto:list@example.net>',
                    'List-Owner: <mailto:owner@example.net>',
                    'List-Archive: <https://example.net/archive>',
                    'X-Tra: extra'
                ])
            )
        ).id;
    });

    scenario('EGET-043', async () => {
        const email = await headersOf(
            [
                'Received: from a by b; Thu, 22 Aug 2019 23:12:06 -0600',
                'Received: from c by d; Thu, 22 Aug 2019 23:12:05 -0600',
                'From: Sender <sender@example.net>',
                'To: Recipient <recipient@example.com>',
                'SUBJECT: Upper case name',
                'X-Custom: custom value',
                'Date: Thu, 22 Aug 2019 23:12:06 -0600',
                'Message-ID: <order@example.net>'
            ],
            ['headers']
        );
        expect(email.headers.map(header => header.name)).to.deep.equal(['Received', 'Received', 'From', 'To', 'SUBJECT', 'X-Custom', 'Date', 'Message-ID']);
        expect(email.headers[4].value).to.equal(' Upper case name');
        expect(email.headers[0].value).to.equal(' from a by b; Thu, 22 Aug 2019 23:12:06 -0600');
        expect(email.headers[1].value).to.equal(' from c by d; Thu, 22 Aug 2019 23:12:05 -0600');
        for (const header of email.headers) {
            expect(header.value.startsWith(' ')).to.be.true;
            expect(header.value).to.not.match(/\r?\n$/);
        }
    });

    scenario('EGET-044', async () => {
        const email = await headersOf([...BASE, 'Subject:  Hello  World ', 'X-Tight:nospace'], ['header:Subject', 'header:Subject:asRaw', 'header:X-Tight']);
        expect(email['header:Subject']).to.equal('  Hello  World ');
        expect(email['header:Subject:asRaw']).to.equal('  Hello  World ');
        expect(email['header:X-Tight']).to.equal('nospace');
    });

    scenario('EGET-045', async () => {
        const email = await headersOf([...BASE, 'X-Long: part one\r\n part two\r\n\tpart three'], ['header:X-Long', 'headers']);
        expect(email['header:X-Long']).to.equal(' part one\r\n part two\r\n\tpart three');
        expect(email.headers.find(header => header.name === 'X-Long').value).to.equal(' part one\r\n part two\r\n\tpart three');
    });

    scenario('EGET-046', async () => {
        const email = await headersOf([...BASE, 'X-Custom-Header: v'], ['header:x-custom-header', 'header:X-CUSTOM-HEADER', 'header:X-Custom-Header:asText']);
        expect(email).to.deep.equal({
            id: email.id,
            'header:x-custom-header': ' v',
            'header:X-CUSTOM-HEADER': ' v',
            'header:X-Custom-Header:asText': 'v'
        });
    });

    scenario('EGET-047', async () => {
        const email = await getOne(ctx.client, fullId, {
            properties: ['header:X-Missing', 'header:X-Missing:asText', 'header:X-Missing:all', 'header:X-Missing:asAddresses:all']
        });
        expect(email['header:X-Missing']).to.be.null;
        expect(email['header:X-Missing:asText']).to.be.null;
        expect(email['header:X-Missing:all']).to.deep.equal([]);
        expect(email['header:X-Missing:asAddresses:all']).to.deep.equal([]);
    });

    scenario('EGET-048', async () => {
        const email = await headersOf([...BASE, 'X-Tra: foo', 'Subject: between', 'X-Tra: bar'], ['header:X-Tra', 'header:X-Tra:asText']);
        expect(email['header:X-Tra']).to.equal(' bar');
        expect(email['header:X-Tra:asText']).to.equal('bar');
    });

    scenario('EGET-049', async () => {
        const email = await headersOf(
            [...BASE, 'X-Tra: foo', 'X-Tra: bar', 'X-One: 1'],
            ['header:X-Tra:all', 'header:X-Tra:asRaw:all', 'header:X-Tra:asText:all', 'header:X-One:all', 'header:X-Tra']
        );
        expect(email['header:X-Tra:all']).to.deep.equal([' foo', ' bar']);
        expect(email['header:X-Tra:asRaw:all']).to.deep.equal([' foo', ' bar']);
        expect(email['header:X-Tra:asText:all']).to.deep.equal(['foo', 'bar']);
        expect(email['header:X-One:all']).to.deep.equal([' 1']);
        expect(email['header:X-Tra:all'][1]).to.equal(email['header:X-Tra']);
    });

    scenario('EGET-050', async () => {
        await expectInvalid(ctx.client, { ids: [fullId], properties: ['header:X-Tra:all:asText'] });
    });

    scenario('EGET-051', async () => {
        for (const property of [
            'header:',
            'header:From:Subject',
            'header:X-A:asFoo',
            'header:X-A:astext',
            'header:X A',
            'header:X-A:asText:all:all',
            'Header:Subject'
        ]) {
            const err = await expectInvalid(ctx.client, { ids: [fullId], properties: [property] }, property);
            expect(err.response.description, property).to.include(property);
        }
    });

    scenario('EGET-052', async () => {
        const email = await headersOf(
            [
                'From: Sender <sender@example.net>',
                'To: Recipient <recipient@example.com>',
                'Subject: Several forms',
                'Date: Thu, 22 Aug 2019 23:12:06 -0600',
                'Message-ID: <forms@example.net>',
                'List-Unsubscribe: <https://example.net/unsub>',
                'X-Custom: one',
                'X-Custom: two'
            ],
            [
                'header:Subject',
                'header:Subject:asText',
                'header:From:asAddresses',
                'header:From:asGroupedAddresses',
                'header:Date:asDate',
                'header:Message-ID:asMessageIds',
                'header:List-Unsubscribe:asURLs',
                'header:X-Custom:asText:all'
            ]
        );
        expect(email['header:Subject']).to.equal(' Several forms');
        expect(email['header:Subject:asText']).to.equal('Several forms');
        expect(email['header:From:asAddresses']).to.deep.equal([{ name: 'Sender', email: 'sender@example.net' }]);
        expect(email['header:From:asGroupedAddresses']).to.deep.equal([{ name: null, addresses: [{ name: 'Sender', email: 'sender@example.net' }] }]);
        expect(new Date(email['header:Date:asDate']).toISOString()).to.equal('2019-08-23T05:12:06.000Z');
        expect(email['header:Message-ID:asMessageIds']).to.deep.equal(['forms@example.net']);
        expect(email['header:List-Unsubscribe:asURLs']).to.deep.equal(['https://example.net/unsub']);
        expect(email['header:X-Custom:asText:all']).to.deep.equal(['one', 'two']);
    });

    scenario('EGET-053', async () => {
        const email = await headersOf(
            [...BASE, 'Subject:   A folded\r\n subject =?UTF-8?Q?caf=C3=A9?=', 'X-Spam-Hits: SPAMA, SPAMB, SPAMC'],
            ['header:Subject:asText', 'header:X-Spam-Hits:asRaw', 'header:X-Spam-Hits:asText']
        );
        expect(email['header:Subject:asText']).to.equal('A folded subject café');
        expect(email['header:X-Spam-Hits:asRaw']).to.equal(' SPAMA, SPAMB, SPAMC');
        expect(email['header:X-Spam-Hits:asText']).to.equal('SPAMA, SPAMB, SPAMC');
    });

    scenario('EGET-054', async () => {
        const email = await headersOf(
            [
                ...BASE,
                'Subject: the\r\n subject',
                'Comments: a\r\n comment',
                'Keywords: k1,\r\n k2',
                'List-Id: Example <list.example.net>',
                'X-Mood:  happy',
                'Content-Type: text/plain;\r\n charset=utf-8',
                'Content-Transfer-Encoding: 7bit'
            ],
            [
                'header:Subject:asText',
                'header:Comments:asText',
                'header:Keywords:asText',
                'header:List-Id:asText',
                'header:X-Mood:asText',
                'header:Content-Type:asText',
                'header:Content-Transfer-Encoding:asText'
            ]
        );
        expect(email['header:Subject:asText']).to.equal('the subject');
        expect(email['header:Comments:asText']).to.equal('a comment');
        expect(email['header:Keywords:asText']).to.equal('k1, k2');
        expect(email['header:List-Id:asText']).to.equal('Example <list.example.net>');
        expect(email['header:X-Mood:asText']).to.equal('happy');
        expect(email['header:Content-Type:asText']).to.equal('text/plain; charset=utf-8');
        expect(email['header:Content-Transfer-Encoding:asText']).to.equal('7bit');
    });

    scenario('EGET-055', async () => {
        const names = ['From', 'To', 'Date', 'Message-ID', 'References', 'Received', 'Return-Path', 'Resent-To', 'List-Unsubscribe'];
        for (const name of names) {
            await expectInvalid(ctx.client, { ids: [fullId], properties: [`header:${name}:asText`] }, name);
            await expectInvalid(ctx.client, { ids: [fullId], properties: [`header:${name}:asText:all`] }, `${name} all`);
        }
        // the same on a message that lacks the headers
        const { id } = await append(ctx.user, raw('X-Only: 1', '', 'body'));
        for (const name of names) {
            await expectInvalid(ctx.client, { ids: [id], properties: [`header:${name}:asText`] }, name);
        }
    });

    scenario('EGET-056', async () => {
        const decomposed = 'Café';
        const email = await headersOf(
            [`From: a@example.com`, `To: ${decomposed} <to@example.com>`, `X-My-Header: ${decomposed}`].map(line =>
                Buffer.from(line, 'utf8').toString('binary')
            ),
            ['header:X-My-Header', 'header:X-My-Header:asText', 'header:to', 'to']
        );
        expect(email['header:X-My-Header:asText']).to.equal('Café');
        expect(email.to[0].name).to.equal('Café');
        expect(email['header:X-My-Header']).to.equal(` ${decomposed}`);
        expect(email['header:to']).to.include(decomposed);
    });
});

describe('Email/get address forms (email-get.yaml)', () => {
    let ctx;

    const headersOf = async (headers, properties) => {
        const { id } = await append(ctx.user, message(headers));
        return getOne(ctx.client, id, { properties });
    };

    before(async () => {
        ctx = await newUser();
    });

    const RFC_GROUP = 'To: "  James Smythe" <james@example.com>, Friends:\r\n jane@example.com, =?UTF-8?Q?John_Sm=C3=AEth?= <john@example.com>;';

    scenario('EGET-057', async () => {
        const email = await headersOf(
            ['From: a@example.com', 'To: Alice Example <alice@example.com>, bob@example.com, "Carol, C." <carol@example.com>'],
            ['header:To:asAddresses']
        );
        expect(email['header:To:asAddresses']).to.deep.equal([
            { name: 'Alice Example', email: 'alice@example.com' },
            { name: null, email: 'bob@example.com' },
            { name: 'Carol, C.', email: 'carol@example.com' }
        ]);
        for (const entry of email['header:To:asAddresses']) {
            expect(Object.keys(entry)).to.have.members(['name', 'email']);
        }
    });

    scenario('EGET-058', async () => {
        const email = await headersOf(['From: "  James \\"Jim\\" Smythe\\\\"\r\n <james@example.com>', 'To: b@example.com'], ['header:From:asAddresses']);
        expect(email['header:From:asAddresses']).to.deep.equal([{ name: 'James "Jim" Smythe\\', email: 'james@example.com' }]);
    });

    scenario('EGET-059', async () => {
        const email = await headersOf(['From: jane@example.com (Jane Doe)', 'To: Real Name <x@example.com> (ignored comment)'], ['from', 'to']);
        expect(email.from).to.deep.equal([{ name: 'Jane Doe', email: 'jane@example.com' }]);
        expect(email.to).to.deep.equal([{ name: 'Real Name', email: 'x@example.com' }]);
    });

    scenario('EGET-060', async () => {
        const email = await headersOf(['From: a@example.com', RFC_GROUP], ['header:To:asAddresses', 'to']);
        const expected = [
            { name: 'James Smythe', email: 'james@example.com' },
            { name: null, email: 'jane@example.com' },
            { name: 'John Smîth', email: 'john@example.com' }
        ];
        expect(email['header:To:asAddresses']).to.deep.equal(expected);
        expect(email.to).to.deep.equal(expected);
    });

    scenario('EGET-061', async () => {
        const names = [
            'From',
            'Sender',
            'Reply-To',
            'To',
            'Cc',
            'Bcc',
            'Resent-From',
            'Resent-Sender',
            'Resent-Reply-To',
            'Resent-To',
            'Resent-Cc',
            'Resent-Bcc',
            'X-Original-To'
        ];
        const email = await headersOf(
            names.map((name, i) => `${name}: user${i}@example.com`),
            names.flatMap(name => [`header:${name}:asAddresses`, `header:${name}:asGroupedAddresses`])
        );
        names.forEach((name, i) => {
            const address = { name: null, email: `user${i}@example.com` };
            expect(email[`header:${name}:asAddresses`], name).to.deep.equal([address]);
            expect(email[`header:${name}:asGroupedAddresses`], name).to.deep.equal([{ name: null, addresses: [address] }]);
        });
    });

    scenario('EGET-062', async () => {
        const { id } = await append(
            ctx.user,
            message([
                'From: a@example.com',
                'Subject: s',
                'Date: Thu, 22 Aug 2019 23:12:06 -0600',
                'Message-ID: <m@example.com>',
                'In-Reply-To: <p@example.com>',
                'References: <p@example.com>',
                'Received: from a by b; Thu, 22 Aug 2019 23:12:06 -0600',
                'Comments: c',
                'Keywords: k',
                'List-Post: <mailto:list@example.com>',
                'List-Id: <list.example.com>'
            ])
        );
        for (const name of ['Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'Received', 'Comments', 'Keywords', 'List-Post', 'List-Id']) {
            for (const form of ['asAddresses', 'asGroupedAddresses']) {
                await expectInvalid(ctx.client, { ids: [id], properties: [`header:${name}:${form}`] }, `${name} ${form}`);
            }
        }
    });

    scenario('EGET-063', async () => {
        const email = await headersOf(
            ['From: a@example.com', 'Resent-To: a1@example.com, a2@example.com', 'Resent-To: a3@example.com'],
            ['header:Resent-To:asAddresses:all', 'header:Resent-To:asAddresses']
        );
        const a = n => ({ name: null, email: `a${n}@example.com` });
        expect(email['header:Resent-To:asAddresses:all']).to.deep.equal([[a(1), a(2)], [a(3)]]);
        expect(email['header:Resent-To:asAddresses']).to.deep.equal([a(3)]);
    });

    scenario('EGET-064', async () => {
        const values = ['To: blahblah', 'To: <>', 'To: ,, ,', 'To:', 'To: Name Only <', 'To: user@', 'To: a@example.com, broken <, b@example.com'];
        for (const line of values) {
            const email = await headersOf(['From: a@example.com', line], ['header:To:asAddresses', 'header:To:asGroupedAddresses', 'to']);
            for (const property of ['header:To:asAddresses', 'to']) {
                expect(email[property], `${line} ${property}`).to.be.an('array');
                for (const entry of email[property]) {
                    expect(entry.email, line).to.be.a('string');
                    expect(entry.name === null || typeof entry.name === 'string', line).to.be.true;
                }
            }
            expect(email['header:To:asGroupedAddresses'], line).to.be.an('array');
            if (['To: ,, ,', 'To:'].includes(line)) {
                expect(email.to, line).to.deep.equal([]);
                expect(email['header:To:asGroupedAddresses'], line).to.deep.equal([]);
            }
            if (line.startsWith('To: a@example.com')) {
                expect(email.to.map(entry => entry.email)).to.include.members(['a@example.com', 'b@example.com']);
            }
        }
    });

    scenario('EGET-065', async () => {
        const email = await headersOf(['From: a@example.com', RFC_GROUP], ['header:To:asGroupedAddresses']);
        expect(email['header:To:asGroupedAddresses']).to.deep.equal([
            { name: null, addresses: [{ name: 'James Smythe', email: 'james@example.com' }] },
            {
                name: 'Friends',
                addresses: [
                    { name: null, email: 'jane@example.com' },
                    { name: 'John Smîth', email: 'john@example.com' }
                ]
            }
        ]);
    });

    scenario('EGET-066', async () => {
        const email = await headersOf(['From: A <a@example.com>, b@example.com'], ['header:From:asGroupedAddresses']);
        expect(email['header:From:asGroupedAddresses']).to.deep.equal([
            {
                name: null,
                addresses: [
                    { name: 'A', email: 'a@example.com' },
                    { name: null, email: 'b@example.com' }
                ]
            }
        ]);
    });

    scenario('EGET-067', async () => {
        const email = await headersOf(
            ['From: x@example.com', 'To: a@example.com, G1: b@example.com;, c@example.com, d@example.com, G2: e@example.com;'],
            ['header:To:asGroupedAddresses']
        );
        const a = letter => ({ name: null, email: `${letter}@example.com` });
        expect(email['header:To:asGroupedAddresses']).to.deep.equal([
            { name: null, addresses: [a('a')] },
            { name: 'G1', addresses: [a('b')] },
            { name: null, addresses: [a('c'), a('d')] },
            { name: 'G2', addresses: [a('e')] }
        ]);
    });

    scenario('EGET-068', async () => {
        const email = await headersOf(['From: x@example.com', 'To: undisclosed-recipients:;'], ['header:To:asGroupedAddresses', 'header:To:asAddresses', 'to']);
        expect(email['header:To:asGroupedAddresses']).to.deep.equal([{ name: 'undisclosed-recipients', addresses: [] }]);
        expect(email['header:To:asAddresses']).to.deep.equal([]);
        expect(email.to).to.deep.equal([]);
    });

    scenario('EGET-069', async () => {
        const email = await headersOf(
            ['From: x@example.com', 'X-To: =?UTF-8?B?R3LDvHBwZQ==?=: ann@example.com;, "  Team A ": tom@example.com;'],
            ['header:X-To:asGroupedAddresses']
        );
        const groups = email['header:X-To:asGroupedAddresses'];
        expect(groups.map(group => group.name)).to.deep.equal(['Grüppe', 'Team A']);
        expect(groups[0].addresses).to.deep.equal([{ name: null, email: 'ann@example.com' }]);
    });

    scenario('EGET-083', async () => {
        const names = { from: 'From', to: 'To', cc: 'Cc', bcc: 'Bcc', sender: 'Sender', replyTo: 'Reply-To' };
        const email = await headersOf(
            [
                'From: Sender Name <sender@example.net>',
                'Sender: sender@example.net',
                'Reply-To: Replies <reply@example.net>',
                'To: First <first@example.com>, second@example.com',
                'Cc: Copy <cc@example.com>',
                'Bcc: Blind <bcc@example.com>',
                'Subject: convenience'
            ],
            [...Object.keys(names), ...Object.values(names).map(name => `header:${name}:asAddresses`)]
        );
        for (const [property, name] of Object.entries(names)) {
            expect(email[property], property).to.deep.equal(email[`header:${name}:asAddresses`]);
        }
        expect(email.sender).to.deep.equal([{ name: null, email: 'sender@example.net' }]);
        expect(email.to.map(entry => entry.email)).to.deep.equal(['first@example.com', 'second@example.com']);
        expect(email.bcc).to.deep.equal([{ name: 'Blind', email: 'bcc@example.com' }]);
    });

    scenario('EGET-098', async () => {
        const to = [
            'To: "Folded\r\n Name" <a1@example.com>, a2@example.com,',
            ' Person Three\r\n <a3@example.com>, a4@example.com,',
            ' a5@example.com, "Six" <a6@example.com>,',
            '\ta7@example.com, a8@example.com,',
            ' a9@example.com, Ten <a10@example.com>'
        ].join('\r\n');
        const email = await headersOf(['From: x@example.com', to, 'Subject: one\r\n\ttwo\r\n\tthree\r\n\tfour'], ['to', 'subject']);
        expect(email.to).to.have.length(10);
        email.to.forEach((entry, i) => {
            expect(entry.email).to.equal(`a${i + 1}@example.com`);
            if (entry.name) {
                expect(entry.name).to.not.match(/[\r\n\t]/);
            }
        });
        expect(email.to[0].name).to.equal('Folded Name');
        expect(email.to[2].name).to.equal('Person Three');
        expect(email.subject).to.equal('one\ttwo\tthree\tfour');
    });

    scenario('EGET-099', async () => {
        const refs = Array.from({ length: 500 }, (entry, i) => `<reference-${i}-${'x'.repeat(20)}@example.com>`);
        const references = 'References: ' + refs.join('\r\n ');
        const to = 'To: ' + Array.from({ length: 400 }, (entry, i) => `user${i}@example.com`).join(',\r\n ');
        const long = 'L'.repeat(5000);
        const { id } = await append(ctx.user, message(['From: x@example.com', to, references, `X-Long: ${long}`, 'Subject: long headers']));
        const email = await getOne(ctx.client, id, { properties: ['references', 'to', 'header:X-Long', 'header:X-Long:asText', 'headers'] });
        expect(email.references).to.have.length(500);
        expect(email.references[499]).to.equal(refs[499].slice(1, -1));
        expect(email.to).to.have.length(400);
        expect(email['header:X-Long']).to.have.length(5001);
        expect(email['header:X-Long:asText']).to.equal(long);
    });

    scenario('EGET-100', async () => {
        const email = await headersOf(
            [
                'From: x@example.com',
                'To: <@relay1.example,@relay2.example:user@example.com>',
                'Cc: John Q. Public <jqp@example.com>',
                'Bcc: "quoted local"@example.com',
                'Reply-To: Mary Smith <mary@example.com> , , jdoe@example.org'
            ],
            ['to', 'cc', 'bcc', 'replyTo']
        );
        expect(email.to).to.deep.equal([{ name: null, email: 'user@example.com' }]);
        expect(email.cc).to.deep.equal([{ name: 'John Q. Public', email: 'jqp@example.com' }]);
        expect(email.bcc).to.have.length(1);
        expect(email.bcc[0].email).to.equal('"quoted local"@example.com');
        expect(email.replyTo).to.deep.equal([
            { name: 'Mary Smith', email: 'mary@example.com' },
            { name: null, email: 'jdoe@example.org' }
        ]);
    });

    scenario('EGET-101', async () => {
        const headers = ['From: J. Besteiro <jb@julián.example.com>', 'To: x@xn--julin-0qa.example.com', 'Subject: idn'].map(line =>
            Buffer.from(line, 'utf8').toString('binary')
        );
        const { id, uid } = await append(ctx.user, message(headers));
        const email = await getOne(ctx.client, id, { properties: ['from', 'to'] });
        expect(email.from[0].email).to.equal('jb@julián.example.com');
        expect(email.to[0].email).to.equal('x@xn--julin-0qa.example.com');
        const imap = await imapFor(ctx.user);
        await imap.mailboxOpen('INBOX');
        const fetched = await imap.fetchOne(String(uid), { envelope: true }, { uid: true });
        // IMAP sends domains as A-labels to clients without UTF8=ACCEPT, compare in that form
        const aLabel = address => address.replace(/@(.*)$/, (match, domain) => '@' + punycode.toASCII(domain));
        expect(aLabel(fetched.envelope.from[0].address)).to.equal(aLabel(email.from[0].email));
        expect(aLabel(fetched.envelope.to[0].address)).to.equal(aLabel(email.to[0].email));
    });
});

describe('Email/get message id, date and URL forms (email-get.yaml)', () => {
    let ctx;

    const headersOf = async (headers, properties) => {
        const { id } = await append(ctx.user, message(headers));
        return getOne(ctx.client, id, { properties });
    };

    before(async () => {
        ctx = await newUser();
    });

    scenario('EGET-070', async () => {
        const email = await headersOf(
            [
                'From: x@example.com',
                'Message-ID: <id1@example.com>',
                'In-Reply-To: <parent@example.com>',
                'References: <root@example.com> <parent@example.com>'
            ],
            ['header:Message-ID:asMessageIds', 'header:In-Reply-To:asMessageIds', 'header:References:asMessageIds', 'header:references']
        );
        expect(email['header:Message-ID:asMessageIds']).to.deep.equal(['id1@example.com']);
        expect(email['header:In-Reply-To:asMessageIds']).to.deep.equal(['parent@example.com']);
        expect(email['header:References:asMessageIds']).to.deep.equal(['root@example.com', 'parent@example.com']);
        expect(email['header:references']).to.equal(' <root@example.com> <parent@example.com>');
    });

    scenario('EGET-071', async () => {
        const email = await headersOf(
            [
                'From: x@example.com',
                'X-Refs: <a@example.com> (comment) <b@example.com>',
                'References: <r1@example.com>\r\n <r2@example.com>  \r\n   <r3@example.com>'
            ],
            ['header:X-Refs:asMessageIds', 'references']
        );
        expect(email['header:X-Refs:asMessageIds']).to.deep.equal(['a@example.com', 'b@example.com']);
        expect(email.references).to.deep.equal(['r1@example.com', 'r2@example.com', 'r3@example.com']);
    });

    scenario('EGET-072', async () => {
        const email = await headersOf(
            ['From: x@example.com', 'X-Bad: not a message id', 'In-Reply-To: your mail of yesterday'],
            ['header:X-Bad:asMessageIds', 'inReplyTo', 'header:X-Bad:asMessageIds:all']
        );
        expect(email['header:X-Bad:asMessageIds']).to.be.null;
        expect(email.inReplyTo).to.be.null;
        expect(email['header:X-Bad:asMessageIds:all']).to.deep.equal([null]);
    });

    scenario('EGET-073', async () => {
        const email = await headersOf(
            ['From: x@example.com', 'References: invalid   bloblah\r\n <3456@example.net>', 'X-Bare: c@example.com'],
            ['references', 'header:X-Bare:asMessageIds']
        );
        expect(email.references).to.deep.equal(['3456@example.net']);
        expect(email['header:X-Bare:asMessageIds']).to.deep.equal(['c@example.com']);
    });

    scenario('EGET-074', async () => {
        const { id } = await append(
            ctx.user,
            message([
                'From: x@example.com',
                'To: y@example.com',
                'Subject: s',
                'Date: Thu, 22 Aug 2019 23:12:06 -0600',
                'Received: from a by b; Thu, 22 Aug 2019 23:12:06 -0600',
                'List-Unsubscribe: <https://example.com/u>',
                'Message-ID: <m@example.com>'
            ])
        );
        for (const name of ['From', 'To', 'Subject', 'Date', 'Received', 'List-Unsubscribe']) {
            await expectInvalid(ctx.client, { ids: [id], properties: [`header:${name}:asMessageIds`] }, name);
        }
        const email = await getOne(ctx.client, id, {
            properties: ['Message-ID', 'In-Reply-To', 'References', 'Resent-Message-ID', 'X-Anything'].map(name => `header:${name}:asMessageIds`)
        });
        expect(email['header:Message-ID:asMessageIds']).to.deep.equal(['m@example.com']);
        expect(email['header:X-Anything:asMessageIds']).to.be.null;
    });

    scenario('EGET-075', async () => {
        const email = await headersOf(['From: x@example.com', 'Date: Thu, 22 Aug 2019 23:12:06 -0600'], ['header:Date:asDate', 'sentAt']);
        expect(email.sentAt).to.equal(email['header:Date:asDate']);
        // the sender's offset is kept
        expect(email.sentAt).to.equal('2019-08-22T23:12:06-06:00');
        expect(new Date(email.sentAt).toISOString()).to.equal('2019-08-23T05:12:06.000Z');
    });

    scenario('EGET-076', async () => {
        for (const headers of [['Date: invalid'], ['Date: 32 Foo 2020 25:61:00 +0000'], ['Date:'], []]) {
            const email = await headersOf(['From: x@example.com', 'Subject: no usable date', ...headers], ['header:Date:asDate', 'sentAt', 'receivedAt']);
            expect(email['header:Date:asDate'], headers.join()).to.be.null;
            expect(email.sentAt, headers.join()).to.be.null;
            expect(email.receivedAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        }
    });

    scenario('EGET-077', async () => {
        const cases = [
            ['22 Aug 2019 23:12 GMT', '2019-08-22T23:12:00Z'],
            ['Thu, 22 Aug 19 23:12:06 EST', '2019-08-23T04:12:06Z'],
            ['Thu, 22 Aug 2019 23:12:06 +0200 (CEST)', '2019-08-22T21:12:06Z'],
            ['Thu,\r\n   22  Aug 2019\r\n\t23:12:06    +0000', '2019-08-22T23:12:06Z']
        ];
        for (const [value, instant] of cases) {
            const email = await headersOf(['From: x@example.com', `Date: ${value}`], ['sentAt']);
            expect(email.sentAt, value).to.be.a('string');
            expect(new Date(email.sentAt).getTime(), value).to.equal(new Date(instant).getTime());
        }
    });

    scenario('EGET-078', async () => {
        const { id } = await append(
            ctx.user,
            message([
                'From: x@example.com',
                'Subject: dates',
                'Message-ID: <d@example.com>',
                'Received: from a by b; Thu, 22 Aug 2019 23:12:06 -0600',
                'Date: Thu, 22 Aug 2019 23:12:06 -0600',
                'Resent-Date: Fri, 23 Aug 2019 10:00:00 +0000',
                'X-Tra: Thu, 22 Aug 2019 23:12:06 -0600'
            ])
        );
        const email = await getOne(ctx.client, id, { properties: ['header:Date:asDate', 'header:Resent-Date:asDate', 'header:X-Tra:asDate'] });
        expect(email['header:Date:asDate']).to.be.a('string');
        expect(new Date(email['header:Resent-Date:asDate']).toISOString()).to.equal('2019-08-23T10:00:00.000Z');
        expect(email['header:X-Tra:asDate']).to.equal(email['header:Date:asDate']);
        for (const name of ['From', 'Subject', 'Received', 'Message-ID']) {
            await expectInvalid(ctx.client, { ids: [id], properties: [`header:${name}:asDate`] }, name);
        }
    });

    scenario('EGET-079', async () => {
        const email = await headersOf(
            [
                'From: x@example.com',
                'List-Unsubscribe: <mailto:unsub@example.com?subject=unsubscribe>, <https://example.com/unsub?id=1,2>',
                'List-Help: <https://example.com/help> (Web help)'
            ],
            ['header:List-Unsubscribe:asURLs', 'header:List-Help:asURLs']
        );
        expect(email['header:List-Unsubscribe:asURLs']).to.deep.equal(['mailto:unsub@example.com?subject=unsubscribe', 'https://example.com/unsub?id=1,2']);
        expect(email['header:List-Help:asURLs']).to.deep.equal(['https://example.com/help']);
    });

    scenario('EGET-080', async () => {
        const email = await headersOf(
            ['From: x@example.com', 'List-Help: Invalid', 'List-Post: NO (posting not allowed on this list)'],
            ['header:List-Help:asURLs', 'header:List-Post:asURLs']
        );
        expect(email['header:List-Help:asURLs']).to.be.null;
        expect(email['header:List-Post:asURLs']).to.be.null;
    });

    scenario('EGET-081', async () => {
        const lists = ['List-Help', 'List-Unsubscribe', 'List-Subscribe', 'List-Post', 'List-Owner', 'List-Archive', 'X-Link'];
        const { id } = await append(
            ctx.user,
            message([
                'From: x@example.com',
                'Subject: urls',
                'Date: Thu, 22 Aug 2019 23:12:06 -0600',
                'References: <r@example.com>',
                ...lists.map(name => `${name}: <https://example.com/${name.toLowerCase()}>`)
            ])
        );
        const email = await getOne(ctx.client, id, { properties: lists.map(name => `header:${name}:asURLs`) });
        for (const name of lists) {
            expect(email[`header:${name}:asURLs`], name).to.deep.equal([`https://example.com/${name.toLowerCase()}`]);
        }
        for (const name of ['Subject', 'From', 'Date', 'References']) {
            await expectInvalid(ctx.client, { ids: [id], properties: [`header:${name}:asURLs`] }, name);
        }
    });

    scenario('EGET-082', async () => {
        const email = await headersOf(
            [
                'From: x@example.com',
                'Message-ID: <reply@example.com>',
                'In-Reply-To: <parent@example.com>',
                'References: <root@example.com> <middle@example.com> <parent@example.com>'
            ],
            ['messageId', 'inReplyTo', 'references', 'header:Message-ID:asMessageIds', 'header:In-Reply-To:asMessageIds', 'header:References:asMessageIds']
        );
        expect(email.messageId).to.deep.equal(['reply@example.com']);
        expect(email.inReplyTo).to.deep.equal(['parent@example.com']);
        expect(email.references).to.deep.equal(['root@example.com', 'middle@example.com', 'parent@example.com']);
        expect(email.messageId).to.deep.equal(email['header:Message-ID:asMessageIds']);
        expect(email.inReplyTo).to.deep.equal(email['header:In-Reply-To:asMessageIds']);
        expect(email.references).to.deep.equal(email['header:References:asMessageIds']);
    });
});

describe('Email/get convenience properties and decoding (email-get.yaml)', () => {
    let ctx;

    const headersOf = async (headers, properties, body) => {
        const { id } = await append(ctx.user, message(headers, body));
        return getOne(ctx.client, id, { properties });
    };
    // header lines given as Unicode text, stored as UTF-8 bytes
    const utf8 = lines => lines.map(line => Buffer.from(line, 'utf8').toString('binary'));

    before(async () => {
        ctx = await newUser();
    });

    scenario('EGET-084', async () => {
        const email = await headersOf(
            ['From: x@example.com', 'Subject:  Weekly   report ', 'Date: Thu, 22 Aug 2019 23:12:06 -0600'],
            ['subject', 'header:Subject:asText', 'sentAt', 'header:Date:asDate']
        );
        expect(email.subject).to.equal(email['header:Subject:asText']);
        // RFC 8621 4.1.2.2: leading SP removed, the rest of the value kept as it is
        expect(email.subject).to.equal('Weekly   report ');
        expect(email.sentAt).to.equal(email['header:Date:asDate']);
    });

    scenario('EGET-085', async () => {
        const properties = ['messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt'];
        const { id } = await append(ctx.user, raw('X-Only: 1', '', 'Short body'));
        const email = await getOne(ctx.client, id, { properties });
        for (const property of properties) {
            expect(email, property).to.have.property(property);
            expect(email[property], property).to.be.null;
        }
    });

    scenario('EGET-086', async () => {
        const first = await headersOf(['From: x@example.com', 'Subject:'], ['subject', 'header:Subject']);
        const second = await headersOf(['From: x@example.com', 'Subject:    '], ['subject', 'header:Subject']);
        expect(first.subject).to.equal('');
        expect(second.subject).to.equal('');
        expect(first['header:Subject']).to.equal('');
        expect(second['header:Subject']).to.equal('    ');
    });

    scenario('EGET-087', async () => {
        const email = await headersOf(
            [
                'From: first-from@example.com',
                'To: first-to@example.com',
                'Cc: first-cc@example.com',
                'Bcc: first-bcc@example.com',
                'Sender: first-sender@example.com',
                'Reply-To: first-reply@example.com',
                'Subject: first subject',
                'Date: Thu, 22 Aug 2019 23:12:06 +0000',
                'From: second-from@example.com',
                'To: second-to@example.com',
                'Cc: second-cc@example.com',
                'Bcc: second-bcc@example.com',
                'Sender: second-sender@example.com',
                'Reply-To: second-reply@example.com',
                'Subject: second subject',
                'Date: Fri, 23 Aug 2019 10:00:00 +0000'
            ],
            ['from', 'to', 'cc', 'bcc', 'sender', 'replyTo', 'subject', 'sentAt', 'header:To:asAddresses:all']
        );
        for (const [property, name] of [
            ['from', 'from'],
            ['to', 'to'],
            ['cc', 'cc'],
            ['bcc', 'bcc'],
            ['sender', 'sender'],
            ['replyTo', 'reply']
        ]) {
            expect(email[property], property).to.deep.equal([{ name: null, email: `second-${name}@example.com` }]);
        }
        expect(email.subject).to.equal('second subject');
        expect(email.sentAt).to.equal('2019-08-23T10:00:00Z');
        expect(email['header:To:asAddresses:all']).to.deep.equal([
            [{ name: null, email: 'first-to@example.com' }],
            [{ name: null, email: 'second-to@example.com' }]
        ]);
    });

    scenario('EGET-088', async () => {
        const email = await headersOf(
            [
                'From: =?ISO-8859-1?B?SvxyZ2Vu?= <from@example.com>',
                'To: =?UTF-8?Q?T=C3=B5nu?= <to@example.com>',
                'Cc: =?UTF-8?B?w4TDpGl0?= <cc@example.com>',
                'Bcc: =?UTF-8?Q?=C5=A0arlote?= <bcc@example.com>',
                'Sender: =?UTF-8?Q?S=C3=A4nder?= <sender@example.com>',
                'Reply-To: =?UTF-8?Q?R=C3=A9ply?= <reply@example.com>',
                'Subject: =?UTF-8?Q?Caf=C3=A9_men=C3=BC?=',
                'X-Mood: =?UTF-8?B?8J+Ygw==?='
            ],
            ['subject', 'from', 'to', 'cc', 'bcc', 'sender', 'replyTo', 'header:X-Mood:asText', 'header:Subject']
        );
        expect(email.subject).to.equal('Café menü');
        expect(email.from[0].name).to.equal('Jürgen');
        expect(email.to[0].name).to.equal('Tõnu');
        expect(email.cc[0].name).to.equal('Ääit');
        expect(email.bcc[0].name).to.equal('Šarlote');
        expect(email.sender[0].name).to.equal('Sänder');
        expect(email.replyTo[0].name).to.equal('Réply');
        expect(email['header:X-Mood:asText']).to.equal('\u{1F603}');
        expect(email['header:Subject']).to.equal(' =?UTF-8?Q?Caf=C3=A9_men=C3=BC?=');
    });

    scenario('EGET-089', async () => {
        const email = await headersOf(
            [
                'From: x@example.com',
                'X-Two: =?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=',
                'X-Fold: =?ISO-8859-1?Q?a?=\r\n =?ISO-8859-1?Q?b?=',
                'X-Plain: =?ISO-8859-1?Q?a?= b',
                'X-Space: =?ISO-8859-1?Q?a_?= =?ISO-8859-1?Q?b?='
            ],
            ['header:X-Two:asText', 'header:X-Fold:asText', 'header:X-Plain:asText', 'header:X-Space:asText']
        );
        expect(email['header:X-Two:asText']).to.equal('ab');
        expect(email['header:X-Fold:asText']).to.equal('ab');
        expect(email['header:X-Plain:asText']).to.equal('a b');
        expect(email['header:X-Space:asText']).to.equal('a b');
    });

    scenario('EGET-090', async () => {
        // U+1F600 is F0 9F 98 80, cut after its first byte
        const email = await headersOf(['From: x@example.com', 'Subject: =?UTF-8?Q?smile_=F0?=\r\n =?UTF-8?Q?=9F=98?=\r\n =?UTF-8?Q?=80_end?='], ['subject']);
        expect(email.subject).to.equal('smile \u{1F600} end');
        expect(email.subject).to.not.include('�');
    });

    scenario('EGET-091', async () => {
        const cases = [
            ['=?iso-8859-1?Q?J=FCrgen?=', 'Jürgen'],
            ['=?ISO-8859-15?Q?=A4uro?=', '€uro'],
            ['=?Windows-1252?Q?=80_price?=', '€ price'],
            ['=?koi8-R?B?8NLJ18XU?=', 'Привет'],
            ['=?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=', 'こんにちは'],
            ['=?Shift_JIS?B?grGC8YLJgr+CzQ==?=', 'こんにちは'],
            ['=?gb2312?B?xOO6ww==?=', '你好'],
            ['=?Big5?B?p0Gmbg==?=', '你好'],
            ['=?euc-KR?B?vsiz58fPvLy/5A==?=', '안녕하세요']
        ];
        for (const [encoded, expected] of cases) {
            const email = await headersOf(['From: x@example.com', `Subject: ${encoded}`], ['subject']);
            expect(email.subject, encoded).to.equal(expected);
        }
    });

    scenario('EGET-092', async () => {
        const email = await headersOf(['From: x@example.com', 'Subject: =?x-unknown-charset?Q?abc?= tail'], ['subject', 'header:Subject:asText']);
        expect(email.subject).to.equal('=?x-unknown-charset?Q?abc?= tail');
        expect(email['header:Subject:asText']).to.equal('=?x-unknown-charset?Q?abc?= tail');
    });

    scenario('EGET-093', async () => {
        const email = await headersOf(
            ['From: "=?UTF-8?Q?J=C3=B5gi?=" <river@example.com>', 'X-A: foo=?UTF-8?Q?bar?=baz', 'X-B: =?UTF-8?Q?a b?='],
            ['header:X-A:asText', 'header:X-B:asText', 'from']
        );
        expect(email['header:X-A:asText']).to.equal('foo=?UTF-8?Q?bar?=baz');
        expect(email['header:X-B:asText']).to.equal('=?UTF-8?Q?a b?=');
        expect(email.from[0].name).to.equal('Jõgi');
    });

    scenario('EGET-094', async () => {
        const email = await headersOf(
            ['From: x@example.com', 'Subject: =?UTF-8?Q?a=00b=07c?=', 'X-Bad: =?UTF-8?Q?x=FFy?='],
            ['subject', 'header:X-Bad:asText']
        );
        expect(email.subject).to.equal('abc');
        expect(email['header:X-Bad:asText']).to.equal('x�y');
    });

    scenario('EGET-095', async () => {
        const email = await headersOf(utf8(['From: Иван Петров <ivan@example.com>', 'To: юзер@example.com', 'Subject: Привет мир']), [
            'subject',
            'from',
            'to',
            'header:Subject',
            'headers'
        ]);
        expect(email.subject).to.equal('Привет мир');
        expect(email.from[0].name).to.equal('Иван Петров');
        expect(email.to[0].email).to.equal('юзер@example.com');
        expect(email['header:Subject']).to.equal(' Привет мир');
        expect(email.headers.find(header => header.name === 'From').value).to.equal(' Иван Петров <ivan@example.com>');
        expect(JSON.stringify(email)).to.not.include('�');
    });

    scenario('EGET-096', async () => {
        // "Привет" in KOI8-R, and "Jürgen" in ISO-8859-1
        const koi8 = Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]).toString('binary');
        const latin = Buffer.from('J\xfcrgen', 'latin1').toString('binary');
        const first = await headersOf(['From: ' + koi8 + ' <koi@example.com>', 'Subject: KOI8 ' + koi8], ['subject', 'from', 'header:Subject', 'headers']);
        expect(first.from[0].email).to.equal('koi@example.com');
        expect(first.subject.startsWith('KOI8 ')).to.be.true;
        expect(first['header:Subject']).to.match(/^ KOI8 (�+|Привет)$/);
        expect(first.subject).to.match(/^KOI8 (�+|Привет)$/);

        const second = await headersOf(['From: latin@example.com', 'Subject: Latin ' + latin], ['subject', 'from', 'header:Subject', 'headers']);
        expect(second.from[0].email).to.equal('latin@example.com');
        expect(second['header:Subject']).to.match(/^ Latin J(�|ü)rgen$/);
    });

    scenario('EGET-097', async () => {
        const content = raw('From: x@example.com', 'X-Nul: a\x00b', 'Subject: nul', '', 'body');
        let id;
        try {
            id = (await append(ctx.user, content)).id;
        } catch {
            // IMAP refused the NUL octet, deliver over LMTP instead
            await seed.deliver(ctx.user.address, content);
            const res = await clock.waitFor(async () => {
                const query = await ctx.client.method('Email/query', { filter: { subject: 'nul' } });
                return query.ids.length && query.ids;
            });
            id = res[0];
        }
        const email = await getOne(ctx.client, id, { properties: ['header:X-Nul', 'headers'] });
        expect(email['header:X-Nul']).to.equal(' ab');
        expect(email.headers.find(header => header.name === 'X-Nul').value).to.equal(' ab');
        expect(JSON.stringify(email)).to.not.include('\\u0000');
    });

    scenario('EGET-102', async () => {
        const { id } = await append(
            ctx.user,
            raw(
                'From: x@example.com',
                'Subject: malformed lines',
                'this is not a header',
                'To: Recipient <to@example.com>',
                ': value',
                'X-Space : v',
                '',
                'body'
            )
        );
        const email = await getOne(ctx.client, id, { properties: ['headers', 'subject', 'to', 'header:X-Space'] });
        expect(email.subject).to.equal('malformed lines');
        expect(email.to).to.deep.equal([{ name: 'Recipient', email: 'to@example.com' }]);
        for (const header of email.headers) {
            expect(header.name).to.be.a('string').that.is.not.empty;
            expect(header.name).to.not.include(':');
        }
    });

    scenario('EGET-103', async () => {
        const args = {
            properties: [
                'id',
                'blobId',
                'threadId',
                'mailboxIds',
                'keywords',
                'size',
                'receivedAt',
                'messageId',
                'inReplyTo',
                'references',
                'sender',
                'from',
                'to',
                'cc',
                'bcc',
                'replyTo',
                'subject',
                'sentAt',
                'hasAttachment',
                'preview',
                'bodyValues',
                'textBody',
                'htmlBody',
                'attachments',
                'headers',
                'bodyStructure'
            ],
            fetchAllBodyValues: true
        };
        const ids = [];
        for (const content of [Buffer.from('\r\nOnly body text\r\n'), Buffer.from('Subject: headers only\r\n'), Buffer.from('Subject: empty body\r\n\r\n')]) {
            ids.push((await append(ctx.user, content)).id);
        }
        const res = await get(ctx.client, ids, args);
        expect(res.notFound).to.deep.equal([]);
        const [bodyOnly, headersOnly, emptyBody] = ids.map(id => res.list.find(email => email.id === id));

        expect(bodyOnly.headers).to.deep.equal([]);
        for (const property of ['messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt']) {
            expect(bodyOnly[property], property).to.be.null;
        }
        expect(Object.values(bodyOnly.bodyValues).map(value => value.value)).to.deep.equal(['Only body text\n']);

        for (const email of [headersOnly, emptyBody]) {
            expect(email.bodyStructure.type).to.equal('text/plain');
            expect(email.bodyStructure.size).to.equal(0);
            expect(email.preview).to.equal('');
            expect(Object.values(email.bodyValues).map(value => value.value)).to.deep.equal(['']);
        }
    });
});
