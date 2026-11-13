/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before */
'use strict';

// Catalogue file submission.yaml, EmailSubmission/set create (RFC 8621 7.5): the capability, sending
// a draft, the envelope derived from the header or given, and the end to end path through the
// outbound queue (the MTA of the test rig is test/jmap/harness/outbound.js). Also CORE-014.

const { expect } = require('chai');
const { scenario, seed, jmap, outbound, clock } = require('../harness');
const h = require('./submission-helpers');

describe('EmailSubmission create', function () {
    this.timeout(60000);

    describe('capability and basics', () => {
        let ctx;
        before(async () => {
            ctx = await h.sender();
        });

        scenario('SUB-001', async () => {
            const session = await ctx.client.session();
            expect(session.capabilities[jmap.URN.submission]).to.deep.equal({});
            const capability = session.accounts[ctx.client.accountId].accountCapabilities[jmap.URN.submission];
            expect(capability).to.deep.equal({ maxDelayedSend: 2592000, submissionExtensions: { FUTURERELEASE: ['2592000'] } });
            expect(Number.isInteger(capability.maxDelayedSend)).to.be.true;
        });

        scenario('CORE-014', async () => {
            const session = await ctx.client.session();
            expect(session.capabilities[jmap.URN.submission]).to.deep.equal({});
            const capability = session.accounts[ctx.client.accountId].accountCapabilities[jmap.URN.submission];
            expect(capability.maxDelayedSend).to.be.a('number').above(0);
            expect(capability.submissionExtensions).to.deep.equal({ FUTURERELEASE: [String(capability.maxDelayedSend)] });
            expect(session.primaryAccounts[jmap.URN.submission]).to.equal(ctx.client.accountId);
        });

        // withdrawn: an interim state before EmailSubmission existed
        scenario('SUB-002', () => {});

        scenario('SUB-003', async () => {
            const draft = await h.createDraft(ctx);
            const before = await h.queuedMessages(ctx);
            const using = [jmap.URN.core, jmap.URN.mail];
            for (const [name, args] of [
                ['EmailSubmission/set', { create: { s1: { identityId: ctx.identity.id, emailId: draft.id } } }],
                ['EmailSubmission/get', {}],
                ['EmailSubmission/query', {}],
                ['EmailSubmission/changes', { sinceState: 'o0.0.00000000' }]
            ]) {
                const error = await h.methodError(ctx, name, args, using);
                expect(error.type).to.equal('unknownMethod');
            }
            await h.expectNothingQueued(ctx, before);
        });

        scenario('SUB-004', async () => {
            const other = await h.sender();
            const draft = await h.createDraft(other);
            for (const accountId of [other.client.accountId, 'u000000000000000000000000']) {
                for (const [name, args] of [
                    ['EmailSubmission/set', { accountId, create: { s1: { identityId: other.identity.id, emailId: draft.id } } }],
                    ['EmailSubmission/get', { accountId }],
                    ['EmailSubmission/query', { accountId }],
                    ['EmailSubmission/changes', { accountId, sinceState: 'o0.0.00000000' }]
                ]) {
                    const error = await h.methodError(ctx, name, args);
                    expect(error.type, name).to.equal('accountNotFound');
                }
            }
            await h.expectNothingQueued(other, []);
        });

        scenario('SUB-005', async () => {
            const draft = await h.createDraft(ctx, { to: 'one@example.net' });
            const before = await h.queuedMessages(ctx);
            const res = await h.submitEmail(ctx, draft.id);
            const created = h.expectCreated(res);
            expect(created.id).to.match(/^[A-Za-z][A-Za-z0-9_-]*$/);
            expect(res.notCreated || {}).to.deep.equal({});
            expect(res.newState).to.not.equal(res.oldState);
            const queued = (await h.queuedMessages(ctx)).filter(id => !before.includes(id));
            expect(queued).to.have.length(1);
            expect((await outbound.entries(queued[0])).map(entry => entry.recipient)).to.deep.equal(['one@example.net']);
        });

        scenario('SUB-006', async () => {
            const draft = await h.createDraft(ctx);
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
            expect(Object.keys(created).sort()).to.deep.equal(
                ['id', 'threadId', 'sendAt', 'undoStatus', 'deliveryStatus', 'dsnBlobIds', 'mdnBlobIds', 'envelope'].sort()
            );
            const fetched = await h.getSubmission(ctx, created.id);
            for (const [key, value] of Object.entries(created)) {
                expect(fetched[key], key).to.deep.equal(value);
            }
        });

        scenario('SUB-007', async () => {
            const draft = await h.createDraft(ctx);
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
            const { list } = await h.call(ctx, 'EmailSubmission/get', { ids: [created.id], properties: null });
            const object = list[0];
            expect(Object.keys(object).sort()).to.deep.equal(
                ['id', 'identityId', 'emailId', 'threadId', 'envelope', 'sendAt', 'undoStatus', 'deliveryStatus', 'dsnBlobIds', 'mdnBlobIds'].sort()
            );
            expect(object).to.include({ identityId: ctx.identity.id, emailId: draft.id });
            expect(object.sendAt).to.match(h.UTC_DATE);
            expect(['pending', 'final', 'canceled']).to.include(object.undoStatus);
            expect(object.dsnBlobIds).to.be.an('array');
            expect(object.mdnBlobIds).to.be.an('array');
        });

        scenario('SUB-008', async () => {
            const original = await h.createDraft(ctx, { subject: 'Thread start', extra: { messageId: [`${h.unique('t')}@example.com`] } });
            const { list } = await ctx.client.method('Email/get', { ids: [original.id], properties: ['messageId', 'threadId'] });
            const reply = await h.createDraft(ctx, { subject: 'Re: Thread start', extra: { inReplyTo: list[0].messageId, references: list[0].messageId } });
            const { list: replyList } = await ctx.client.method('Email/get', { ids: [reply.id], properties: ['threadId'] });
            expect(replyList[0].threadId).to.equal(list[0].threadId);
            const created = h.expectCreated(await h.submitEmail(ctx, reply.id));
            expect(created.threadId).to.equal(list[0].threadId);
            await ctx.client.method('Email/set', { update: { [reply.id]: { mailboxIds: { [ctx.mb.Sent]: true } } } });
            expect((await h.getSubmission(ctx, created.id)).threadId).to.equal(list[0].threadId);
        });

        scenario('SUB-009', async () => {
            const draft = await h.createDraft(ctx, { extra: { sentAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z') } });
            const before = Date.now();
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
            const sendAt = new Date((await h.getSubmission(ctx, created.id)).sendAt).getTime();
            expect(created.sendAt).to.match(/Z$/);
            expect(Math.abs(sendAt - before)).to.be.below(5000);
        });

        scenario('SUB-010', async () => {
            const draft = await h.createDraft(ctx);
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
            expect((await h.getSubmission(ctx, created.id)).undoStatus).to.equal('pending');
            await outbound.lock(await h.queueIdOf(created.id));
            expect((await h.getSubmission(ctx, created.id)).undoStatus).to.equal('final');
            // the MTA defers and unlocks the entry: the submission stays final
            const queueId = await h.queueIdOf(created.id);
            await outbound.unlock(queueId);
            expect((await h.getSubmission(ctx, created.id)).undoStatus).to.equal('final');
            await outbound.remove(queueId);
            expect((await h.getSubmission(ctx, created.id)).undoStatus).to.equal('final');
        });

        scenario('SUB-011', async () => {
            const draft = await h.createDraft(ctx, { to: ['first@example.net', 'second@example.org'] });
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
            const smtpReply = /^\d{3} \d\.\d{1,3}\.\d{1,3} \S.*$/;
            let status = (await h.getSubmission(ctx, created.id)).deliveryStatus;
            expect(Object.keys(status).sort()).to.deep.equal(['first@example.net', 'second@example.org']);
            for (const value of Object.values(status)) {
                expect(value).to.include({ delivered: 'queued', displayed: 'unknown' });
                expect(value.smtpReply).to.be.a('string').and.match(smtpReply);
            }
            await outbound.remove(await h.queueIdOf(created.id));
            status = (await h.getSubmission(ctx, created.id)).deliveryStatus;
            expect(Object.keys(status).sort()).to.deep.equal(['first@example.net', 'second@example.org']);
            for (const value of Object.values(status)) {
                expect(value).to.include({ delivered: 'unknown', displayed: 'unknown' });
                expect(value.smtpReply).to.be.a('string').and.match(smtpReply);
            }
        });

        scenario('SUB-012', async () => {
            const draft = await h.createDraft(ctx);
            const created = h.expectCreated(await h.submitEmail(ctx, draft.id));
            let object = await h.getSubmission(ctx, created.id);
            expect(object.dsnBlobIds).to.deep.equal([]);
            expect(object.mdnBlobIds).to.deep.equal([]);
            const dsn = [
                'From: MAILER-DAEMON@example.net',
                `To: ${ctx.user.address}`,
                'Subject: Delivery Status Notification (Failure)',
                'MIME-Version: 1.0',
                'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
                '',
                '--b1',
                'Content-Type: text/plain',
                '',
                'Your message could not be delivered.',
                '--b1',
                'Content-Type: message/delivery-status',
                '',
                'Reporting-MTA: dns; mx.example.net',
                '',
                'Final-Recipient: rfc822; rcpt@example.net',
                'Action: failed',
                'Status: 5.1.1',
                '--b1--',
                ''
            ].join('\r\n');
            await seed.deliver(ctx.user.address, dsn, '');
            const inbox = await clock.waitFor(async () => {
                const ids = await h.inbox(ctx);
                return ids.length ? ids : null;
            });
            const report = await h.emailOf(ctx, inbox[0], ['subject', 'mailboxIds']);
            expect(report.subject).to.equal('Delivery Status Notification (Failure)');
            expect(report.mailboxIds).to.deep.equal({ [ctx.mb.INBOX]: true });
            object = await h.getSubmission(ctx, created.id);
            expect(object.dsnBlobIds).to.deep.equal([]);
            expect(object.mdnBlobIds).to.deep.equal([]);
        });
    });
});
