'use strict';

const { html, rawHtml } = require('../html');

function isHtmxRequest(req) {
    if (!req || !req.headers) {
        return false;
    }
    return req.headers['hx-request'] === 'true' && req.headers['hx-boosted'] !== 'true';
}

function renderLanguageSelector({ locale, csrfToken, redirectTo = '/' }) {
    return html`<form method="POST" action="/locale" hx-post="/locale" style="display:inline-flex;align-items:center;gap:0.25rem;margin:0;">
        <input type="hidden" name="_csrf" value="${csrfToken || ''}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <select name="lang" class="form-select" style="width:auto;padding:0.25rem 0.5rem;font-size:12px;" onchange="this.form.requestSubmit ? this.form.requestSubmit() : this.form.submit()" aria-label="Language">
            <option value="en" ${locale === 'en' ? rawHtml('selected') : ''}>English (EN)</option>
            <option value="vi" ${locale === 'vi' ? rawHtml('selected') : ''}>Tiếng Việt (VI)</option>
        </select>
    </form>`;
}

function renderTopbar({ t, locale, csrfToken, session, activeSection, currentPath }) {
    let navLinks = '';
    if (session && session.userId) {
        navLinks = html`<div class="suite-topbar-nav">
            <a href="/webmail" class="btn btn-sm ${activeSection === 'webmail' ? 'btn-primary' : ''}">${t('auth.webmailPortal')}</a>
            ${
                session.role === 'admin'
                    ? html`<a href="/admin" class="btn btn-sm ${activeSection === 'admin' ? 'btn-primary' : ''}">${t('auth.adminPortal')}</a>`
                    : ''
            }
        </div>`;
    } else if (activeSection === 'setup') {
        navLinks = html`<div class="suite-topbar-nav">
            <span class="badge badge-neutral">${t('auth.setupWizard')}</span>
        </div>`;
    }

    let userControls = '';
    if (session && session.username) {
        userControls = html`<span style="font-size:12px;color:var(--text-secondary);font-weight:600;">${session.username}</span>
            <form method="POST" action="/logout" hx-post="/logout" style="display:inline;margin:0;">
                <input type="hidden" name="_csrf" value="${csrfToken || ''}">
                <button type="submit" class="btn btn-sm">${t('common.logout')}</button>
            </form>`;
    }

    return html`<header class="suite-topbar">
        <div style="display:flex;align-items:center;gap:1rem;">
            <a href="/" class="suite-brand">
                <span class="suite-brand-badge">WD</span>
                <span>${t('common.appName')}</span>
            </a>
            ${navLinks}
        </div>
        <div class="suite-topbar-Controls">
            <span class="htmx-indicator badge badge-neutral" id="global-indicator">${t('common.loading')}</span>
            ${renderLanguageSelector({ locale, csrfToken, redirectTo: currentPath || '/' })}
            <button type="button" class="btn btn-sm" data-toggle-theme="true" title="${t('common.theme')}">◑</button>
            ${userControls}
        </div>
    </header>`;
}

function renderDocument(options = {}) {
    let { req, t, locale = 'en', title = 'WildDuck Mail Suite', csrfToken = '', session = null, activeSection = '', body = '' } = options;

    if (isHtmxRequest(req)) {
        return typeof body === 'string' ? body : body.toString();
    }

    let currentPath = (req && req.url) || '/';
    let pageHtml = html`<!DOCTYPE html>
<html lang="${locale}" data-theme="light">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${csrfToken}">
    <title>${title} - ${t ? t('common.appName') : 'WildDuck Mail Suite'}</title>
    <link rel="stylesheet" href="/suite-assets/suite.css">
    <script src="/suite-assets/htmx.min.js" defer></script>
    <script src="/suite-assets/suite-client.js" defer></script>
</head>
<body hx-indicator="#global-indicator">
    ${t ? renderTopbar({ t, locale, csrfToken, session, activeSection, currentPath }) : ''}
    <div id="suite-app-root">${rawHtml(body)}</div>
    <div id="modal-container" aria-live="polite"></div>
    <div id="toast-region" class="toast-region" aria-live="polite"></div>
</body>
</html>`;

    return pageHtml.toString();
}

module.exports = {
    isHtmxRequest,
    renderLanguageSelector,
    renderTopbar,
    renderDocument
};
