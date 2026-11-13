/* eslint no-unused-expressions: 0 */
/* globals before: false */
'use strict';

// Catalogue file searchsnippet.yaml: SearchSnippet/get (SNIP).

const openpgp = require('openpgp');
const { expect } = require('chai');
const { scenario, accounts, seed, fixtures, clock, jmap } = require('../harness');

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** The stored document of a message by its Message-ID, once it exists */
async function storedDoc(user, messageId) {
    const db = await seed.db();
    return clock.waitFor(
        () => db.collection('messages').findOne({ user: new seed.ObjectId(user.id), msgid: messageId }, { projection: { root: true, uid: true } }),
        {
            message: `message ${messageId} not stored`
        }
    );
}

const messageIdOf = raw => /^Message-ID: (.*)$/im.exec(raw.toString())[1].trim();

/** Appends a message built from MailComposer options over IMAP and answers its Email id */
async function append(user, options = {}, flags = []) {
    const raw = await fixtures.buildMessage(options);
    await seed.withImap(user, client => client.append('INBOX', raw, flags));
    const doc = await storedDoc(user, messageIdOf(raw));
    return `M${doc.root}`;
}

/** Delivers a message over LMTP and answers its Email id */
async function deliver(user, options = {}) {
    const raw = await fixtures.buildMessage(options);
    await seed.deliver(user.address, raw);
    const doc = await storedDoc(user, messageIdOf(raw));
    return `M${doc.root}`;
}

async function snippets(client, filter, emailIds) {
    const res = await client.method('SearchSnippet/get', { filter, emailIds });
    return res;
}

async function snippetOf(client, filter, emailId) {
    const res = await snippets(client, filter, [emailId]);
    expect(res.list).to.have.length(1);
    return res.list[0];
}

async function expectError(promise, type) {
    const err = await promise.then(
        () => null,
        error => error
    );
    expect(err, `expected ${type}`).to.exist;
    expect(err.type).to.equal(type);
}

const unescape = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const stripMarks = value => value.replace(/<\/?mark>/g, '');
// the markup of a snippet with the mark tags removed: only escaped text may remain
const withoutMarks = value => value.replace(/<\/?mark>/g, '');
const marked = value => [...value.matchAll(/<mark>(.*?)<\/mark>/g)].map(match => match[1]);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function expectBalancedMarks(value) {
    expect(value.split('<mark>').length).to.equal(value.split('</mark>').length);
    expect(/<mark>[^<]*<mark>/.test(value)).to.be.false;
    expect(withoutMarks(value)).to.not.match(/[<>]/);
}

describe('JMAP SearchSnippet (searchsnippet.yaml)', () => {
    let user;
    let client;
    let inbox;

    before(async () => {
        user = await accounts.createUser();
        client = jmap.forUser(user);
        await client.session();
        const boxes = await client.method('Mailbox/get', { ids: null, properties: ['role'] });
        inbox = boxes.list.find(entry => entry.role === 'inbox').id;
    });

    scenario('SNIP-001', async () => {
        const e1 = await append(user, { subject: 'Foosball competition', text: 'the foosball final is on friday' });
        const e2 = await append(user, { subject: 'Lunch', text: 'no match here' });
        const [[name, res]] = await client.call([['SearchSnippet/get', { accountId: true, filter: { text: 'foosball' }, emailIds: [e1, e2] }, 's']]);
        expect(name).to.equal('SearchSnippet/get');
        expect(res).to.have.all.keys('accountId', 'list', 'notFound');
        expect(res.notFound).to.equal(null);
        expect(res.list).to.have.length(2);
        for (const entry of res.list) {
            expect(entry).to.have.all.keys('emailId', 'subject', 'preview');
        }
        expect(res.list.map(entry => entry.emailId).sort()).to.deep.equal([e1, e2].sort());
    });

    scenario('SNIP-002', async () => {
        const e1 = await append(user, { subject: 'The Foosball competition', text: 'nothing relevant in the body' });
        for (const filter of [{ text: 'foosball' }, { subject: 'FOOSBALL' }]) {
            const entry = await snippetOf(client, filter, e1);
            expect(entry.subject).to.equal('The <mark>Foosball</mark> competition');
            expect(entry.preview).to.equal(null);
        }
    });

    scenario('SNIP-003', async () => {
        const filler = 'lorem ipsum dolor sit amet consectetur ';
        const head = filler.repeat(11).slice(0, 399).replace(/\S*$/, '');
        const body = (head + 'kumquat ' + filler.repeat(6)).slice(0, 600);
        const e1 = await append(user, { subject: 'Weekly notes', text: body });
        const email = await client.method('Email/get', { ids: [e1], properties: ['preview'] });
        for (const filter of [{ text: 'kumquat' }, { body: 'kumquat' }]) {
            const entry = await snippetOf(client, filter, e1);
            expect(entry.subject).to.equal(null);
            expect(entry.preview).to.be.a('string');
            expect(entry.preview).to.include('<mark>kumquat</mark>');
            const plain = stripMarks(entry.preview);
            expect(plain.length).to.be.above('kumquat'.length);
            expect(body.replace(/\s+/g, ' ')).to.include(unescape(plain).trim());
            expect(entry.preview).to.not.equal(email.list[0].preview);
        }
    });

    scenario('SNIP-004', async () => {
        const e1 = await append(user, { subject: 'foosball league', text: 'foosball again' });
        const e2 = await append(user, { subject: 'Unrelated', text: 'nothing here' });
        const res = await snippets(client, { text: 'foosball' }, [e1, e2]);
        expect(res.notFound).to.equal(null);
        const first = res.list.find(entry => entry.emailId === e1);
        const second = res.list.find(entry => entry.emailId === e2);
        expect(second).to.deep.equal({ emailId: e2, subject: null, preview: null });
        expect(first.subject).to.be.a('string');
        expect(first.preview).to.be.a('string');
    });

    scenario('SNIP-005', async () => {
        const e1 = await append(user, { subject: 'R&D <urgent> widget', text: 'returns <1 widget & more > less' });
        const entry = await snippetOf(client, { text: 'widget' }, e1);
        expect(entry.subject).to.equal('R&amp;D &lt;urgent&gt; <mark>widget</mark>');
        expect(entry.preview).to.include('&lt;1 <mark>widget</mark> &amp; more &gt; less');
        for (const value of [entry.subject, entry.preview]) {
            expect(withoutMarks(value)).to.not.match(/[<>]/);
        }
    });

    scenario('SNIP-006', async () => {
        const e1 = await append(user, {
            subject: '<mark>fake</mark> real',
            text: undefined,
            html: '<html><body><script>var secret = "real script";</script><p>real deal</p></body></html>'
        });
        const entry = await snippetOf(client, { text: 'real' }, e1);
        expect(entry.subject).to.equal('&lt;mark&gt;fake&lt;/mark&gt; <mark>real</mark>');
        expect(entry.preview).to.be.a('string');
        expect(entry.preview).to.include('<mark>real</mark> deal');
        expect(entry.preview).to.not.include('script');
        expect(entry.preview).to.not.include('secret');
        expectBalancedMarks(entry.subject);
        expectBalancedMarks(entry.preview);
    });

    scenario('SNIP-007', async () => {
        const own = await accounts.createUser();
        const ownClient = jmap.forUser(own);
        const other = await accounts.createUser();
        const e1 = await append(own, { subject: 'x marks the spot', text: 'x' });
        const e2 = await append(own, { subject: 'x deleted', text: 'x' }, ['\\Deleted']);
        const e3 = await append(other, { subject: 'x foreign', text: 'x' });
        const unknown = `M${new seed.ObjectId()}`;
        const res = await snippets(ownClient, { text: 'x' }, [e1, unknown, 'not-an-id', e3, e2]);
        expect(res.list.map(entry => entry.emailId)).to.deep.equal([e1]);
        expect(res.notFound).to.have.members([unknown, 'not-an-id', e3, e2]);
        expect(res.notFound).to.have.length(4);
    });

    scenario('SNIP-008', async () => {
        const empty = await client.method('SearchSnippet/get', { filter: { text: 'x' }, emailIds: [] });
        expect(empty.list).to.deep.equal([]);
        expect(empty.notFound).to.equal(null);

        const someId = `M${new seed.ObjectId()}`;
        const invalid = [
            { filter: { text: 'x' } },
            { filter: { text: 'x' }, emailIds: null },
            { filter: { text: 'x' }, emailIds: someId },
            { emailIds: [someId] },
            { filter: { bogus: 1 }, emailIds: [someId] },
            { filter: { operator: 'XOR', conditions: [] }, emailIds: [someId] }
        ];
        for (const args of invalid) {
            await expectError(client.method('SearchSnippet/get', args), 'invalidArguments');
        }
        await expectError(client.method('SearchSnippet/get', { accountId: `u${new seed.ObjectId()}`, filter: null, emailIds: [] }), 'accountNotFound');
    });

    scenario('SNIP-009', async () => {
        const e1 = await append(user, { from: 'Snippet Sender <snippet.sender@example.net>', subject: 'Flagged one', text: 'some body text' }, ['\\Flagged']);
        for (const filter of [null, {}, { inMailbox: inbox, hasKeyword: '$flagged' }, { from: 'snippet.sender@example.net' }]) {
            const res = await snippets(client, filter, [e1]);
            expect(res.list).to.deep.equal([{ emailId: e1, subject: null, preview: null }]);
            expect(res.notFound).to.equal(null);
        }
    });

    scenario('SNIP-010', async () => {
        const own = await accounts.createUser();
        const ownClient = jmap.forUser(own);
        await append(own, { subject: 'mango season', text: 'fruit' });
        await append(own, { subject: 'shopping', text: 'buy a mango' });
        await append(own, { subject: 'Mango smoothie', text: 'mango and milk' });
        await append(own, { subject: 'apples', text: 'apples only' });
        await append(own, { subject: 'pears', text: 'pears only' });
        const [[, query], [name, res]] = await ownClient.call([
            ['Email/query', { accountId: true, filter: { text: 'mango' } }, 'q'],
            ['SearchSnippet/get', { accountId: true, filter: { text: 'mango' }, '#emailIds': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 's']
        ]);
        expect(name).to.equal('SearchSnippet/get');
        expect(query.ids).to.have.length(3);
        expect(res.list).to.have.length(3);
        expect(res.list.map(entry => entry.emailId)).to.have.members(query.ids);
        for (const entry of res.list) {
            expect(`${entry.subject || ''}${entry.preview || ''}`).to.include('<mark>');
        }
        expect(res.notFound).to.equal(null);
    });

    scenario('SNIP-011', async () => {
        const e1 = await append(user, { subject: 'red green blue', text: 'a red car and a blue bike' });
        const first = await snippetOf(client, { text: 'red blue' }, e1);
        expect(first.subject).to.equal('<mark>red</mark> green <mark>blue</mark>');
        expect(marked(first.preview)).to.deep.equal(['red', 'blue']);

        const second = await snippetOf(client, { operator: 'OR', conditions: [{ subject: 'green' }, { body: 'bike' }] }, e1);
        expect(second.subject).to.equal('red <mark>green</mark> blue');
        expect(marked(second.preview)).to.deep.equal(['bike']);

        const third = await snippetOf(client, { operator: 'AND', conditions: [{ text: 'red' }, { text: 'car' }] }, e1);
        expect(third.subject).to.equal('<mark>red</mark> green blue');
        expect(marked(third.preview)).to.deep.equal(['red', 'car']);
    });

    scenario('SNIP-012', async () => {
        const e1 = await append(user, { subject: 'alpha beta', text: 'nothing' });
        const first = await snippetOf(client, { operator: 'AND', conditions: [{ text: 'alpha' }, { operator: 'NOT', conditions: [{ text: 'gamma' }] }] }, e1);
        expect(first.subject).to.equal('<mark>alpha</mark> beta');
        const second = await snippetOf(client, { operator: 'NOT', conditions: [{ text: 'beta' }] }, e1);
        expect(second.subject).to.equal(null);
        expect(second.preview).to.equal(null);
    });

    scenario('SNIP-013', async () => {
        const e1 = await append(user, { subject: 'Help your country', text: 'country first, then your country needs you' });
        const e2 = await append(user, { subject: 'your own country', text: 'nothing' });
        const res = await snippets(client, { text: '"your country"' }, [e1, e2]);
        const first = res.list.find(entry => entry.emailId === e1);
        const second = res.list.find(entry => entry.emailId === e2);
        expect(first.subject).to.be.oneOf(['Help <mark>your country</mark>', 'Help <mark>your</mark> <mark>country</mark>']);
        expect(stripMarks(first.preview)).to.equal('country first, then your country needs you');
        expect(first.preview.startsWith('country first')).to.be.true;
        expect(first.preview).to.match(/then (<mark>your country<\/mark>|<mark>your<\/mark> <mark>country<\/mark>) needs/);
        expect(second.subject).to.equal(null);
    });

    scenario('SNIP-014', async () => {
        const e1 = await append(user, { subject: 'Voyage sur la Côte', text: 'nothing' });
        const e2 = await append(user, { subject: '孫子兵法 <notes>', text: '我讀了孫子兵法。' });
        const first = await snippetOf(client, { text: 'cote' }, e1);
        expect(first.subject).to.equal('Voyage sur la <mark>Côte</mark>');
        const second = await snippetOf(client, { text: '孫子兵法' }, e2);
        expect(second.subject).to.equal('<mark>孫子兵法</mark> &lt;notes&gt;');
        expect(marked(second.preview)).to.deep.equal(['孫子兵法']);

        // the snippet marks what Email/query finds
        const query = await client.method('Email/query', { filter: { text: 'cote' } });
        if (query.ids.includes(e1)) {
            expect(first.subject).to.include('<mark>');
        }
    });

    scenario('SNIP-015', async () => {
        const e1 = await append(user, {
            subject: 'Greetings',
            text: undefined,
            html: '<html><head><style>p { color: red; }</style></head><body><p>Grüße aus <b>München</b> &amp; Umgebung</p><a href="https://example.com/">more</a></body></html>'
        });
        const first = await snippetOf(client, { text: 'münchen' }, e1);
        expect(first.preview).to.include('aus <mark>München</mark> &amp; Umgebung');
        expect(first.preview).to.not.match(/<(p|b|a|style)\b/);
        expect(first.preview).to.not.include('&amp;amp;');
        const second = await snippetOf(client, { text: 'style' }, e1);
        expect(second.preview).to.equal(null);
    });

    scenario('SNIP-016', async () => {
        const body1 = 'zpreview é&<> ☃ '.repeat(40);
        const body2 = 'filler & <text> '.repeat(40) + 'zendmatch.';
        const body3 = 'zgrapheme ' + 'ü é \u{1F469}‍\u{1F469}‍\u{1F467} '.repeat(60);
        const e1 = await append(user, { subject: 'one', text: body1 });
        const e2 = await append(user, { subject: 'two', text: body2 });
        const e3 = await append(user, { subject: 'three', text: body3 });
        for (const [emailId, term, body] of [
            [e1, 'zpreview', body1],
            [e2, 'zendmatch', body2],
            [e3, 'zgrapheme', body3]
        ]) {
            const { preview } = await snippetOf(client, { text: term }, emailId);
            expect(preview).to.be.a('string');
            expect(Buffer.byteLength(preview)).to.be.at.most(255);
            expect(LONE_SURROGATE.test(preview)).to.be.false;
            expect(Buffer.from(preview).toString()).to.equal(preview);
            expect(preview).to.include(`<mark>${term}</mark>`);
            expectBalancedMarks(preview);
            expect(preview).to.not.match(/&[a-z]*$/);
            // the text is a run of whole grapheme clusters of the body
            const plain = unescape(stripMarks(preview)).trim();
            const flat = body.replace(/\s+/g, ' ').trim();
            const at = flat.indexOf(plain);
            expect(at, 'preview text is taken from the body').to.be.at.least(0);
            const boundaries = new Set([...graphemes.segment(flat)].map(entry => entry.index).concat(flat.length));
            expect(boundaries.has(at)).to.be.true;
            expect(boundaries.has(at + plain.length)).to.be.true;
        }
    });

    scenario('SNIP-017', async () => {
        const filler = 'filler text without the word '.repeat(150);
        const e1 = await append(user, { subject: 'persimmon list', text: `${filler}persimmon` });
        const query = await client.method('Email/query', { filter: { text: 'persimmon' } });
        expect(query.ids).to.include(e1);
        const first = await snippetOf(client, { text: 'persimmon' }, e1);
        expect(first.subject).to.equal('<mark>persimmon</mark> list');
        if (first.preview !== null) {
            expect(first.preview).to.include('<mark>persimmon</mark>');
        }
        const second = await snippetOf(client, { body: 'persimmon' }, e1);
        if (second.preview !== null) {
            expect(second.preview).to.include('<mark>persimmon</mark>');
        }
    });

    scenario('SNIP-018', async () => {
        const e1 = await append(user, {
            subject: 'see attached',
            text: 'see attached',
            attachments: [{ filename: 'fruit.txt', content: 'durian is a fruit', contentType: 'text/plain' }]
        });

        const { publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: 'Sealed', email: 'sealed@example.com' }] });
        const sealedUser = await accounts.createUser({ pubKey: publicKey, encryptMessages: true });
        const sealedClient = jmap.forUser(sealedUser);
        const e2 = await deliver(sealedUser, { subject: 'sealed', text: 'the durian is inside' });

        const plain = await snippetOf(client, { text: 'durian' }, e1);
        expect(plain).to.deep.equal({ emailId: e1, subject: null, preview: null });
        const sealedDurian = await snippetOf(sealedClient, { text: 'durian' }, e2);
        expect(sealedDurian).to.deep.equal({ emailId: e2, subject: null, preview: null });
        const sealedSubject = await snippetOf(sealedClient, { text: 'sealed' }, e2);
        expect(sealedSubject.subject).to.equal('<mark>sealed</mark>');
        expect(sealedSubject.preview).to.equal(null);
    });

    scenario('SNIP-019', async () => {
        const e1 = await append(user, { subject: 'xylophone lessons', text: 'nothing' });
        const entry = await snippetOf(client, { someInThreadHaveKeyword: '$flagged', text: 'xylophone' }, e1);
        expect(entry.subject).to.equal('<mark>xylophone</mark> lessons');

        let deep = { text: 'xylophone' };
        // deeper than the filter depth limit, well within the JSON nesting limit
        for (let i = 0; i < 15; i++) {
            deep = { operator: 'AND', conditions: [deep] };
        }
        await expectError(client.method('SearchSnippet/get', { filter: deep, emailIds: [e1] }), 'unsupportedFilter');
        await expectError(client.method('Email/query', { filter: deep }), 'unsupportedFilter');
    });

    scenario('SNIP-020', async () => {
        const session = await client.session();
        const max = session.capabilities[jmap.URN.core].maxObjectsInGet;
        const ids = Array.from({ length: max + 1 }, () => `M${new seed.ObjectId()}`);
        await expectError(client.method('SearchSnippet/get', { filter: { text: 'x' }, emailIds: ids }), 'requestTooLarge');
        const res = await client.method('SearchSnippet/get', { filter: { text: 'x' }, emailIds: ids.slice(0, max) });
        expect(res.list).to.deep.equal([]);
        expect(res.notFound).to.have.length(max);
    });

    scenario('SNIP-021', async () => {
        const [[name, res]] = await client.call([['SearchSnippet/get', { accountId: true, filter: null, emailIds: [] }, 's']], [jmap.URN.core]);
        expect(name).to.equal('error');
        expect(res.type).to.equal('unknownMethod');
        const responses = await client.call([
            ['SearchSnippet/set', { accountId: true }, 'a'],
            ['SearchSnippet/changes', { accountId: true, sinceState: 'x' }, 'b']
        ]);
        for (const [responseName, args] of responses) {
            expect(responseName).to.equal('error');
            expect(args.type).to.equal('unknownMethod');
        }
    });
});
