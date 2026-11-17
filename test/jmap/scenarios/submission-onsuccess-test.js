/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before */
'use strict';

// Catalogue file submission.yaml: onSuccessUpdateEmail and onSuccessDestroyEmail, answered as an
// implicit Email/set right after the EmailSubmission/set response (RFC 8621 7.5).

const crypto = require('crypto');
const { expect } = require('chai');
const { scenario, seed, outbound } = require('../harness');
const h = require('./submission-helpers');

/** The patch that files a sent draft: out of Drafts, into Sent, $draft cleared */
const toSent = ctx => ({ [`mailboxIds/${ctx.mb.Drafts}`]: null, [`mailboxIds/${ctx.mb.Sent}`]: true, 'keywords/$draft': null });

const create = (ctx, emailId, extra = {}) => Object.assign({ identityId: ctx.identity.id, emailId }, extra);

/** EmailSubmission/set in its own request (call id c1); answers the methodResponses */
const setCall = (ctx, args) => h.calls(ctx, [['EmailSubmission/set', args, 'c1']]);

const counts = async (ctx, ids) => {
    const { list } = await ctx.client.method('Mailbox/get', { ids, properties: ['totalEmails'] });
    return Object.fromEntries(list.map(entry => [entry.id, entry.totalEmails]));
};

describe('EmailSubmission onSuccess', function () {
    this.timeout(60000);

    let ctx;
    before(async () => {
        ctx = await h.sender();
    });

    scenario('SUB-070', async () => {
        const draft = await h.createDraft(ctx);
        const responses = await setCall(ctx, { create: { s1: create(ctx, draft.id) }, onSuccessUpdateEmail: { '#s1': toSent(ctx) } });
        expect(responses.map(([name, , callId]) => [name, callId])).to.deep.equal([
            ['EmailSubmission/set', 'c1'],
            ['Email/set', 'c1']
        ]);
        h.expectCreated(responses[0][1]);
        const emailSet = responses[1][1];
        expect(emailSet.updated).to.have.property(draft.id);
        expect(emailSet.accountId).to.equal(ctx.client.accountId);
        expect(emailSet.oldState).to.be.a('string');
        expect(emailSet.newState).to.be.a('string').and.not.equal(emailSet.oldState);
        const email = await h.emailOf(ctx, draft.id, ['mailboxIds', 'keywords']);
        expect(email.id).to.equal(draft.id);
        expect(email.mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
        expect(email.keywords).to.not.have.property('$draft');
    });

    scenario('SUB-071', async () => {
        const draft = await h.createDraft(ctx);
        const responses = await h.calls(ctx, [
            ['Mailbox/get', { ids: [ctx.mb.Sent], properties: ['name'] }, 'c0'],
            ['EmailSubmission/set', { create: { s1: create(ctx, draft.id) }, onSuccessUpdateEmail: { '#s1': toSent(ctx) } }, 'c1'],
            ['Email/get', { ids: [draft.id], properties: ['mailboxIds', 'keywords'] }, 'c2']
        ]);
        expect(responses.map(([name, , callId]) => `${name} ${callId}`)).to.deep.equal([
            'Mailbox/get c0',
            'EmailSubmission/set c1',
            'Email/set c1',
            'Email/get c2'
        ]);
        expect(responses[3][1].list[0].mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
    });

    scenario('SUB-072', async () => {
        for (const extra of [{}, { onSuccessUpdateEmail: null, onSuccessDestroyEmail: null }, { onSuccessUpdateEmail: {}, onSuccessDestroyEmail: [] }]) {
            const draft = await h.createDraft(ctx);
            const responses = await setCall(ctx, Object.assign({ create: { s1: create(ctx, draft.id) } }, extra));
            expect(responses).to.have.length(1);
            expect(responses[0][0]).to.equal('EmailSubmission/set');
            h.expectCreated(responses[0][1]);
        }
    });

    scenario('SUB-073', async () => {
        const draft = await h.createDraft(ctx, { to: null });
        for (const extra of [{ onSuccessUpdateEmail: { '#s1': toSent(ctx) } }, { onSuccessDestroyEmail: ['#s1'] }]) {
            const responses = await setCall(ctx, Object.assign({ create: { s1: create(ctx, draft.id) } }, extra));
            expect(responses).to.have.length(1);
            h.expectNotCreated(responses[0][1], 'noRecipients');
            const email = await h.emailOf(ctx, draft.id, ['mailboxIds', 'keywords']);
            expect(email.mailboxIds).to.deep.equal({ [ctx.mb.Drafts]: true });
            expect(email.keywords).to.include({ $draft: true });
        }
    });

    scenario('SUB-074', async () => {
        const d1 = await h.createDraft(ctx);
        const d2 = await h.createDraft(ctx, { to: null });
        const responses = await setCall(ctx, {
            create: { s1: create(ctx, d1.id), s2: create(ctx, d2.id) },
            onSuccessUpdateEmail: { '#s1': toSent(ctx), '#s2': toSent(ctx) }
        });
        expect(responses).to.have.length(2);
        const emailSet = responses[1][1];
        expect(Object.keys(emailSet.updated)).to.deep.equal([d1.id]);
        expect(emailSet.notUpdated).to.equal(null);
        expect((await h.emailOf(ctx, d2.id, ['mailboxIds'])).mailboxIds).to.deep.equal({ [ctx.mb.Drafts]: true });
    });

    scenario('SUB-075', async () => {
        const draft = await h.createDraft(ctx);
        const { threadId } = await h.emailOf(ctx, draft.id, ['threadId']);
        const responses = await setCall(ctx, { create: { s1: create(ctx, draft.id) }, onSuccessDestroyEmail: ['#s1'] });
        const created = h.expectCreated(responses[0][1]);
        expect(responses[1][0]).to.equal('Email/set');
        expect(responses[1][1].destroyed).to.deep.equal([draft.id]);
        expect((await ctx.client.method('Email/get', { ids: [draft.id] })).notFound).to.deep.equal([draft.id]);
        const queueId = await h.queueIdOf(created.id);
        expect(await outbound.entries(queueId)).to.have.length(1);
        expect(await outbound.message(queueId)).to.be.instanceOf(Buffer);
        const submission = await h.getSubmission(ctx, created.id);
        expect(submission).to.include({ emailId: draft.id, threadId });
    });

    scenario('SUB-076', async () => {
        const d1 = await h.createDraft(ctx);
        const d2 = await h.createDraft(ctx);
        const responses = await setCall(ctx, {
            create: { s1: create(ctx, d1.id), s2: create(ctx, d2.id) },
            onSuccessUpdateEmail: { '#s1': toSent(ctx) },
            onSuccessDestroyEmail: ['#s2']
        });
        expect(responses.map(([name]) => name)).to.deep.equal(['EmailSubmission/set', 'Email/set']);
        expect(Object.keys(responses[1][1].updated)).to.deep.equal([d1.id]);
        expect(responses[1][1].destroyed).to.deep.equal([d2.id]);
    });

    scenario('SUB-077', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        for (const extra of [{ onSuccessUpdateEmail: { '#other': toSent(own) } }, { onSuccessDestroyEmail: ['#other'] }]) {
            const responses = await setCall(own, Object.assign({ create: { s1: create(own, draft.id) } }, extra));
            expect(responses).to.have.length(1);
            expect(responses[0][0]).to.equal('error');
            expect(responses[0][1].type).to.equal('invalidArguments');
        }
        expect((await h.call(own, 'EmailSubmission/get', {})).list).to.deep.equal([]);
        await h.expectNothingQueued(own, []);
    });

    scenario('SUB-078', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const existing = h.expectCreated(await h.submitEmail(own, (await h.createDraft(own)).id)).id;
        const queued = await h.queuedMessages(own);
        const state = await h.submissionState(own);
        const before = await h.emailOf(own, draft.id, ['mailboxIds', 'keywords']);
        const variants = [
            { onSuccessUpdateEmail: { s1: toSent(own) } },
            { onSuccessUpdateEmail: { S0123456789abcdef01234567: toSent(own) } },
            { onSuccessUpdateEmail: { [existing]: toSent(own) } },
            { onSuccessUpdateEmail: [toSent(own)] },
            { onSuccessUpdateEmail: { '#s1': 'not a patch' } },
            { onSuccessDestroyEmail: '#s1' }
        ];
        for (const extra of variants) {
            const responses = await setCall(own, Object.assign({ create: { s1: create(own, draft.id) } }, extra));
            expect(responses, JSON.stringify(extra)).to.have.length(1);
            expect(responses[0][1].type).to.equal('invalidArguments');
        }
        expect(await h.queuedMessages(own)).to.deep.equal(queued);
        expect(await h.submissionState(own)).to.equal(state);
        expect(await h.emailOf(own, draft.id, ['mailboxIds', 'keywords'])).to.deep.equal(before);
    });

    scenario('SUB-079', async () => {
        const creationId = crypto.randomBytes(200).toString('base64url').slice(0, 255);
        expect(creationId).to.have.length(255);
        const d1 = await h.createDraft(ctx);
        const updateRun = await setCall(ctx, { create: { [creationId]: create(ctx, d1.id) }, onSuccessUpdateEmail: { [`#${creationId}`]: toSent(ctx) } });
        h.expectCreated(updateRun[0][1], creationId);
        expect(updateRun[1][1].updated).to.have.property(d1.id);
        const d2 = await h.createDraft(ctx);
        const destroyRun = await setCall(ctx, { create: { [creationId]: create(ctx, d2.id) }, onSuccessDestroyEmail: [`#${creationId}`] });
        h.expectCreated(destroyRun[0][1], creationId);
        expect(destroyRun[1][1].destroyed).to.deep.equal([d2.id]);
    });

    scenario('SUB-080', async () => {
        const draft = await h.createDraft(ctx);
        const patch = { 'mailboxIds/F0123456789abcdef01234567': true, [`mailboxIds/${ctx.mb.Drafts}`]: null };
        const responses = await setCall(ctx, { create: { s1: create(ctx, draft.id) }, onSuccessUpdateEmail: { '#s1': patch } });
        const created = h.expectCreated(responses[0][1]);
        expect(await outbound.entries(await h.queueIdOf(created.id))).to.have.length(1);
        expect(responses[1][1].notUpdated[draft.id].type).to.equal('invalidProperties');
        expect((await h.emailOf(ctx, draft.id, ['mailboxIds'])).mailboxIds).to.deep.equal({ [ctx.mb.Drafts]: true });
    });

    scenario('SUB-081', async () => {
        const draft = await h.createDraft(ctx);
        const responses = await setCall(ctx, {
            create: { s1: create(ctx, draft.id) },
            onSuccessUpdateEmail: { '#s1': { [`mailboxIds/${ctx.mb.Sent}`]: true, 'keywords/$draft': null } }
        });
        const created = h.expectCreated(responses[0][1]);
        expect(await outbound.entries(await h.queueIdOf(created.id))).to.have.length(1);
        expect(responses[1][1].notUpdated[draft.id].type).to.equal('tooManyMailboxes');
        const email = await h.emailOf(ctx, draft.id, ['mailboxIds', 'keywords']);
        expect(email.mailboxIds).to.deep.equal({ [ctx.mb.Drafts]: true });
        expect(email.keywords).to.include({ $draft: true });
    });

    scenario('SUB-082', async () => {
        const draft = await h.createDraft(ctx, { keywords: { $draft: true, $seen: true } });
        const properties = ['blobId', 'threadId', 'receivedAt'];
        const before = await h.emailOf(ctx, draft.id, properties);
        const responses = await setCall(ctx, {
            create: { s1: create(ctx, draft.id) },
            onSuccessUpdateEmail: { '#s1': { mailboxIds: { [ctx.mb.Sent]: true }, keywords: { $seen: true } } }
        });
        expect(responses[1][1].updated).to.have.property(draft.id);
        const email = await h.emailOf(ctx, draft.id, properties.concat('mailboxIds', 'keywords'));
        expect(email.mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
        expect(email.keywords).to.deep.equal({ $seen: true });
        for (const property of properties) {
            expect(email[property], property).to.equal(before[property]);
        }
    });

    scenario('SUB-083', async () => {
        const own = await h.sender();
        const upload = await own.client.raw(`/jmap/upload/${own.client.accountId}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/pdf' },
            body: crypto.randomBytes(1000)
        });
        const draft = await h.createDraft(own, {
            bcc: 'hidden@example.net',
            extra: { attachments: [{ blobId: upload.json.blobId, type: 'application/pdf', name: 'a.pdf' }] }
        });
        const draftView = await h.emailOf(own, draft.id, ['hasAttachment', 'bcc']);
        const before = await counts(own, [own.mb.Sent, own.mb.Drafts]);
        const responses = await setCall(own, { create: { s1: create(own, draft.id) }, onSuccessUpdateEmail: { '#s1': toSent(own) } });
        const created = h.expectCreated(responses[0][1]);
        await h.deliverSubmission(created.id);
        expect(await h.queuedMessages(own)).to.deep.equal([]);
        const after = await counts(own, [own.mb.Sent, own.mb.Drafts]);
        expect(after[own.mb.Sent]).to.equal(before[own.mb.Sent] + 1);
        expect(after[own.mb.Drafts]).to.equal(before[own.mb.Drafts] - 1);
        const { ids } = await own.client.method('Email/query', { filter: { inMailbox: own.mb.Sent } });
        expect(ids).to.deep.equal([draft.id]);
        await seed.withImap(own.user, async imap => {
            expect((await imap.mailboxOpen('Sent Mail')).exists).to.equal(1);
        });
        const sentView = await h.emailOf(own, draft.id, ['hasAttachment', 'bcc']);
        expect(sentView).to.deep.equal(draftView);
        expect(sentView.bcc).to.deep.equal([{ name: null, email: 'hidden@example.net' }]);
    });

    scenario('SUB-084', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const e1 = (await own.client.method('Email/get', { ids: [] })).state;
        const before = await counts(own, [own.mb.Sent, own.mb.Drafts]);
        const responses = await setCall(own, { create: { s1: create(own, draft.id) }, onSuccessUpdateEmail: { '#s1': toSent(own) } });
        const implicit = responses[1][1];
        expect(implicit.oldState).to.equal(e1);
        const current = (await own.client.method('Email/get', { ids: [] })).state;
        expect(implicit.newState).to.equal(current);
        const changes = await own.client.method('Email/changes', { sinceState: e1 });
        expect(changes).to.deep.include({ created: [], updated: [draft.id], destroyed: [] });
        const mailboxChanges = await own.client.method('Mailbox/changes', { sinceState: e1 });
        expect(mailboxChanges.updated.sort()).to.deep.equal([own.mb.Drafts, own.mb.Sent].sort());
        const after = await counts(own, [own.mb.Sent, own.mb.Drafts]);
        expect(after[own.mb.Sent]).to.equal(before[own.mb.Sent] + 1);
        expect(after[own.mb.Drafts]).to.equal(before[own.mb.Drafts] - 1);
    });

    scenario('SUB-085', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const other = await h.createDraft(own, { subject: 'unrelated' });
        const s1 = await h.submissionState(own);
        const e1 = (await own.client.method('Email/get', { ids: [] })).state;
        const responses = await setCall(own, { create: { s1: create(own, draft.id) }, onSuccessUpdateEmail: { '#s1': toSent(own) } });
        const submission = responses[0][1];
        expect(submission.oldState).to.equal(s1);
        const s2 = submission.newState;
        expect(s2).to.not.equal(s1);
        expect(responses[1][1].oldState).to.equal(e1);
        expect(responses[1][1].newState).to.not.equal(s2);
        await own.client.method('Email/set', { update: { [other.id]: { 'keywords/$flagged': true } } });
        expect((await own.client.method('Email/get', { ids: [] })).state).to.not.equal(responses[1][1].newState);
        expect(await h.submissionState(own)).to.equal(s2);
    });

    scenario('SUB-086', async () => {
        const draft = await h.createDraft(ctx);
        const envelope = { mailFrom: { email: ctx.user.address, parameters: { HOLDFOR: '3600' } }, rcptTo: [{ email: 'r@example.net' }] };
        const first = await setCall(ctx, { create: { s1: create(ctx, draft.id, { envelope }) }, onSuccessUpdateEmail: { '#s1': toSent(ctx) } });
        const x = h.expectCreated(first[0][1]).id;
        expect((await h.emailOf(ctx, draft.id, ['mailboxIds'])).mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
        const responses = await setCall(ctx, {
            update: { [x]: { undoStatus: 'canceled' } },
            onSuccessUpdateEmail: { [x]: { mailboxIds: { [ctx.mb.Drafts]: true }, 'keywords/$draft': true } }
        });
        expect(responses[0][1].updated).to.have.property(x);
        expect(responses[1][0]).to.equal('Email/set');
        expect(responses[1][1].updated).to.have.property(draft.id);
        const email = await h.emailOf(ctx, draft.id, ['mailboxIds', 'keywords']);
        expect(email.mailboxIds).to.deep.equal({ [ctx.mb.Drafts]: true });
        expect(email.keywords).to.include({ $draft: true });
    });

    scenario('SUB-087', async () => {
        const draft = await h.createDraft(ctx);
        const first = await setCall(ctx, { create: { s1: create(ctx, draft.id) }, onSuccessUpdateEmail: { '#s1': toSent(ctx) } });
        const x = h.expectCreated(first[0][1]).id;
        await outbound.lock(await h.queueIdOf(x));
        expect((await h.getSubmission(ctx, x)).undoStatus).to.equal('final');
        const responses = await setCall(ctx, {
            update: { [x]: { undoStatus: 'canceled' } },
            onSuccessUpdateEmail: { [x]: { mailboxIds: { [ctx.mb.Drafts]: true } } }
        });
        expect(responses).to.have.length(1);
        expect(responses[0][1].notUpdated[x].type).to.equal('cannotUnsend');
        expect((await h.emailOf(ctx, draft.id, ['mailboxIds'])).mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
    });

    scenario('SUB-088', async () => {
        for (const destroyedBefore of [false, true]) {
            const draft = await h.createDraft(ctx);
            const x = h.expectCreated(await h.submitEmail(ctx, draft.id)).id;
            await outbound.remove(await h.queueIdOf(x));
            expect((await h.getSubmission(ctx, x)).undoStatus).to.equal('final');
            if (destroyedBefore) {
                await ctx.client.method('Email/set', { destroy: [draft.id] });
            }
            const responses = await setCall(ctx, { destroy: [x], onSuccessDestroyEmail: [x] });
            expect(responses[0][1].destroyed).to.deep.equal([x]);
            expect(responses[1][0]).to.equal('Email/set');
            if (destroyedBefore) {
                expect(responses[1][1].notDestroyed[draft.id].type).to.equal('notFound');
            } else {
                expect(responses[1][1].destroyed).to.deep.equal([draft.id]);
            }
            expect((await h.call(ctx, 'EmailSubmission/get', { ids: [x] })).notFound).to.deep.equal([x]);
        }
    });

    scenario('SUB-089', async () => {
        const draft = await h.createDraft(ctx);
        const responses = await h.calls(ctx, [
            ['EmailSubmission/set', { create: { s1: create(ctx, draft.id) } }, 'c0'],
            ['EmailSubmission/get', { ids: ['#s1'] }, 'c1']
        ]);
        const created = h.expectCreated(responses[0][1]);
        expect(responses[1][1].list.map(entry => entry.id)).to.deep.equal([created.id]);
        expect(responses[1][1].notFound).to.deep.equal([]);
    });

    scenario('SUB-090', async () => {
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
                            subject: 'One request',
                            textBody: [{ partId: 't', type: 'text/plain' }],
                            bodyValues: { t: { value: 'Hello' } }
                        }
                    }
                },
                'c0'
            ],
            ['EmailSubmission/set', { create: { s1: { emailId: '#m1', identityId: own.identity.id } }, onSuccessUpdateEmail: { '#s1': toSent(own) } }, 'c1'],
            ['Email/get', { ids: ['#m1'], properties: ['mailboxIds', 'keywords'] }, 'c2']
        ]);
        expect(responses.map(([name]) => name)).to.deep.equal(['Email/set', 'EmailSubmission/set', 'Email/set', 'Email/get']);
        const [email] = responses[3][1].list;
        expect(email.mailboxIds).to.deep.equal({ [own.mb.Sent]: true });
        expect(email.keywords).to.not.have.property('$draft');
        expect(await h.queuedMessages(own)).to.have.length(1);
    });
});
