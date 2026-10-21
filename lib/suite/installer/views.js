'use strict';

const os = require('os');
const { html, rawHtml } = require('../html');

function detectDefaultPublicIp() {
    let interfaces = os.networkInterfaces() || {};
    for (let name of Object.keys(interfaces)) {
        for (let iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal && iface.address) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

function renderBadge(status, t) {
    if (status === 'pass' || status === 'completed') {
        return html`<span class="badge badge-pass">● ${t ? t('common.status') : 'PASS'}</span>`;
    }
    if (status === 'warn') {
        return html`<span class="badge badge-warn">▲ WARN</span>`;
    }
    return html`<span class="badge badge-fail">✕ FAIL</span>`;
}

function renderStepper(activeStep, state, token, t) {
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
            let isDone = st === 'completed' || s.num < activeStep;
            let cls = s.num === activeStep ? 'wizard-step active' : isDone ? 'wizard-step done' : 'wizard-step';
            let badgeText = isDone && s.num !== activeStep ? '✓' : String(s.num);
            if (s.num < activeStep && activeStep < 5 && token) {
                return html`<a href="/setup?step=${s.num}&token=${encodeURIComponent(token)}"
                               class="${cls}">
                    <span class="wizard-step-num">${badgeText}</span>
                    <span>${s.label}</span>
                </a>`;
            }
            return html`<div class="${cls}">
                <span class="wizard-step-num">${badgeText}</span>
                <span>${s.label}</span>
            </div>`;
        })}
    </nav>`;
}

function renderStep1Language({ state, token, t }) {
    return html`${renderStepper(1, state, token, t)}
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">${t('installer.stepLanguage')}</h2>
                <span class="form-hint">${t('installer.chooseLanguage')}</span>
            </div>
            <span class="badge badge-neutral">WildDuck v${state.version || '1.55.1'}</span>
        </div>
        <form method="POST" action="/setup/language" hx-post="/setup/language" hx-target="#wizard-stage" hx-swap="innerHTML">
            <input type="hidden" name="token" value="${token}">
            <div class="form-group">
                <label class="form-label" for="setup-lang-select">${t('common.language')}</label>
                <select id="setup-lang-select" name="lang" class="form-select">
                    <option value="en" ${state.locale === 'en' ? rawHtml('selected') : ''}>🌐 English (International Default)</option>
                    <option value="vi" ${state.locale === 'vi' ? rawHtml('selected') : ''}>🇻🇳 Tiếng Việt (Vietnamese)</option>
                </select>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:1.25rem;">
                <button type="submit" class="btn btn-primary">${t('common.next')} →</button>
            </div>
        </form>
    </div>`;
}

function renderStep2Preflight({ report, state = {}, token, t }) {
    let rows = (report.checks || []).map(
        check => html`<tr>
            <td><strong>${t(check.labelKey)}</strong><span class="form-hint">${check.detail}</span></td>
            <td><span class="code-inline">${check.value}</span></td>
            <td>${renderBadge(check.status)}</td>
        </tr>`
    );

    return html`${renderStepper(2, state, token, t)}
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">${t('installer.preflightTitle')}</h2>
                <span class="form-hint">${t('installer.preflightDesc')}</span>
            </div>
            <form method="POST" action="/setup/preflight" hx-post="/setup/preflight" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="rescan" value="true">
                <button type="submit" class="btn btn-sm">↻ ${t('installer.runPreflight')}</button>
            </form>
        </div>
        <div class="callout callout-info">
            <div>${t('installer.preflightCallout')}</div>
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
        <div style="margin-top:1.25rem;display:flex;justify-content:space-between;align-items:center;">
            <a href="/setup?step=1&token=${encodeURIComponent(token)}" class="btn">← ${t('common.back')}</a>
            <form method="POST" action="/setup/preflight" hx-post="/setup/preflight" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <button type="submit" class="btn btn-primary">${t('common.next')} →</button>
            </form>
        </div>
    </div>`;
}

function renderStep3Provision({ state, token, errorMsg, t }) {
    let cfg = state.config || {};
    let defaultIp = cfg.publicIp || detectDefaultPublicIp();
    let errorBanner = errorMsg
        ? html`<div class="callout" style="background:var(--status-fail-bg);border-color:var(--status-fail-border);color:var(--status-fail-fg);">
              <strong>${t('common.error')}:</strong> ${errorMsg}
          </div>`
        : '';

    return html`${renderStepper(3, state, token, t)}
    <div class="card">
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
                    <label class="form-label" for="prov-domain">${t('installer.mailDomain')} *</label>
                    <input id="prov-domain"
                           name="mailDomain"
                           class="form-input"
                           required
                           placeholder="example.com"
                           value="${cfg.mailDomain || ''}"
                           oninput="var h=document.getElementById('prov-hostname'); if(h && (!h.dataset.touched)){ h.value = this.value ? 'mail.' + this.value.trim() : ''; }">
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-hostname">${t('installer.serverHostname')} *</label>
                    <input id="prov-hostname"
                           name="hostname"
                           class="form-input"
                           required
                           placeholder="mail.example.com"
                           value="${cfg.hostname || ''}"
                           oninput="this.dataset.touched='1'">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-ip">${t('installer.publicIpLabel')} *</label>
                    <input id="prov-ip" name="publicIp" class="form-input mono" required value="${defaultIp}">
                    <span class="form-hint">${t('installer.publicIpHint')}</span>
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-selector">${t('admin.dkimSelector')} *</label>
                    <input id="prov-selector" name="dkimSelector" class="form-input mono" required value="${cfg.dkimSelector || 'wd2026'}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-admin">${t('installer.adminUsername')} *</label>
                    <input id="prov-admin" name="adminUsername" class="form-input" required value="${cfg.adminUsername || 'admin'}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-pass">${t('installer.adminPassword')} *</label>
                    <input id="prov-pass" type="password" name="adminPassword" class="form-input" required minlength="6" placeholder="••••••••">
                </div>
            </div>
            <div class="form-group">
                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                    <input type="checkbox" name="enableLetsEncrypt" value="true" ${cfg.enableLetsEncrypt !== false ? rawHtml('checked') : ''}>
                    <span>${t('installer.enableLetsEncrypt')}</span>
                </label>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1.25rem;">
                <a href="/setup?step=2&token=${encodeURIComponent(token)}" class="btn">← ${t('common.back')}</a>
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
                <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
                    <span class="code-inline" style="flex:1;">${rec.expected}</span>
                    <button type="button" class="btn btn-sm" data-copy-text="${rec.expected}" data-copied-label="${t('common.copied')}">📋 ${t('common.copy')}</button>
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

function renderStep4Dns({ dnsReport, state = {}, token, t }) {
    let records = (dnsReport && dnsReport.records) || [];
    let passedCount = records.filter(r => r.status === 'pass').length;
    let allPassed = records.length > 0 && passedCount === records.length;

    return html`${renderStepper(4, state, token, t)}
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">${t('installer.dnsTitle')}</h2>
                <span class="form-hint">${t('installer.dnsDesc')}</span>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem;">
                <span class="badge ${allPassed ? 'badge-pass' : 'badge-warn'}">${t('installer.verifiedCount', { passed: passedCount, total: records.length })}</span>
                <form method="POST" action="/setup/verify-dns" hx-post="/setup/verify-dns" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                    <input type="hidden" name="token" value="${token}">
                    <button type="submit" class="btn btn-primary btn-sm">↻ ${t('installer.verifyDnsNow')}</button>
                </form>
            </div>
        </div>

        <div class="callout ${allPassed ? 'callout-info' : 'callout-warn'}">
            <div>${t('installer.dnsCallout')}</div>
        </div>

        ${renderDnsVerificationTable({ dnsReport, t })}

        <div style="margin-top:1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;">
            <a href="/setup?step=3&token=${encodeURIComponent(token)}" class="btn">← ${t('common.back')}</a>
            <div style="display:flex;gap:0.625rem;align-items:center;">
                <form method="POST" action="/setup/verify-dns" hx-post="/setup/verify-dns" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                    <input type="hidden" name="token" value="${token}">
                    <button type="submit" class="btn">↻ ${t('installer.verifyDnsNow')}</button>
                </form>
                <form method="POST" action="/setup/finalize" hx-post="/setup/finalize" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                    <input type="hidden" name="token" value="${token}">
                    <button type="submit" class="btn ${allPassed ? 'btn-primary' : ''}">
                        ${allPassed ? `${t('common.finish')} ✓` : `${t('installer.skipDnsFinish')} →`}
                    </button>
                </form>
            </div>
        </div>
    </div>`;
}

function renderStep5Complete({ state, t }) {
    let cfg = state.config || {};
    return html`${renderStepper(5, state, '', t)}
    <div class="card" style="text-align:center;padding:3rem 1.5rem;">
        <div style="margin-bottom:1rem;">
            <span class="badge badge-pass" style="font-size:13px;padding:0.4rem 1rem;">● READY</span>
        </div>
        <h2 style="margin-top:0;font-size:22px;">${t('installer.completeTitle')}</h2>
        <p style="color:var(--text-secondary);max-width:580px;margin:0.5rem auto 1.25rem;">
            ${t('installer.completeDesc')} (${cfg.mailDomain || 'WildDuck'} / ${cfg.hostname || 'localhost'})
        </p>
        <div style="display:flex;justify-content:center;gap:0.75rem;flex-wrap:wrap;">
            <a href="/login?next=/admin" class="btn btn-primary">🛡 ${t('installer.openAdmin')}</a>
            <a href="/login?next=/webmail" class="btn">✉ ${t('installer.openWebmail')}</a>
        </div>
    </div>`;
}

function renderWizardShell({ activeStep, state, stageContent, t }) {
    let resumeBanner = '';
    if (state.resumeStep > 1 && state.steps && Object.values(state.steps).some(s => s.status === 'failed')) {
        resumeBanner = html`<div class="callout callout-warn">
            <strong>${t('installer.resumeNotice', { step: state.resumeStep })}</strong>
        </div>`;
    }

    return html`<main class="wizard-container">
        <div class="wizard-hero">
            <div>
                <h1>${t('installer.welcomeTitle', { version: state.version || '1.55.1' })}</h1>
                <p>${t('installer.welcomeSubtitle')}</p>
            </div>
            <span class="badge badge-pass">Zero-Touch Core v${state.version || '1.55.1'}</span>
        </div>
        ${resumeBanner}
        <section id="wizard-stage" data-active-step="${activeStep}">${stageContent}</section>
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
