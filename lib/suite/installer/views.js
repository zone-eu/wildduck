'use strict';

const { html, rawHtml } = require('../html');

function renderBadge(status, t) {
    if (status === 'pass' || status === 'completed') {
        return html`<span class="badge badge-pass">✓ ${t ? t('common.status') : 'PASS'}</span>`;
    }
    if (status === 'warn') {
        return html`<span class="badge badge-warn">! WARN</span>`;
    }
    return html`<span class="badge badge-fail">✕ FAIL</span>`;
}

function renderStepper(activeStep, state, t) {
    let steps = [
        { num: 1, key: 'language', label: t('installer.stepLanguage') },
        { num: 2, key: 'preflight', label: t('installer.stepPreflight') },
        { num: 3, key: 'provision', label: t('installer.stepProvision') },
        { num: 4, key: 'dns', label: t('installer.stepDns') },
        { num: 5, key: 'finalize', label: t('installer.stepComplete') }
    ];

    return html`<nav class="wizard-stepper" aria-label="Setup Progress">
        ${steps.map(s => {
            let st = state && state.steps && state.steps[s.key] && state.steps[s.key].status;
            let cls = s.num === activeStep ? 'wizard-step active' : st === 'completed' ? 'wizard-step done' : 'wizard-step';
            return html`<div class="${cls}">${s.label}</div>`;
        })}
    </nav>`;
}

function renderStep1Language({ state, token, t }) {
    return html`<div class="card">
        <div class="card-header">
            <h2 class="card-title">${t('installer.stepLanguage')}</h2>
            <span class="badge badge-neutral">v${state.version || '1.55.1'}</span>
        </div>
        <p>${t('installer.chooseLanguage')}</p>
        <form method="POST" action="/setup/language" hx-post="/setup/language" hx-target="#wizard-stage" hx-swap="innerHTML">
            <input type="hidden" name="token" value="${token}">
            <div class="form-group">
                <label class="form-label" for="setup-lang-select">${t('common.language')}</label>
                <select id="setup-lang-select" name="lang" class="form-select">
                    <option value="en" ${state.locale === 'en' ? rawHtml('selected') : ''}>English (International Default)</option>
                    <option value="vi" ${state.locale === 'vi' ? rawHtml('selected') : ''}>Tiếng Việt (Vietnamese)</option>
                </select>
            </div>
            <button type="submit" class="btn btn-primary">${t('common.next')} →</button>
        </form>
    </div>`;
}

function renderStep2Preflight({ report, token, t }) {
    let rows = (report.checks || []).map(
        check => html`<tr>
            <td><strong>${t(check.labelKey)}</strong><span class="form-hint">${check.detail}</span></td>
            <td><span class="code-inline">${check.value}</span></td>
            <td>${renderBadge(check.status)}</td>
        </tr>`
    );

    return html`<div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">${t('installer.preflightTitle')}</h2>
                <span class="form-hint">${t('installer.preflightDesc')}</span>
            </div>
            <form method="POST" action="/setup/preflight" hx-post="/setup/preflight" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="rescan" value="true">
                <button type="submit" class="btn btn-sm">${t('installer.runPreflight')}</button>
            </form>
        </div>
        <div class="table-wrap">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Check</th>
                        <th>Detected</th>
                        <th>${t('common.status')}</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div style="margin-top:1.25rem;display:flex;justify-content:flex-end;">
            <form method="POST" action="/setup/preflight" hx-post="/setup/preflight" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <button type="submit" class="btn btn-primary">${t('common.next')} →</button>
            </form>
        </div>
    </div>`;
}

function renderStep3Provision({ state, token, errorMsg, t }) {
    let cfg = state.config || {};
    let errorBanner = errorMsg ? html`<div class="card" style="background:var(--status-fail-bg);color:var(--status-fail-fg);">${errorMsg}</div>` : '';

    return html`<div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">${t('installer.domainConfigTitle')}</h2>
                <span class="form-hint">${t('installer.domainConfigDesc')}</span>
            </div>
        </div>
        ${errorBanner}
        <form method="POST" action="/setup/provision" hx-post="/setup/provision" hx-target="#wizard-stage" hx-swap="innerHTML">
            <input type="hidden" name="token" value="${token}">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-domain">${t('installer.mailDomain')}</label>
                    <input id="prov-domain" name="mailDomain" class="form-input" required placeholder="example.com" value="${cfg.mailDomain || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-hostname">${t('installer.serverHostname')}</label>
                    <input id="prov-hostname" name="hostname" class="form-input" required placeholder="mail.example.com" value="${cfg.hostname || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-ip">Server Public IPv4</label>
                    <input id="prov-ip" name="publicIp" class="form-input" required value="${cfg.publicIp || '127.0.0.1'}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-selector">${t('admin.dkimSelector')}</label>
                    <input id="prov-selector" name="dkimSelector" class="form-input" required value="${cfg.dkimSelector || 'wd2026'}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-admin">${t('installer.adminUsername')}</label>
                    <input id="prov-admin" name="adminUsername" class="form-input" required value="${cfg.adminUsername || 'admin'}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-pass">${t('installer.adminPassword')}</label>
                    <input id="prov-pass" type="password" name="adminPassword" class="form-input" required minlength="6" placeholder="••••••••">
                </div>
            </div>
            <div class="form-group">
                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                    <input type="checkbox" name="enableLetsEncrypt" value="true" ${cfg.enableLetsEncrypt !== false ? rawHtml('checked') : ''}>
                    <span>${t('installer.enableLetsEncrypt')}</span>
                </label>
            </div>
            <div style="display:flex;justify-content:flex-end;">
                <button type="submit" class="btn btn-primary">${t('installer.provisionNow')} →</button>
            </div>
        </form>
    </div>`;
}

function renderDnsVerificationTable({ dnsReport, t }) {
    let rows = (dnsReport.records || []).map(
        rec => html`<tr>
            <td><span class="badge badge-neutral">${rec.type}</span></td>
            <td><span class="code-inline">${rec.host}</span></td>
            <td>
                <div style="display:flex;align-items:center;gap:0.5rem;">
                    <span class="code-inline">${rec.expected}</span>
                    <button type="button" class="btn btn-sm" data-copy-text="${rec.expected}" data-copied-label="${t('common.copied')}">${t('common.copy')}</button>
                </div>
                <span class="form-hint">${rec.description || ''}</span>
            </td>
            <td><span class="code-inline">${(rec.actual && rec.actual.length && rec.actual.join(', ')) || '-'}</span></td>
            <td>${renderBadge(rec.status)}</td>
        </tr>`
    );

    return html`<div id="dns-verification-table" class="table-wrap">
        <table class="data-table">
            <thead>
                <tr>
                    <th>${t('installer.recordType')}</th>
                    <th>${t('installer.recordHost')}</th>
                    <th>${t('installer.recordValue')}</th>
                    <th>${t('installer.recordActual')}</th>
                    <th>${t('installer.recordStatus')}</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function renderStep4Dns({ dnsReport, token, t }) {
    return html`<div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">${t('installer.dnsTitle')}</h2>
                <span class="form-hint">${t('installer.dnsDesc')}</span>
            </div>
            <form method="POST" action="/setup/verify-dns" hx-post="/setup/verify-dns" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <button type="submit" class="btn btn-sm">${t('installer.verifyDnsNow')}</button>
            </form>
        </div>
        ${renderDnsVerificationTable({ dnsReport, t })}
        <div style="margin-top:1.25rem;display:flex;justify-content:flex-end;">
            <form method="POST" action="/setup/finalize" hx-post="/setup/finalize" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <button type="submit" class="btn btn-primary">${t('common.finish')} ✓</button>
            </form>
        </div>
    </div>`;
}

function renderStep5Complete({ state, t }) {
    let cfg = state.config || {};
    return html`<div class="card" style="text-align:center;padding:2.5rem 1.5rem;">
        <div style="margin-bottom:1rem;">
            <span class="badge badge-pass" style="font-size:14px;padding:0.375rem 0.875rem;">✓ READY</span>
        </div>
        <h2 style="margin-top:0;">${t('installer.completeTitle')}</h2>
        <p style="color:var(--text-secondary);max-width:560px;margin:0.5rem auto 1.5rem;">
            ${t('installer.completeDesc')} (${cfg.mailDomain || 'WildDuck'} / ${cfg.hostname || 'localhost'})
        </p>
        <div style="display:flex;justify-content:center;gap:0.75rem;flex-wrap:wrap;">
            <a href="/admin" class="btn btn-primary">${t('installer.openAdmin')}</a>
            <a href="/webmail" class="btn">${t('installer.openWebmail')}</a>
        </div>
    </div>`;
}

function renderWizardShell({ activeStep, state, stageContent, t }) {
    let resumeBanner = '';
    if (state.resumeStep > 1 && state.steps && Object.values(state.steps).some(s => s.status === 'failed')) {
        resumeBanner = html`<div class="card" style="border-color:var(--status-warn-fg);background:var(--status-warn-bg);color:var(--status-warn-fg);">
            <strong>${t('installer.resumeNotice', { step: state.resumeStep })}</strong>
        </div>`;
    }

    return html`<main class="wizard-container">
        <div style="margin-bottom:1.25rem;">
            <h1 style="margin:0 0 0.25rem;font-size:20px;">${t('installer.welcomeTitle', { version: state.version || '1.55.1' })}</h1>
            <p style="margin:0;color:var(--text-secondary);">${t('installer.welcomeSubtitle')}</p>
        </div>
        ${resumeBanner}
        ${renderStepper(activeStep, state, t)}
        <section id="wizard-stage">${stageContent}</section>
    </main>`;
}

module.exports = {
    renderBadge,
    renderStepper,
    renderStep1Language,
    renderStep2Preflight,
    renderStep3Provision,
    renderDnsVerificationTable,
    renderStep4Dns,
    renderStep5Complete,
    renderWizardShell
};
