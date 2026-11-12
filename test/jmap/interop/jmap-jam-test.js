/* eslint no-unused-expressions: 0 */
/* globals before: false, after: false, globalThis: false */
'use strict';

// Client interop (implementation plan 4.6): jmap-jam, a typed JMAP client library, against the test
// server. The library discovers the session, reads mailboxes and mail, follows a result reference,
// downloads and uploads blobs, creates a draft and holds an event source connection. The account is
// seeded over LMTP, the REST API and IMAP, never over JMAP, and the effects of the library's writes
// are checked over IMAP. Results of the real client rounds are in docs/jmap/interop-log.md.

const crypto = require('crypto');
const { expect } = require('chai');
const { accounts, seed, fixtures, clock } = require('../harness');
const { JMAP_URL } = require('../harness/client');
const { AuthorizedEventSource } = require('./event-source');

const ATTACHMENT = crypto.randomBytes(3000);
const UPLOAD = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), crypto.randomBytes(500)]);

describe('Interop: jmap-jam', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    let JamClient;
    let jam;
    let user;
    let token;
    let accountId;
    let mailboxes;
    let seeded;
    let attachment;
    let uploaded;
    let source;
    const savedEventSource = globalThis.EventSource;

    before(async () => {
        // the library is an ES module
        ({ JamClient } = await import('jmap-jam'));

        user = await accounts.createUser();
        token = await accounts.createToken(user);

        const raw = await fixtures.buildMessage({
            to: user.address,
            subject: `Interop jam ${crypto.randomBytes(3).toString('hex')}`,
            text: 'Hello from the interop test',
            attachments: [{ filename: 'report.bin', contentType: 'application/octet-stream', content: ATTACHMENT }]
        });
        await seed.deliver(user.address, raw);
        seeded = { subject: raw.toString().match(/^Subject: (.*)$/m)[1] };

        jam = new JamClient({ sessionUrl: `${JMAP_URL}/.well-known/jmap`, bearerToken: token });
    });

    after(() => {
        if (source) {
            source.close();
        }
        globalThis.EventSource = savedEventSource;
    });

    it('loads the session and finds the primary mail account', async () => {
        const session = await jam.session;
        expect(session.capabilities).to.have.property('urn:ietf:params:jmap:core');
        expect(session.capabilities).to.have.property('urn:ietf:params:jmap:mail');
        expect(session.username).to.equal(user.username);

        accountId = await jam.getPrimaryAccount();
        expect(accountId).to.equal(`u${user.id}`);
        expect(session.accounts[accountId].accountCapabilities).to.have.property('urn:ietf:params:jmap:mail');
    });

    it('reads the mailboxes', async () => {
        const [result] = await jam.api.Mailbox.get({ accountId, ids: null });
        mailboxes = {};
        for (const mailbox of result.list) {
            mailboxes[mailbox.role || mailbox.name] = mailbox;
        }
        expect(mailboxes).to.include.keys('inbox', 'drafts', 'sent', 'trash', 'junk');
        expect(mailboxes.inbox).to.include({ totalEmails: 1, unreadEmails: 1 });
    });

    it('queries the inbox and gets the emails through a result reference', async () => {
        const [{ query, emails }, meta] = await jam.requestMany(t => {
            const query = t.Email.query({ accountId, filter: { inMailbox: mailboxes.inbox.id }, sort: [{ property: 'receivedAt', isAscending: false }] });
            const emails = t.Email.get({
                accountId,
                ids: query.$ref('/ids'),
                properties: ['id', 'threadId', 'subject', 'from', 'keywords', 'hasAttachment', 'textBody', 'attachments', 'bodyValues'],
                fetchTextBodyValues: true
            });
            return { query, emails };
        });

        // the library sends #ids, the server resolved it
        expect(meta.response.status).to.equal(200);
        expect(query.ids).to.have.length(1);
        expect(emails.list.map(email => email.id)).to.deep.equal(query.ids);

        const [email] = emails.list;
        expect(email.subject).to.equal(seeded.subject);
        expect(email.from).to.deep.equal([{ name: 'Sender', email: 'sender@example.net' }]);
        expect(email.keywords).to.deep.equal({});
        expect(email.hasAttachment).to.be.true;
        expect(email.bodyValues[email.textBody[0].partId].value.trim()).to.equal('Hello from the interop test');
        expect(email.attachments).to.have.length(1);
        attachment = email.attachments[0];
        expect(attachment).to.include({ name: 'report.bin', type: 'application/octet-stream', size: ATTACHMENT.length });

        const [threads] = await jam.api.Thread.get({ accountId, ids: [email.threadId] });
        expect(threads.list[0].emailIds).to.deep.equal([email.id]);
    });

    it('downloads an attachment', async () => {
        const res = await jam.downloadBlob({ accountId, blobId: attachment.blobId, mimeType: attachment.type, fileName: attachment.name });
        expect(res.headers.get('content-type')).to.equal('application/octet-stream');
        expect(res.headers.get('content-disposition')).to.include('report.bin');
        expect(Buffer.from(await res.arrayBuffer()).equals(ATTACHMENT)).to.be.true;
    });

    it('uploads a blob and downloads it again', async () => {
        uploaded = await jam.uploadBlob(accountId, new Blob([UPLOAD], { type: 'image/png' }));
        expect(uploaded).to.include({ accountId, type: 'image/png', size: UPLOAD.length });
        expect(uploaded.blobId).to.be.a('string');

        const res = await jam.downloadBlob({ accountId, blobId: uploaded.blobId, mimeType: 'image/png', fileName: 'pixel.png' });
        expect(Buffer.from(await res.arrayBuffer()).equals(UPLOAD)).to.be.true;
    });

    it('creates a draft with the uploaded blob, visible over IMAP', async () => {
        const subject = `Interop draft ${crypto.randomBytes(3).toString('hex')}`;
        const [result] = await jam.api.Email.set({
            accountId,
            create: {
                draft: {
                    mailboxIds: { [mailboxes.drafts.id]: true },
                    keywords: { $draft: true, $seen: true },
                    from: [{ name: user.username, email: user.address }],
                    to: [{ name: 'Friend', email: 'friend@example.net' }],
                    subject,
                    bodyValues: { body: { value: 'Draft written by jmap-jam' } },
                    textBody: [{ partId: 'body', type: 'text/plain' }],
                    attachments: [{ blobId: uploaded.blobId, type: 'image/png', name: 'pixel.png', disposition: 'attachment' }]
                }
            }
        });
        expect(result.notCreated || {}).to.deep.equal({});
        expect(result.created.draft).to.include.keys('id', 'blobId', 'threadId', 'size');

        const [got] = await jam.api.Email.get({ accountId, ids: [result.created.draft.id], properties: ['mailboxIds', 'keywords', 'subject', 'attachments'] });
        expect(got.list[0].mailboxIds).to.deep.equal({ [mailboxes.drafts.id]: true });
        expect(got.list[0].attachments[0]).to.include({ name: 'pixel.png', type: 'image/png', size: UPLOAD.length });

        const message = await seed.withImap(user, async client => {
            await client.mailboxOpen('Drafts');
            const [found] = await client.search({ header: { subject } });
            return client.fetchOne(String(found), { flags: true, source: true }, { uid: false });
        });
        expect([...message.flags]).to.include.members(['\\Draft', '\\Seen']);
        expect(message.source.toString()).to.include('Draft written by jmap-jam');
        expect(message.source.toString()).to.include(UPLOAD.toString('base64').slice(0, 60));
    });

    it('holds an event source connection and receives a state change after a delivery', async () => {
        // see event-source.js: the library uses the global EventSource, which cannot authenticate
        globalThis.EventSource = AuthorizedEventSource.withAuthorization(`Bearer ${token}`);

        const [before] = await jam.api.Email.get({ accountId, ids: [] });
        const events = [];
        source = await jam.connectEventSource({ types: ['Email', 'Mailbox'], ping: 5, closeafter: 'no' });
        expect(source.url).to.match(/\/jmap\/eventsource\/\?types=Email,Mailbox&closeafter=no&ping=5$/);
        source.addEventListener('state', event => events.push(JSON.parse(event.data)));
        await new Promise((resolve, reject) => {
            source.addEventListener('open', resolve, { once: true });
            source.addEventListener('error', () => reject(source.error), { once: true });
        });

        await seed.deliver(user.address, await fixtures.buildMessage({ to: user.address, subject: 'Interop push' }));

        const change = await clock.waitFor(() => events.find(event => event.changed[accountId] && event.changed[accountId].Email !== before.state), {
            timeout: 10000,
            message: 'no state change for the delivery'
        });
        expect(change['@type']).to.equal('StateChange');
        expect(change.changed[accountId]).to.include.keys('Email', 'Mailbox');

        // the pushed state is the one the client reads afterwards
        const [after] = await jam.api.Email.get({ accountId, ids: [] });
        expect(change.changed[accountId].Email).to.equal(after.state);
        const [changes] = await jam.api.Email.changes({ accountId, sinceState: before.state });
        expect(changes.created).to.have.length(1);
    });
});
