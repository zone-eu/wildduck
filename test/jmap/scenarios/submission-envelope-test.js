/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before */
'use strict';

// Catalogue file submission.yaml, EmailSubmission/set create (RFC 8621 7.5): the envelope derived
// from the message header or given by the client, and the references to the identity and the Email.

const { expect } = require('chai');
const { scenario, accounts, seed, outbound, clock } = require('../harness');
const h = require('./submission-helpers');

describe('EmailSubmission envelope', function () {
    this.timeout(60000);

    let ctx;
    before(async () => {
        ctx = await h.sender();
    });

    scenario('SUB-013', async () => {
        const draft = await h.createDraft(ctx, { to: 't@example.net', cc: 'c@example.net', bcc: 'b@example.net' });
        for (const extra of [{}, { envelope: null }]) {
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id, extra));
            const { envelope } = await h.getSubmission(ctx, created.id);
            expect(envelope.mailFrom.email).to.equal(ctx.user.address);
            expect(envelope.mailFrom.parameters ?? null).to.equal(null);
            expect(envelope.rcptTo.map(address => address.email).sort()).to.deep.equal(['b@example.net', 'c@example.net', 't@example.net']);
            expect(envelope.rcptTo.every(address => (address.parameters ?? null) === null)).to.be.true;
            const queueId = await h.queueIdOf(created.id);
            expect((await outbound.entries(queueId)).map(entry => entry.recipient).sort()).to.deep.equal(['b@example.net', 'c@example.net', 't@example.net']);
            expect((await outbound.file(queueId)).metadata.data.from).to.equal(ctx.user.address);
        }
    });

    scenario('SUB-014', async () => {
        const x = await h.sender();
        const y = await h.sender();
        const upper = x.user.address.toUpperCase();
        const draft = await h.createDraft(ctx, { to: [x.user.address, x.user.address], cc: upper, bcc: [x.user.address, y.user.address] });
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
        const { envelope } = await h.getSubmission(ctx, created.id);
        expect(envelope.rcptTo.map(address => address.email.toLowerCase()).sort()).to.deep.equal([x.user.address, y.user.address].sort());
        const queueId = await h.queueIdOf(created.id);
        expect((await outbound.entries(queueId)).map(entry => entry.recipient.toLowerCase()).sort()).to.deep.equal([x.user.address, y.user.address].sort());
        await outbound.deliver(queueId);
        await clock.waitFor(async () => (await h.inbox(y)).length === 1);
        expect(await h.inbox(x)).to.have.length(1);
    });

    scenario('SUB-015', async () => {
        const id = await h.appendRaw(ctx, [`From: ${ctx.user.address}`, 'To: Team: a@example.net, b@example.org;', 'Cc: Empty: ;', 'Subject: group']);
        const created = h.expectCreated(await h.submitEmail(ctx, id));
        const { envelope } = await h.getSubmission(ctx, created.id);
        expect(envelope.rcptTo.map(address => address.email).sort()).to.deep.equal(['a@example.net', 'b@example.org']);
    });

    scenario('SUB-016', async () => {
        const own = await h.sender();
        const domain = `${h.unique('wild')}.example`;
        await h.addAddress(own, `${h.unique('b')}@example.com`);
        await h.addAddress(own, `*@${domain}`, { allowWildcard: true });
        const first = await h.createDraft(own, { from: own.user.address, sender: own.user.address });
        const firstFrom = (await h.getSubmission(own, h.expectCreated(await h.submitEmail(own, first.id)).id)).envelope.mailFrom;
        expect(firstFrom.email).to.equal(own.user.address);
        expect(firstFrom.parameters ?? null).to.equal(null);
        const wildcard = await h.identityOf(own, `*@${domain}`);
        const second = await h.createDraft(own, { from: `x@${domain}`, sender: `y@${domain}` });
        const mailFrom = (await h.getSubmission(own, h.expectCreated(await h.submitEmail(own, second.id, { identityId: wildcard.id })).id)).envelope.mailFrom;
        expect(mailFrom.email).to.equal(`y@${domain}`);
        expect(mailFrom.parameters ?? null).to.equal(null);
    });

    scenario('SUB-017', async () => {
        const own = await h.sender();
        const b = `${h.unique('b')}@example.com`;
        await h.addAddress(own, b);
        const draft = await h.createDraft(own, { from: own.user.address, sender: b });
        const created = h.expectCreated(await h.submitEmail(own, draft.id));
        expect((await h.getSubmission(own, created.id)).envelope.mailFrom.email).to.equal(own.user.address);
    });

    scenario('SUB-018', async () => {
        const other = await accounts.createUser();
        const before = await h.queuedMessages(ctx);
        const cases = [
            [[`From: ${ctx.user.address}, ${other.address}`, 'To: r@example.net'], 'from'],
            [[`From: ${ctx.user.address}`, `From: ${ctx.user.address}`, 'To: r@example.net'], 'from'],
            [[`From: ${ctx.user.address}`, `Sender: ${ctx.user.address}`, `Sender: ${ctx.user.address}`, 'To: r@example.net'], 'sender']
        ];
        for (const [headers, property] of cases) {
            const id = await h.appendRaw(ctx, headers.concat('Subject: several'));
            const error = h.expectNotCreated(await h.submitEmail(ctx, id), 'invalidEmail');
            expect(error.properties).to.deep.equal([property]);
        }
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-019', async () => {
        const r1 = await h.sender();
        const r2 = await h.sender();
        const draft = await h.createDraft(ctx, { to: 't@example.net', subject: 'Explicit envelope' });
        const envelope = { mailFrom: { email: ctx.user.address }, rcptTo: [{ email: r1.user.address }, { email: r2.user.address }] };
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope }));
        const queueId = await h.queueIdOf(created.id);
        expect((await outbound.entries(queueId)).map(entry => entry.recipient).sort()).to.deep.equal([r1.user.address, r2.user.address].sort());
        expect(await outbound.deliver(queueId)).to.have.length(2);
        for (const r of [r1, r2]) {
            const [id] = await clock.waitFor(() => h.inbox(r).then(ids => (ids.length ? ids : null)));
            const received = await h.emailOf(r, id, ['to', 'subject']);
            expect(received.to).to.deep.equal([{ name: null, email: 't@example.net' }]);
            expect(received.subject).to.equal('Explicit envelope');
        }
        expect((await h.getSubmission(ctx, created.id)).envelope).to.deep.equal(envelope);
    });

    scenario('SUB-020', async () => {
        const draft = await h.createDraft(ctx);
        const envelope = {
            mailFrom: { email: ctx.user.address },
            rcptTo: [{ email: 'same@example.net' }, { email: 'same@example.net' }, { email: 'Same@Example.NET' }]
        };
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope }));
        const entries = await outbound.entries(await h.queueIdOf(created.id));
        expect(entries).to.have.length(1);
        expect(entries[0].recipient.toLowerCase()).to.equal('same@example.net');
    });

    scenario('SUB-021', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const mailFrom = { email: ctx.user.address };
        const rcptTo = [{ email: 'r@example.net' }];
        const bad = [
            'envelope',
            { rcptTo },
            { mailFrom },
            { mailFrom: ctx.user.address, rcptTo },
            { mailFrom, rcptTo: { email: 'r@example.net' } },
            { mailFrom, rcptTo: [{ parameters: null }] },
            { mailFrom, rcptTo, extra: true },
            { mailFrom: { email: ctx.user.address, name: 'x' }, rcptTo }
        ];
        for (const envelope of bad) {
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'invalidProperties'), ['envelope']);
        }
        await h.expectNothingQueued(ctx, before);
        for (const parameters of [null, undefined, {}]) {
            const envelope = { mailFrom: Object.assign({}, mailFrom, parameters === undefined ? {} : { parameters }), rcptTo };
            h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope }));
        }
    });

    scenario('SUB-022', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        h.expectProperties(h.expectNotCreated(await h.submit(ctx, { emailId: draft.id }), 'invalidProperties'), ['identityId']);
        h.expectProperties(h.expectNotCreated(await h.submit(ctx, { emailId: draft.id, identityId: null }), 'invalidProperties'), ['identityId']);
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-023', async () => {
        const own = await h.sender();
        const other = await h.sender();
        const extra = await h.call(own, 'Identity/set', { create: { x: { email: own.user.address, name: 'Extra' } } });
        const x = extra.created.x.id;
        await h.call(own, 'Identity/set', { destroy: [x] });
        const draft = await h.createDraft(own);
        for (const identityId of ['I0123456789abcdef01234567', 'bad id!', other.identity.id, x]) {
            h.expectProperties(h.expectNotCreated(await h.submit(own, { identityId, emailId: draft.id }), 'invalidProperties'), ['identityId']);
        }
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-024', async () => {
        const own = await h.sender();
        const other = await h.sender();
        const foreign = await h.createDraft(other);
        const destroyed = await h.createDraft(own);
        await own.client.method('Email/set', { destroy: [destroyed.id] });
        const flagged = await h.appendRaw(own, [`From: ${own.user.address}`, 'To: r@example.net', 'Subject: deleted']);
        await seed.withImap(own.user, async imap => {
            await imap.mailboxOpen('Drafts');
            await imap.messageFlagsAdd({ all: true }, ['\\Deleted']);
        });
        h.expectProperties(h.expectNotCreated(await h.submit(own, { identityId: own.identity.id }), 'invalidProperties'), ['emailId']);
        for (const emailId of ['M0123456789abcdef01234567', 'not an id', foreign.id, destroyed.id, flagged]) {
            h.expectProperties(h.expectNotCreated(await h.submit(own, { identityId: own.identity.id, emailId }), 'invalidProperties'), ['emailId']);
        }
        await h.expectNothingQueued(own, []);
        await h.expectNothingQueued(other, []);
    });

    scenario('SUB-025', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const base = { identityId: ctx.identity.id, emailId: draft.id };
        const cases = [
            ['bogus', 1],
            ['id', 'S0123456789abcdef01234567'],
            ['threadId', 'T0123456789abcdef01234567'],
            ['sendAt', '2030-01-01T00:00:00Z'],
            ['undoStatus', 'canceled'],
            ['deliveryStatus', { 'r@example.net': { smtpReply: '250 2.0.0 ok', delivered: 'yes', displayed: 'yes' } }],
            ['dsnBlobIds', ['Bm0123456789abcdef01234567']],
            ['mdnBlobIds', ['Bm0123456789abcdef01234567']]
        ];
        for (const [property, value] of cases) {
            h.expectProperties(h.expectNotCreated(await h.submit(ctx, Object.assign({}, base, { [property]: value })), 'invalidProperties'), [property]);
        }
        await h.expectNothingQueued(ctx, before);
        const { threadId } = await h.emailOf(ctx, draft.id, ['threadId']);
        h.expectCreated(await h.submit(ctx, Object.assign({}, base, { threadId })));
    });

    scenario('SUB-026', async () => {
        const own = await h.sender();
        const responses = await h.calls(own, [
            [
                'Email/set',
                {
                    create: {
                        m1: {
                            mailboxIds: { [own.mb.Drafts]: true },
                            keywords: { $draft: true },
                            from: [{ email: own.user.address }],
                            to: [{ email: 'r@example.net' }],
                            subject: 'Created and sent',
                            textBody: [{ partId: 't', type: 'text/plain' }],
                            bodyValues: { t: { value: 'Hello' } }
                        }
                    }
                },
                'c0'
            ],
            ['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: '#m1' } } }, 'c1']
        ]);
        const emailId = responses[0][1].created.m1.id;
        const created = h.expectCreated(responses[1][1]);
        expect((await h.getSubmission(own, created.id)).emailId).to.equal(emailId);
        expect(await h.queuedMessages(own)).to.have.length(1);
    });

    scenario('SUB-027', async () => {
        const own = await h.sender();
        const responses = await h.calls(own, [
            ['Email/set', { create: { m1: { mailboxIds: { F0123456789abcdef01234567: true }, subject: 'x' } } }, 'c0'],
            ['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: '#m1' } } }, 'c1']
        ]);
        expect(responses[0][1].notCreated).to.have.property('m1');
        h.expectProperties(h.expectNotCreated(responses[1][1], 'invalidProperties'), ['emailId']);
        const [[, alone]] = await h.calls(own, [['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: '#m1' } } }, 'c0']]);
        h.expectProperties(h.expectNotCreated(alone, 'invalidProperties'), ['emailId']);
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-028', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const responses = await h.calls(own, [
            ['Identity/set', { create: { i1: { email: own.user.address, name: 'Created now' } } }, 'c0'],
            ['EmailSubmission/set', { create: { s1: { identityId: '#i1', emailId: draft.id } } }, 'c1']
        ]);
        const identityId = responses[0][1].created.i1.id;
        const created = h.expectCreated(responses[1][1]);
        expect((await h.getSubmission(own, created.id)).identityId).to.equal(identityId);
    });
});
