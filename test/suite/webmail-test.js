/* eslint no-invalid-this: 0, no-unused-expressions: 0 */

'use strict';

const chai = require('chai');
const { createSuiteApp } = require('../../suite');
const { SESSION_COOKIE_NAME } = require('../../lib/suite/session');

const expect = chai.expect;

describe('HTMX Webmail Client (Tasks 8, 9 & 10)', () => {
    const USER_ID = '507f191e810c19729de860ea';
    const INBOX_ID = '507f1f77bcf86cd799439011';
    const TRASH_ID = '507f1f77bcf86cd799439012';

    function createWebmailMockApi() {
        let calls = [];
        let client = {
            calls,
            get: async (path, opts) => {
                calls.push({ method: 'GET', path, query: opts && opts.query, token: opts && opts.token });
                if (path === `/users/${USER_ID}`) {
                    return {
                        success: true,
                        id: USER_ID,
                        username: 'alice',
                        name: 'Alice Nguyen',
                        address: 'alice@example.com',
                        language: 'vi',
                        tags: [],
                        limits: {
                            quota: { used: 52428800, allowed: 1073741824 }
                        },
                        targets: ['backup@example.com']
                    };
                }
                if (path === `/users/${USER_ID}/mailboxes`) {
                    return {
                        success: true,
                        results: [
                            { id: INBOX_ID, name: 'Inbox', path: 'INBOX', specialUse: null, total: 12, unseen: 3 },
                            { id: TRASH_ID, name: 'Trash', path: 'Trash', specialUse: '\\Trash', total: 2, unseen: 0 },
                            { id: 'mb_custom', name: 'Projects', path: 'Projects', specialUse: null, total: 5, unseen: 1 }
                        ]
                    };
                }
                if (path === `/users/${USER_ID}/mailboxes/${INBOX_ID}/messages`) {
                    return {
                        success: true,
                        total: 1,
                        nextCursor: null,
                        results: [
                            {
                                id: 101,
                                mailbox: INBOX_ID,
                                subject: 'Welcome to WildDuck HTMX Suite',
                                from: { name: 'Team WildDuck', address: 'team@wildduck.email' },
                                to: [{ address: 'alice@example.com' }],
                                date: '2026-10-21T09:30:00Z',
                                intro: 'Fast, secure open-source mail server',
                                seen: false,
                                flagged: true,
                                attachments: true
                            }
                        ]
                    };
                }
                if (path === `/users/${USER_ID}/messages`) {
                    return {
                        success: true,
                        total: 1,
                        results: [
                            {
                                id: 101,
                                mailbox: INBOX_ID,
                                subject: 'Search Match Subject',
                                from: { name: 'Team WildDuck', address: 'team@wildduck.email' },
                                date: '2026-10-21T09:30:00Z',
                                intro: 'Matched search query',
                                seen: true,
                                flagged: false
                            }
                        ]
                    };
                }
                if (path === `/users/${USER_ID}/mailboxes/${INBOX_ID}/messages/101`) {
                    return {
                        success: true,
                        id: 101,
                        mailbox: INBOX_ID,
                        subject: 'Welcome to WildDuck HTMX Suite',
                        from: { name: 'Team WildDuck', address: 'team@wildduck.email' },
                        to: [{ name: 'Alice', address: 'alice@example.com' }],
                        cc: [],
                        date: '2026-10-21T09:30:00Z',
                        seen: true,
                        flagged: true,
                        html: ['<p>Hello <b>Alice</b>!</p><script>window.pwned=true</script><img src="x" onerror="alert(1)">'],
                        text: 'Hello Alice!',
                        attachments: [{ id: 'ATT001', filename: 'guide.pdf', contentType: 'application/pdf', size: 24576 }]
                    };
                }
                if (path === `/users/${USER_ID}/mailboxes/${INBOX_ID}/messages/101/attachments/ATT001`) {
                    return {
                        filename: 'guide.pdf',
                        contentType: 'application/pdf',
                        encoding: 'base64',
                        content: Buffer.from('PDF-MOCK-DATA').toString('base64')
                    };
                }
                if (path === `/users/${USER_ID}/autoreply`) {
                    return {
                        success: true,
                        status: true,
                        subject: 'Out of office',
                        text: 'I am away on vacation.'
                    };
                }
                if (path === `/users/${USER_ID}/filters`) {
                    return {
                        success: true,
                        results: [{ id: 'flt1', name: 'Invoices', query: { from: 'billing' }, action: { mailbox: INBOX_ID } }]
                    };
                }
                if (path === `/users/${USER_ID}/asps`) {
                    return {
                        success: true,
                        results: [{ id: 'asp1', description: 'Thunderbird Laptop', created: '2026-10-20T00:00:00Z' }]
                    };
                }
                return { success: true, results: [] };
            },
            post: async (path, opts) => {
                calls.push({ method: 'POST', path, body: opts && opts.body, token: opts && opts.token });
                if (path === '/authenticate') {
                    if (opts.body.password !== 'correct-pass') {
                        let err = new Error('Invalid credentials');
                        err.code = 'AuthFailed';
                        err.responseCode = 403;
                        throw err;
                    }
                    return {
                        success: true,
                        id: USER_ID,
                        username: opts.body.username,
                        token: 'user_access_tok_999'
                    };
                }
                if (path === `/users/${USER_ID}/2fa/totp/setup`) {
                    return {
                        success: true,
                        seed: 'JBSWY3DPEHPK3PXP',
                         otpauth: 'otpauth://totp/WildDuck:alice?secret=JBSWY3DPEHPK3PXP'
                    };
                }
                if (path === `/users/${USER_ID}/asps`) {
                    return {
                        success: true,
                        id: 'asp_new',
                        password: 'wdasp_generated_secret_123'
                    };
                }
                return { success: true, id: 'new_id_1' };
            },
            put: async (path, opts) => {
                calls.push({ method: 'PUT', path, body: opts && opts.body, token: opts && opts.token });
                return { success: true };
            },
            del: async (path, opts) => {
                calls.push({ method: 'DELETE', path, query: opts && opts.query, token: opts && opts.token });
                return { success: true };
            }
        };
        return client;
    }

    describe('Authentication, Three-Pane Shell, Folders & SSE Updates (Task 8)', () => {
        it('authenticates users with 2FA support, renders the 3-pane workspace, manages folders, and streams SSE events', async () => {
            let mockApi = createWebmailMockApi();
            let app = await createSuiteApp({
                cookieSecret: 'webmail-test-secret',
                apiClient: mockApi
            });

            try {
                // 1. Login page renders
                let loginPage = await app.inject({ method: 'GET', url: '/login?lang=vi' });
                expect(loginPage.statusCode).to.equal(200);
                expect(loginPage.body).to.include('Đăng nhập WildDuck Mail');

                // 2. Failed login returns 401 with localized message
                let badLogin = await app.inject({
                    method: 'POST',
                    url: '/login',
                    payload: { username: 'alice', password: 'wrong-password' }
                });
                expect(badLogin.statusCode).to.equal(401);

                // 3. Valid login creates session cookie and redirects to /webmail
                let okLogin = await app.inject({
                    method: 'POST',
                    url: '/login',
                    payload: { username: 'alice', password: 'correct-pass', totpCode: '123456' }
                });
                expect(okLogin.statusCode).to.equal(302);
                expect(okLogin.headers.location).to.equal('/webmail');

                let rawSetCookie = Array.isArray(okLogin.headers['set-cookie'])
                    ? okLogin.headers['set-cookie'].find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))
                    : okLogin.headers['set-cookie'];
                let sessionCookie = rawSetCookie.split(';')[0];
                let sessionObj = await app.suiteSessions.getSessionFromCookie(sessionCookie.split('=')[1]);

                let headers = {
                    cookie: sessionCookie,
                    'x-csrf-token': sessionObj.csrfToken,
                    'hx-request': 'true'
                };

                // 4. Load 3-pane Webmail workspace
                let workspace = await app.inject({
                    method: 'GET',
                    url: '/webmail',
                    headers: { cookie: sessionCookie }
                });
                expect(workspace.statusCode).to.equal(200);
                expect(workspace.body).to.include('Welcome to WildDuck HTMX Suite');
                expect(workspace.body).to.include('Projects');

                // 5. Create custom folder & empty Trash
                let createFolder = await app.inject({
                    method: 'POST',
                    url: '/webmail/mailboxes',
                    headers,
                    payload: { path: 'Invoices' }
                });
                expect(createFolder.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'POST' && c.path === `/users/${USER_ID}/mailboxes`)).to.equal(true);

                let emptyTrash = await app.inject({
                    method: 'POST',
                    url: `/webmail/mailboxes/${TRASH_ID}/empty`,
                    headers
                });
                expect(emptyTrash.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'DELETE' && c.path === `/users/${USER_ID}/mailboxes/${TRASH_ID}/messages`)).to.equal(true);

                // 6. SSE real-time notification endpoint
                let sseRes = await app.inject({
                    method: 'GET',
                    url: '/webmail/events',
                    headers: { cookie: sessionCookie }
                });
                expect(sseRes.statusCode).to.equal(200);
                expect(sseRes.headers['content-type']).to.include('text/event-stream');
                expect(sseRes.body).to.include('event: connected');
            } finally {
                await app.close();
            }
        });
    });

    describe('Message List, Search, XSS-Safe Reader & Composer (Task 9)', () => {
        it('lists and searches messages, strips malicious XSS in HTML emails, updates flags/folders, and submits outbound mail', async () => {
            let mockApi = createWebmailMockApi();
            let app = await createSuiteApp({
                cookieSecret: 'webmail-msg-secret',
                apiClient: mockApi
            });

            try {
                let loginRes = await app.inject({
                    method: 'POST',
                    url: '/login',
                    payload: { username: 'alice', password: 'correct-pass' }
                });
                let rawCookie = Array.isArray(loginRes.headers['set-cookie'])
                    ? loginRes.headers['set-cookie'].find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))
                    : loginRes.headers['set-cookie'];
                let sessionCookie = rawCookie.split(';')[0];
                let sessionObj = await app.suiteSessions.getSessionFromCookie(sessionCookie.split('=')[1]);
                let headers = {
                    cookie: sessionCookie,
                    'x-csrf-token': sessionObj.csrfToken,
                    'hx-request': 'true'
                };

                // 1. List messages in INBOX
                let listRes = await app.inject({
                    method: 'GET',
                    url: `/webmail/mailboxes/${INBOX_ID}/messages`,
                    headers
                });
                expect(listRes.statusCode).to.equal(200);
                expect(listRes.body).to.include('Welcome to WildDuck HTMX Suite');

                // 2. Full-text search across messages
                let searchRes = await app.inject({
                    method: 'GET',
                    url: '/webmail/search?query=invoice',
                    headers
                });
                expect(searchRes.statusCode).to.equal(200);
                expect(searchRes.body).to.include('Search Match Subject');

                // 3. Open message 101 and verify <script> and onerror= are stripped by webSafeHtml
                let readRes = await app.inject({
                    method: 'GET',
                    url: `/webmail/mailboxes/${INBOX_ID}/messages/101`,
                    headers
                });
                expect(readRes.statusCode).to.equal(200);
                expect(readRes.body).to.include('<p>Hello <b>Alice</b>!</p>');
                expect(readRes.body).to.not.include('<script>');
                expect(readRes.body).to.not.include('onerror');
                expect(readRes.body).to.include('guide.pdf');

                // Download attachment
                let attRes = await app.inject({
                    method: 'GET',
                    url: `/webmail/mailboxes/${INBOX_ID}/messages/101/attachments/ATT001`,
                    headers: { cookie: sessionCookie }
                });
                expect(attRes.statusCode).to.equal(200);
                expect(attRes.headers['content-disposition']).to.include('guide.pdf');
                expect(attRes.body).to.equal('PDF-MOCK-DATA');

                // 4. Toggle flag & move message
                let flagRes = await app.inject({
                    method: 'POST',
                    url: `/webmail/mailboxes/${INBOX_ID}/messages/101/update`,
                    headers,
                    payload: { flagged: 'false', seen: 'true' }
                });
                expect(flagRes.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'PUT' && c.path === `/users/${USER_ID}/mailboxes/${INBOX_ID}/messages`)).to.equal(true);

                // 5. Open composer with Reply prefill and submit message
                let composeForm = await app.inject({
                    method: 'GET',
                    url: `/webmail/compose?replyMailbox=${INBOX_ID}&replyMessage=101`,
                    headers
                });
                expect(composeForm.statusCode).to.equal(200);
                expect(composeForm.body).to.include('Re: Welcome to WildDuck HTMX Suite');
                expect(composeForm.body).to.include('team@wildduck.email');

                let sendRes = await app.inject({
                    method: 'POST',
                    url: '/webmail/send',
                    headers,
                    payload: {
                        to: 'bob@example.com, carol@example.com',
                        cc: 'manager@example.com',
                        subject: 'Project Launch Update',
                        text: 'Everything is ready for launch!'
                    }
                });
                expect(sendRes.statusCode).to.equal(200);
                let submitCall = mockApi.calls.find(c => c.method === 'POST' && c.path === `/users/${USER_ID}/submit`);
                expect(submitCall).to.be.an('object');
                expect(submitCall.body.subject).to.equal('Project Launch Update');
                expect(submitCall.body.to).to.have.lengthOf(2);
            } finally {
                await app.close();
            }
        });
    });

    describe('User Settings: Autoreply, Forwarding, Filters, 2FA QR & App Passwords (Task 10)', () => {
        it('manages profile/language, autoreply, forwarding, mail filters, TOTP 2FA QR setup, and ASPs via HTMX', async () => {
            let mockApi = createWebmailMockApi();
            let app = await createSuiteApp({
                cookieSecret: 'webmail-settings-secret',
                apiClient: mockApi
            });

            try {
                let loginRes = await app.inject({
                    method: 'POST',
                    url: '/login',
                    payload: { username: 'alice', password: 'correct-pass' }
                });
                let rawCookie = Array.isArray(loginRes.headers['set-cookie'])
                    ? loginRes.headers['set-cookie'].find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))
                    : loginRes.headers['set-cookie'];
                let sessionCookie = rawCookie.split(';')[0];
                let sessionObj = await app.suiteSessions.getSessionFromCookie(sessionCookie.split('=')[1]);
                let headers = {
                    cookie: sessionCookie,
                    'x-csrf-token': sessionObj.csrfToken,
                    'hx-request': 'true'
                };

                // 1. Load Settings pane
                let settingsView = await app.inject({
                    method: 'GET',
                    url: '/webmail/settings',
                    headers
                });
                expect(settingsView.statusCode).to.equal(200);
                expect(settingsView.body).to.include('Alice Nguyen');
                expect(settingsView.body).to.include('Out of office');
                expect(settingsView.body).to.include('Thunderbird Laptop');

                // 2. Update Profile & Language
                let profRes = await app.inject({
                    method: 'POST',
                    url: '/webmail/settings/profile',
                    headers,
                    payload: { name: 'Alice Tran', language: 'vi' }
                });
                expect(profRes.statusCode).to.equal(200);
                expect(String(profRes.headers['set-cookie'])).to.include('wd_locale=vi');

                // 3. Update Forwarding
                let fwdRes = await app.inject({
                    method: 'POST',
                    url: '/webmail/settings/forwarding',
                    headers,
                    payload: { targets: 'archive@example.com\nbackup@example.com' }
                });
                expect(fwdRes.statusCode).to.equal(200);
                let fwdCall = mockApi.calls.find(
                    c => c.method === 'PUT' && c.path === `/users/${USER_ID}` && Array.isArray(c.body.targets)
                );
                expect(fwdCall.body.targets).to.deep.equal(['archive@example.com', 'backup@example.com']);

                // 4. Update Vacation Autoreply
                let arRes = await app.inject({
                    method: 'POST',
                    url: '/webmail/settings/autoreply',
                    headers,
                    payload: {
                        status: 'true',
                        subject: 'On Holiday',
                        text: 'Back next Monday'
                    }
                });
                expect(arRes.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'PUT' && c.path === `/users/${USER_ID}/autoreply`)).to.equal(true);

                // 5. Create and delete Mail Filter
                let createFilter = await app.inject({
                    method: 'POST',
                    url: '/webmail/settings/filters',
                    headers,
                    payload: {
                        name: 'Receipts',
                        queryFrom: 'billing@stripe.com',
                        mailbox: INBOX_ID
                    }
                });
                expect(createFilter.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'POST' && c.path === `/users/${USER_ID}/filters`)).to.equal(true);

                let delFilter = await app.inject({
                    method: 'DELETE',
                    url: `/webmail/settings/filters/flt1?_csrf=${encodeURIComponent(sessionObj.csrfToken)}`,
                    headers
                });
                expect(delFilter.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'DELETE' && c.path === `/users/${USER_ID}/filters/flt1`)).to.equal(true);

                // 6. TOTP 2FA Setup with QR code DataURL & Enable
                let totpSetupRes = await app.inject({
                    method: 'POST',
                    url: '/webmail/settings/2fa/totp/setup',
                    headers
                });
                expect(totpSetupRes.statusCode).to.equal(200);
                expect(totpSetupRes.body).to.include('JBSWY3DPEHPK3PXP');
                expect(totpSetupRes.body).to.include('data:image/png;base64,');

                let totpEnableRes = await app.inject({
                    method: 'POST',
                    url: '/webmail/settings/2fa/totp/enable',
                    headers,
                    payload: { code: '654321' }
                });
                expect(totpEnableRes.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'PUT' && c.path === `/users/${USER_ID}/2fa/totp`)).to.equal(true);

                // 7. Create & delete Application-Specific Password (ASP)
                let aspCreateRes = await app.inject({
                    method: 'POST',
                    url: '/webmail/settings/asps',
                    headers,
                    payload: { description: 'iPhone Mail' }
                });
                expect(aspCreateRes.statusCode).to.equal(200);
                expect(aspCreateRes.body).to.include('wdasp_generated_secret_123');

                let aspDelRes = await app.inject({
                    method: 'DELETE',
                    url: `/webmail/settings/asps/asp1?_csrf=${encodeURIComponent(sessionObj.csrfToken)}`,
                    headers
                });
                expect(aspDelRes.statusCode).to.equal(200);
                expect(mockApi.calls.some(c => c.method === 'DELETE' && c.path === `/users/${USER_ID}/asps/asp1`)).to.equal(true);
            } finally {
                await app.close();
            }
        });
    });
});
