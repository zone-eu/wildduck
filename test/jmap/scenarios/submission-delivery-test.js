/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Catalogue file submission.yaml: what the outbound queue and the recipient see of a submission.
// The test environment runs no ZoneMTA; test/jmap/harness/outbound.js takes the queued message the
// way the MTA does (stored header list plus body) and hands it to the local recipient over LMTP.

const crypto = require('crypto');
const { expect } = require('chai');
const { dkimVerify } = require('mailauth');
const { scenario, api, seed, jmap, outbound, clock } = require('../harness');
const sse = require('../harness/sse');
const h = require('./submission-helpers');

const TRACE_HEADERS = new Set(['received', 'return-path', 'delivered-to', 'x-original-to']);

async function upload(ctx, content, type) {
    const res = await ctx.client.raw(`/jmap/upload/${ctx.client.accountId}/`, { method: 'POST', headers: { 'Content-Type': type }, body: content });
    expect(res.status, res.body.toString()).to.equal(201);
    return res.json.blobId;
}

async function download(ctx, blobId) {
    const res = await ctx.client.raw(`/jmap/download/${ctx.client.accountId}/${blobId}/blob`);
    expect(res.status).to.equal(200);
    return res.body;
}

/** The header section of a raw message */
const headerSection = raw => {
    const text = raw.toString('binary');
    const end = text.indexOf('\r\n\r\n');
    return end < 0 ? text : text.slice(0, end + 2);
};

/** The one Email that arrives in the INBOX of a user */
async function arrived(ctx, count = 1) {
    const ids = await clock.waitFor(async () => {
        const list = await h.inbox(ctx);
        return list.length >= count ? list : null;
    });
    expect(ids).to.have.length(count);
    return ids;
}

const ALL = ['from', 'sender', 'replyTo', 'to', 'cc', 'subject', 'sentAt', 'messageId', 'inReplyTo', 'references', 'bodyStructure', 'headers'];

/** Leaf parts of a bodyStructure */
const leaves = part => (part.subParts ? part.subParts.flatMap(leaves) : [part]);
const withoutBlobIds = part => {
    const copy = Object.assign({}, part);
    delete copy.blobId;
    if (copy.subParts) {
        copy.subParts = copy.subParts.map(withoutBlobIds);
    }
    return copy;
};

describe('EmailSubmission delivery', function () {
    this.timeout(60000);

    let a;
    before(async () => {
        a = await h.sender();
    });
    after(() => sse.closeAll());

    scenario('SUB-029', async () => {
        const b = await h.sender();
        const attachment = crypto.randomBytes(3000);
        const blobId = await upload(a, attachment, 'application/pdf');
        const draft = await h.createDraft(a, {
            to: b.user.address,
            subject: 'End to end',
            extra: {
                textBody: undefined,
                bodyStructure: {
                    type: 'multipart/mixed',
                    subParts: [
                        {
                            type: 'multipart/alternative',
                            subParts: [
                                { partId: 't', type: 'text/plain' },
                                { partId: 'h', type: 'text/html' }
                            ]
                        },
                        { blobId, type: 'application/pdf', name: 'report.pdf', disposition: 'attachment' }
                    ]
                },
                bodyValues: { t: { value: 'Plain text body' }, h: { value: '<p>HTML body</p>' } }
            }
        });
        const before = (await b.client.method('Email/get', { ids: [] })).state;
        const stream = await sse.open('/jmap/eventsource/?types=EmailDelivery&closeafter=no&ping=0', {
            authorization: jmap.basic(b.user.username, b.user.password)
        });
        await stream.until(() => stream.comments.length || stream.events.length, 5000, 'the stream did not start');
        await stream.settle(300);

        const created = h.expectCreated(await h.submitEmail(a, draft.id));
        await h.deliverSubmission(created.id);
        const [id] = await arrived(b);
        const event = await stream.next('state', 8000);
        expect(event.json.changed[b.client.accountId]).to.have.property('EmailDelivery');

        const properties = ['from', 'to', 'subject', 'messageId', 'textBody', 'htmlBody', 'attachments', 'bodyValues'];
        const args = { properties, fetchTextBodyValues: true, fetchHTMLBodyValues: true };
        const [sent] = (await a.client.method('Email/get', Object.assign({ ids: [draft.id] }, args))).list;
        const [received] = (await b.client.method('Email/get', Object.assign({ ids: [id] }, args))).list;
        for (const property of ['from', 'to', 'subject', 'messageId']) {
            expect(received[property], property).to.deep.equal(sent[property]);
        }
        const text = part => received.bodyValues[part.partId].value;
        expect(text(received.textBody[0]).trim()).to.equal('Plain text body');
        expect(text(received.htmlBody[0]).trim()).to.equal('<p>HTML body</p>');
        expect(received.attachments).to.have.length(1);
        expect(received.attachments[0]).to.include({ name: 'report.pdf', type: 'application/pdf' });
        expect(Buffer.compare(await download(b, received.attachments[0].blobId), attachment)).to.equal(0);

        const changes = await b.client.method('Email/changes', { sinceState: before });
        expect(changes.created).to.deep.equal([id]);
        await seed.withImap(b.user, async imap => {
            const mailbox = await imap.mailboxOpen('INBOX');
            expect(mailbox.exists).to.equal(1);
            const message = await imap.fetchOne('1', { envelope: true });
            expect(message.envelope.subject).to.equal('End to end');
            expect(message.envelope.messageId).to.equal(`<${sent.messageId[0]}>`);
        });
        stream.close();
    });

    scenario('SUB-030', async () => {
        const self = await h.sender();
        const draft = await h.createDraft(self, { to: self.user.address, subject: 'To myself' });
        const draftBefore = await h.emailOf(self, draft.id, ['mailboxIds', 'keywords', 'blobId']);
        const created = h.expectCreated(await h.submitEmail(self, draft.id));
        await h.deliverSubmission(created.id);
        const [id] = await arrived(self);
        expect(id).to.not.equal(draft.id);
        expect((await h.emailOf(self, id, ['subject'])).subject).to.equal('To myself');
        expect(await h.emailOf(self, draft.id, ['mailboxIds', 'keywords', 'blobId'])).to.deep.equal(draftBefore);
    });

    scenario('SUB-031', async () => {
        const b = await h.sender();
        const c = await h.sender();
        const draft = await h.createDraft(a, { to: b.user.address, cc: c.user.address, subject: 'To and Cc' });
        const created = h.expectCreated(await h.submitEmail(a, draft.id));
        await h.deliverSubmission(created.id);
        const copies = [];
        for (const recipient of [b, c]) {
            const [id] = await arrived(recipient);
            const { to, cc } = await h.emailOf(recipient, id, ['to', 'cc']);
            copies.push({ to, cc });
        }
        expect(copies[0]).to.deep.equal(copies[1]);
        expect(copies[0].to).to.deep.equal([{ name: null, email: b.user.address }]);
        expect(copies[0].cc).to.deep.equal([{ name: null, email: c.user.address }]);
    });

    scenario('SUB-032', async () => {
        const b = await h.sender();
        const c = await h.sender();
        const draft = await h.createDraft(a, { to: b.user.address, bcc: c.user.address, subject: 'With Bcc' });
        const created = h.expectCreated(await h.submitEmail(a, draft.id));
        const queueId = await h.queueIdOf(created.id);
        const queued = headerSection(await outbound.message(queueId));
        expect(queued).to.not.match(/^bcc:/im);
        expect(queued.toLowerCase()).to.not.include(c.user.address);
        await outbound.deliver(queueId);
        for (const recipient of [b, c]) {
            const [id] = await arrived(recipient);
            const { blobId } = await h.emailOf(recipient, id, ['blobId']);
            const header = headerSection(await download(recipient, blobId));
            expect(header).to.not.match(/^bcc:/im);
            // the trace fields of the recipient's own copy name its own address, the message header does not
            const fields = header.split(/\r\n(?![ \t])/).filter(line => !/^(received|delivered-to|return-path|x-original-to):/i.test(line));
            expect(fields.join('\n').toLowerCase()).to.not.include(c.user.address);
        }
        expect((await h.emailOf(a, draft.id, ['bcc'])).bcc).to.deep.equal([{ name: null, email: c.user.address }]);
    });

    scenario('SUB-033', async () => {
        const body = 'First line\r\nBcc: this line is body text\r\nLast line\r\n';
        const common = [`From: ${a.user.address}`, 'To: r@example.net', 'Subject: Bcc removal', 'Date: Mon, 2 Nov 2026 10:00:00 +0000'];
        const variants = [
            {
                headers: [
                    common[0],
                    'Bcc: one@example.net,',
                    '  two@example.net,',
                    '  three@example.net',
                    ...common.slice(1),
                    `Message-ID: <${h.unique('m')}@example.com>`
                ],
                bcc: [1, 2, 3]
            },
            { headers: [...common, `Message-ID: <${h.unique('m')}@example.com>`, 'Bcc: last@example.net'], bcc: [5] },
            { headers: ['Bcc: first@example.net', ...common, 'Bcc: second@example.net', `Message-ID: <${h.unique('m')}@example.com>`], bcc: [0, 5] }
        ];
        for (const variant of variants) {
            const raw = Buffer.from(variant.headers.join('\r\n') + '\r\n\r\n' + body, 'binary');
            const id = await h.appendRaw(a, raw);
            const created = h.expectCreated(await h.submitEmail(a, id));
            const queued = (await outbound.message(await h.queueIdOf(created.id))).toString('binary');
            const expected = variant.headers.filter((line, index) => !variant.bcc.includes(index)).join('\r\n') + '\r\n\r\n' + body;
            expect(queued).to.equal(expected);
        }
    });

    scenario('SUB-034', async () => {
        const b = await h.sender();
        const image = crypto.randomBytes(500);
        const file = crypto.randomBytes(2000);
        const imageId = await upload(a, image, 'image/png');
        const fileId = await upload(a, file, 'application/octet-stream');
        const draft = await h.createDraft(a, {
            from: { name: 'Jürgen Müller', email: a.user.address },
            to: b.user.address,
            cc: 'carbon@example.net',
            subject: 'Grüße und Äpfel',
            extra: {
                textBody: undefined,
                replyTo: [{ name: 'Replies', email: 'replies@example.net' }],
                inReplyTo: ['parent@example.net'],
                references: ['root@example.net', 'parent@example.net'],
                'header:X-Custom-One:asText': 'custom value',
                'header:X-Custom-Two:asText': 'second custom value',
                bodyStructure: {
                    type: 'multipart/mixed',
                    subParts: [
                        {
                            type: 'multipart/related',
                            subParts: [
                                { partId: 'h', type: 'text/html' },
                                { blobId: imageId, type: 'image/png', cid: 'logo@example.com', disposition: 'inline', name: 'logo.png' }
                            ]
                        },
                        { blobId: fileId, type: 'application/octet-stream', name: 'data.bin', disposition: 'attachment' }
                    ]
                },
                bodyValues: { h: { value: '<p>Hello <img src="cid:logo@example.com"></p>' } }
            }
        });
        const created = h.expectCreated(await h.submitEmail(a, draft.id));
        await h.deliverSubmission(created.id);
        const [id] = await arrived(b);
        const properties = ALL.concat('header:X-Custom-One:asText', 'header:X-Custom-Two:asText');
        const sent = await h.emailOf(a, draft.id, properties);
        const received = await h.emailOf(b, id, properties);
        for (const property of properties.filter(name => !['bodyStructure', 'headers'].includes(name))) {
            expect(received[property], property).to.deep.equal(sent[property]);
        }
        expect(withoutBlobIds(received.bodyStructure)).to.deep.equal(withoutBlobIds(sent.bodyStructure));
        const sentLeaves = leaves(sent.bodyStructure);
        const receivedLeaves = leaves(received.bodyStructure);
        for (const [index, part] of sentLeaves.entries()) {
            expect(Buffer.compare(await download(b, receivedLeaves[index].blobId), await download(a, part.blobId))).to.equal(0);
        }
        // the received header is the sent one plus trace fields
        const sentFields = sent.headers.map(header => `${header.name.toLowerCase()}:${header.value}`);
        const extra = received.headers.filter(header => !sentFields.includes(`${header.name.toLowerCase()}:${header.value}`));
        expect(extra.map(header => header.name.toLowerCase()).filter(name => !TRACE_HEADERS.has(name))).to.deep.equal([]);
        const receivedFields = received.headers.map(header => `${header.name.toLowerCase()}:${header.value}`);
        expect(sentFields.filter(field => !receivedFields.includes(field) && !field.startsWith('bcc:'))).to.deep.equal([]);
    });

    scenario('SUB-035', async () => {
        const b = await h.sender();
        const signedDomain = `${h.unique('dkim')}.example`;
        const plainDomain = `${h.unique('nodkim')}.example`;
        const selector = 'jmaptest';
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'der' }
        });
        await api('POST', '/dkim', { domain: signedDomain, selector, privateKey });
        const signedFrom = `sender@${signedDomain}`;
        const plainFrom = `sender@${plainDomain}`;
        await h.addAddress(a, signedFrom);
        await h.addAddress(a, plainFrom);
        // the signing step of zonemta-wildduck: the key registered for the domain of the From address
        const signingKey = async from => {
            const domain = from.split('@')[1];
            const found = await api('GET', `/dkim/resolve/${domain}`).catch(err => (err.status === 404 ? null : Promise.reject(err)));
            if (!found) {
                return null;
            }
            const key = await api('GET', `/dkim/${found.id}`);
            return { signingDomain: key.domain, selector: key.selector, privateKey };
        };
        for (const from of [signedFrom, plainFrom]) {
            const identity = await h.identityOf(a, from);
            const draft = await h.createDraft(a, { from, to: b.user.address, subject: `Signed by ${from}` });
            const created = h.expectCreated(await h.submitEmail(a, draft.id, { identityId: identity.id }));
            await h.deliverSubmission(created.id, { dkim: await signingKey(from) });
        }
        const ids = await arrived(b, 2);
        const resolver = async (name, type) => {
            if (type === 'TXT' && name === `${selector}._domainkey.${signedDomain}`) {
                return [[`v=DKIM1; k=rsa; p=${publicKey.toString('base64')}`]];
            }
            const err = new Error('not found');
            err.code = 'ENOTFOUND';
            throw err;
        };
        for (const id of ids) {
            const email = await h.emailOf(b, id, ['blobId', 'from']);
            const raw = await download(b, email.blobId);
            const result = await dkimVerify(raw, { resolver });
            const signatures = result.results.filter(entry => entry.signingDomain);
            if (email.from[0].email === signedFrom) {
                expect(signatures).to.have.length(1);
                expect(signatures[0].signingDomain).to.equal(signedDomain);
                expect(signatures[0].selector).to.equal(selector);
                expect(signatures[0].status.result).to.equal('pass');
            } else {
                expect(signatures.filter(entry => entry.signingDomain === plainDomain)).to.deep.equal([]);
            }
        }
    });

    scenario('SUB-036', async () => {
        const own = await h.sender();
        const draft = await h.createDraft(own, { bcc: 'hidden@example.net' });
        const properties = ['blobId', 'size', 'keywords', 'mailboxIds', 'bcc'];
        const before = await h.emailOf(own, draft.id, properties);
        const state = (await own.client.method('Email/get', { ids: [] })).state;
        h.expectCreated(await h.submitEmail(own, draft.id));
        expect(await h.emailOf(own, draft.id, properties)).to.deep.equal(before);
        expect(before.keywords).to.include({ $draft: true });
        expect(before.mailboxIds).to.deep.equal({ [own.mb.Drafts]: true });
        expect((await own.client.method('Email/get', { ids: [] })).state).to.equal(state);
        const changes = await own.client.method('Email/changes', { sinceState: state });
        expect(changes).to.deep.include({ created: [], updated: [], destroyed: [] });
        const { list } = await own.client.method('Mailbox/get', { ids: [own.mb.Sent], properties: ['totalEmails'] });
        expect(list[0].totalEmails).to.equal(0);
    });
});
