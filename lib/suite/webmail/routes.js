'use strict';

const { SESSION_COOKIE_NAME } = require('../session');
const { html } = require('../html');
const { renderMailboxesSidebar } = require('./views/mailboxes');
const { renderLoginView, renderWebmailWorkspace } = require('./views/shell');
const { renderMessageListPane, renderMessageReaderPane } = require('./views/messages');
const { renderComposerPane } = require('./views/composer');

function ensureAuthenticatedUser(req, reply) {
    if (!req.session || !req.session.userId) {
        if (req.headers['hx-request'] === 'true') {
            reply.header('HX-Redirect', '/login').send('');
            return false;
        }
        reply.redirect('/login');
        return false;
    }
    return true;
}

function parseAddressHeaderInput(raw) {
    if (!raw || typeof raw !== 'string') {
        return [];
    }
    return raw
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(address => ({ address }));
}

module.exports = async function webmailRoutes(app) {
    app.get('/', async (req, reply) => {
        if (req.session && req.session.userId) {
            return reply.redirect('/webmail');
        }
        return reply.redirect('/login');
    });

    app.get('/login', async (req, reply) => {
        let nextUrl = (req.query && req.query.next) || '/webmail';
        let body = renderLoginView({ nextUrl, t: req.t });
        return reply.renderPage({
            title: req.t('auth.loginTitle'),
            activeSection: 'login',
            body
        });
    });

    app.post('/login', { config: { skipCsrf: true } }, async (req, reply) => {
        let username = String((req.body && req.body.username) || '').trim();
        let password = String((req.body && req.body.password) || '');
        let totpCode = String((req.body && req.body.totpCode) || '').trim();
        let nextUrl = String((req.body && req.body.next) || '/webmail');
        if (!nextUrl.startsWith('/')) {
            nextUrl = '/webmail';
        }

        try {
            let authPayload = {
                username,
                password,
                scope: 'master',
                sess: true
            };
            if (totpCode) {
                authPayload.token = totpCode;
            }

            let authRes = await app.suiteApi.post('/authenticate', { body: authPayload });
            let userId = authRes.id;
            let accessToken = authRes.token || '';

            let userInfo = { username, tags: [] };
            try {
                userInfo = await app.suiteApi.get(`/users/${userId}`, { token: accessToken || undefined });
            } catch (err) {
                // Keep basic user info
            }

            let isAdmin =
                username === 'admin' ||
                (Array.isArray(userInfo.tags) && userInfo.tags.includes('role:admin'));

            let created = await app.suiteSessions.createSession({
                userId,
                username: userInfo.username || username,
                role: isAdmin ? 'admin' : 'user',
                accessToken
            });

            reply.setCookie(SESSION_COOKIE_NAME, created.cookieValue, {
                maxAge: app.suiteSessions.ttlSeconds,
                httpOnly: true
            });

            return reply.redirect(nextUrl);
        } catch (err) {
            let body = renderLoginView({
                errorMsg: req.t('auth.invalidCredentials'),
                nextUrl,
                t: req.t
            });
            return reply.code(401).renderPage({
                title: req.t('auth.loginTitle'),
                activeSection: 'login',
                body
            });
        }
    });

    app.post('/logout', async (req, reply) => {
        if (req.session) {
            await app.suiteSessions.destroySession(req.session.id);
        }
        reply.setCookie(SESSION_COOKIE_NAME, '', { maxAge: 0, httpOnly: true });
        if (req.headers['hx-request'] === 'true') {
            return reply.header('HX-Redirect', '/login').send('');
        }
        return reply.redirect('/login');
    });

    app.get('/webmail', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let token = req.session.accessToken;

        let [account, mbRes] = await Promise.all([
            app.suiteApi.get(`/users/${userId}`, { token }),
            app.suiteApi.get(`/users/${userId}/mailboxes`, { query: { counters: true }, token })
        ]);

        let mailboxes = (mbRes && mbRes.results) || [];
        let inbox = mailboxes.find(m => m.path === 'INBOX') || mailboxes[0] || { id: '' };
        let activeMailboxId = (req.query && req.query.mailbox) || inbox.id;

        let messages = [];
        if (activeMailboxId) {
            let msgRes = await app.suiteApi.get(`/users/${userId}/mailboxes/${activeMailboxId}/messages`, {
                query: { limit: 30, order: 'desc' },
                token
            });
            messages = (msgRes && msgRes.results) || [];
        }

        let listPaneHtml = renderMessageListPane({
            messages,
            activeMailboxId,
            locale: req.locale,
            t: req.t
        });

        let readerPaneHtml = html`<div style="margin:auto;text-align:center;color:var(--text-muted);">
            <p>${req.t('webmail.selectMessagePrompt')}</p>
        </div>`;

        let body = renderWebmailWorkspace({
            mailboxes,
            activeMailboxId,
            account,
            listPaneHtml,
            readerPaneHtml,
            csrfToken: req.session.csrfToken,
            t: req.t
        });

        return reply.renderPage({
            title: req.t('webmail.title'),
            activeSection: 'webmail',
            body
        });
    });

    app.get('/webmail/mailboxes/:mailboxId/messages', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let mailboxId = req.params.mailboxId;
        let queryParams = { limit: 30, order: 'desc' };
        let filter = 'all';

        if (req.query && req.query.unseen === 'true') {
            queryParams.unseen = true;
            filter = 'unseen';
        } else if (req.query && req.query.flagged === 'true') {
            queryParams.flagged = true;
            filter = 'flagged';
        }

        let msgRes = await app.suiteApi.get(`/users/${userId}/mailboxes/${mailboxId}/messages`, {
            query: queryParams,
            token: req.session.accessToken
        });
        let pane = renderMessageListPane({
            messages: (msgRes && msgRes.results) || [],
            activeMailboxId: mailboxId,
            filter,
            locale: req.locale,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(pane.toString());
    });

    app.get('/webmail/search', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let searchQuery = String((req.query && req.query.query) || '').trim();
        let msgRes = await app.suiteApi.get(`/users/${userId}/messages`, {
            query: { query: searchQuery, limit: 30 },
            token: req.session.accessToken
        });
        let pane = renderMessageListPane({
            messages: (msgRes && msgRes.results) || [],
            searchQuery,
            locale: req.locale,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(pane.toString());
    });

    app.get('/webmail/mailboxes/:mailboxId/messages/:messageId', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let { mailboxId, messageId } = req.params;
        let token = req.session.accessToken;

        let [message, mbRes] = await Promise.all([
            app.suiteApi.get(`/users/${userId}/mailboxes/${mailboxId}/messages/${messageId}`, {
                query: { markAsSeen: true },
                token
            }),
            app.suiteApi.get(`/users/${userId}/mailboxes`, { token })
        ]);

        let reader = renderMessageReaderPane({
            message,
            activeMailboxId: mailboxId,
            mailboxes: (mbRes && mbRes.results) || [],
            csrfToken: req.session.csrfToken,
            locale: req.locale,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(reader.toString());
    });

    app.post('/webmail/mailboxes/:mailboxId/messages/:messageId/update', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let { mailboxId, messageId } = req.params;
        let token = req.session.accessToken;
        let body = req.body || {};

        let updateBody = { message: String(messageId) };
        if (body.flagged !== undefined) {
            updateBody.flagged = body.flagged === 'true' || body.flagged === true;
        }
        if (body.seen !== undefined) {
            updateBody.seen = body.seen === 'true' || body.seen === true;
        }
        if (body.moveTo && body.moveTo !== mailboxId) {
            updateBody.moveTo = body.moveTo;
        }

        await app.suiteApi.put(`/users/${userId}/mailboxes/${mailboxId}/messages`, {
            body: updateBody,
            token
        });

        reply.toast(req.t('common.success'));
        if (updateBody.moveTo) {
            return reply
                .type('text/html; charset=utf-8')
                .send(`<div style="margin:auto;text-align:center;color:var(--text-muted);">${req.t('common.success')}</div>`);
        }

        let [message, mbRes] = await Promise.all([
            app.suiteApi.get(`/users/${userId}/mailboxes/${mailboxId}/messages/${messageId}`, { token }),
            app.suiteApi.get(`/users/${userId}/mailboxes`, { token })
        ]);

        let reader = renderMessageReaderPane({
            message,
            activeMailboxId: mailboxId,
            mailboxes: (mbRes && mbRes.results) || [],
            csrfToken: req.session.csrfToken,
            locale: req.locale,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(reader.toString());
    });

    app.delete('/webmail/mailboxes/:mailboxId/messages/:messageId', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let { mailboxId, messageId } = req.params;
        await app.suiteApi.del(`/users/${userId}/mailboxes/${mailboxId}/messages/${messageId}`, {
            token: req.session.accessToken
        });
        reply.toast(req.t('common.success'));
        return reply
            .type('text/html; charset=utf-8')
            .send(`<div style="margin:auto;text-align:center;color:var(--text-muted);">${req.t('webmail.selectMessagePrompt')}</div>`);
    });

    app.get('/webmail/compose', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let token = req.session.accessToken;
        let draft = {};

        if (req.query && req.query.replyMailbox && req.query.replyMessage) {
            let orig = await app.suiteApi.get(
                `/users/${userId}/mailboxes/${req.query.replyMailbox}/messages/${req.query.replyMessage}`,
                { token }
            );
            draft.to = (orig.from && orig.from.address) || '';
            draft.subject = orig.subject && orig.subject.toLowerCase().startsWith('re:') ? orig.subject : `Re: ${orig.subject || ''}`;
            draft.text = `\n\n--- Original Message ---\n${orig.text || ''}`;
        } else if (req.query && req.query.forwardMailbox && req.query.forwardMessage) {
            let orig = await app.suiteApi.get(
                `/users/${userId}/mailboxes/${req.query.forwardMailbox}/messages/${req.query.forwardMessage}`,
                { token }
            );
            draft.subject = orig.subject && orig.subject.toLowerCase().startsWith('fwd:') ? orig.subject : `Fwd: ${orig.subject || ''}`;
            draft.text = `\n\n--- Forwarded Message ---\n${orig.text || ''}`;
        }

        let pane = renderComposerPane({
            draft,
            csrfToken: req.session.csrfToken,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(pane.toString());
    });

    app.get('/webmail/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let { mailboxId, messageId, attachmentId } = req.params;
        let token = req.session.accessToken;

        let attRes = await app.suiteApi.get(
            `/users/${userId}/mailboxes/${mailboxId}/messages/${messageId}/attachments/${attachmentId}`,
            { token }
        );
        let contentBuffer =
            attRes && attRes.content
                ? Buffer.from(attRes.content, attRes.encoding || 'base64')
                : Buffer.from(typeof attRes === 'string' ? attRes : JSON.stringify(attRes || ''));
        let filename = (attRes && attRes.filename) || `${attachmentId}.bin`;
        let contentType = (attRes && attRes.contentType) || 'application/octet-stream';

        return reply
            .header('Content-Type', contentType)
            .header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`)
            .send(contentBuffer);
    });

    app.post('/webmail/send', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let token = req.session.accessToken;
        let body = req.body || {};
        let payload = {
            to: parseAddressHeaderInput(body.to),
            cc: parseAddressHeaderInput(body.cc),
            bcc: parseAddressHeaderInput(body.bcc),
            subject: String(body.subject || '').trim(),
            text: String(body.text || ''),
            html: `<p>${String(body.text || '').replace(/\r?\n/g, '<br>')}</p>`
        };

        if (body.attachmentFilename && body.attachmentContent) {
            payload.attachments = [
                {
                    filename: String(body.attachmentFilename).trim(),
                    content: Buffer.from(String(body.attachmentContent), 'utf8').toString('base64')
                }
            ];
        }

        if (body.mode === 'draft') {
            let mbRes = await app.suiteApi.get(`/users/${userId}/mailboxes`, {
                query: { specialUse: '\\Drafts' },
                token
            });
            let draftsMb = mbRes && mbRes.results && mbRes.results[0];
            if (draftsMb) {
                await app.suiteApi.post(`/users/${userId}/mailboxes/${draftsMb.id}/messages`, {
                    body: Object.assign({ draft: true }, payload),
                    token
                });
            }
            reply.toast(req.t('common.success'));
            return reply
                .type('text/html; charset=utf-8')
                .send(`<div class="card"><span class="badge badge-pass">✓ DRAFT</span> <p>${req.t('common.success')}</p></div>`);
        }

        await app.suiteApi.post(`/users/${userId}/submit`, {
            body: payload,
            token
        });

        reply.toast(req.t('webmail.messageSent'));
        return reply
            .type('text/html; charset=utf-8')
            .send(`<div class="card"><span class="badge badge-pass">✓ SENT</span> <p>${req.t('webmail.messageSent')}</p></div>`);
    });

    app.post('/webmail/mailboxes', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let token = req.session.accessToken;
        let folderPath = String((req.body && req.body.path) || '').trim();

        if (folderPath) {
            await app.suiteApi.post(`/users/${userId}/mailboxes`, {
                body: { path: folderPath },
                token
            });
        }

        let [account, mbRes] = await Promise.all([
            app.suiteApi.get(`/users/${userId}`, { token }),
            app.suiteApi.get(`/users/${userId}/mailboxes`, { query: { counters: true }, token })
        ]);
        let mailboxes = (mbRes && mbRes.results) || [];
        reply.toast(req.t('common.success'));
        let sidebar = renderMailboxesSidebar({
            mailboxes,
            activeMailboxId: (mailboxes[0] && mailboxes[0].id) || '',
            account,
            csrfToken: req.session.csrfToken,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(sidebar.toString());
    });

    app.delete('/webmail/mailboxes/:mailboxId', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        await app.suiteApi.del(`/users/${req.session.userId}/mailboxes/${req.params.mailboxId}`, {
            token: req.session.accessToken
        });
        reply.toast(req.t('common.success'));
        return reply.type('text/html; charset=utf-8').send('');
    });

    app.post('/webmail/mailboxes/:mailboxId/empty', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let userId = req.session.userId;
        let mailboxId = req.params.mailboxId;
        await app.suiteApi.del(`/users/${userId}/mailboxes/${mailboxId}/messages`, {
            token: req.session.accessToken
        });
        reply.toast(req.t('common.success'));
        return reply.type('text/html; charset=utf-8').send(`<div style="padding:2rem;text-align:center;color:var(--text-muted);">${req.t('webmail.noMessages')}</div>`);
    });

    app.get('/webmail/events', async (req, reply) => {
        if (!ensureAuthenticatedUser(req, reply)) {
            return;
        }
        let payload = `event: connected\ndata: ${JSON.stringify({ userId: req.session.userId, timestamp: Date.now() })}\n\n`;
        return reply
            .header('Content-Type', 'text/event-stream; charset=utf-8')
            .header('Cache-Control', 'no-cache')
            .header('Connection', 'keep-alive')
            .send(payload);
    });
};
