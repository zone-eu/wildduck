/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before */
'use strict';

// Catalogue file submission.yaml, EmailSubmission/set create (RFC 8621 7.5): failures leave nothing
// behind, ifInState, and injection safety of the envelope and of addresses taken from the header.

const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { scenario, api } = require('../harness');
const { startInstance, stopInstance } = require('../harness/instance');
const h = require('./submission-helpers');

/** A database handle whose collection `name` fails the given methods */
function failing(name, methods) {
    const wrap = (target, override) =>
        new Proxy(target, {
            get(object, property) {
                if (override && Object.hasOwn(override, property)) {
                    return override[property];
                }
                const value = object[property];
                return typeof value === 'function' ? value.bind(object) : value;
            }
        });
    const fail = async () => {
        throw new Error('injected failure');
    };
    return db =>
        wrap(db, {
            collection: (collectionName, ...rest) => {
                const collection = db.collection(collectionName, ...rest);
                return collectionName === name ? wrap(collection, Object.fromEntries(methods.map(method => [method, fail]))) : collection;
            }
        });
}

/** The parts of the account a rejected create must leave as they were */
async function snapshot(ctx) {
    return {
        state: await h.submissionState(ctx),
        ids: (await h.call(ctx, 'EmailSubmission/query', {})).ids,
        queued: await h.queuedMessages(ctx),
        counter: await h.recipientsUsed(ctx)
    };
}

async function expectUnchanged(ctx, before, options = {}) {
    const after = await snapshot(ctx);
    if (options.state === false) {
        // a failed store may have used a change sequence number: the state string moves, nothing changed
        after.state = before.state;
    }
    expect(after).to.deep.equal(before);
    const changes = await h.call(ctx, 'EmailSubmission/changes', { sinceState: before.state });
    expect(changes).to.deep.include({ created: [], updated: [], destroyed: [] });
}

describe('EmailSubmission safety', function () {
    this.timeout(60000);

    let ctx;
    before(async () => {
        ctx = await h.sender();
    });

    scenario('SUB-063', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const onSuccessUpdateEmail = { '#s1': { [`mailboxIds/${own.mb.Drafts}`]: null, [`mailboxIds/${own.mb.Sent}`]: true } };
        for (const hooks of [
            { senderDb: failing(config.sender.collection, ['insertMany', 'insertOne']) },
            { database: failing('jmapsubmissions', ['insertOne']) }
        ]) {
            const before = await snapshot(own);
            const instance = await startInstance({}, hooks);
            try {
                const responses = await h.callsAt(instance.url, own, [
                    ['EmailSubmission/set', { create: { s1: { identityId: own.identity.id, emailId: draft.id } }, onSuccessUpdateEmail }]
                ]);
                expect(responses).to.have.length(1);
                const error = h.expectNotCreated(responses[0][1], 'serverFail');
                expect(['serverFail', 'forbiddenToSend']).to.include(error.type);
            } finally {
                await stopInstance(instance.app);
            }
            await expectUnchanged(own, before, { state: false });
            expect((await h.call(own, 'EmailSubmission/get', {})).list).to.deep.equal([]);
            expect((await h.emailOf(own, draft.id, ['mailboxIds'])).mailboxIds).to.deep.equal({ [own.mb.Drafts]: true });
        }
    });

    scenario('SUB-064', async () => {
        const own = await h.sender();
        const other = await h.sender();
        const draft = await h.createDraft(own);
        const noFrom = await h.appendRaw(own, ['To: r@example.net', 'Subject: no from']);
        const noRecipients = await h.createDraft(own, { to: null });
        const foreign = await h.createDraft(own, { from: other.user.address });
        const maxRcptTo = (await api('GET', '/settings')).settings.find(entry => entry.key === 'const:max:rcpt_to').value;
        const base = { identityId: own.identity.id, emailId: draft.id };
        const envelope = rcptTo => ({ mailFrom: { email: own.user.address }, rcptTo: rcptTo.map(email => ({ email })) });
        const cases = [
            ['invalidProperties', Object.assign({ bogus: true }, base)],
            ['invalidEmail', { identityId: own.identity.id, emailId: noFrom }],
            ['noRecipients', { identityId: own.identity.id, emailId: noRecipients.id }],
            ['invalidRecipients', Object.assign({ envelope: envelope(['not-an-address']) }, base)],
            ['tooManyRecipients', Object.assign({ envelope: envelope(Array.from({ length: maxRcptTo + 1 }, (value, i) => `r${i}@example.net`)) }, base)],
            ['forbiddenFrom', { identityId: own.identity.id, emailId: foreign.id }],
            ['forbiddenMailFrom', Object.assign({ envelope: { mailFrom: { email: other.user.address }, rcptTo: [{ email: 'r@example.net' }] } }, base)]
        ];
        // one accepted submission first, so the query result is not empty
        h.expectCreated(await h.submit(own, base));
        for (const [type, object] of cases) {
            const before = await snapshot(own);
            const res = await h.submit(own, object);
            h.expectNotCreated(res, type);
            expect(res.newState).to.equal(before.state);
            await expectUnchanged(own, before);
        }
    });

    scenario('SUB-065', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own);
        const s1 = await h.submissionState(own);
        h.expectCreated(await h.submitEmail(own, (await h.createDraft(own)).id));
        const queued = await h.queuedMessages(own);
        const responses = await h.calls(own, [
            [
                'EmailSubmission/set',
                {
                    ifInState: s1,
                    create: { s1: { identityId: own.identity.id, emailId: draft.id } },
                    onSuccessUpdateEmail: { '#s1': { 'keywords/$draft': null } }
                },
                'c1'
            ]
        ]);
        expect(responses).to.have.length(1);
        expect(responses[0][0]).to.equal('error');
        expect(responses[0][1].type).to.equal('stateMismatch');
        expect(await h.queuedMessages(own)).to.deep.equal(queued);
        expect((await h.emailOf(own, draft.id, ['keywords'])).keywords).to.include({ $draft: true });
    });

    scenario('SUB-066', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const address = ctx.user.address;
        const [local, domain] = address.split('@');
        const bad = [`${address}>\r\nRCPT TO:<evil@example.net`, `${local}>x@${domain}`, `${local} x@${domain}`, `${local}\u0000x@${domain}`, `<${address}>`];
        for (const email of bad) {
            const fromEnvelope = { mailFrom: { email }, rcptTo: [{ email: 'r@example.net' }] };
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope: fromEnvelope }), 'invalidProperties'), ['envelope']);
            const rcptEnvelope = { mailFrom: { email: address }, rcptTo: [{ email: 'r@example.net' }, { email }] };
            const error = h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope: rcptEnvelope }), 'invalidRecipients');
            expect(error.invalidRecipients).to.deep.equal([email]);
        }
        await h.expectNothingQueued(ctx, before);
        for (const entry of await h.queueEntriesOf(ctx)) {
            expect(entry.recipient).to.not.match(/[\r\n]/);
        }
    });

    scenario('SUB-067', async () => {
        const before = await h.queuedMessages(ctx);
        const address = ctx.user.address;
        const [local, domain] = address.split('@');
        const fromCases = [`From: ${local} x@${domain}`, `From: "${local}>NOTIFY=SUCCESS"@${domain}`];
        for (const from of fromCases) {
            const id = await h.appendRaw(ctx, [from, 'To: r@example.net', 'Subject: crafted from']);
            const error = h.expectNotCreated(await h.submitEmail(ctx, id), 'invalidEmail');
            expect(error.properties).to.deep.equal(['from']);
        }
        const toCases = [
            'To: ok@example.net, bad x@example.net',
            'To: "evil>NOTIFY=SUCCESS"@example.net',
            'To: =?utf-8?Q?a=40example.net=0D=0Ab=40example.net?='
        ];
        for (const to of toCases) {
            const id = await h.appendRaw(ctx, [`From: ${address}`, to, 'Subject: crafted to']);
            h.expectNotCreated(await h.submitEmail(ctx, id), 'invalidRecipients');
        }
        await h.expectNothingQueued(ctx, before);
        // an encoded word is a display name, never an address
        const named = await h.appendRaw(ctx, [
            `From: ${address}`,
            'To: =?utf-8?Q?a=40example.net=0D=0Ab=40example.net?= <real@example.net>',
            'Subject: encoded'
        ]);
        const created = h.expectCreated(await h.submitEmail(ctx, named));
        const { envelope } = await h.getSubmission(ctx, created.id);
        expect(envelope.rcptTo.map(entry => entry.email)).to.deep.equal(['real@example.net']);
        for (const entry of [envelope.mailFrom, ...envelope.rcptTo]) {
            expect(entry.email).to.not.match(/[\s<>]/);
        }
    });

    scenario('SUB-068', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const mailFromParameters = [
            { SIZE: '1000' },
            { BODY: '8BITMIME' },
            { SMTPUTF8: null },
            { RET: 'FULL' },
            { ENVID: 'abc' },
            { AUTH: '<>' },
            { XUNKNOWN: 'x' }
        ];
        for (const parameters of mailFromParameters) {
            const envelope = { mailFrom: { email: ctx.user.address, parameters }, rcptTo: [{ email: 'r@example.net' }] };
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'invalidProperties'), ['envelope']);
        }
        for (const parameters of [{ NOTIFY: 'SUCCESS,FAILURE' }, { ORCPT: 'rfc822;r@example.net' }, { XUNKNOWN: null }]) {
            const envelope = { mailFrom: { email: ctx.user.address }, rcptTo: [{ email: 'r@example.net', parameters }] };
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'invalidProperties'), ['envelope']);
        }
        await h.expectNothingQueued(ctx, before);
    });

    scenario('SUB-069', async () => {
        const draft = await h.createDraft(ctx);
        const before = await h.queuedMessages(ctx);
        const parameterSets = [
            { 'HOLD FOR': '10' },
            { 'HOLDFOR=10': null },
            { 'HOLDFOR\r\nRCPT': '10' },
            { HOLDFOR: 10 },
            { HOLDFOR: ['10'] },
            { HOLDFOR: { value: '10' } },
            { HOLDFOR: '10\r\nRCPT TO:<x@example.net>' }
        ];
        for (const parameters of parameterSets) {
            const envelope = { mailFrom: { email: ctx.user.address, parameters }, rcptTo: [{ email: 'r@example.net' }] };
            h.expectProperties(h.expectNotCreated(await h.submitEmail(ctx, draft.id, { envelope }), 'invalidProperties'), ['envelope']);
        }
        await h.expectNothingQueued(ctx, before);
    });
});
