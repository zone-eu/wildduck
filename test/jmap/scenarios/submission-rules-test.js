/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Catalogue file submission.yaml, EmailSubmission/set create (RFC 8621 7.5): who may send what, the
// SetErrors of a create, recipient limits shared with the REST API, and injection safety of the
// envelope.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { scenario, api, accounts, seed, outbound } = require('../harness');
const { startInstance, stopInstance } = require('../harness/instance');
const h = require('./submission-helpers');
const { append, message } = require('./email-get-helpers');
const { docOf, rawOf } = require('./email-set-helpers');

const PUB_KEY = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'user2-public.key'), 'utf8');

/** The body of a message, after the header */
const bodyOf = raw => raw.slice(raw.indexOf('\r\n\r\n') + 4);

/** Sends through the REST submit endpoint to the given number of recipients */
const restSubmit = (ctx, count) =>
    api('POST', `/users/${ctx.user.id}/submit`, {
        to: Array.from({ length: count }, (value, i) => ({ address: `rest${i}@example.net` })),
        subject: 'REST submission',
        text: 'Hello'
    });

const setSetting = (key, value) => api('POST', `/settings/${key}`, { value });

describe('EmailSubmission rules', function () {
    this.timeout(60000);

    let ctx;
    before(async () => {
        ctx = await h.sender();
    });

    scenario('SUB-037', async () => {
        const { id } = await append(ctx.user, message([`From: ${ctx.user.address}`, 'To: r@example.net', 'Subject: not a draft']), { mailbox: 'Sent Mail' });
        const { keywords, mailboxIds } = await h.emailOf(ctx, id, ['keywords', 'mailboxIds']);
        expect(mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
        expect(keywords).to.not.have.property('$draft');
        const before = await h.queuedMessages(ctx);
        h.expectCreated(await h.submitEmail(ctx, id));
        expect(await h.queuedMessages(ctx)).to.have.length(before.length + 1);
    });

    scenario('SUB-038', async () => {
        const own = await h.sender();
        await seed.deliver(own.user.address, ['From: stranger@example.net', `To: ${own.user.address}`, 'Subject: received', '', 'Hello'].join('\r\n'));
        const [id] = await h.inbox(own);
        const envelope = { mailFrom: { email: own.user.address }, rcptTo: [{ email: 'other@example.net' }] };
        h.expectNotCreated(await h.submitEmail(own, id, { envelope }), 'forbiddenFrom');
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-039', async () => {
        const own = await h.sender();
        const rcpt = await h.sender();
        const draft = await h.createDraft(own, { to: rcpt.user.address });
        const first = h.expectCreated(await h.submitEmail(own, draft.id));
        const second = h.expectCreated(await h.submitEmail(own, draft.id));
        const both = await h.submissionSet(own, {
            create: { a: { identityId: own.identity.id, emailId: draft.id }, b: { identityId: own.identity.id, emailId: draft.id } }
        });
        const ids = [first.id, second.id, h.expectCreated(both, 'a').id, h.expectCreated(both, 'b').id];
        expect(new Set(ids).size).to.equal(4);
        const queueIds = await Promise.all(ids.map(h.queueIdOf));
        expect(new Set(queueIds).size).to.equal(4);
        expect((await h.queuedMessages(own)).sort()).to.deep.equal([...queueIds].sort());
        const query = await h.call(own, 'EmailSubmission/query', { filter: { emailIds: [draft.id] } });
        expect(query.ids.sort()).to.deep.equal([...ids].sort());
        // the MTA delivers one copy per submission; WildDuck's inbound duplicate check (same Message-ID
        // and Date in the mailbox) stores the first one only
        for (const queueId of queueIds) {
            expect(await outbound.deliver(queueId)).to.deep.equal([rcpt.user.address]);
        }
        expect(await h.inbox(rcpt)).to.have.length(1);
    });

    scenario('SUB-040', async () => {
        const own = await h.sender();
        const d1 = await h.createDraft(own);
        const d2 = await h.createDraft(own, { to: null });
        const res = await h.submissionSet(own, {
            create: { s1: { identityId: own.identity.id, emailId: d1.id }, s2: { identityId: own.identity.id, emailId: d2.id } }
        });
        expect(Object.keys(res.created)).to.deep.equal(['s1']);
        h.expectNotCreated(res, 'noRecipients', 's2');
        expect(await h.queuedMessages(own)).to.have.length(1);
        expect(res.newState).to.not.equal(res.oldState);
    });

    scenario('SUB-041', async () => {
        const own = await h.sender();
        const b = `${h.unique('b')}@example.com`;
        await h.addAddress(own, b);
        const draft = await h.createDraft(own, { from: b });
        h.expectNotCreated(await h.submitEmail(own, draft.id), 'forbiddenFrom');
        await h.expectNothingQueued(own, []);
        h.expectCreated(await h.submitEmail(own, draft.id, { identityId: (await h.identityOf(own, b)).id }));
    });

    scenario('SUB-042', async () => {
        const own = await h.sender();
        const other = await accounts.createUser();
        for (const from of [other.address, 'external@example.net']) {
            const draft = await h.createDraft(own, { from });
            h.expectNotCreated(await h.submitEmail(own, draft.id), 'forbiddenFrom');
            const envelope = { mailFrom: { email: own.user.address }, rcptTo: [{ email: 'r@example.net' }] };
            h.expectNotCreated(await h.submitEmail(own, draft.id, { envelope }), 'forbiddenFrom');
            expect((await h.emailOf(own, draft.id, ['from'])).from).to.deep.equal([{ name: null, email: from }]);
        }
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-043', async () => {
        const own = await h.sender();
        const other = await accounts.createUser();
        const envelope = { mailFrom: { email: own.user.address }, rcptTo: [{ email: 'r@example.net' }] };
        const senderOnly = await h.appendRaw(own, [`From: ${own.user.address}`, `Sender: ${other.address}`, 'To: r@example.net', 'Subject: foreign sender']);
        for (const extra of [{}, { envelope }]) {
            const error = h.expectNotCreated(await h.submitEmail(own, senderOnly, extra), 'forbiddenFrom');
            expect(error.properties).to.deep.equal(['sender']);
        }
        const both = await h.appendRaw(own, [`From: ${other.address}`, `Sender: ${other.address}`, 'To: r@example.net', 'Subject: both foreign']);
        const error = h.expectNotCreated(await h.submitEmail(own, both), 'forbiddenFrom');
        expect([...error.properties].sort()).to.deep.equal(['from', 'sender']);
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-044', async () => {
        const own = await h.sender();
        const domain = `${h.unique('wild')}.example`;
        await h.addAddress(own, `*@${domain}`, { allowWildcard: true });
        const wildcard = await h.identityOf(own, `*@${domain}`);
        for (const from of [`anything@${domain}`, `ANY@${domain.toUpperCase()}`]) {
            const draft = await h.createDraft(own, { from });
            const created = h.expectCreated(await h.submitEmail(own, draft.id, { identityId: wildcard.id }));
            expect((await h.getSubmission(own, created.id)).envelope.mailFrom.email).to.equal(from);
        }
        for (const from of [`x@sub.${domain}`, 'x@other.example']) {
            const draft = await h.createDraft(own, { from });
            h.expectNotCreated(await h.submitEmail(own, draft.id, { identityId: wildcard.id }), 'forbiddenFrom');
        }
    });

    scenario('SUB-045', async () => {
        const own = await h.sender();
        const other = await accounts.createUser();
        const draft = await h.createDraft(own);
        for (const email of [other.address, 'external@example.net']) {
            const envelope = { mailFrom: { email }, rcptTo: [{ email: 'r@example.net' }] };
            h.expectNotCreated(await h.submitEmail(own, draft.id, { envelope }), 'forbiddenMailFrom');
        }
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-046', async () => {
        const own = await h.sender();
        const b = `${h.unique('b')}@example.com`;
        const domain = `${h.unique('wild')}.example`;
        const partner = `ext@${h.unique('partner')}.example`;
        await h.addAddress(own, b);
        await h.addAddress(own, `*@${domain}`, { allowWildcard: true });
        await api('PUT', `/users/${own.user.id}`, { fromWhitelist: [partner] });
        const draft = await h.createDraft(own);
        for (const email of [b, partner, `bounce@${domain}`]) {
            const envelope = { mailFrom: { email }, rcptTo: [{ email: 'r@example.net' }] };
            const created = h.expectCreated(await h.submitEmail(own, draft.id, { envelope }));
            expect((await outbound.file(await h.queueIdOf(created.id))).metadata.data.from).to.equal(email);
        }
    });

    scenario('SUB-047', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const envelope = { mailFrom: { email: '' }, rcptTo: [{ email: 'r@example.net' }] };
        h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'forbiddenMailFrom');
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-048', async () => {
        const other = await accounts.createUser();
        const third = await accounts.createUser();
        const draft = await h.createDraft(ctx, { from: other.address });
        const envelope = { mailFrom: { email: third.address }, rcptTo: [{ email: 'r@example.net' }] };
        const error = h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'forbiddenFrom');
        expect(error.type).to.equal('forbiddenFrom');
    });

    scenario('SUB-049', async () => {
        const before = await h.queuedMessages(ctx);
        const envelope = { mailFrom: { email: ctx.user.address }, rcptTo: [{ email: 'r@example.net' }] };
        const variants = [
            ['To: r@example.net', 'Subject: no from'],
            [`Sender: ${ctx.user.address}`, 'To: r@example.net', 'Subject: sender only'],
            ['From: ', 'To: r@example.net', 'Subject: empty from']
        ];
        for (const headers of variants) {
            const id = await h.appendRaw(ctx, headers);
            for (const extra of [{}, { envelope }]) {
                const error = h.expectNotCreated(await h.submitEmail(ctx, id, extra), 'invalidEmail');
                expect(error.properties).to.deep.equal(['from']);
            }
        }
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-050', async () => {
        for (const headers of [
            [`From: ${ctx.user.address}`, 'To: r@example.net', 'Subject: no date', `Message-ID: <${h.unique('m')}@example.com>`],
            [`From: ${ctx.user.address}`, 'To: r@example.net', 'Subject: no date nor id']
        ]) {
            const id = await h.appendRaw(ctx, headers);
            const created = h.expectCreated(await h.submitEmail(ctx, id));
            const queued = (await outbound.message(await h.queueIdOf(created.id))).toString('binary');
            const header = queued.slice(0, queued.indexOf('\r\n\r\n'));
            const date = /^Date: (.+)$/m.exec(header);
            expect(date, header).to.exist;
            expect(Math.abs(new Date(date[1]).getTime() - new Date(created.sendAt).getTime())).to.be.below(5000);
            expect(header).to.match(/^Message-ID: <[^>]+>$/m);
            const stored = await h.emailOf(ctx, id, ['sentAt', 'messageId']);
            expect(stored.sentAt).to.equal(null);
            if (!headers.some(line => line.startsWith('Message-ID'))) {
                expect(stored.messageId).to.equal(null);
            }
        }
    });

    scenario('SUB-051', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own, { to: null });
        const state = await h.submissionState(own);
        const res = await h.submitEmail(own, draft.id);
        h.expectNotCreated(res, 'noRecipients');
        expect(res.newState).to.equal(state);
        const withEnvelope = await h.submitEmail(own, draft.id, { envelope: { mailFrom: { email: own.user.address }, rcptTo: [] } });
        h.expectNotCreated(withEnvelope, 'noRecipients');
        expect(withEnvelope.newState).to.equal(state);
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-052', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const envelope = {
            mailFrom: { email: ctx.user.address },
            rcptTo: [{ email: 'good@example.net' }, { email: 'rcpt1@localhost@localhost' }, { email: 'no-at-sign' }]
        };
        const error = h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'invalidRecipients');
        expect(error.invalidRecipients.sort()).to.deep.equal(['no-at-sign', 'rcpt1@localhost@localhost']);
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-053', async () => {
        const before = await h.queuedMessages(ctx);
        for (const bad of ['a b@example.com', 'user@']) {
            const id = await h.appendRaw(ctx, [`From: ${ctx.user.address}`, `To: ok@example.net, ${bad}`, 'Subject: bad recipient']);
            const error = h.expectNotCreated(await h.submitEmail(ctx, id), 'invalidRecipients');
            expect(error.invalidRecipients).to.deep.equal([bad]);
        }
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-054', async () => {
        for (const address of [`someone@${h.unique('remote')}.example`, `${h.unique('nobody')}@example.com`]) {
            const draft = await h.createDraft(ctx, { to: address });
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
            expect((await outbound.entries(await h.queueIdOf(created.id))).map(entry => entry.recipient)).to.deep.equal([address]);
        }
    });

    scenario('SUB-055', async () => {
        const draft = await h.createDraft(ctx);
        const unicode = { mailFrom: { email: ctx.user.address }, rcptTo: [{ email: 'user@exämple.com' }] };
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope: unicode }));
        const [entry] = await outbound.entries(await h.queueIdOf(created.id));
        expect(['user@exämple.com', 'user@xn--exmple-cua.com']).to.include(entry.recipient);
        expect(['exämple.com', 'xn--exmple-cua.com']).to.include(entry.domain);
        for (const email of ['user@-bad.example', 'user@bad .example']) {
            const envelope = { mailFrom: { email: ctx.user.address }, rcptTo: [{ email }] };
            const error = h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'invalidRecipients');
            expect(error.invalidRecipients).to.deep.equal([email]);
        }
    });

    scenario('SUB-056', async () => {
        const address = 'üser@example.net';
        const id = await h.appendRaw(ctx, Buffer.from([`From: ${ctx.user.address}`, `To: ${address}`, 'Subject: unicode local part', '', 'Body'].join('\r\n')));
        const envelope = { mailFrom: { email: ctx.user.address }, rcptTo: [{ email: address }] };
        for (const extra of [{}, { envelope }]) {
            const created = h.expectCreated(await h.submitEmail(ctx, id, extra));
            const { envelope: stored } = await h.getSubmission(ctx, created.id, ['envelope']);
            expect(stored.rcptTo.map(entry => entry.email)).to.deep.equal([address]);
            // the queue entry keeps the address in UTF-8, the MTA delivers it with SMTPUTF8
            const entries = await outbound.entries(await h.queueIdOf(created.id));
            expect(entries.map(entry => entry.recipient)).to.deep.equal([address]);
        }
    });

    describe('recipient limits', () => {
        const LIMIT = 5;
        let previous;
        before(async () => {
            previous = (await api('GET', '/settings')).settings.find(entry => entry.key === 'const:max:rcpt_to');
            await setSetting('const:max:rcpt_to', LIMIT);
        });
        after(async () => {
            await setSetting('const:max:rcpt_to', previous.value);
        });

        const addresses = count => Array.from({ length: count }, (value, i) => `limit${i}@example.net`);

        scenario('SUB-057', async () => {
            const own = await h.sender();
            const over = await h.createDraft(own, { to: addresses(3), cc: addresses(6).slice(3) });
            const error = h.expectNotCreated(await h.submitEmail(own, over.id), 'tooManyRecipients');
            expect(error.maxRecipients).to.equal(LIMIT);
            const valid = await h.createDraft(own);
            const envelope = { mailFrom: { email: own.user.address }, rcptTo: addresses(LIMIT + 1).map(email => ({ email })) };
            expect(h.expectNotCreated(await h.submitEmail(own, valid.id, { envelope }), 'tooManyRecipients').maxRecipients).to.equal(LIMIT);
            await h.expectNothingQueued(own, []);
            const exact = await h.createDraft(own, { to: addresses(LIMIT) });
            h.expectCreated(await h.submitEmail(own, exact.id));
        });

        scenario('SUB-058', async () => {
            const own = await h.sender();
            const list = addresses(LIMIT);
            const draft = await h.createDraft(own, { to: list, cc: list.slice(0, 3), bcc: list.slice(2) });
            h.expectCreated(await h.submitEmail(own, draft.id));
        });
    });

    scenario('SUB-059', async () => {
        const own = await h.sender();
        await api('PUT', `/users/${own.user.id}`, { recipients: 5 });
        await restSubmit(own, 4);
        expect(await h.recipientsUsed(own)).to.equal(4);
        const two = await h.createDraft(own, { to: ['x1@example.net', 'x2@example.net'] });
        const one = await h.createDraft(own, { to: 'y1@example.net' });
        const another = await h.createDraft(own, { to: 'z1@example.net' });
        const before = await h.queuedMessages(own);
        h.expectNotCreated(await h.submitEmail(own, two.id), 'rateLimit');
        expect(await h.recipientsUsed(own)).to.equal(4);
        expect(await h.queuedMessages(own)).to.deep.equal(before);
        h.expectCreated(await h.submitEmail(own, one.id));
        h.expectNotCreated(await h.submitEmail(own, another.id), 'rateLimit');
        const { list } = await h.call(own, 'EmailSubmission/get', {});
        expect(list.map(entry => entry.emailId)).to.deep.equal([one.id]);
    });

    scenario('SUB-060', async () => {
        const own = await h.sender();
        await api('PUT', `/users/${own.user.id}`, { recipients: 3 });
        await restSubmit(own, 2);
        const two = await h.createDraft(own, { to: ['x1@example.net', 'x2@example.net'] });
        const one = await h.createDraft(own, { to: 'y1@example.net' });
        h.expectNotCreated(await h.submitEmail(own, two.id), 'rateLimit');
        h.expectCreated(await h.submitEmail(own, one.id));
        expect(await h.recipientsUsed(own)).to.equal(3);
    });

    scenario('SUB-061', async () => {
        const own = await h.sender();
        const LIMIT = 4096;
        const instance = await startInstance({ submission: { maxSize: LIMIT } });
        try {
            const big = await h.createDraft(own, { text: 'x'.repeat(LIMIT) });
            const small = await h.createDraft(own, { text: 'small' });
            expect(big.size).to.be.above(LIMIT);
            expect(small.size).to.be.below(LIMIT);
            const [[, tooLarge]] = await h.callsAt(instance.url, own, [
                ['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: big.id } } }]
            ]);
            const error = h.expectNotCreated(tooLarge, 'tooLarge');
            expect(error.maxSize).to.equal(LIMIT);
            await h.expectNothingQueued(own, []);
            const [[, fits]] = await h.callsAt(instance.url, own, [
                ['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: small.id } } }]
            ]);
            h.expectCreated(fits);
        } finally {
            await stopInstance(instance.app);
        }
    });

    scenario('SUB-062', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const state = await h.submissionState(own);
        await api('PUT', `/users/${own.user.id}`, { disabledScopes: ['smtp'] });
        const body = {
            using: h.USING,
            methodCalls: [
                ['EmailSubmission/set', { accountId: own.client.accountId, create: { s1: { identityId: own.identity.id, emailId: draft.id } } }, 'c0']
            ]
        };
        const res = await own.client.request(body, { 'Accept-Language': 'de' });
        expect(res.status).to.equal(200);
        const [[, response]] = res.json.methodResponses;
        const error = h.expectNotCreated(response, 'forbiddenToSend');
        expect(error.description).to.be.a('string');
        expect(response.newState).to.equal(state);
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-142', async () => {
        const own = await h.sender();
        const db = await seed.db();
        // stored before the account turned encryption on, encrypted when it is moved afterwards
        const moved = await h.createDraft(own, { mailbox: own.mb.Archive, keywords: { $seen: true } });
        await api('PUT', `/users/${own.user.id}`, { pubKey: PUB_KEY, encryptMessages: true });
        const added = await h.createDraft(own, { mailbox: own.mb.INBOX, keywords: { $seen: true } });
        const update = await own.client.method('Email/set', { update: { [moved.id]: { mailboxIds: { [own.mb.INBOX]: true } } } });
        expect(update.updated, JSON.stringify(update)).to.have.property(moved.id);
        // an older WildDuck left no mark, only its armor comment
        const legacy = await h.createDraft(own, { mailbox: own.mb.INBOX, keywords: { $seen: true } });
        const legacyDoc = await docOf(own, legacy.id);
        await db.collection('messages').updateOne({ _id: legacyDoc._id, mailbox: legacyDoc.mailbox, uid: legacyDoc.uid }, { $unset: { encryptedAtRest: '' } });

        for (const email of [added, moved]) {
            const doc = await docOf(own, email.id);
            expect(doc.encryptedAtRest, email.id).to.equal(true);
            expect(doc.mimeTree.parsedHeader['content-type'].value).to.equal('multipart/encrypted');
        }
        expect((await docOf(own, legacy.id)).encryptedAtRest).to.equal(undefined);
        expect(await rawOf(own, legacy.blobId)).to.include('Comment: Plaintext message encrypted by WildDuck Mail Server');

        const counter = await h.recipientsUsed(own);
        for (const email of [added, moved, legacy]) {
            const error = h.expectNotCreated(await h.submitEmail(own, email.id), 'invalidEmail');
            expect(error.properties, email.id).to.deep.equal(['emailId']);
            expect(error.description).to.match(/stored encrypted/);
            expect(error.description).to.match(/can not be sent/);
        }
        await h.expectNothingQueued(own, [], counter);
    });

    scenario('SUB-143', async () => {
        const own = await h.sender();
        const armored = [
            '-----BEGIN PGP MESSAGE-----',
            'Comment: Encrypted by the client for the recipient',
            '',
            'hQEMA0Wn4xyP7k1bAQf/client+ciphertext',
            '=Ab12',
            '-----END PGP MESSAGE-----'
        ];
        const raw = Buffer.from(
            [
                `From: ${own.user.address}`,
                'To: rcpt@example.net',
                'Subject: client encrypted',
                'MIME-Version: 1.0',
                'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc1"',
                '',
                '--enc1',
                'Content-Type: application/pgp-encrypted',
                '',
                'Version: 1',
                '',
                '--enc1',
                'Content-Type: application/octet-stream; name="encrypted.asc"',
                '',
                ...armored,
                '--enc1--',
                ''
            ].join('\r\n')
        );
        const id = await h.appendRaw(own, raw);
        expect((await docOf(own, id)).encryptedAtRest).to.equal(undefined);
        const created = h.expectCreated(await h.submitEmail(own, id));
        const queued = (await outbound.message(await h.queueIdOf(created.id))).toString('binary');
        expect(queued).to.match(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"; boundary="enc1"\r$/m);
        expect(bodyOf(queued)).to.equal(bodyOf(raw.toString('binary')));
    });
});
