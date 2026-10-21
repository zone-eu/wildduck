'use strict';

const { html } = require('../../html');
const { renderMailboxesSidebar } = require('./mailboxes');

function renderLoginView({ errorMsg = '', nextUrl = '/webmail', t }) {
    return html`<main class="auth-wrapper">
        <div class="card auth-card">
            <div style="text-align:center;margin-bottom:1.25rem;">
                <div class="suite-brand-badge" style="width:40px;height:40px;font-size:16px;margin-bottom:0.5rem;">WD</div>
                <h1 style="margin:0 0 0.25rem;font-size:18px;">${t('auth.loginTitle')}</h1>
                <p style="margin:0;color:var(--text-secondary);font-size:13px;">${t('auth.loginSubtitle')}</p>
            </div>
            ${errorMsg ? html`<div class="card" style="background:var(--status-fail-bg);color:var(--status-fail-fg);padding:0.625rem;">${errorMsg}</div>` : ''}
            <form method="POST" action="/login">
                <input type="hidden" name="next" value="${nextUrl}">
                <div class="form-group">
                    <label class="form-label" for="login-user">${t('auth.username')}</label>
                    <input id="login-user" name="username" class="form-input" required autocomplete="username" autofocus>
                </div>
                <div class="form-group">
                    <label class="form-label" for="login-pass">${t('auth.password')}</label>
                    <input id="login-pass" name="password" type="password" class="form-input" required autocomplete="current-password">
                </div>
                <div class="form-group">
                    <label class="form-label" for="login-totp">${t('auth.totpCode')}</label>
                    <input id="login-totp" name="totpCode" class="form-input" inputmode="numeric" placeholder="Optional 6-digit code">
                    <span class="form-hint">${t('auth.totpPrompt')}</span>
                </div>
                <button type="submit" class="btn btn-primary" style="width:100%;padding:0.6rem;">${t('auth.signIn')} →</button>
            </form>
        </div>
    </main>`;
}

function renderWebmailWorkspace({ mailboxes, activeMailboxId, account, listPaneHtml, readerPaneHtml, csrfToken, t }) {
    return html`<div class="webmail-shell">
        <aside class="webmail-folders" id="webmail-folders-pane">
            ${renderMailboxesSidebar({ mailboxes, activeMailboxId, account, csrfToken, t })}
        </aside>
        <section class="webmail-list-pane" id="webmail-list-pane">
            ${listPaneHtml}
        </section>
        <main class="webmail-reader-pane" id="webmail-reader-pane">
            ${readerPaneHtml}
        </main>
    </div>`;
}

module.exports = {
    renderLoginView,
    renderWebmailWorkspace
};
