'use strict';

const { html } = require('../../html');
const { renderMailboxesSidebar } = require('./mailboxes');

function renderLoginView({ errorMsg = '', nextUrl = '/webmail', t }) {
    return html`<main class="auth-wrapper">
        <div class="card auth-card">
            <div style="text-align:center;margin-bottom:1.5rem;">
                <div class="suite-brand-badge" style="width:46px;height:46px;font-size:17px;border-radius:12px;margin:0 auto 0.75rem;">WD</div>
                <h1 style="margin:0 0 0.35rem;font-size:20px;font-weight:800;letter-spacing:-0.02em;">${t('auth.loginTitle')}</h1>
                <p style="margin:0;color:var(--text-secondary);font-size:13px;">${t('auth.loginSubtitle')}</p>
            </div>
            ${
                errorMsg
                    ? html`<div class="callout" style="background:var(--status-fail-bg);border-color:var(--status-fail-border);color:var(--status-fail-fg);padding:0.75rem 1rem;margin-bottom:1.125rem;">
                          <strong>✕</strong> <span>${errorMsg}</span>
                      </div>`
                    : ''
            }
            <form method="POST" action="/login">
                <input type="hidden" name="next" value="${nextUrl}">
                <div class="form-group">
                    <label class="form-label" for="login-user">${t('auth.username')}</label>
                    <input id="login-user" name="username" class="form-input" required autocomplete="username" placeholder="admin hoặc user@domain.com" autofocus>
                </div>
                <div class="form-group">
                    <label class="form-label" for="login-pass">${t('auth.password')}</label>
                    <input id="login-pass" name="password" type="password" class="form-input" required autocomplete="current-password" placeholder="••••••••">
                </div>
                <details style="margin-bottom:1.25rem;">
                    <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text-secondary);">🔐 ${t('auth.totpCode')} (Tùy chọn nếu tài khoản bật 2FA)</summary>
                    <div class="form-group" style="margin-top:0.625rem;margin-bottom:0;">
                        <input id="login-totp" name="totpCode" class="form-input mono" inputmode="numeric" placeholder="123456">
                        <span class="form-hint">${t('auth.totpPrompt')}</span>
                    </div>
                </details>
                <button type="submit" class="btn btn-primary" style="width:100%;padding:0.675rem;font-size:14px;">${t('auth.signIn')} →</button>
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
