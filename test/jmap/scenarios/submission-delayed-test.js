/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before */
'use strict';

// Catalogue file submission.yaml: delayed send with the FUTURERELEASE hold parameters (RFC 4865,
// RFC 8621 7), undo (undoStatus canceled), destroying submissions, and how the REST outbound queue
// routes and EmailSubmission see each other. Also ESET-087.

const { expect } = require('chai');
const { scenario, api, seed, outbound, clock } = require('../harness');
const { startInstance, stopInstance } = require('../harness/instance');
const h = require('./submission-helpers');

const MAX_DELAYED_SEND = 2592000;
const utc = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const held = (ctx, parameters, rcptTo = ['r@example.net']) => ({ mailFrom: { email: ctx.user.address, parameters }, rcptTo: rcptTo.map(email => ({ email })) });
const toSent = ctx => ({ [`mailboxIds/${ctx.mb.Drafts}`]: null, [`mailboxIds/${ctx.mb.Sent}`]: true, 'keywords/$draft': null });

/** A pending delayed submission of a new draft; answers {draft, id, queueId} */
async function delayed(ctx, options = {}) {
    const draft = await h.createDraft(ctx, { to: options.to || 'r@example.net', subject: options.subject });
    const rcptTo = [].concat(options.to || 'r@example.net');
    const envelope = held(ctx, { HOLDFOR: String(options.hold || 3600) }, rcptTo);
    const created = h.expectCreated(
        await h.submissionSet(ctx, Object.assign({ create: { s1: { identityId: ctx.identity.id, emailId: draft.id, envelope } } }, options.args))
    );
    return { draft, id: created.id, created, queueId: await h.queueIdOf(created.id) };
}

/**
 * A delayed submission whose release time has come and whose queue entries the MTA locked. The MTA
 * takes due entries only, so a submission is looked at from its release on.
 */
async function started(ctx, options = {}) {
    const submission = await delayed(ctx, Object.assign({ hold: 1 }, options));
    await clock.delay(1100);
    await outbound.lock(submission.queueId);
    return submission;
}

/** The REST view of the message of an Email */
async function restMessage(ctx, emailId) {
    const doc = await (await seed.db()).collection('messages').findOne({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(emailId.slice(1)) });
    return api('GET', `/users/${ctx.user.id}/mailboxes/${doc.mailbox}/messages/${doc.uid}`);
}

describe('EmailSubmission delayed send and undo', function () {
    this.timeout(60000);

    let ctx;
    before(async () => {
        ctx = await h.sender();
    });

    scenario('SUB-091', async () => {
        for (const name of ['holdfor', 'HOLDFOR']) {
            const draft = await h.createDraft(ctx);
            const start = Date.now();
            const envelope = held(ctx, { [name]: '3600' });
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope }));
            const submission = await h.getSubmission(ctx, created.id);
            expect(Math.abs(new Date(submission.sendAt).getTime() - (start + 3600 * 1000))).to.be.below(5000);
            expect(submission.undoStatus).to.equal('pending');
            expect(submission.envelope).to.deep.equal(envelope);
            const [entry] = await outbound.entries(await h.queueIdOf(created.id));
            expect(new Date(entry.queued).getTime()).to.equal(new Date(submission.sendAt).getTime());
        }
    });

    scenario('SUB-092', async () => {
        const draft = await h.createDraft(ctx);
        const until = utc(Date.now() + 2 * 3600 * 1000);
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope: held(ctx, { holduntil: until }) }));
        const submission = await h.getSubmission(ctx, created.id);
        expect(submission.sendAt).to.equal(until);
        expect(submission.undoStatus).to.equal('pending');
        const [entry] = await outbound.entries(await h.queueIdOf(created.id));
        expect(new Date(entry.queued).toISOString()).to.equal(new Date(until).toISOString());
    });

    scenario('SUB-093', async () => {
        const b = await h.sender();
        const { id, queueId } = await delayed(ctx, { to: b.user.address, hold: 2, subject: 'Held briefly' });
        const s1 = await h.submissionState(ctx);
        expect(await outbound.deliver(queueId)).to.deep.equal([]);
        expect(await h.inbox(b)).to.deep.equal([]);
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('pending');
        await clock.delay(2500);
        expect(await outbound.deliver(queueId)).to.deep.equal([b.user.address]);
        expect(await h.inbox(b)).to.have.length(1);
        expect(await outbound.deliver(queueId)).to.deep.equal([]);
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('final');
        const changes = await h.call(ctx, 'EmailSubmission/changes', { sinceState: s1 });
        expect(changes.updated).to.deep.equal([id]);
    });

    scenario('SUB-094', async () => {
        const draft = await h.createDraft(ctx);
        const start = Date.now();
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope: held(ctx, { HOLDFOR: '0' }) }));
        expect(Math.abs(new Date(created.sendAt).getTime() - start)).to.be.below(3000);
        const [entry] = await outbound.entries(await h.queueIdOf(created.id));
        expect(new Date(entry.queued).getTime()).to.be.at.most(Date.now());
    });

    scenario('SUB-095', async () => {
        const session = await ctx.client.session();
        const max = session.accounts[ctx.client.accountId].accountCapabilities['urn:ietf:params:jmap:submission'].maxDelayedSend;
        expect(max).to.equal(MAX_DELAYED_SEND);
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        for (const parameters of [{ HOLDFOR: String(max + 1) }, { HOLDUNTIL: utc(Date.now() + (max + 60) * 1000) }]) {
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope: held(ctx, parameters) }), 'invalidProperties'), ['envelope']);
        }
        await h.expectNothingQueued(ctx, before);
        for (const parameters of [{ HOLDFOR: String(max) }, { HOLDUNTIL: utc(Date.now() + (max - 60) * 1000) }]) {
            h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope: held(ctx, parameters) }));
        }
    });

    scenario('SUB-096', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const values = [
            { HOLDFOR: '-1' },
            { HOLDFOR: '' },
            { HOLDFOR: ' ' },
            { HOLDFOR: '30a' },
            { HOLDFOR: null },
            { HOLDUNTIL: '' },
            { HOLDUNTIL: null },
            { HOLDUNTIL: ['2030-01-01T00:00:00Z'] },
            { HOLDUNTIL: 'tomorrow' },
            { HOLDUNTIL: utc(Date.now() + 3600 * 1000).replace('Z', '') }
        ];
        for (const parameters of values) {
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope: held(ctx, parameters) }), 'invalidProperties'), ['envelope']);
        }
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-097', async () => {
        const draft = await h.createDraft(ctx);
        const start = Date.now();
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id, { envelope: held(ctx, { HOLDUNTIL: utc(start - 3600 * 1000) }) }));
        expect(Math.abs(new Date(created.sendAt).getTime() - start)).to.be.below(3000);
        const [entry] = await outbound.entries(await h.queueIdOf(created.id));
        expect(new Date(entry.queued).getTime()).to.be.at.least(start - 3000);
        expect(new Date(entry.queued).getTime()).to.be.at.most(Date.now());
    });

    scenario('SUB-098', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const parameters = { HOLDFOR: '60', HOLDUNTIL: utc(Date.now() + 3600 * 1000) };
        h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope: held(ctx, parameters) }), 'invalidProperties'), ['envelope']);
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-099', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        for (const parameters of [{ HOLDFOR: '60' }, { holduntil: utc(Date.now() + 3600 * 1000) }]) {
            const envelope = { mailFrom: { email: ctx.user.address }, rcptTo: [{ email: 'r@example.net', parameters }] };
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'invalidProperties'), ['envelope']);
        }
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-100', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const instance = await startInstance({ submission: { maxDelayedSend: 0 } });
        try {
            const session = await own.client.raw(`${instance.url}/.well-known/jmap`);
            expect(session.json.accounts[own.client.accountId].accountCapabilities['urn:ietf:params:jmap:submission'].maxDelayedSend).to.equal(0);
            for (const parameters of [{ HOLDFOR: '60' }, { HOLDUNTIL: utc(Date.now() + 3600 * 1000) }]) {
                const [[, res]] = await h.callsAt(instance.url, own, [
                    ['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: draft.id, envelope: held(own, parameters) } } }]
                ]);
                h.expectProperties(h.expectNotCreated(res, 'invalidProperties'), ['envelope']);
            }
            await h.expectNothingQueued(own, []);
            const start = Date.now();
            const [[, res]] = await h.callsAt(instance.url, own, [
                ['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: draft.id, envelope: held(own, { HOLDFOR: '0' }) } } }]
            ]);
            const created = h.expectCreated(res);
            expect(Math.abs(new Date(created.sendAt).getTime() - start)).to.be.below(3000);
        } finally {
            await stopInstance(instance.app);
        }
    });

    scenario('SUB-101', async () => {
        const draft = await h.createDraft(ctx);
        const responses = await h.calls(ctx, [
            [
                'EmailSubmission/set',
                {
                    create: { s1: { identityId: ctx.identity.id, emailId: draft.id, envelope: held(ctx, { HOLDFOR: '3600' }) } },
                    onSuccessUpdateEmail: { '#s1': toSent(ctx) }
                },
                'c1'
            ]
        ]);
        expect(responses.map(([name]) => name)).to.deep.equal(['EmailSubmission/set', 'Email/set']);
        const created = h.expectCreated(responses[0][1]);
        expect(new Date(created.sendAt).getTime()).to.be.above(Date.now() + 3500 * 1000);
        const properties = ['mailboxIds', 'keywords', 'blobId'];
        const filed = await h.emailOf(ctx, draft.id, properties);
        expect(filed.mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
        const state = (await ctx.client.method('Email/get', { ids: [] })).state;
        await outbound.deliver(await h.queueIdOf(created.id), { force: true });
        expect(await h.emailOf(ctx, draft.id, properties)).to.deep.equal(filed);
        expect((await ctx.client.method('Email/get', { ids: [] })).state).to.equal(state);
    });

    scenario('SUB-102', async () => {
        const b = await h.sender();
        const { draft, id, queueId } = await delayed(ctx, { to: b.user.address, hold: 2, subject: 'Content at submission' });
        const original = await h.emailOf(ctx, draft.id, ['subject', 'messageId', 'threadId', 'bodyValues', 'textBody']);
        await ctx.client.method('Email/set', { update: { [draft.id]: { mailboxIds: { [ctx.mb.Archive]: true }, keywords: { $flagged: true } } } });
        await ctx.client.method('Email/set', { destroy: [draft.id] });
        await clock.delay(2500);
        expect(await outbound.deliver(queueId)).to.deep.equal([b.user.address]);
        const [received] = await h.inbox(b);
        const copy = await b.client.method('Email/get', {
            ids: [received],
            properties: ['subject', 'messageId', 'textBody', 'bodyValues'],
            fetchTextBodyValues: true
        });
        expect(copy.list[0].subject).to.equal('Content at submission');
        expect(copy.list[0].messageId).to.deep.equal(original.messageId);
        expect(Object.values(copy.list[0].bodyValues)[0].value.trim()).to.equal('Hello from a submission scenario');
        const submission = await h.getSubmission(ctx, id);
        expect(submission).to.include({ emailId: draft.id, threadId: original.threadId });
        expect(submission.undoStatus).to.equal('final');
        expect((await ctx.client.method('Email/get', { ids: [draft.id] })).notFound).to.deep.equal([draft.id]);
    });

    scenario('SUB-103', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own, { text: 'x'.repeat(20000) });
        const used = async () => (await api('GET', `/users/${own.user.id}`)).limits.quota.used;
        const before = await used();
        const responses = await h.calls(own, [
            [
                'EmailSubmission/set',
                {
                    create: { s1: { identityId: own.identity.id, emailId: draft.id, envelope: held(own, { HOLDFOR: '86400' }) } },
                    onSuccessDestroyEmail: ['#s1']
                },
                'c1'
            ]
        ]);
        h.expectCreated(responses[0][1]);
        expect(responses[1][1].destroyed).to.deep.equal([draft.id]);
        expect(await used()).to.equal(before - draft.size);
    });

    scenario('SUB-104', async () => {
        const b = await h.sender();
        const { id, queueId } = await delayed(ctx, { to: b.user.address, hold: 2 });
        const res = await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'canceled' } } });
        expect(res.updated).to.have.property(id);
        expect(res.newState).to.not.equal(res.oldState);
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('canceled');
        expect(await outbound.entries(queueId)).to.deep.equal([]);
        expect(await outbound.file(queueId)).to.equal(null);
        await clock.delay(2500);
        expect(await outbound.deliver(queueId)).to.deep.equal([]);
        expect(await h.inbox(b)).to.deep.equal([]);
    });

    scenario('SUB-105', async () => {
        const { id } = await started(ctx);
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('final');
        const state = await h.submissionState(ctx);
        const res = await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'canceled' } } });
        expect(res.notUpdated[id].type).to.equal('cannotUnsend');
        expect(res.newState).to.equal(state);
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('final');
        expect(await h.submissionState(ctx)).to.equal(state);
    });

    scenario('SUB-106', async () => {
        const { id, queueId } = await delayed(ctx, { to: ['one@example.net', 'two@example.org'] });
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('pending');
        const entries = await outbound.entries(queueId);
        expect(entries).to.have.length(2);
        const lockedEntry = entries.find(entry => entry.domain === 'example.net');
        await outbound.lock(queueId, lockedEntry.seq);
        const res = await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'canceled' } } });
        expect(res.notUpdated[id].type).to.equal('cannotUnsend');
        const after = await outbound.entries(queueId);
        expect(after.map(entry => entry.recipient).sort()).to.deep.equal(['one@example.net', 'two@example.org']);
        expect(after.find(entry => entry.domain === 'example.org').locked).to.equal(false);
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('final');
    });

    scenario('SUB-107', async () => {
        const draft = await h.createDraft(ctx);
        const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
        const queueId = await h.queueIdOf(created.id);
        const res = await h.submissionSet(ctx, { update: { [created.id]: { undoStatus: 'canceled' } } });
        expect(res.updated).to.have.property(created.id);
        expect((await h.getSubmission(ctx, created.id)).undoStatus).to.equal('canceled');
        expect(await outbound.entries(queueId)).to.deep.equal([]);
    });

    scenario('SUB-108', async () => {
        const { id, draft } = await delayed(ctx);
        const other = await h.createDraft(ctx);
        const current = await h.getSubmission(ctx, id);
        const state = await h.submissionState(ctx);
        const changes = [
            ['identityId', 'I0123456789abcdef01234567'],
            ['emailId', other.id],
            ['envelope', held(ctx, null, ['changed@example.net'])],
            ['sendAt', utc(Date.now())],
            ['threadId', 'T0123456789abcdef01234567'],
            ['deliveryStatus', {}],
            ['bogus', 1],
            ['undoStatus', 'final'],
            ['undoStatus', 'pending'],
            ['undoStatus', 'sent']
        ];
        for (const [property, value] of changes) {
            const res = await h.submissionSet(ctx, { update: { [id]: { [property]: value } } });
            h.expectProperties(res.notUpdated[id], [property]);
        }
        expect(await h.getSubmission(ctx, id)).to.deep.equal(current);
        expect(await h.submissionState(ctx)).to.equal(state);
        const same = await h.submissionSet(ctx, { update: { [id]: { identityId: current.identityId, emailId: draft.id, envelope: current.envelope } } });
        expect(same.updated).to.have.property(id);
        expect(same.newState).to.equal(state);
    });

    scenario('SUB-109', async () => {
        const { id, queueId } = await delayed(ctx);
        expect((await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'canceled' } } }).then(res => res.updated)) || {}).to.have.property(id);
        const state = await h.submissionState(ctx);
        const revive = await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'pending' } } });
        h.expectProperties(revive.notUpdated[id], ['undoStatus']);
        expect(await outbound.entries(queueId)).to.deep.equal([]);
        const again = await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'canceled' } } });
        expect(again.updated).to.have.property(id);
        expect(again.newState).to.equal(state);
    });

    scenario('SUB-110', async () => {
        const other = await h.sender();
        const y = (await delayed(other)).id;
        const draft = await h.createDraft(ctx);
        const random = 'S0123456789abcdef01234567';
        const res = await h.submissionSet(ctx, {
            create: { s1: { identityId: ctx.identity.id, emailId: draft.id } },
            update: { [random]: { undoStatus: 'canceled' }, [y]: { undoStatus: 'canceled' }, '#nosuch': { undoStatus: 'canceled' }, '#s1': {} }
        });
        const created = h.expectCreated(res);
        for (const key of [random, y, '#nosuch']) {
            expect(res.notUpdated[key].type, key).to.equal('notFound');
        }
        expect(res.updated).to.deep.equal({ [created.id]: null });
        expect((await h.getSubmission(other, y)).undoStatus).to.equal('pending');
        expect((await h.getSubmission(ctx, created.id)).undoStatus).to.equal('pending');
        expect(await outbound.entries(await h.queueIdOf(created.id))).to.have.length(1);
    });

    scenario('SUB-111', async () => {
        const b = await h.sender();
        const { id, queueId } = await delayed(ctx, { to: b.user.address, hold: 2 });
        const res = await h.submissionSet(ctx, { destroy: [id] });
        expect(res.destroyed).to.deep.equal([id]);
        expect((await h.call(ctx, 'EmailSubmission/get', { ids: [id] })).notFound).to.deep.equal([id]);
        expect(await outbound.entries(queueId)).to.have.length(1);
        await clock.delay(2500);
        expect(await outbound.deliver(queueId)).to.deep.equal([b.user.address]);
        expect(await h.inbox(b)).to.have.length(1);
    });

    scenario('SUB-112', async () => {
        const first = await started(ctx);
        const second = await delayed(ctx);
        await h.submissionSet(ctx, { update: { [second.id]: { undoStatus: 'canceled' } } });
        expect((await h.getSubmission(ctx, first.id)).undoStatus).to.equal('final');
        expect((await h.getSubmission(ctx, second.id)).undoStatus).to.equal('canceled');
        const res = await h.submissionSet(ctx, { destroy: [first.id, second.id] });
        expect(res.destroyed.sort()).to.deep.equal([first.id, second.id].sort());
        expect((await h.call(ctx, 'EmailSubmission/get', { ids: [first.id, second.id] })).notFound.sort()).to.deep.equal([first.id, second.id].sort());
        const { ids } = await h.call(ctx, 'EmailSubmission/query', {});
        expect(ids).to.not.include.members([first.id]);
        expect(ids).to.not.include.members([second.id]);
        const emails = await ctx.client.method('Email/get', { ids: [first.draft.id, second.draft.id], properties: ['mailboxIds'] });
        expect(emails.notFound).to.deep.equal([]);
    });

    scenario('SUB-113', async () => {
        const other = await h.sender();
        const y = (await delayed(other)).id;
        const draft = await h.createDraft(ctx);
        const random = 'S0123456789abcdef01234567';
        const queued = await h.queuedMessages(ctx);
        const res = await h.submissionSet(ctx, { create: { s1: { identityId: ctx.identity.id, emailId: draft.id } }, destroy: [random, y, '#nosuch', '#s1'] });
        const created = h.expectCreated(res);
        for (const key of [random, y, '#nosuch']) {
            expect(res.notDestroyed[key].type, key).to.equal('notFound');
        }
        expect(res.destroyed).to.deep.equal([created.id]);
        expect((await h.getSubmission(other, y)).undoStatus).to.equal('pending');
        // destroying the record does not touch the delivery
        const added = (await h.queuedMessages(ctx)).filter(queueId => !queued.includes(queueId));
        expect(added).to.have.length(1);
        expect(await outbound.entries(added[0])).to.have.length(1);
    });

    scenario('SUB-114', async () => {
        const { draft, id } = await delayed(ctx);
        const s1 = await h.submissionState(ctx);
        const message = await restMessage(ctx, draft.id);
        const queueId = message.outbound[0].queueId;
        await api('DELETE', `/users/${ctx.user.id}/outbound/${queueId}`);
        expect((await h.getSubmission(ctx, id)).undoStatus).to.equal('canceled');
        expect((await h.call(ctx, 'EmailSubmission/changes', { sinceState: s1 })).updated).to.deep.equal([id]);
    });

    scenario('SUB-115', async () => {
        const { draft, id } = await delayed(ctx);
        const s1 = await h.submissionState(ctx);
        const queueId = (await restMessage(ctx, draft.id)).outbound[0].queueId;
        const sendTime = utc(Date.now() + 7200 * 1000);
        await api('PUT', `/users/${ctx.user.id}/outbound/${queueId}`, { sendTime });
        expect((await h.getSubmission(ctx, id)).sendAt).to.equal(sendTime);
        expect((await h.call(ctx, 'EmailSubmission/changes', { sinceState: s1 })).updated).to.deep.equal([id]);
        const tooLate = await api(
            'PUT',
            `/users/${ctx.user.id}/outbound/${queueId}`,
            { sendTime: utc(Date.now() + (MAX_DELAYED_SEND + 7200) * 1000) },
            { expect: 400 }
        );
        expect(tooLate.code).to.equal('SendTimeTooLate');
        expect((await h.getSubmission(ctx, id)).sendAt).to.equal(sendTime);
    });

    scenario('SUB-116', async () => {
        const { draft, id } = await delayed(ctx, { args: { onSuccessUpdateEmail: { '#s1': toSent(ctx) } } });
        expect((await h.emailOf(ctx, draft.id, ['mailboxIds'])).mailboxIds).to.deep.equal({ [ctx.mb.Sent]: true });
        const message = await restMessage(ctx, draft.id);
        expect(message.mailbox).to.equal(ctx.mb.Sent.slice(1));
        expect(message.outbound).to.have.length(1);
        expect(message.outbound[0].queueId).to.equal(await h.queueIdOf(id));
        expect(message.outbound[0].entries.map(entry => entry.recipient)).to.deep.equal(['r@example.net']);
        const sendTime = utc(Date.now() + 600 * 1000);
        const updated = await api('PUT', `/users/${ctx.user.id}/outbound/${message.outbound[0].queueId}`, { sendTime });
        expect(updated.success).to.be.true;
        expect((await h.getSubmission(ctx, id)).sendAt).to.equal(sendTime);
    });

    scenario('SUB-117', async () => {
        const own = await h.sender();
        h.expectCreated(await h.submitEmail(own, (await h.createDraft(own)).id));
        const state = await h.submissionState(own);
        const { ids } = await h.call(own, 'EmailSubmission/query', {});
        const target = `${h.unique('target')}@example.net`;
        const correspondent = `${h.unique('someone')}@example.net`;
        await api('POST', `/users/${own.user.id}/submit`, { to: [{ address: `${h.unique('rest')}@example.net` }], subject: 'REST', text: 'Hello' });
        await api('PUT', `/users/${own.user.id}`, { targets: [target] });
        await api('PUT', `/users/${own.user.id}/autoreply`, { status: true, subject: 'Away', text: 'I am away' });
        await seed.deliver(
            own.user.address,
            [`From: ${correspondent}`, `To: ${own.user.address}`, 'Subject: forwarded and answered', '', 'Hello'].join('\r\n'),
            correspondent
        );
        // the forward and the autoreply are queued
        await clock.waitFor(async () => (await outbound.entriesFor(target)).length && (await outbound.entriesFor(correspondent)).length, { timeout: 8000 });
        expect((await h.call(own, 'EmailSubmission/query', {})).ids).to.deep.equal(ids);
        expect(await h.submissionState(own)).to.equal(state);
        expect(await h.call(own, 'EmailSubmission/changes', { sinceState: state })).to.deep.include({ created: [], updated: [], destroyed: [] });
    });

    scenario('SUB-147', async () => {
        const own = await h.sender();
        const sendTime = new Date(Date.now() + 3600 * 1000).toISOString();
        // REST submit with a send time
        const submitted = await api('POST', `/users/${own.user.id}/submit`, {
            to: [{ address: 'rest-later@example.net' }],
            subject: 'REST later',
            text: 'Hello',
            sendTime
        });
        // REST draft submit with a send time
        const draft = await h.createDraft(own, { to: 'draft-later@example.net' });
        const stored = await (
            await seed.db()
        )
            .collection('messages')
            .findOne({ user: new seed.ObjectId(own.user.id), root: new seed.ObjectId(draft.id.slice(1)) });
        const draftSubmitted = await api('POST', `/users/${own.user.id}/mailboxes/${stored.mailbox}/messages/${stored.uid}/submit`, { sendTime });
        // JMAP submission held for an hour
        const jmap = await delayed(own, { to: 'jmap-later@example.net' });

        const queueIds = [submitted.message.queueId, draftSubmitted.queueId, jmap.queueId];
        expect(queueIds.every(id => typeof id === 'string')).to.be.true;
        for (const queueId of queueIds) {
            expect(await outbound.entries(queueId)).to.have.length(1);
        }

        await api('DELETE', `/users/${own.user.id}`);
        for (const queueId of queueIds) {
            expect(await outbound.entries(queueId), queueId).to.deep.equal([]);
            expect(await outbound.file(queueId), queueId).to.equal(null);
        }
        // the submission follows its queue entries as when the REST API deletes them
        expect((await h.recordOf(jmap.id)).undoStatus).to.equal('canceled');
    });

    scenario('ESET-087', async () => {
        const { draft, id, queueId } = await delayed(ctx);
        const res = await ctx.client.method('Email/set', { destroy: [draft.id] });
        expect(res.destroyed).to.deep.equal([draft.id]);
        const { ids } = await h.call(ctx, 'EmailSubmission/query', { filter: { emailIds: [draft.id] } });
        expect(ids).to.deep.equal([id]);
        expect((await h.getSubmission(ctx, id)).emailId).to.equal(draft.id);
        expect(await outbound.entries(queueId)).to.have.length(1);
        const cancel = await h.submissionSet(ctx, { update: { [id]: { undoStatus: 'canceled' } } });
        expect(cancel.updated).to.have.property(id);
        expect(await outbound.entries(queueId)).to.deep.equal([]);
    });
});
