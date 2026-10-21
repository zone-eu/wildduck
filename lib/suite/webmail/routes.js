'use strict';

const { SESSION_COOKIE_NAME } = require('../session');
const { html } = require('../html');
const { renderMailboxesSidebar } = require('./views/mailboxes');
const { renderLoginView, renderWebmailWorkspace } = require('./views/shell');

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

function renderInitialListPlaceholder(messages = [], activeMailboxId = '', t) {
    if (!messages.length) {
        return html`<div style="padding:2rem;text-align:center;color:var(--text-muted);">${t('webmail.noMessages')}</div>`;
    }
    return html`<div class="webmail-messages-scroll">
        ${messages.map(
            msg => html`<a href="/webmail/mailboxes/${activeMailboxId}/messages/${msg.id}"
                           hx-get="/webmail/mailboxes/${activeMailboxId}/messages/${msg.id}"
                           hx-target="#webmail-reader-pane"
                           hx-swap="innerHTML"
                           class="message-row ${msg.seen ? '' : 'unseen'}">
                <div class="message-meta">
                    <span class="message-sender">${(msg.from && (msg.from.name || msg.from.address)) || '-'}</span>
                </div>
                <div class="message-subject">${msg.subject || '(No Subject)'}</div>
                <div class="message-intro">${msg.intro || ''}</div>
            </a>`
        )}
    </div>`;
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

        let listPaneHtml = app.suiteRenderMessageList
            ? app.suiteRenderMessageList({
                  messages,
                  activeMailboxId,
                  mailboxes,
                  csrfToken: req.session.csrfToken,
                  locale: req.locale,
                  t: req.t
              })
            : renderInitialListPlaceholder(messages, activeMailboxId, req.t);

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
